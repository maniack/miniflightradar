package backend

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/maniack/miniflightradar/monitoring"
	"github.com/maniack/miniflightradar/storage"
)

// FlightData is a minimal subset of the OpenSky /api/states/all response used by the ingestor.
type FlightData struct {
	States [][]interface{} `json:"states"`
}

var (
	cacheMu   sync.Mutex
	cacheData *FlightData
	cacheAt   time.Time

	pollInterval = 10 * time.Second

	// HTTP client/proxy configuration
	proxyOverride string
	clientMu      sync.Mutex
	httpClient    *http.Client
)

// SetPollInterval sets the polling interval for OpenSky ingestor (defaults to 10s).
func SetPollInterval(d time.Duration) {
	if d > 0 {
		pollInterval = d
	}
}

// GetPollInterval returns current polling interval.
func GetPollInterval() time.Duration { return pollInterval }

// SetProxy sets a CLI-provided proxy URL (overrides environment). Empty disables override.
func SetProxy(p string) {
	clientMu.Lock()
	defer clientMu.Unlock()
	proxyOverride = strings.TrimSpace(p)
	// reset client to rebuild with new proxy settings on next use
	httpClient = nil
}

// noProxyMatch reports whether host should bypass proxy according to NO_PROXY/no_proxy env.
func noProxyMatch(host string) bool {
	if host == "" {
		return false
	}
	noProxy := os.Getenv("NO_PROXY")
	if noProxy == "" {
		noProxy = os.Getenv("no_proxy")
	}
	if noProxy == "" {
		return false
	}
	host = strings.ToLower(host)
	for _, token := range strings.Split(noProxy, ",") {
		t := strings.ToLower(strings.TrimSpace(token))
		if t == "" {
			continue
		}
		if t == "*" {
			return true
		}
		// strip port in token if any
		if h, _, err := net.SplitHostPort(t); err == nil {
			t = h
		}
		// strip port from host too
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		// leading dot means suffix match
		if strings.HasPrefix(t, ".") {
			if strings.HasSuffix(host, t) || host == strings.TrimPrefix(t, ".") {
				return true
			}
			continue
		}
		// exact or subdomain match
		if host == t || strings.HasSuffix(host, "."+t) {
			return true
		}
	}
	return false
}

// buildHTTPClient builds (once) an HTTP client honoring CLI proxy override and environment proxies.
func buildHTTPClient(target string) *http.Client {
	clientMu.Lock()
	defer clientMu.Unlock()
	if httpClient != nil {
		return httpClient
	}

	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	tr := &http.Transport{
		Proxy:               nil,
		DialContext:         dialer.DialContext,
		ForceAttemptHTTP2:   true,
		TLSHandshakeTimeout: 10 * time.Second,
	}

	source := "none"
	mode := "direct"
	bypass := false

	// Determine target host
	thost := ""
	if u, err := url.Parse(target); err == nil {
		thost = u.Hostname()
	}

	if proxyOverride != "" {
		source = "cli"
		purl, err := url.Parse(proxyOverride)
		if err == nil && purl.Host != "" {
			bypass = noProxyMatch(thost)
			if !bypass {
				mode = strings.ToLower(purl.Scheme)
				fixed := purl
				tr.Proxy = func(req *http.Request) (*url.URL, error) {
					if noProxyMatch(req.URL.Hostname()) {
						return nil, nil
					}
					return fixed, nil
				}
			}
		}
	} else {
		// Environment (honors http_proxy/https_proxy/all_proxy/no_proxy)
		source = "env"
		tr.Proxy = http.ProxyFromEnvironment
		if req, _ := http.NewRequest("GET", target, nil); req != nil {
			if purl, _ := http.ProxyFromEnvironment(req); purl != nil {
				mode = strings.ToLower(purl.Scheme)
			}
		}
	}

	httpClient = &http.Client{Transport: tr, Timeout: 15 * time.Second}
	monitoring.Debugf("http_client configured source=%s mode=%s bypass=%t", source, mode, bypass)
	return httpClient
}

// RateLimitError indicates API rate limiting with suggested retry delay.
type RateLimitError struct {
	Status     int
	RetryAfter time.Duration
}

func (e *RateLimitError) Error() string {
	return fmt.Sprintf("rate limited: status=%d retry_after=%s", e.Status, e.RetryAfter)
}

func parseRetryAfter(v string) time.Duration {
	if v == "" {
		return 0
	}
	// seconds
	if secs, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
		return time.Duration(secs) * time.Second
	}
	// HTTP-date
	if t, err := http.ParseTime(v); err == nil {
		d := time.Until(t)
		if d < 0 {
			return 0
		}
		return d
	}
	return 0
}

