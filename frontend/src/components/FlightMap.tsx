import React, { useEffect, useRef } from "react";
import "ol/ol.css";
import Map from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import OSM from "ol/source/OSM";
import XYZ from "ol/source/XYZ";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import { fromLonLat } from "ol/proj";

interface FlightMapProps {
  callsign: string;
  searchToken: number;
  theme: 'light' | 'dark';
  baseMode: 'osm' | 'sat';
  // Token to trigger centering on user's current location
  locateToken?: number;
}

const FlightMap: React.FC<FlightMapProps> = ({ callsign, searchToken, theme, baseMode, locateToken = 0 }) => {
  const mapRef = useRef<Map | null>(null);
  const vectorSourceRef = useRef<VectorSource>(new VectorSource());
  const baseOSMLightRef = useRef<TileLayer<any> | null>(null);
  const baseOSMDarkRef = useRef<TileLayer<any> | null>(null);
  const baseSatRef = useRef<TileLayer<any> | null>(null);

  const centerTo = (lon: number, lat: number, zoom = 8) => {
    if (!mapRef.current) return;
    const v = mapRef.current.getView();
    v.animate({ center: fromLonLat([lon, lat]), zoom, duration: 400 });
  };

  const geolocate = () => {
    if (!("geolocation" in navigator)) return;
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          centerTo(longitude, latitude, Math.max(8, mapRef.current?.getView().getZoom() || 8));
        },
        // Ignore errors silently (user may deny permission)
        () => {},
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }
      );
    } catch (_) {
      // noop
    }
  };

  // Initialize OpenLayers map once
  useEffect(() => {
    if (mapRef.current) return;

    const osmLight = new TileLayer({
      source: new OSM(),
      visible: true,
    });

    const osmDark = new TileLayer({
      source: new XYZ({
        url: "https://{a-c}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        attributions: '© OpenStreetMap contributors © CARTO',
        crossOrigin: "anonymous",
      }),
      visible: false,
    });

    const sat = new TileLayer({
      source: new XYZ({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        attributions: '© Esri, Maxar, Earthstar Geographics, and the GIS User Community',
        crossOrigin: "anonymous",
      }),
      visible: false,
    });

    baseOSMLightRef.current = osmLight;
    baseOSMDarkRef.current = osmDark;
    baseSatRef.current = sat;

    const map = new Map({
      target: "map",
      layers: [osmLight, osmDark, sat, new VectorLayer({ source: vectorSourceRef.current })],
      view: new View({
        center: fromLonLat([0, 20]),
        zoom: 2,
      }),
    });

    mapRef.current = map;

    // On first load, try to center on user's location
    geolocate();

    return () => {
      map.setTarget(undefined as unknown as string);
    };
  }, []);

  // Switch base layer according to theme and baseMode
  useEffect(() => {
    const osmLight = baseOSMLightRef.current;
    const osmDark = baseOSMDarkRef.current;
    const sat = baseSatRef.current;
    if (!osmLight || !osmDark || !sat) return;

    if (baseMode === 'sat') {
      osmLight.setVisible(false);
      osmDark.setVisible(false);
      sat.setVisible(true);
    } else {
      // OSM mode follows theme
      sat.setVisible(false);
      if (theme === 'dark') {
        osmLight.setVisible(false);
        osmDark.setVisible(true);
      } else {
        osmLight.setVisible(true);
        osmDark.setVisible(false);
      }
    }
  }, [theme, baseMode]);

  // Recenter to user's location when requested
  useEffect(() => {
    if (!locateToken) return;
    geolocate();
  }, [locateToken]);

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