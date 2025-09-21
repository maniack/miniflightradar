package storage

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tidwall/buntdb"
)

// Point represents a single aircraft position sample.
// JSON kept compact for network payloads.
type Point struct {
	Icao24   string  `json:"icao24"`
	Callsign string  `json:"callsign"`
	Lon      float64 `json:"lon"`
	Lat      float64 `json:"lat"`
	Alt      float64 `json:"alt,omitempty"`
	Track    float64 `json:"track,omitempty"`
	Speed    float64 `json:"speed,omitempty"` // velocity (m/s) from OpenSky, if available
	TS       int64   `json:"ts"`              // unix seconds
}

type Store struct {
	db        *buntdb.DB
	retention time.Duration
	nowTTL    time.Duration
}

// TouchNow extends the TTL of all current-position keys (now:*) to the provided duration.
// It keeps the existing values intact while refreshing their expiration.
// If ttl <= 0, the store's default nowTTL is used.
func (s *Store) TouchNow(ttl time.Duration) error {
	if s == nil || s.db == nil {
		return nil
	}
	if ttl <= 0 {
		ttl = s.nowTTL
	}
	return s.db.Update(func(tx *buntdb.Tx) error {
		keys := make([]string, 0, 1024)
		_ = tx.AscendKeys("now:*", func(key, val string) bool {
			keys = append(keys, key)
			return true
		})
		for _, k := range keys {
			if v, err := tx.Get(k); err == nil {
				_, _, _ = tx.Set(k, v, &buntdb.SetOptions{Expires: true, TTL: ttl})
			}
		}
		return nil
	})
}

var store *Store

// Open opens a persistent BuntDB file on disk and configures retention.
// DB file: ./data/flight.buntdb (directory will be created if missing).
func Open(retention time.Duration) (*Store, error) {
	if retention <= 0 {
		retention = 7 * 24 * time.Hour
	}
	// Ensure data directory exists
	dataDir := filepath.Join(".", "data")
	_ = os.MkdirAll(dataDir, 0o755)
	path := filepath.Join(dataDir, "flight.buntdb")

	db, err := buntdb.Open(path)
	if err != nil {
		return nil, err
	}
	store = &Store{db: db, retention: retention, nowTTL: 60 * time.Second}
	// Rebuild ephemeral "now:*" keys from persisted historical data on startup
	_ = store.RebuildNow()
	return store, nil
}

func Get() *Store { return store }

