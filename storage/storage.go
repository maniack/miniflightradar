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
	TS       int64   `json:"ts"` // unix seconds
}

type Store struct {
	db        *buntdb.DB
	retention time.Duration
	nowTTL    time.Duration
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
			var track float64
			if v, ok := toFloat(st[10]); ok {
				track = v
			}
			p := Point{Icao24: icao, Callsign: callsign, Lon: lon, Lat: lat, Alt: alt, Track: track, TS: ts}
			b, _ := json.Marshal(p)

			keyPos := fmt.Sprintf("pos:%s:%010d", icao, ts)
			_, _, _ = tx.Set(keyPos, string(b), &buntdb.SetOptions{Expires: true, TTL: s.retention})

			keyNow := fmt.Sprintf("now:%s", icao)
			_, _, _ = tx.Set(keyNow, string(b), &buntdb.SetOptions{Expires: true, TTL: s.nowTTL})

			if callsign != "" {
				keyMap := fmt.Sprintf("map:cs:%s", callsign)
				_, _, _ = tx.Set(keyMap, icao, &buntdb.SetOptions{Expires: true, TTL: s.retention})
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
		return nil, err
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
		return nil, "", err
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

// CurrentInBBox returns latest points inside [minLon,minLat,maxLon,maxLat].
func (s *Store) CurrentInBBox(minLon, minLat, maxLon, maxLat float64) ([]Point, error) {
	if s == nil {
		return nil, errors.New("store not initialized")
	}
	pts := []Point{}
	s.db.View(func(tx *buntdb.Tx) error {
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
	return pts, nil
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
