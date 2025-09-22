package backend

import (
	"bufio"
	"bytes"
	"compress/flate"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/maniack/miniflightradar/monitoring"
	"github.com/maniack/miniflightradar/security"
	"github.com/maniack/miniflightradar/storage"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
)

// minimal websocket writer (server-to-client only)
const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type wsConn struct {
	c       net.Conn
	buf     *bufio.ReadWriter
	deflate bool
	mu      sync.Mutex
}

func (w *wsConn) Close() error { return w.c.Close() }

func (w *wsConn) WriteText(b []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	// Optionally compress payload with permessage-deflate if negotiated
	payload := b
	first := byte(0x81)            // FIN=1, RSV1=0, opcode=1 (text)
	if w.deflate && len(b) >= 64 { // compress only if non-trivial size
		var buf bytes.Buffer
		fw, err := flate.NewWriter(&buf, flate.DefaultCompression)
		if err == nil {
			_, _ = fw.Write(b)
			_ = fw.Close()
			payload = buf.Bytes()
			first = 0xC1 // FIN=1, RSV1=1, opcode=1
		}
	}
	// Frame header with optional extended length
	header := []byte{first}
	l := len(payload)
	switch {
	case l <= 125:
		header = append(header, byte(l))
	case l < 65536:
		header = append(header, 126, byte(l>>8), byte(l))
	default:
		// 64-bit length (we practically don't send >2^32)
		header = append(header, 127,
			0, 0, 0, 0,
			byte(l>>24), byte(l>>16), byte(l>>8), byte(l))
	}
	if _, err := w.buf.Write(header); err != nil {
		return err
	}
	if _, err := w.buf.Write(payload); err != nil {
		return err
	}
	return w.buf.Flush()
}

