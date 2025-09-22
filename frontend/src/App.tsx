import React, { useEffect, useMemo, useState } from "react";
import "./App.css";
import FlightMap from "./components/FlightMap";
import { startUISpan } from './otel-ui';
import SearchBar from './components/ui/SearchBar';
import NoticeCard from './components/ui/NoticeCard';

const App: React.FC = () => {
  const [callsign, setCallsign] = useState("");
  const [searchToken, setSearchToken] = useState(0);
  const [locateToken, setLocateToken] = useState(0);
  const [notice, setNotice] = useState<{ kind: 'flight' | 'geo' | 'backend-offline' | 'backend-shutdown' | 'backend-online'; msg: string } | null>(null);
  const [submitted, setSubmitted] = useState(false);
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
        setSubmitted(true);
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
        setSubmitted(!!up);
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
    // APM: Search submit span
    try { const { end } = startUISpan('ui.search.submit', { query: up }); end(); } catch {}
    setCallsign(up);
    setNotice(null);
    setSubmitted(true);
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
          <SearchBar
            value={callsign}
            canSearch={canSearch}
            onChange={(raw) => {
              setNotice(null);
              const up = raw.toUpperCase().trim();
              setCallsign(up);
              if (up === '') {
                // Clear selection and URL when input emptied
                setSubmitted(false);
                setURLCallsign(null, false);
              } else {
                setSubmitted(false);
              }
            }}
            onSubmit={() => onSubmit()}
          />
        </div>
        {notice && (notice.kind !== 'flight' || submitted) && (
          <div className="error-panel" role="alert" aria-live="assertive">
            <NoticeCard
              content={{
                title: notice.kind === 'geo' ? 'Location unavailable' :
                       notice.kind === 'backend-offline' ? 'Backend unavailable' :
                       notice.kind === 'backend-shutdown' ? 'Server is shutting down' :
                       notice.kind === 'backend-online' ? 'Server is back online' : 'Flight not found',
                msg: notice.msg,
              }}
              onClose={() => setNotice(null)}
              colors={panelColors}
            />
          </div>
        )}

        {/* Bottom-left controls: layer switcher */}
        <div className="bl-controls">
          <div className="layer-switch">
            <button
              className={`chip ${baseMode === 'osm' ? 'active' : ''}`}
              onClick={() => { try { const { end } = startUISpan('ui.layer.switch', { to: 'osm' }); end(); } catch {}; setBaseMode('osm'); }}
              title="OpenStreetMap"
            >
              <i className="fa-solid fa-map"></i>
              <span>OSM</span>
            </button>
            <button
              className={`chip ${baseMode === 'hyb' ? 'active' : ''}`}
              onClick={() => { try { const { end } = startUISpan('ui.layer.switch', { to: 'hyb' }); end(); } catch {}; setBaseMode('hyb'); }}
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
            try { const { end } = startUISpan('ui.select.flight', { callsign: up || '(clear)' }); end(); } catch {}
            setCallsign(up);
            setNotice(null);
            if (up === '') {
              // Toggle off selection: clear URL query and submitted state
              setSubmitted(false);
              setURLCallsign(null, false);
            } else {
              setSubmitted(true);
              setURLCallsign(up, false);
            }
            setSearchToken((x) => x + 1);
          }}
          onNotFound={(msg) => setNotice({ kind: 'flight', msg })}
          onFound={() => setNotice((n) => (n && n.kind !== 'flight' ? n : null))}
          onGeoError={(msg) => setNotice({ kind: 'geo', msg })}
          onGeoOk={() => setNotice((n) => (n && n.kind === 'geo' ? null : n))}
          onBackendOffline={(msg) => setNotice({ kind: 'backend-offline', msg })}
          onBackendShuttingDown={(msg) => setNotice({ kind: 'backend-shutdown', msg })}
          onBackendOnline={() => {
            setNotice({ kind: 'backend-online', msg: 'Server is back online' });
            window.setTimeout(() => setNotice((n) => (n && n.kind === 'backend-online' ? null : n)), 3000);
          }}
        />


        {/* Bottom-right controls: locate + theme toggle */}
        <div className="br-controls">
          <button className="fab-btn" onClick={() => { try { const { end } = startUISpan('ui.locate'); end(); } catch {}; doLocate(); }} title="Center on my location" aria-label="Center on my location">
            <i className="fa-solid fa-location-crosshairs"></i>
          </button>
          <button className="fab-btn" onClick={() => { try { const next = theme === 'light' ? 'dark' : 'light'; const { end } = startUISpan('ui.theme.toggle', { from: theme, to: next }); end(); } catch {}; toggleTheme(); }} aria-label="Toggle theme" title="Toggle theme">
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