// FetchOpenSkyData calls OpenSky /api/states/all and returns parsed states.
// If environment variables OPENSKY_USER and OPENSKY_PASS are set, it uses Basic Auth.
func FetchOpenSkyData() (*FlightData, error) {
	url := "https://opensky-network.org/api/states/all"
	client := buildHTTPClient(url)

	// Auth for faster quota if available; TTL driven by configured poll interval
	u, p := os.Getenv("OPENSKY_USER"), os.Getenv("OPENSKY_PASS")
	auth := u != "" && p != ""
	ttl := GetPollInterval()
	if ttl <= 0 {
		ttl = 10 * time.Second
	}

	// Serve from cache if fresh
	cacheMu.Lock()
	if cacheData != nil && time.Since(cacheAt) < ttl {
		age := time.Since(cacheAt)
		cacheMu.Unlock()
		monitoring.Debugf("opensky cache hit age=%s ttl=%s states=%d", age, ttl, len(cacheData.States))
		return cacheData, nil
	}
	cacheMu.Unlock()

	start := time.Now()
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	if auth {
		req.SetBasicAuth(u, p)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 5<<20)) // limit 5MB
	dur := time.Since(start)
	monitoring.Debugf("opensky request url=%s status=%d duration=%s body_len=%d", url, resp.StatusCode, dur, len(body))
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable {
		ra := parseRetryAfter(resp.Header.Get("Retry-After"))
		if ra <= 0 {
			ra = 30 * time.Second
		}
		return nil, &RateLimitError{Status: resp.StatusCode, RetryAfter: ra}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("opensky status %d", resp.StatusCode)
	}
	var data FlightData
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, err
	}
	monitoring.Debugf("opensky states count=%d", len(data.States))
	// Update cache
	cacheMu.Lock()
	cacheData = &data
	cacheAt = time.Now()
	cacheMu.Unlock()
	return &data, nil
}

// IngestLoop periodically fetches from OpenSky and stores into BuntDB.
func IngestLoop(stop <-chan struct{}) {
	fetchOnce := func() (nextSleep time.Duration) {
		data, err := FetchOpenSkyData()
		if err != nil {
			if rl, ok := err.(*RateLimitError); ok {
				// Respect server-provided Retry-After but never less than our polling interval
				delay := rl.RetryAfter
				min := GetPollInterval()
				if min <= 0 {
					min = 10 * time.Second
				}
				if delay < min {
					delay = min
				}
				monitoring.Debugf("ingestor rate-limited status=%d retry_after=%s applied_backoff=%s", rl.Status, rl.RetryAfter, delay)
				// Extend TTL for current positions so markers don't disappear while backing off
				if s := storage.Get(); s != nil {
					buf := 5 * time.Second
					_ = s.TouchNow(delay + buf)
				}
				return delay
			}
			monitoring.Debugf("ingestor fetch error: %v", err)
			// On transient error, keep current positions visible until next poll attempt
			if s := storage.Get(); s != nil {
				d := GetPollInterval()
				if d <= 0 {
					d = 10 * time.Second
				}
				_ = s.TouchNow(d + 5*time.Second)
			}
			// On error, try again after normal interval
			d := GetPollInterval()
			if d <= 0 {
				d = 10 * time.Second
			}
			return d
		}
		if data != nil {
			_ = storage.Get().UpsertStates(data.States)
			monitoring.Debugf("ingestor upserted states=%d", len(data.States))
		}
		d := GetPollInterval()
		if d <= 0 {
			d = 10 * time.Second
		}
		return d
	}

	// First fetch immediately to reduce startup latency
	sleep := fetchOnce()
	for {
		select {
		case <-stop:
			return
		case <-time.After(sleep):
			sleep = fetchOnce()
		}
	}
}

func normalizeCallsign(s string) string {
	return strings.ToUpper(strings.TrimSpace(s))
}

