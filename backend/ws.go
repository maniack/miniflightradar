package backend

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/maniack/miniflightradar/monitoring"
	"github.com/maniack/miniflightradar/storage"
)

// minimal websocket writer (server-to-client only)
const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type wsConn struct {
	c   net.Conn
	buf *bufio.ReadWriter
}

func (w *wsConn) Close() error { return w.c.Close() }

func (w *wsConn) WriteText(b []byte) error {
	// Frame: FIN=1, RSV=0, opcode=1 (text), MASK=0, payload len
	header := []byte{0x81}
	l := len(b)
	switch {
	case l <= 125:
		header = append(header, byte(l))
	case l < 65536:
		header = append(header, 126, byte(l>>8), byte(l))
	default:
		// 64-bit length
		header = append(header, 127,
			0, 0, 0, 0, // we won't send > 2^32
			byte(l>>24), byte(l>>16), byte(l>>8), byte(l))
	}
	if _, err := w.buf.Write(header); err != nil {
		return err
	}
	if _, err := w.buf.Write(b); err != nil {
		return err
	}
	return w.buf.Flush()
}

func (w *wsConn) WritePing() error {
	// small ping payload
	p := []byte("p")
	h := []byte{0x89, byte(len(p))}
	if _, err := w.buf.Write(h); err != nil {
		return err
	}
	if _, err := w.buf.Write(p); err != nil {
		return err
	}
	return w.buf.Flush()
}

func tokenListContains(headerVal, token string) bool {
	if headerVal == "" {
		return false
	}
	token = strings.ToLower(token)
	for _, v := range strings.Split(headerVal, ",") {
		if strings.TrimSpace(strings.ToLower(v)) == token {
			return true
		}
	}
	return false
}

func upgradeToWebSocket(w http.ResponseWriter, r *http.Request) (*wsConn, error) {
	if !tokenListContains(r.Header.Get("Connection"), "upgrade") || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return nil, fmt.Errorf("not a websocket upgrade")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return nil, fmt.Errorf("missing Sec-WebSocket-Key")
	}
	h := sha1.New()
	_, _ = io.WriteString(h, key+wsGUID)
	accept := base64.StdEncoding.EncodeToString(h.Sum(nil))

	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, fmt.Errorf("hijacking not supported")
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}

	// Write handshake response
	resp := fmt.Sprintf("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", accept)
	if _, err := rw.WriteString(resp); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return &wsConn{c: conn, buf: rw}, nil
}

// FlightsWSHandler streams positions of all flights and recent trails as JSON array messages.
// Frontend performs filtering and track rendering. Any provided bbox parameter is ignored for simplicity.
func FlightsWSHandler(w http.ResponseWriter, r *http.Request) {
	ws, err := upgradeToWebSocket(w, r)
	if err != nil {
		monitoring.Debugf("ws upgrade error: %v", err)
		return
	}
	defer ws.Close()

	type trailPoint struct {
		Lon float64 `json:"lon"`
		Lat float64 `json:"lat"`
		TS  int64   `json:"ts"`
	}
	type item struct {
		Icao24   string       `json:"icao24"`
		Callsign string       `json:"callsign"`
		Lon      float64      `json:"lon"`
		Lat      float64      `json:"lat"`
		Alt      float64      `json:"alt,omitempty"`
		Track    float64      `json:"track,omitempty"`
		Speed    float64      `json:"speed,omitempty"`
		TS       int64        `json:"ts"`
		Trail    []trailPoint `json:"trail,omitempty"`
	}

	send := func() error {
		pts, err := storage.Get().CurrentAll()
		if err != nil {
			return err
		}
		items := make([]item, 0, len(pts))
		for _, p := range pts {
			it := item{
				Icao24:   p.Icao24,
				Callsign: p.Callsign,
				Lon:      p.Lon,
				Lat:      p.Lat,
				Alt:      p.Alt,
				Track:    p.Track,
				Speed:    p.Speed,
				TS:       p.TS,
			}
			// recent trail (limit and window chosen for reasonable payload)
			trailPts, _ := storage.Get().RecentTrackByICAO(p.Icao24, 100, 45*time.Minute)
			if len(trailPts) > 0 {
				tr := make([]trailPoint, 0, len(trailPts))
				for _, tp := range trailPts {
					tr = append(tr, trailPoint{Lon: tp.Lon, Lat: tp.Lat, TS: tp.TS})
				}
				it.Trail = tr
			}
			items = append(items, it)
		}
		b, _ := json.Marshal(items)
		return ws.WriteText(b)
	}
	if err := send(); err != nil {
		return
	}

	interval := GetPollInterval()
	if interval <= 0 {
		interval = 10 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if err := send(); err != nil {
				return
			}
			_ = ws.WritePing()
		}
	}
}

// FlightWSHandler streams latest position for a single callsign as JSON object messages (storage.Point).
// Query: callsign=XXX
func FlightWSHandler(w http.ResponseWriter, r *http.Request) {
	callsign := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("callsign")))
	if callsign == "" {
		http.Error(w, "callsign is required", http.StatusBadRequest)
		return
	}

	ws, err := upgradeToWebSocket(w, r)
	if err != nil {
		monitoring.Debugf("ws upgrade error: %v", err)
		return
	}
	defer ws.Close()

	var lastSentTS int64
	send := func() error {
		p, err := storage.Get().LatestByCallsign(callsign)
		if err != nil || p == nil {
			return nil
		}
		if p.TS == lastSentTS {
			return nil
		}
		lastSentTS = p.TS
		b, _ := json.Marshal(p)
		return ws.WriteText(b)
	}
	if err := send(); err != nil {
		return
	}

	interval := GetPollInterval()
	if interval <= 0 {
		interval = 10 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if err := send(); err != nil {
				return
			}
			_ = ws.WritePing()
		}
	}
}