// RebuildNow scans historical position keys (pos:ICAO:TS) and rebuilds ephemeral
// now:* and callsign mapping keys at startup so the app has immediate data
// after restart, even before the ingestor runs again.
func (s *Store) RebuildNow() error {
	if s == nil || s.db == nil {
		return nil
	}
	latest := map[string]string{}
	// Collect latest value per ICAO (keys are lexicographically ordered; timestamps are zero-padded)
	if err := s.db.View(func(tx *buntdb.Tx) error {
		_ = tx.AscendKeys("pos:*", func(key, val string) bool {
			if len(key) <= 5 {
				return true
			}
			// key format: pos:{icao}:{ts}
			rest := key[4:]
			sep := strings.IndexByte(rest, ':')
			if sep <= 0 {
				return true
			}
			icao := rest[:sep]
			latest[icao] = val // last assignment wins (ascending order by TS)
			return true
		})
		return nil
	}); err != nil {
		return err
	}
	if len(latest) == 0 {
		return nil
	}
	return s.db.Update(func(tx *buntdb.Tx) error {
		for icao, val := range latest {
			// Restore now: key with short TTL
			_, _, _ = tx.Set("now:"+icao, val, &buntdb.SetOptions{Expires: true, TTL: s.nowTTL})
			// Restore callsign mapping if present
			var p Point
			if json.Unmarshal([]byte(val), &p) == nil && p.Callsign != "" {
				cs := normalizeCallsign(p.Callsign)
				_, _, _ = tx.Set("map:cs:"+cs, icao, &buntdb.SetOptions{Expires: true, TTL: s.retention})
			}
		}
		return nil
	})
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

// UpsertStates stores many OpenSky states. Each state is [][]interface{}
// fields used: 0:icao24, 1:callsign, 3:time_position, 4:last_contact, 5:lon, 6:lat
func (s *Store) UpsertStates(states [][]interface{}) error {
	if s == nil {
		return errors.New("store not initialized")
	}
	return s.db.Update(func(tx *buntdb.Tx) error {
		for _, st := range states {
			if len(st) < 7 {
				continue
			}
			icao, _ := st[0].(string)
			icao = normalizeICAO(icao)
			if icao == "" {
				continue
			}
			callsign, _ := st[1].(string)
			callsign = normalizeCallsign(callsign)
			lon, lok := toFloat(st[5])
			lat, aok := toFloat(st[6])
			if !lok || !aok || math.IsNaN(lon) || math.IsNaN(lat) {
				continue
			}
			// Clamp coordinates to valid ranges
			lon = clamp(lon, -180, 180)
			lat = clamp(lat, -90, 90)
			var ts int64
			if v, ok := toInt64(st[4]); ok && v > 0 {
				ts = v
			} else if v, ok := toInt64(st[3]); ok {
				ts = v
			}
			if ts <= 0 {
				ts = time.Now().Unix()
			}

			var alt float64
			if v, ok := toFloat(st[13]); ok {
				alt = v
			} else if v, ok := toFloat(st[7]); ok {
				alt = v
			}
			if math.IsNaN(alt) || math.IsInf(alt, 0) || alt < 0 {
				alt = 0
			}
			var track float64
			if v, ok := toFloat(st[10]); ok {
				track = normAngle360(v)
			}
			var speed float64
			if v, ok := toFloat(st[9]); ok {
				speed = v // m/s per OpenSky
				if math.IsNaN(speed) || math.IsInf(speed, 0) || speed < 0 {
					speed = 0
				}
			}
			p := Point{Icao24: icao, Callsign: callsign, Lon: lon, Lat: lat, Alt: alt, Track: track, Speed: speed, TS: ts}
			b, _ := json.Marshal(p)

			keyPos := fmt.Sprintf("pos:%s:%010d", icao, ts)
			_, _, _ = tx.Set(keyPos, string(b), &buntdb.SetOptions{Expires: true, TTL: s.retention})

			keyNow := fmt.Sprintf("now:%s", icao)
			_, _, _ = tx.Set(keyNow, string(b), &buntdb.SetOptions{Expires: true, TTL: s.nowTTL})

			if callsign != "" {
				keyMap := fmt.Sprintf("map:cs:%s", callsign)
				_, _, _ = tx.Set(keyMap, icao, &buntdb.SetOptions{Expires: true, TTL: s.retention})
				// Also map alternate airline code form (IATA<->ICAO) if available
				if alt := convertCallsignAlternate(callsign); alt != "" {
					keyMapAlt := fmt.Sprintf("map:cs:%s", alt)
					_, _, _ = tx.Set(keyMapAlt, icao, &buntdb.SetOptions{Expires: true, TTL: s.retention})
				}
			}
		}
		return nil
	})
}

// LatestByCallsign returns the latest sample for callsign (if mapped) or nil.
func (s *Store) LatestByCallsign(callsign string) (*Point, error) {
	if s == nil {
		return nil, errors.New("store not initialized")
	}
	callsign = normalizeCallsign(callsign)
	var icao string
	err := s.db.View(func(tx *buntdb.Tx) error {
		v, err := tx.Get("map:cs:" + callsign)
		if err != nil {
			return err
		}
		icao = v
		return nil
	})
	if err != nil {
		// Try alternate airline code form (IATA<->ICAO)
		if alt := convertCallsignAlternate(callsign); alt != "" {
			_ = s.db.View(func(tx *buntdb.Tx) error {
				v, e := tx.Get("map:cs:" + alt)
				if e == nil {
					icao = v
					return nil
				}
				return e
			})
			if icao == "" {
				return nil, err
			}
		} else {
			return nil, err
		}
	}
	var out *Point
	s.db.View(func(tx *buntdb.Tx) error {
		v, err := tx.Get("now:" + icao)
		if err != nil {
			return err
		}
		var p Point
		if json.Unmarshal([]byte(v), &p) == nil {
			out = &p
		}
		return nil
	})
	return out, nil
}

// TrackByCallsign returns all stored points (ascending time) for given callsign.
func (s *Store) TrackByCallsign(callsign string, limit int) ([]Point, string, error) {
	if s == nil {
		return nil, "", errors.New("store not initialized")
	}
	callsign = normalizeCallsign(callsign)
	var icao string
	err := s.db.View(func(tx *buntdb.Tx) error {
		v, err := tx.Get("map:cs:" + callsign)
		if err != nil {
			return err
		}
		icao = v
		return nil
	})
	if err != nil {
		// Try alternate airline code form (IATA<->ICAO)
		if alt := convertCallsignAlternate(callsign); alt != "" {
			_ = s.db.View(func(tx *buntdb.Tx) error {
				v, e := tx.Get("map:cs:" + alt)
				if e == nil {
					icao = v
					return nil
				}
				return e
			})
			if icao == "" {
				return nil, "", err
			}
		} else {
			return nil, "", err
		}
	}
	pts := make([]Point, 0, 256)
	s.db.View(func(tx *buntdb.Tx) error {
		prefix := fmt.Sprintf("pos:%s:", icao)
		_ = tx.AscendKeys(prefix+"*", func(key, val string) bool {
			var p Point
			if json.Unmarshal([]byte(val), &p) == nil {
				pts = append(pts, p)
				if limit > 0 && len(pts) >= limit {
					return false
				}
			}
			return true
		})
		return nil
	})
	return pts, icao, nil
}

// CurrentInBBox returns latest non-landed points inside [minLon,minLat,maxLon,maxLat].
func (s *Store) CurrentInBBox(minLon, minLat, maxLon, maxLat float64) ([]Point, error) {
	if s == nil {
		return nil, errors.New("store not initialized")
	}
	pts := []Point{}
	// Collect current points within bbox
	_ = s.db.View(func(tx *buntdb.Tx) error {
		_ = tx.AscendKeys("now:*", func(key, val string) bool {
			var p Point
			if json.Unmarshal([]byte(val), &p) == nil {
				if p.Lon >= minLon && p.Lon <= maxLon && p.Lat >= minLat && p.Lat <= maxLat {
					pts = append(pts, p)
				}
			}
			return true
		})
		return nil
	})
	// Filter out flights that have likely landed using historical heuristic.
	// Do not hide aircraft solely based on current speed value, as many samples may lack speed or report it as 0.
	out := make([]Point, 0, len(pts))
	for _, p := range pts {
		landed, _ := s.IsLandedWithin(p.Icao24, 10*time.Minute)
		if landed {
			continue
		}
		out = append(out, p)
	}
	return out, nil
}

// IsLandedWithin reports whether the aircraft for given ICAO has been effectively stationary
// (on the ground) within the provided time window. The heuristic checks that over the window:
// - time span covers at least half the window,
// - geographic displacement is small,
// - last recorded speed is near zero,
// - altitude change is minimal.
func (s *Store) IsLandedWithin(icao string, window time.Duration) (bool, error) {
	if s == nil {
		return false, errors.New("store not initialized")
	}
	if window <= 0 {
		window = 15 * time.Minute
	}
	var newest *Point
	var oldest *Point
	err := s.db.View(func(tx *buntdb.Tx) error {
		prefix := fmt.Sprintf("pos:%s:", icao)
		cutoff := time.Now().Add(-window).Unix()
		count := 0
		_ = tx.DescendKeys(prefix+"*", func(key, val string) bool {
			var p Point
			if json.Unmarshal([]byte(val), &p) != nil {
				return true
			}
			if newest == nil {
				newest = &p
			}
			oldest = &p
			count++
			if p.TS < cutoff || count >= 10 {
				return false
			}
			return true
		})
		return nil
	})
	if err != nil {
		return false, err
	}
	if newest == nil || oldest == nil {
		return false, nil
	}
	span := newest.TS - oldest.TS
	if span < int64((window/time.Second)/2) {
		// Not enough history to decide
		return false, nil
	}
	altDiff := math.Abs(newest.Alt - oldest.Alt)
	dist := haversineMeters(oldest.Lat, oldest.Lon, newest.Lat, newest.Lon)
	// consider landed if last speed ~0, tiny movement and nearly no alt change
	if newest.Speed <= 1.5 && dist < 500 && altDiff < 10 {
		return true, nil
	}
	return false, nil
}

// haversineMeters returns great-circle distance between two lat/lon points in meters.
func haversineMeters(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371000.0 // meters
	toRad := func(d float64) float64 { return d * math.Pi / 180 }
	dLat := toRad(lat2 - lat1)
	dLon := toRad(lon2 - lon1)
	la1 := toRad(lat1)
	la2 := toRad(lat2)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Sin(dLon/2)*math.Sin(dLon/2)*math.Cos(la1)*math.Cos(la2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return R * c
}

func normalizeCallsign(s string) string { return strings.ToUpper(strings.TrimSpace(s)) }

func toFloat(v interface{}) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case float32:
		return float64(t), true
	case json.Number:
		f, err := t.Float64()
		if err == nil {
			return f, true
		}
	}
	return 0, false
}