// FlightHandler returns latest sample for callsign from storage (OpenSky-compatible shape)
func FlightHandler(w http.ResponseWriter, r *http.Request) {
	callsignRaw := r.URL.Query().Get("callsign")
	if strings.TrimSpace(callsignRaw) == "" {
		http.Error(w, "callsign is required", http.StatusBadRequest)
		monitoring.FlightErrors.WithLabelValues("unknown").Inc()
		monitoring.LastStatus.WithLabelValues("unknown").Set(400.0)
		return
	}
	callsign := normalizeCallsign(callsignRaw)

	p, err := storage.Get().LatestByCallsign(callsign)
	if err != nil || p == nil {
		monitoring.Debugf("flight latest not found callsign=%s err=%v", callsign, err)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([][]interface{}{})
		return
	}

	// Return OpenSky-compatible "states" array with just one entry
	row := make([]interface{}, 17)
	row[0] = p.Icao24
	row[1] = p.Callsign
	row[4] = p.TS
	row[5] = p.Lon
	row[6] = p.Lat
	if p.Speed != 0 {
		row[9] = p.Speed // velocity in m/s per OpenSky schema
	}
	if p.Track != 0 {
		row[10] = p.Track
	}
	if p.Alt != 0 {
		row[13] = p.Alt
	}
	filtered := [][]interface{}{row}
	monitoring.UpdateAircraftCount(callsign, len(filtered))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(filtered)
}

// FlightsInBBoxHandler returns current positions within bbox (minLon,minLat,maxLon,maxLat).
// It validates inputs to avoid pathological requests and responds with 400 on invalid parameters.
func FlightsInBBoxHandler(w http.ResponseWriter, r *http.Request) {
	bbox := r.URL.Query().Get("bbox")
	parts := strings.Split(bbox, ",")
	if len(parts) != 4 {
		http.Error(w, "bbox is required as minLon,minLat,maxLon,maxLat", http.StatusBadRequest)
		return
	}
	parse := func(s string) (float64, bool) {
		v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
		if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
			return 0, false
		}
		return v, true
	}
	minLon, ok1 := parse(parts[0])
	minLat, ok2 := parse(parts[1])
	maxLon, ok3 := parse(parts[2])
	maxLat, ok4 := parse(parts[3])
	if !(ok1 && ok2 && ok3 && ok4) {
		http.Error(w, "invalid bbox coordinates", http.StatusBadRequest)
		return
	}
	// Clamp to valid ranges
	if minLon < -180 {
		minLon = -180
	}
	if maxLon > 180 {
		maxLon = 180
	}
	if minLat < -90 {
		minLat = -90
	}
	if maxLat > 90 {
		maxLat = 90
	}
	if maxLon <= minLon || maxLat <= minLat {
		http.Error(w, "invalid bbox order", http.StatusBadRequest)
		return
	}
	pts, err := storage.Get().CurrentInBBox(minLon, minLat, maxLon, maxLat)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(pts)
}

// TrackHandler returns the current flight segment track for the given callsign.
// It avoids merging separate flights under the same callsign by trimming history
// to the most recent continuous segment for the (icao24 + callsign) pair.
func TrackHandler(w http.ResponseWriter, r *http.Request) {
	callsignRaw := r.URL.Query().Get("callsign")
	if strings.TrimSpace(callsignRaw) == "" {
		http.Error(w, "callsign is required", http.StatusBadRequest)
		return
	}
	callsign := normalizeCallsign(callsignRaw)

	pts, icao, err := storage.Get().TrackByCallsign(callsign, 0)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// Filter by exact callsign to avoid mixing with other identifiers
	filtered := make([]storage.Point, 0, len(pts))
	for _, p := range pts {
		if normalizeCallsign(p.Callsign) == callsign {
			filtered = append(filtered, p)
		}
	}
	if len(filtered) == 0 {
		filtered = pts // fallback if callsign not present in history
	}
	// Walk backwards to find the start of the current flight segment.
	// We split on:
	// - long time gap (e.g., > 45 minutes), or
	// - both samples near-stationary on the ground for a while (dt > 5 minutes and ~0 speed, tiny alt change)
	start := 0
	if n := len(filtered); n >= 2 {
		start = 0
		for i := n - 2; i >= 0; i-- {
			dt := filtered[i+1].TS - filtered[i].TS
			if dt > int64(45*time.Minute/time.Second) {
				start = i + 1
				break
			}
			// ground idle split heuristic
			if dt > int64(5*time.Minute/time.Second) {
				sp1 := filtered[i].Speed
				sp2 := filtered[i+1].Speed
				if sp1 <= 1.5 && sp2 <= 1.5 && math.Abs(filtered[i+1].Alt-filtered[i].Alt) < 20 {
					start = i + 1
					break
				}
			}
		}
	}

	resp := struct {
		Callsign string          `json:"callsign"`
		Icao24   string          `json:"icao24"`
		Points   []storage.Point `json:"points"`
	}{
		Callsign: callsign,
		Icao24:   icao,
		Points:   filtered[start:],
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
