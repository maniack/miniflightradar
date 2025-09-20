import React, { useEffect, useMemo, useState } from "react";
import "./App.css";
import FlightMap from "./components/FlightMap";

const App: React.FC = () => {
  const [callsign, setCallsign] = useState("");
  const [searchToken, setSearchToken] = useState(0);
  const [locateToken, setLocateToken] = useState(0);
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

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('baseMode', baseMode);
  }, [baseMode]);

  const canSearch = useMemo(() => callsign.trim().length > 0, [callsign]);

  const onSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!canSearch) return;
    setSearchToken((x) => x + 1);
  };

  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));
  const doLocate = () => setLocateToken((x) => x + 1);

  return (
    <div className="app">
      <div className="map-wrap">
        {/* Top controls: search + layer switcher */}
        <div className="controls">
          <form onSubmit={onSubmit} style={{display:'flex',alignItems:'center',gap:8}}>
            <div className="field">
              <span style={{color:'var(--muted)'}}>Callsign</span>
              <input
                className="input"
                type="text"
                placeholder="e.g. AAL100"
                value={callsign}
                onChange={(e) => setCallsign(e.target.value.toUpperCase())}
              />
            </div>
            <button className="button" type="submit" disabled={!canSearch}>Search</button>
          </form>
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
        <FlightMap callsign={callsign} searchToken={searchToken} theme={theme} baseMode={baseMode} locateToken={locateToken} />

        {/* Bottom-right controls: locate + theme toggle */}
        <div className="br-controls">
          <button className="fab-btn" onClick={doLocate} title="Center on my location" aria-label="Center on my location">
            <i className="fa-solid fa-location-crosshairs"></i>
          </button>
          <button className="fab-btn" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
            {theme === 'light' ? <i className="fa-solid fa-moon"></i> : <i className="fa-solid fa-sun"></i>}
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;