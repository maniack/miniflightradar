import React, { useEffect, useRef } from "react";
import "ol/ol.css";
import Map from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import OSM from "ol/source/OSM";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import { fromLonLat } from "ol/proj";

interface FlightMapProps {
  callsign: string;
}

const FlightMap: React.FC<FlightMapProps> = ({ callsign }) => {
  const mapRef = useRef<Map | null>(null);
  const vectorSourceRef = useRef<VectorSource>(new VectorSource());

  // Initialize OpenLayers map once
  useEffect(() => {
    if (mapRef.current) return;

    const map = new Map({
      target: "map",
      layers: [
        new TileLayer({ source: new OSM() }),
        new VectorLayer({ source: vectorSourceRef.current }),
      ],
      view: new View({
        center: fromLonLat([-0.09, 51.505]),
        zoom: 3,
      }),
    });

    mapRef.current = map;

    return () => {
      map.setTarget(undefined as unknown as string);
    };
  }, []);

  // Poll backend and update markers
  useEffect(() => {
    const source = vectorSourceRef.current;
    if (!callsign) {
      source.clear();
      return;
    }

    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const resp = await fetch(`/api/flight?callsign=${encodeURIComponent(callsign)}`);
        if (!resp.ok) return;
        const data = await resp.json();
        if (cancelled) return;

        // Clear existing points
        source.clear();

        // Add new points
        (data || []).forEach((state: any) => {
          const lat = state?.[6];
          const lon = state?.[5];
          if (typeof lat === "number" && typeof lon === "number") {
            const feature = new Feature({
              geometry: new Point(fromLonLat([lon, lat])),
            });
            source.addFeature(feature);
          }
        });
      } catch (e) {
        // ignore fetch errors for demo
      }
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [callsign]);

  return <div id="map" style={{ height: "600px", width: "100%" }}></div>;
};

export default FlightMap;