import React, { useEffect, useMemo, useState } from "react";
import "./App.css";
import FlightMap from "./components/FlightMap";

const App: React.FC = () => {
  const [callsign, setCallsign] = useState("");
  const [searchToken, setSearchToken] = useState(0);
  const [theme, setTheme] = useState<string>(() => localStorage.getItem("theme") || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const canSearch = useMemo(() => callsign.trim().length > 0, [callsign]);

  const onSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!canSearch) return;
    setSearchToken((x) => x + 1);
  };

  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));

  return (
    <div className="app">
      <div className="map-wrap">
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
          <button className="button secondary" onClick={toggleTheme} aria-label="Toggle theme">
            {theme === 'light' ? 'Dark' : 'Light'}
          </button>
        </div>
        <FlightMap callsign={callsign} searchToken={searchToken} />
        <div className="info-bar">Type callsign and press Search</div>
      </div>
    </div>
  );
};

export default App;