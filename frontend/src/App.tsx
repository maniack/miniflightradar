import React, { useEffect, useMemo, useState } from "react";
import "./App.css";
import FlightMap from "./components/FlightMap";

const App: React.FC = () => {
  const [callsign, setCallsign] = useState("");
  const [searchToken, setSearchToken] = useState(0);
  const [locateToken, setLocateToken] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const stored = localStorage.getItem('theme');
    if (stored === 'light' || stored === 'dark') return stored;
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'dark' : 'light';
  });
  // Map base mode: 'osm' follows theme (light/dark), 'hyb' is hybrid imagery with labels
  const [baseMode, setBaseMode] = useState<'osm' | 'hyb'>(() => {
    const stored = localStorage.getItem('baseMode');
    if (stored === 'hyb') return 'hyb';
    // migrate old 'sat' to 'hyb'
    if (stored === 'sat') return 'hyb';
    return 'osm';
  });

  // Helper to sync callsign with URL query param (use 'q' in URL; remove legacy 'callsign')
  const setURLCallsign = (cs: string | null, replace = false) => {
    try {
      const url = new URL(window.location.href);
      if (cs && cs.trim()) {
        const up = cs.trim().toUpperCase();
        url.searchParams.set('q', up);
        url.searchParams.delete('callsign'); // cleanup legacy param
      } else {
        url.searchParams.delete('q');
        url.searchParams.delete('callsign');
      }
      const href = url.toString();
      if (replace) {
        window.history.replaceState({}, '', href);
      } else {
        window.history.pushState({}, '', href);
      }
    } catch (_) {
      // ignore URL errors
    }
  };

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('baseMode', baseMode);
  }, [baseMode]);

  // On initial load, read from URL (?q preferred, fallback to legacy ?callsign) and auto-trigger search
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const q = url.searchParams.get('q');
      const legacy = url.searchParams.get('callsign');
      const cs = q || legacy;
      if (cs && cs.trim()) {
        const up = cs.trim().toUpperCase();
        setCallsign(up);
        setSearchToken((x) => x + 1);
        // Migrate legacy param to ?q using replaceState (no history entry)
        if (!q && legacy) setURLCallsign(up, true);
      }
    } catch (_) {
      // noop
    }
  }, []);

  // React to browser back/forward navigation
  useEffect(() => {
    const handler = () => {
      try {
        const url = new URL(window.location.href);
        const q = url.searchParams.get('q');
        const legacy = url.searchParams.get('callsign');
        const cs = q || legacy || '';
        const up = cs ? cs.trim().toUpperCase() : '';
        setCallsign(up);
        setSearchToken((x) => x + 1);
      } catch (_) {
        // noop
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  const canSearch = useMemo(() => callsign.trim().length > 0, [callsign]);

  const panelColors = useMemo(() => {
    if (theme === 'dark') {
      return { bg: '#0b1220cc', fg: '#e5e7eb', border: '#1f2937' };
    }
    return { bg: '#ffffffcc', fg: '#111827', border: '#d1d5db' };
  }, [theme]);

  const onSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!canSearch) return;
    const up = callsign.trim().toUpperCase();
    setCallsign(up);
    setErrorMsg(null);
    setSearchToken((x) => x + 1);
    setURLCallsign(up, false);
  };

  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));
  const doLocate = () => setLocateToken((x) => x + 1);

  return (
    <div className="app">
      <div className="map-wrap">
        {/* Top controls: search form only */}
        <div className="controls">
          <form onSubmit={onSubmit} style={{display:'flex',alignItems:'center',gap:8}}>
            <div className="field">
              <span className="label">Flight #</span>
              <input
                className="input"
                type="text"
                placeholder="e.g. AAL100"
                value={callsign}
                onChange={(e) => { setErrorMsg(null); setCallsign(e.target.value.trim().toUpperCase()); }}
              />
            </div>
            <button className="button search-btn" type="submit" disabled={!canSearch} aria-label="Search">
              <i className="fa-solid fa-magnifying-glass"></i>
              <span className="btn-text">Search</span>
            </button>
          </form>
        </div>

        {/* Bottom-left controls: layer switcher */}
        <div className="bl-controls">
          <div className="layer-switch">
            <button
              className={`chip ${baseMode === 'osm' ? 'active' : ''}`}
              onClick={() => setBaseMode('osm')}
              title="OpenStreetMap"
            >
              <i className="fa-solid fa-map"></i>
              <span>OSM</span>
            </button>
            <button
              className={`chip ${baseMode === 'hyb' ? 'active' : ''}`}
              onClick={() => setBaseMode('hyb')}
              title="Hybrid (Imagery + Labels)"
            >
              <i className="fa-solid fa-layer-group"></i>
              <span>Hybrid</span>
            </button>
          </div>
        </div>

        {/* Map component */}
        <FlightMap
          callsign={callsign}
          searchToken={searchToken}
          theme={theme}
          baseMode={baseMode}
          locateToken={locateToken}
          onSelectCallsign={(cs) => {
            const up = (cs || '').toString().trim().toUpperCase();
            setCallsign(up);
            setErrorMsg(null);
            setSearchToken((x) => x + 1);
            setURLCallsign(up, false);
          }}
          onNotFound={(msg) => setErrorMsg(msg)}
          onFound={() => setErrorMsg(null)}
        />

        {errorMsg && (
          <div role="alert" aria-live="assertive" style={{ position: 'absolute', inset: 0, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: 24, zIndex: 1000, pointerEvents: 'none' }}>
            <div style={{ background: panelColors.bg, color: panelColors.fg, border: `1px solid ${panelColors.border}`, borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.35)', maxWidth: 520, width: 'min(92%, 520px)', padding: '12px 14px', pointerEvents: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <i className="fa-solid fa-triangle-exclamation"></i>
                  <strong>Flight not found</strong>
                </div>
                <button onClick={() => setErrorMsg(null)} aria-label="Close" title="Close" style={{ background: 'transparent', border: 'none', color: panelColors.fg, fontSize: 18, lineHeight: 1, cursor: 'pointer' }}>×</button>
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.45 }}>{errorMsg}</div>
            </div>
          </div>
        )}

        {/* Bottom-right controls: locate + theme toggle */}
        <div className="br-controls">
          <button className="fab-btn" onClick={doLocate} title="Center on my location" aria-label="Center on my location">
            <i className="fa-solid fa-location-crosshairs"></i>
          </button>
          <button className="fab-btn" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
            {theme === 'light' ? <i className="fa-solid fa-moon"></i> : <i className="fa-solid fa-sun"></i>}
          </button>
        </div>

        {/* License / attribution */}
        <div className="info-bar" aria-label="Attribution">
          <small>
            Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors ·
            Flight data via <a href="https://opensky-network.org" target="_blank" rel="noreferrer">OpenSky Network</a>
          </small>
        </div>
      </div>
    </div>
  );
};

export default App;