func toInt64(v interface{}) (int64, bool) {
	switch t := v.(type) {
	case int64:
		return t, true
	case int:
		return int64(t), true
	case float64:
		return int64(t), true
	case json.Number:
		i, err := t.Int64()
		if err == nil {
			return i, true
		}
	}
	return 0, false
}

// normalizeICAO converts ICAO24 hex to lower-case and trims spaces.
func normalizeICAO(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// clamp limits v into [min,max]; NaN/Inf return 0.
func clamp(v, min, max float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

// normAngle360 normalizes angle to [0,360).
func normAngle360(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	r := math.Mod(v, 360)
	if r < 0 {
		r += 360
	}
	if r == 360 {
		r = 0
	}
	return r
}

// --- Airline code mapping and callsign conversion helpers ---

// iataToIcao maps common airline IATA (2-letter) codes to ICAO (3-letter) codes.
// This is a curated subset sufficient for most use cases; extend as needed.
var iataToIcao = map[string]string{
	"AA": "AAL", // American Airlines
	"DL": "DAL", // Delta Air Lines
	"UA": "UAL", // United Airlines
	"AS": "ASA", // Alaska Airlines
	"B6": "JBU", // JetBlue Airways
	"NK": "NKS", // Spirit Airlines
	"F9": "FFT", // Frontier Airlines
	"G4": "AAY", // Allegiant Air
	"WS": "WJA", // WestJet
	"AC": "ACA", // Air Canada
	"AF": "AFR", // Air France
	"KL": "KLM", // KLM Royal Dutch Airlines
	"BA": "BAW", // British Airways
	"LH": "DLH", // Lufthansa
	"LX": "SWR", // SWISS
	"OS": "AUA", // Austrian Airlines
	"SN": "BEL", // Brussels Airlines
	"IB": "IBE", // Iberia
	"VY": "VLG", // Vueling
	"TP": "TAP", // TAP Air Portugal
	"AZ": "ITY", // ITA Airways
	"FR": "RYR", // Ryanair
	"U2": "EZY", // easyJet UK
	"W6": "WZZ", // Wizz Air
	"TK": "THY", // Turkish Airlines
	"EK": "UAE", // Emirates
	"QR": "QTR", // Qatar Airways
	"EY": "ETD", // Etihad Airways
	"FZ": "FDB", // flydubai
	"SU": "AFL", // Aeroflot Russian Airlines
	"S7": "SBI", // S7 Airlines
	"U6": "SVR", // Ural Airlines
	"UT": "UTA", // UTair
	"LO": "LOT", // LOT Polish Airlines
	"SK": "SAS", // Scandinavian Airlines
	"AY": "FIN", // Finnair
	"DY": "NOZ", // Norwegian Air Shuttle
	"BT": "BTI", // airBaltic
	"A3": "AEE", // Aegean Airlines
	"CA": "CCA", // Air China
	"MU": "CES", // China Eastern
	"CZ": "CSN", // China Southern
	"NH": "ANA", // All Nippon Airways
	"JL": "JAL", // Japan Airlines
	"QF": "QFA", // Qantas
	"NZ": "ANZ", // Air New Zealand
	"KE": "KAL", // Korean Air
	"OZ": "AAR", // Asiana Airlines
	"ET": "ETH", // Ethiopian Airlines
	"KQ": "KQA", // Kenya Airways
	"MS": "MSR", // Egyptair
	"SV": "SVA", // Saudia
	"SA": "SAA", // South African Airways
}

var icaoToIata map[string]string

func init() {
	icaoToIata = make(map[string]string, len(iataToIcao))
	for iata, icao := range iataToIcao {
		icaoToIata[icao] = iata
	}
}

// ConvertToIATAForPrefix returns IATA code for an ICAO airline prefix (3 letters), if known.
func ConvertToIATAForPrefix(icao string) string {
	icao = strings.ToUpper(strings.TrimSpace(icao))
	if len(icao) != 3 {
		return ""
	}
	if iata, ok := icaoToIata[icao]; ok {
		return iata
	}
	return ""
}

// ConvertToICAOForPrefix returns ICAO code for an IATA airline prefix (2 letters), if known.
func ConvertToICAOForPrefix(iata string) string {
	iata = strings.ToUpper(strings.TrimSpace(iata))
	if len(iata) != 2 {
		return ""
	}
	if icao, ok := iataToIcao[iata]; ok {
		return icao
	}
	return ""
}

// convertCallsignAlternate returns an alternate callsign form with airline code converted
// between IATA (2-letter) and ICAO (3-letter). If no conversion is possible, returns empty string.
func convertCallsignAlternate(cs string) string {
	cs = normalizeCallsign(cs)
	if cs == "" {
		return ""
	}
	// Extract leading alpha prefix
	i := 0
	for i < len(cs) {
		ch := cs[i]
		if ch < 'A' || ch > 'Z' {
			break
		}
		i++
	}
	if i == 0 {
		return ""
	}
	prefix := cs[:i]
	suffix := cs[i:]
	switch len(prefix) {
	case 2:
		if icao, ok := iataToIcao[prefix]; ok {
			return icao + suffix
		}
	case 3:
		if iata, ok := icaoToIata[prefix]; ok {
			return iata + suffix
		}
	}
	return ""
}
