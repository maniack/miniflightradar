import React, { useState } from "react";
import FlightMap from "./components/FlightMap";

const App: React.FC = () => {
  const [callsign, setCallsign] = useState("");

  return (
    <div>
      <h1>Mini Flightradar</h1>
      <input
        type="text"
        placeholder="Enter callsign"
        value={callsign}
        onChange={(e) => setCallsign(e.target.value.toUpperCase())}
      />
      <FlightMap callsign={callsign} />
    </div>
  );
};

export default App;