func (w *wsConn) WritePing() error {
	w.mu.Lock()
	defer w.mu.Unlock()
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

func (w *wsConn) WritePong(p []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if p == nil {
		p = []byte{}
	}
	if len(p) > 125 {
		p = p[:125]
	}
	h := []byte{0x8A, byte(len(p))}
	if _, err := w.buf.Write(h); err != nil {
		return err
	}
	if _, err := w.buf.Write(p); err != nil {
		return err
	}
	return w.buf.Flush()
}

// ReadFrame reads a single frame from client (masked as per RFC6455)
// Returns opcode and unmasked payload
func (w *wsConn) ReadFrame() (byte, []byte, error) {
	// Read first two bytes
	h := make([]byte, 2)
	if _, err := io.ReadFull(w.buf, h); err != nil {
		return 0, nil, err
	}
	fin := (h[0] & 0x80) != 0
	rsv1 := (h[0] & 0x40) != 0
	opcode := h[0] & 0x0F
	mask := (h[1] & 0x80) != 0
	if !mask {
		// client frames must be masked
		return 0, nil, errors.New("client frame not masked")
	}
	length := int(h[1] & 0x7F)
	switch length {
	case 126:
		// 16-bit length
		b := make([]byte, 2)
		if _, err := io.ReadFull(w.buf, b); err != nil {
			return 0, nil, err
		}
		length = int(b[0])<<8 | int(b[1])
	case 127:
		b := make([]byte, 8)
		if _, err := io.ReadFull(w.buf, b); err != nil {
			return 0, nil, err
		}
		// we only support up to 2^31-1
		length = int(b[4])<<24 | int(b[5])<<16 | int(b[6])<<8 | int(b[7])
	}
	// Masking key
	key := make([]byte, 4)
	if _, err := io.ReadFull(w.buf, key); err != nil {
		return 0, nil, err
	}
	payload := make([]byte, length)
	if length > 0 {
		if _, err := io.ReadFull(w.buf, payload); err != nil {
			return 0, nil, err
		}
		for i := 0; i < length; i++ {
			payload[i] ^= key[i%4]
		}
	}
	// Control frames must not be fragmented; data frames could be fragmented but we do not support fragmentation in this minimal impl
	if !fin {
		return 0, nil, errors.New("fragmented frames not supported")
	}
	// If RSV1 set and permessage-deflate negotiated, decompress payload
	if rsv1 {
		if !w.deflate {
			return 0, nil, errors.New("compressed frame received without negotiation")
		}
		fr := flate.NewReader(bytes.NewReader(payload))
		dec, err := io.ReadAll(fr)
		_ = fr.Close()
		if err != nil {
			return 0, nil, err
		}
		payload = dec
	}
	return opcode, payload, nil
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

// hasExtension reports whether Sec-WebSocket-Extensions contains the named
// extension, ignoring any parameters (e.g., "permessage-deflate; client_max_window_bits").
func hasExtension(headerVal, name string) bool {
	if headerVal == "" {
		return false
	}
	name = strings.ToLower(strings.TrimSpace(name))
	for _, part := range strings.Split(headerVal, ",") {
		p := strings.ToLower(strings.TrimSpace(part))
		if p == "" {
			continue
		}
		base := p
		if i := strings.IndexByte(p, ';'); i >= 0 {
			base = strings.TrimSpace(p[:i])
		}
		if base == name {
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
	// Temporarily disable permessage-deflate negotiation until full client decompression is robust
	extLine := ""
	negDeflate := false
	resp := fmt.Sprintf("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n%s\r\n", accept, extLine)
	if _, err := rw.WriteString(resp); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return &wsConn{c: conn, buf: rw, deflate: negDeflate}, nil
}

// FlightsWSHandler streams diffs of flights. It sends initial snapshot and then only changes
// upon new ingests from OpenSky. Implements simple backpressure: waits for client ACK before
// sending next diff and skips while client reports bufferedAmount > 1MB.
func FlightsWSHandler(w http.ResponseWriter, r *http.Request) {
	// Security check: require valid JWT cookie and CSRF token matching query param
	if !security.ValidateJWTFromRequest(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	csrfQ := r.URL.Query().Get("csrf")
	csrfC := security.GetCSRFFromRequest(r)
	if csrfQ == "" || csrfQ != csrfC {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	ws, err := upgradeToWebSocket(w, r)
	if err != nil {
		monitoring.Debugf("ws upgrade error: %v", err)
		return
	}
	registerWS(ws)
	defer func() {
		unregisterWS(ws)
		_ = ws.Close()
	}()
	monitoring.Debugf("ws flights connected remote=%s deflate=%t", r.RemoteAddr, ws.deflate)

	// Telemetry: track latest viewport bbox reported by the client (if any)
	baseCtx := r.Context()
	tracer := otel.Tracer("backend/ws")
	var bboxMu sync.RWMutex
	var lastBBox string
	var bboxVals [4]float64 // minLon, minLat, maxLon, maxLat
	var hasBBox bool

	parseBBox := func(s string) (float64, float64, float64, float64, bool) {
		parts := strings.Split(s, ",")
		if len(parts) != 4 {
			return 0, 0, 0, 0, false
		}
		minLon, err1 := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
		minLat, err2 := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
		maxLon, err3 := strconv.ParseFloat(strings.TrimSpace(parts[2]), 64)
		maxLat, err4 := strconv.ParseFloat(strings.TrimSpace(parts[3]), 64)
		if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
			return 0, 0, 0, 0, false
		}
		if minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90 {
			return 0, 0, 0, 0, false
		}
		if maxLon <= minLon || maxLat <= minLat {
			return 0, 0, 0, 0, false
		}
		return minLon, minLat, maxLon, maxLat, true
	}

	// message formats
	type trailPoint struct {
		Lon float64 `json:"lon"`
		Lat float64 `json:"lat"`
		// TS omitted to keep payload small; add if needed later
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
	type diffMsg struct {
		Type   string   `json:"type"`
		Seq    int64    `json:"seq"`
		Upsert []item   `json:"upsert,omitempty"`
		Delete []string `json:"delete,omitempty"`
	}
	type ackMsg struct {
		Type     string `json:"type"`
		Seq      int64  `json:"seq"`
		Buffered int64  `json:"buffered,omitempty"`
	}

	// reader loop: handle ping/pong/close and ACKs
	ackCh := make(chan ackMsg, 4)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			op, payload, err := ws.ReadFrame()
			if err != nil {
				monitoring.Debugf("ws flights read error: %v", err)
				return
			}
			switch op := op; op {
			case 0x9: // ping
				monitoring.Debugf("ws flights <= ping len=%d", len(payload))
				_ = ws.WritePong(payload)
			case 0xA: // pong
				monitoring.Debugf("ws flights <= pong len=%d", len(payload))
				// ignore
			case 0x8: // close
				monitoring.Debugf("ws flights <= close")
				return
			case 0x1: // text
				// Handle ACK and VIEWPORT messages
				var any map[string]any
				if err := json.Unmarshal(payload, &any); err == nil {
					typ := strings.ToLower(fmt.Sprint(any["type"]))
					switch typ {
					case "ack":
						seq := int64(0)
						if v, ok := any["seq"]; ok {
							switch t := v.(type) {
							case float64:
								seq = int64(t)
							case string:
								if n, e := strconv.ParseInt(t, 10, 64); e == nil {
									seq = n
								}
							}
						}
						buf := int64(0)
						if v, ok := any["buffered"]; ok {
							switch t := v.(type) {
							case float64:
								buf = int64(t)
							case string:
								if n, e := strconv.ParseInt(t, 10, 64); e == nil {
									buf = n
								}
							}
						}
						if seq > 0 {
							monitoring.Debugf("ws flights <= ack seq=%d buffered=%d", seq, buf)
							select {
							case ackCh <- ackMsg{Type: "ack", Seq: seq, Buffered: buf}:
							default:
							}
						}
					case "viewport":
						bboxStr := strings.TrimSpace(fmt.Sprint(any["bbox"]))
						if bboxStr != "" {
							minLon, minLat, maxLon, maxLat, ok := parseBBox(bboxStr)
							if ok {
								bboxMu.Lock()
								lastBBox = bboxStr
								bboxVals = [4]float64{minLon, minLat, maxLon, maxLat}
								hasBBox = true
								bboxMu.Unlock()
								// Telemetry span for viewport updates
								ctx, sp := tracer.Start(baseCtx, "ws.viewport")
								_ = ctx
								sp.SetAttributes(
									attribute.String("viewport.bbox", bboxStr),
									attribute.Float64("viewport.min_lon", minLon),
									attribute.Float64("viewport.min_lat", minLat),
									attribute.Float64("viewport.max_lon", maxLon),
									attribute.Float64("viewport.max_lat", maxLat),
									attribute.Float64("viewport.width_deg", maxLon-minLon),
									attribute.Float64("viewport.height_deg", maxLat-minLat),
									attribute.Float64("viewport.area_deg2", (maxLon-minLon)*(maxLat-minLat)),
								)
								sp.End()
								monitoring.Debugf("ws flights <= viewport bbox=%s", bboxStr)
							} else {
								monitoring.Debugf("ws flights <= viewport invalid bbox=%s", bboxStr)
							}
						} else {
							monitoring.Debugf("ws flights <= viewport missing bbox")
						}
					default:
						monitoring.Debugf("ws flights <= text type=%s len=%d", typ, len(payload))
					}
				} else {
					monitoring.Debugf("ws flights <= text len=%d", len(payload))
				}
			default:
				// ignore others
			}
		}
	}()

	// helpers to take current snapshot and build diff against previous
	makeCur := func() (map[string]item, []item, error) {
		pts, err := storage.Get().CurrentAll()
		if err != nil {
			return nil, nil, err
		}
		curMap := make(map[string]item, len(pts))
		arr := make([]item, 0, len(pts))
		for _, p := range pts {
			it := item{Icao24: p.Icao24, Callsign: p.Callsign, Lon: p.Lon, Lat: p.Lat, Alt: p.Alt, Track: p.Track, Speed: p.Speed, TS: p.TS}
			key := p.Icao24
			if key == "" {
				key = strings.TrimSpace(strings.ToUpper(p.Callsign))
			}
			if key == "" {
				continue
			}
			curMap[key] = it
			arr = append(arr, it)
		}
		return curMap, arr, nil
	}
	changed := func(a, b item) bool {
		if a.Lon != b.Lon || a.Lat != b.Lat || a.Alt != b.Alt || a.Track != b.Track || a.Speed != b.Speed || a.TS != b.TS || a.Callsign != b.Callsign {
			return true
		}
		return false
	}

	last := make(map[string]item)
	var seq int64
	inflight := false
	bufferHigh := false
	pending := true // send initial snapshot immediately (no server-side bbox)
	lastSend := time.Now()

	// trail limits
	trailLimit := 24
	trailWindow := 45 * time.Minute

	// subscribe to updates
	updates, unsubscribe := UpdatesSubscribe()
	defer unsubscribe()

	// ping ticker
	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()

	// attempt sending if conditions permit
	trySend := func() error {
		if inflight || bufferHigh || !pending {
			return nil
		}
		// Start a span for this diff send
		_, sp := tracer.Start(baseCtx, "ws.diff.send")
		defer sp.End()
		cur, arr, err := makeCur()
		if err != nil {
			sp.SetAttributes(attribute.String("error", err.Error()))
			return err
		}
		// build diff
		up := make([]item, 0, len(arr))
		dl := make([]string, 0)
		if len(last) == 0 {
			up = arr // initial snapshot
		} else {
			for k, v := range cur {
				if ov, ok := last[k]; !ok || changed(ov, v) {
					up = append(up, v)
				}
			}
			for k := range last {
				if _, ok := cur[k]; !ok {
					dl = append(dl, k)
				}
			}
		}
		if len(up) == 0 && len(dl) == 0 {
			pending = false
			last = cur
			sp.SetAttributes(
				attribute.Int("diff.up_count", 0),
				attribute.Int("diff.del_count", 0),
			)
			return nil
		}
		// Attach short trails for upserted flights to restore UX while keeping payload small.
		trailTotal := 0
		for i := range up {
			icao := strings.TrimSpace(up[i].Icao24)
			if icao == "" {
				continue
			}
			pts, err := storage.Get().RecentTrackByICAO(icao, trailLimit, trailWindow)
			if err != nil || len(pts) == 0 {
				continue
			}
			tr := make([]trailPoint, 0, len(pts))
			for _, tp := range pts {
				tr = append(tr, trailPoint{Lon: tp.Lon, Lat: tp.Lat})
			}
			up[i].Trail = tr
			trailTotal += len(tr)
		}
		seq++
		msg := diffMsg{Type: "diff", Seq: seq, Upsert: up, Delete: dl}
		b, _ := json.Marshal(msg)
		if err := ws.WriteText(b); err != nil {
			sp.SetAttributes(
				attribute.Int64("diff.seq", seq),
				attribute.Int("diff.up_count", len(up)),
				attribute.Int("diff.del_count", len(dl)),
				attribute.Int("diff.bytes", len(b)),
				attribute.Int("diff.trails_total", trailTotal),
			)
			// also attach last known viewport if present
			bboxMu.RLock()
			if hasBBox {
				sp.SetAttributes(
					attribute.String("viewport.bbox", lastBBox),
					attribute.Float64("viewport.min_lon", bboxVals[0]),
					attribute.Float64("viewport.min_lat", bboxVals[1]),
					attribute.Float64("viewport.max_lon", bboxVals[2]),
					attribute.Float64("viewport.max_lat", bboxVals[3]),
					attribute.Float64("viewport.width_deg", bboxVals[2]-bboxVals[0]),
					attribute.Float64("viewport.height_deg", bboxVals[3]-bboxVals[1]),
					attribute.Float64("viewport.area_deg2", (bboxVals[2]-bboxVals[0])*(bboxVals[3]-bboxVals[1])),
				)
			}
			bboxMu.RUnlock()
			return err
		}
		lastSend = time.Now()
		monitoring.Debugf("ws flights => diff seq=%d up=%d del=%d bytes=%d trails=%d", seq, len(up), len(dl), len(b), trailTotal)
		inflight = true
		last = cur
		pending = false
		sp.SetAttributes(
			attribute.Int64("diff.seq", seq),
			attribute.Int("diff.up_count", len(up)),
			attribute.Int("diff.del_count", len(dl)),
			attribute.Int("diff.bytes", len(b)),
			attribute.Int("diff.trails_total", trailTotal),
		)
		// also attach last known viewport if present
		bboxMu.RLock()
		if hasBBox {
			sp.SetAttributes(
				attribute.String("viewport.bbox", lastBBox),
				attribute.Float64("viewport.min_lon", bboxVals[0]),
				attribute.Float64("viewport.min_lat", bboxVals[1]),
				attribute.Float64("viewport.max_lon", bboxVals[2]),
				attribute.Float64("viewport.max_lat", bboxVals[3]),
				attribute.Float64("viewport.width_deg", bboxVals[2]-bboxVals[0]),
				attribute.Float64("viewport.height_deg", bboxVals[3]-bboxVals[1]),
				attribute.Float64("viewport.area_deg2", (bboxVals[2]-bboxVals[0])*(bboxVals[3]-bboxVals[1])),
			)
		}
		bboxMu.RUnlock()
		return nil
	}

	// kick initial send
	if err := trySend(); err != nil {
		return
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case <-done:
			return
		case m := <-ackCh:
			if m.Seq == seq {
				inflight = false
				bufferHigh = m.Buffered > 1_000_000 // 1MB
				// if more pending, try send next
				if !bufferHigh {
					if err := trySend(); err != nil {
						return
					}
				}
			}
		case <-updates:
			pending = true
			if err := trySend(); err != nil {
				return
			}
		case <-ping.C:
			if time.Since(lastSend) > 25*time.Second {
				b, _ := json.Marshal(map[string]any{"type": "hb", "ts": time.Now().Unix()})
				if err := ws.WriteText(b); err != nil {
					return
				}
				lastSend = time.Now()
				monitoring.Debugf("ws flights => hb")
			} else {
				_ = ws.WritePing()
				monitoring.Debugf("ws flights => ping")
			}
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
	registerWS(ws)
	defer func() {
		unregisterWS(ws)
		_ = ws.Close()
	}()
	monitoring.Debugf("ws flight connected remote=%s deflate=%t callsign=%s", r.RemoteAddr, ws.deflate, callsign)

	var lastSentTS int64
	lastSend := time.Now()
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
		if err := ws.WriteText(b); err != nil {
			return err
		}
		lastSend = time.Now()
		monitoring.Debugf("ws flight => point bytes=%d ts=%d", len(b), p.TS)
		return nil
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
			if time.Since(lastSend) > 25*time.Second {
				b, _ := json.Marshal(map[string]any{"type": "hb", "ts": time.Now().Unix()})
				if err := ws.WriteText(b); err != nil {
					return
				}
				lastSend = time.Now()
				monitoring.Debugf("ws flight => hb")
			} else {
				_ = ws.WritePing()
				monitoring.Debugf("ws flight => ping")
			}
		}
	}
}

// --- WS connection registry and broadcast ---
var (
	wsClientsMu sync.RWMutex
	wsClients   = make(map[*wsConn]struct{})
)

func registerWS(c *wsConn) {
	wsClientsMu.Lock()
	wsClients[c] = struct{}{}
	wsClientsMu.Unlock()
}

func unregisterWS(c *wsConn) {
	wsClientsMu.Lock()
	delete(wsClients, c)
	wsClientsMu.Unlock()
}

// BroadcastShutdown sends a one-off shutdown notice to all active WS clients.
// The message format is: {"type":"server_shutdown","ts":unix}
func BroadcastShutdown() {
	b, _ := json.Marshal(map[string]any{"type": "server_shutdown", "ts": time.Now().Unix()})
	wsClientsMu.RLock()
	conns := make([]*wsConn, 0, len(wsClients))
	for c := range wsClients {
		conns = append(conns, c)
	}
	wsClientsMu.RUnlock()
	for _, c := range conns {
		_ = c.WriteText(b)
	}
}
