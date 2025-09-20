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
  searchToken: number;
}

const FlightMap: React.FC<FlightMapProps> = ({ callsign, searchToken }) => {
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
        center: fromLonLat([0, 20]),
        zoom: 2,
      }),
    });

    mapRef.current = map;

    return () => {
      map.setTarget(undefined as unknown as string);
    };
  }, []);

  // Fetch once when user clicks Search
  useEffect(() => {
    const source = vectorSourceRef.current;
    if (!callsign) {
      source.clear();
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`/api/flight?callsign=${encodeURIComponent(callsign)}`);
        if (!resp.ok) return;
        const data = await resp.json();
        if (cancelled) return;

        // Clear existing points
        source.clear();

        let firstCoord: [number, number] | null = null;
        // Add new points
        (data || []).forEach((state: any) => {
          const lat = state?.[6];
          const lon = state?.[5];
          if (typeof lat === "number" && typeof lon === "number") {
            const feature = new Feature({
              geometry: new Point(fromLonLat([lon, lat])),
            });
            if (!firstCoord) firstCoord = [lon, lat];
            source.addFeature(feature);
          }
        });

        // Recenter map on the first point
        if (firstCoord && mapRef.current) {
          const v = mapRef.current.getView();
          v.animate({ center: fromLonLat(firstCoord), zoom: 6, duration: 400 });
        }
      } catch (e) {
        // ignore fetch errors for demo
      }
    })();

    return () => { cancelled = true; };
  }, [callsign, searchToken]);

  return <div id="map" style={{ position: 'absolute', inset: 0 }}></div>;
};

export default FlightMap;