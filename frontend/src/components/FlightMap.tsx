import React, { useEffect, useRef } from "react";
import "ol/ol.css";
import OlMap from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import OSM from "ol/source/OSM";
import XYZ from "ol/source/XYZ";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import LineString from "ol/geom/LineString";
import type { Geometry } from "ol/geom";
import { fromLonLat, transformExtent } from "ol/proj";
import Style from "ol/style/Style";
import CircleStyle from "ol/style/Circle";
import Fill from "ol/style/Fill";
import Stroke from "ol/style/Stroke";
import Icon from "ol/style/Icon";
import Overlay from "ol/Overlay";

interface FlightMapProps {
  callsign: string;
  searchToken: number;
  theme: 'light' | 'dark';
  baseMode: 'osm' | 'hyb';
  // Token to trigger centering on user's current location
  locateToken?: number;
  onSelectCallsign?: (callsign: string) => void;
}

const FlightMap: React.FC<FlightMapProps> = ({ callsign, searchToken, theme, baseMode, locateToken = 0, onSelectCallsign }) => {
  const mapRef = useRef<OlMap | null>(null);
  const vectorSourceRef = useRef<VectorSource<Feature<Geometry>>>(new VectorSource<Feature<Geometry>>());
  // Source/layer for tracked flight + its track (on top)
  const flightFeatureRef = useRef<Feature<Point> | null>(null);
  const trackFeatureRef = useRef<Feature<LineString> | null>(null);
  // Source/layer for all flights in viewport (underneath)
  const allSourceRef = useRef<VectorSource<Feature<Geometry>>>(new VectorSource<Feature<Geometry>>());
  const allLayerRef = useRef<VectorLayer<Feature<Geometry>> | null>(null);
  // Index of all-flights features keyed by id (icao24 or callsign)
  const allIndexRef = useRef<Map<string, Feature<Point>>>(new Map());
  const baseOSMLightRef = useRef<TileLayer<any> | null>(null);
  const baseOSMDarkRef = useRef<TileLayer<any> | null>(null);
  const baseHybImageryRef = useRef<TileLayer<any> | null>(null);
  const hybLabelsPlacesRef = useRef<TileLayer<any> | null>(null);
  const hybLabelsTransportRef = useRef<TileLayer<any> | null>(null);
  const vectorLayerRef = useRef<VectorLayer<Feature<Geometry>> | null>(null);
  // Tooltip overlay
  const tooltipElRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<Overlay | null>(null);
  // Keep last known track (degrees) for tracked flight for styling updates
  const lastTrackDegRef = useRef<number>(0);
  // Animation refs for smooth plane movement
  const animFrameRef = useRef<number | null>(null);
  const animStartRef = useRef<number>(0);
  const animFromRef = useRef<[number, number] | null>(null);
  const animToRef = useRef<[number, number] | null>(null);

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

    // Hybrid = Esri World Imagery + reference labels overlays
    const hybImagery = new TileLayer({
      source: new XYZ({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        attributions: '© Esri, Maxar, Earthstar Geographics',
        crossOrigin: "anonymous",
      }),
      visible: false,
    });
    const hybLabelsPlaces = new TileLayer({
      source: new XYZ({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        attributions: '© Esri',
        crossOrigin: "anonymous",
      }),
      visible: false,
    });
    const hybLabelsTransport = new TileLayer({
      source: new XYZ({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
        attributions: '© Esri',
        crossOrigin: "anonymous",
      }),
      visible: false,
    });

    baseOSMLightRef.current = osmLight;
    baseOSMDarkRef.current = osmDark;
    baseHybImageryRef.current = hybImagery;
    hybLabelsPlacesRef.current = hybLabelsPlaces;
    hybLabelsTransportRef.current = hybLabelsTransport;

    const allLayer = new VectorLayer({ source: allSourceRef.current });
    allLayerRef.current = allLayer;

    const vectorLayer = new VectorLayer({ source: vectorSourceRef.current });
    vectorLayerRef.current = vectorLayer;

    const map = new OlMap({
      target: "map",
      layers: [osmLight, osmDark, hybImagery, hybLabelsPlaces, hybLabelsTransport, allLayer, vectorLayer],
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

  // Setup tooltip overlay and pointer interactions
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Create overlay once
    if (!overlayRef.current) {
      const el = document.createElement('div');
      el.className = 'map-tooltip';
      el.style.display = 'none';
      const ov = new Overlay({ element: el, offset: [0, -14], positioning: 'bottom-center', stopEvent: false });
      map.addOverlay(ov);
      tooltipElRef.current = el;
      overlayRef.current = ov;
    }

    const hitAtPixel = (pixel: number[]) => {
      let found: Feature<Geometry> | null = null;
      map.forEachFeatureAtPixel(pixel, (feat, layer) => {
        if (layer === vectorLayerRef.current || layer === allLayerRef.current) {
          found = feat as Feature<Geometry>;
          return true;
        }
        return false;
      });
      return found;
    };

    const showTooltip = (feat: Feature<Geometry> | null) => {
      const el = tooltipElRef.current;
      const ov = overlayRef.current;
      if (!el || !ov) return;
      if (!feat) {
        el.style.display = 'none';
        ov.setPosition(undefined as any);
        return;
      }
      const props: any = feat.getProperties();
      const geom = feat.getGeometry();
      if (!geom || typeof (geom as any).getType !== 'function' || (geom as any).getType() !== 'Point') {
        el.style.display = 'none';
        ov.setPosition(undefined as any);
        return;
      }
      const g = geom as Point;
      const [x, y] = g.getCoordinates();
      const cs = props.callsign || props.CALLSIGN || '';
      const lat = props.lat ?? props.latitude;
      const lon = props.lon ?? props.longitude;
      const alt = props.alt;
      const spd = props.speed; // m/s if present
      const knots = typeof spd === 'number' ? Math.round(spd * 1.94384449) : null;
      el.innerHTML = `<div><strong>${cs || 'Unknown'}</strong><br/>lat: ${typeof lat==='number'?lat.toFixed(4):''}, lon: ${typeof lon==='number'?lon.toFixed(4):''}${typeof alt==='number'?`<br/>alt: ${Math.round(alt)} m`:''}${typeof knots==='number'?`<br/>spd: ${knots} kt`:''}</div>`;
      el.style.display = 'block';
      ov.setPosition([x, y]);
    };

    const onMove = (evt: any) => {
      const feat = hitAtPixel(evt.pixel);
      showTooltip(feat as any);
    };
    const onClick = (evt: any) => {
      const feat = hitAtPixel(evt.pixel) as any;
      if (feat && onSelectCallsign) {
        const cs = feat.get('callsign') || feat.get('CALLSIGN');
        if (cs) onSelectCallsign(String(cs));
      }
    };
    map.on('pointermove', onMove);
    map.on('singleclick', onClick);
    return () => {
      map.un('pointermove', onMove as any);
      map.un('singleclick', onClick as any);
    };
  }, [onSelectCallsign]);

  // Switch base layer according to theme and baseMode
  useEffect(() => {
    const osmLight = baseOSMLightRef.current;
    const osmDark = baseOSMDarkRef.current;
    const hyb = baseHybImageryRef.current;
    const lb1 = hybLabelsPlacesRef.current;
    const lb2 = hybLabelsTransportRef.current;
    if (!osmLight || !osmDark || !hyb || !lb1 || !lb2) return;

    if (baseMode === 'hyb') {
      // Hybrid on
      osmLight.setVisible(false);
      osmDark.setVisible(false);
      hyb.setVisible(true);
      lb1.setVisible(true);
      lb2.setVisible(true);
    } else {
      // OSM mode follows theme
      hyb.setVisible(false);
      lb1.setVisible(false);
      lb2.setVisible(false);
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

  // Track flight with 60s delayed position and draw historical track from backend storage
  useEffect(() => {
    const source = vectorSourceRef.current;
    let cancelled = false;
    let timer: number | null = null;

    const MAX_TRACK_POINTS = 100;
    const VIS_LAG_SEC = 60; // delay displayed position by 60 seconds

    const planeIconData = (fill: string, stroke: string) => {
      const svg = `<?xml version="1.0" encoding="UTF-8"?>
      <svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>
        <path d='M2 16l8-3V6.5A1.5 1.5 0 0 1 11.5 5h1A1.5 1.5 0 0 1 14 6.5V13l8 3v2l-8-1.5V22l-2-1-2 1v-5.5L2 18v-2z' fill='${fill}' stroke='${stroke}' stroke-width='1.5' stroke-linejoin='round' stroke-linecap='round'/>
      </svg>`;
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    };

    const getPointStyle = (th: 'light' | 'dark', rotRad: number = 0) => {
      const accent = th === 'dark' ? '#f59e0b' : '#1d4ed8';
      const halo = th === 'dark' ? '#0b1220' : '#ffffff';
      return new Style({
        image: new Icon({
          src: planeIconData(accent, halo),
          scale: 1.0,
          rotation: rotRad,
          rotateWithView: true,
        })
      });
    };

    const getLineStyles = (th: 'light' | 'dark') => {
      const accent = th === 'dark' ? '#f59e0b' : '#1d4ed8';
      const halo = th === 'dark' ? '#0b1220' : '#ffffff';
      return [
        new Style({ stroke: new Stroke({ color: halo, width: 6, lineCap: 'round', lineJoin: 'round' }) }),
        new Style({ stroke: new Stroke({ color: accent, width: 3, lineCap: 'round', lineJoin: 'round' }) }),
      ];
    };

    const ensureTrack = (lon: number, lat: number) => {
      const coord = fromLonLat([lon, lat]);
      let tf = trackFeatureRef.current;
      if (!tf) {
        const ls = new LineString([coord]);
        tf = new Feature<LineString>({ geometry: ls });
        tf.setStyle(getLineStyles(theme));
        trackFeatureRef.current = tf;
        source.addFeature(tf); // add first so the point is drawn on top
      } else {
        const geom = tf.getGeometry();
        if (!geom) return;
        const coords = geom.getCoordinates();
        const last = coords[coords.length - 1];
        const dx = coord[0] - last[0];
        const dy = coord[1] - last[1];
        const dist2 = dx * dx + dy * dy;
        // Append only if moved enough (~> 20 meters)
        if (dist2 > 20 * 20) {
          geom.appendCoordinate(coord);
          // Trim to last N points for live updates
          const cur = geom.getCoordinates();
          if (cur.length > MAX_TRACK_POINTS) {
            geom.setCoordinates(cur.slice(cur.length - MAX_TRACK_POINTS));
          }
        }
      }
      return coord;
    };

    const setFullTrack = (lonlats: [number, number][]) => {
      if (!lonlats.length) return;
      const coords = lonlats.map(([lo, la]) => fromLonLat([lo, la]));
      const ls = new LineString(coords);
      let tf = trackFeatureRef.current;
      if (!tf) {
        tf = new Feature<LineString>({ geometry: ls });
        tf.setStyle(getLineStyles(theme));
        trackFeatureRef.current = tf;
        source.addFeature(tf);
      } else {
        tf.setGeometry(ls);
      }
    };

    const ensurePoint = (lon: number, lat: number, callsignVal?: string, alt?: number, trackDeg?: number, speedMs?: number, tsSec?: number) => {
      let f = flightFeatureRef.current;
      const to = fromLonLat([lon, lat]);
      const rot = typeof trackDeg === 'number' ? (trackDeg * Math.PI / 180) : (lastTrackDegRef.current * Math.PI / 180);
      const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      const cancelAnim = () => {
        if (animFrameRef.current) {
          cancelAnimationFrame(animFrameRef.current);
          animFrameRef.current = null;
        }
      };
      if (!f) {
        // First time: just place the marker without animation
        const geom = new Point(to);
        f = new Feature<Point>({ geometry: geom });
        f.setStyle(getPointStyle(theme, rot));
        if (callsignVal) f.set('callsign', callsignVal);
        if (typeof alt === 'number') f.set('alt', alt);
        if (typeof speedMs === 'number') f.set('speed', speedMs);
        if (typeof tsSec === 'number') f.set('ts', tsSec);
        f.set('lat', lat);
        f.set('lon', lon);
        if (typeof trackDeg === 'number') f.set('track', trackDeg);
        flightFeatureRef.current = f;
        source.addFeature(f);
      } else {
        // Animate from current to new position
        const geom = f.getGeometry() as Point;
        const from = geom.getCoordinates();
        const dx = to[0] - from[0];
        const dy = to[1] - from[1];
        const dist2 = dx * dx + dy * dy;
        // Update meta
        f.set('lat', lat);
        f.set('lon', lon);
        if (typeof alt === 'number') f.set('alt', alt);
        if (typeof speedMs === 'number') f.set('speed', speedMs);
        if (typeof trackDeg === 'number') {
          f.set('track', trackDeg);
          f.setStyle(getPointStyle(theme, rot));
        }
        if (typeof tsSec === 'number') {
          f.set('ts', tsSec);
        }
        if (dist2 < 1) {
          // very small movement, snap
          geom.setCoordinates(to);
          cancelAnim();
          return;
        }
        cancelAnim();
        animFromRef.current = from as [number, number];
        animToRef.current = to as [number, number];
        animStartRef.current = performance.now();
        // Prefer real time delta between samples if available, otherwise fall back to distance/speed
        let durationMs = 800;
        const prevTs = Number((f.get('ts') as number) || 0);
        const curTs = typeof tsSec === 'number' ? tsSec : prevTs;
        let dtSec = prevTs > 0 && curTs > prevTs ? (curTs - prevTs) : 0;
        if (dtSec > 0) {
          durationMs = Math.max(200, Math.min(15000, dtSec * 1000));
        } else {
          const fromXY = animFromRef.current!;
          const toXY = animToRef.current!;
          const ddx = toXY[0] - fromXY[0];
          const ddy = toXY[1] - fromXY[1];
          const distMeters = Math.sqrt(ddx * ddx + ddy * ddy);
          const spd = (typeof speedMs === 'number' && speedMs > 0) ? speedMs : (Number(f.get('speed')) || 0);
          if (spd > 0) {
            durationMs = Math.max(300, Math.min(12000, (distMeters / spd) * 1000));
          }
        }
        const step = (now: number) => {
          const start = animStartRef.current;
          const t = Math.min(1, (now - start) / durationMs);
          const e = easeInOut(t);
          const fxy = animFromRef.current!;
          const txy = animToRef.current!;
          const x = fxy[0] + (txy[0] - fxy[0]) * e;
          const y = fxy[1] + (txy[1] - fxy[1]) * e;
          geom.setCoordinates([x, y]);
          if (t < 1) {
            animFrameRef.current = requestAnimationFrame(step);
          } else {
            animFrameRef.current = null;
            geom.setCoordinates(txy);
          }
        };
        animFrameRef.current = requestAnimationFrame(step);
      }
    };

    const recenter = (lon: number, lat: number) => {
      if (!mapRef.current) return;
      const v = mapRef.current.getView();
      let z = v.getZoom() || 6;
      if (z < 6) z = 6;
      v.animate({ center: fromLonLat([lon, lat]), zoom: z, duration: 400 });
    };

    const fetchTrackAndShowLagged = async () => {
      if (!callsign) return;
      try {
        console.debug('[FlightMap] track fetch (lagged 60s)', { callsign });
        const resp = await fetch(`/api/track?callsign=${encodeURIComponent(callsign)}`);
        if (!resp.ok) {
          console.debug('[FlightMap] track not ok', resp.status);
          return;
        }
        const data = await resp.json();
        if (cancelled) return;
        const pts = Array.isArray(data?.points) ? (data.points as Array<any>) : [];
        if (!pts.length) return;
        const nowSec = Math.floor(Date.now() / 1000);
        const cutoff = nowSec - VIS_LAG_SEC;
        // Find last point with ts <= cutoff
        let idx = -1;
        for (let i = pts.length - 1; i >= 0; i--) {
          if (typeof pts[i]?.ts === 'number' && pts[i].ts <= cutoff) { idx = i; break; }
        }
        if (idx === -1) {
          // no old-enough point yet; don't move marker
          return;
        }
        // Update track line only up to visible point
        const lonlats: [number, number][] = pts.slice(0, idx + 1).map((p: any) => [p.lon, p.lat]);
        setFullTrack(lonlats);
        const cur = pts[idx];
        if (typeof cur?.track === 'number') { lastTrackDegRef.current = cur.track; }
        ensurePoint(cur.lon, cur.lat, callsign, cur.alt, cur.track, typeof cur?.speed === 'number' ? cur.speed : undefined, typeof cur?.ts === 'number' ? cur.ts : undefined);
        recenter(cur.lon, cur.lat);
      } catch (e) {
        console.debug('[FlightMap] track error', e);
      }
    };

    // Reset previous features when starting a new search or clearing callsign
    source.clear();
    flightFeatureRef.current = null;
    trackFeatureRef.current = null;

    // Hide all-flights layer while tracking a single callsign
    if (allLayerRef.current) {
      allLayerRef.current.setVisible(!callsign);
    }

    if (!callsign) {
      return;
    }

    // Initial and periodic refresh (we always fetch full track but display with 60s lag)
    fetchTrackAndShowLagged();
    timer = window.setInterval(() => fetchTrackAndShowLagged(), 12000);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
    };
  }, [callsign, searchToken]);

  // Browse mode: show all flights within current viewport when no callsign
  useEffect(() => {
    const map = mapRef.current;
    const layer = allLayerRef.current;
    const source = allSourceRef.current;
    if (!map || !layer) return;

    let timer: number | null = null;
    let cancelled = false;

    const planeIconData = (fill: string, stroke: string) => {
      const svg = `<?xml version="1.0" encoding="UTF-8"?>
      <svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>
        <path d='M2 16l8-3V6.5A1.5 1.5 0 0 1 11.5 5h1A1.5 1.5 0 0 1 14 6.5V13l8 3v2l-8-1.5V22l-2-1-2 1v-5.5L2 18v-2z' fill='${fill}' stroke='${stroke}' stroke-width='1.5' stroke-linejoin='round' stroke-linecap='round'/>
      </svg>`;
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    };

    const styleFn = (feature: Feature<Geometry>) => {
      const th = theme;
      const accent = th === 'dark' ? '#93c5fd' : '#1e40af';
      const halo = th === 'dark' ? '#0b1220' : '#ffffff';
      const trackDeg = (feature.get('track') as number) || 0;
      const rot = trackDeg * Math.PI / 180;
      return new Style({
        image: new Icon({ src: planeIconData(accent, halo), scale: 0.9, rotation: rot, rotateWithView: true })
      });
    };
    layer.setStyle(styleFn as any);

    const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

    const animateMove = (feat: Feature<Point>, to: [number, number], dtSec?: number) => {
      const anyFeat = feat as any;
      if (anyFeat.__animHandle) {
        cancelAnimationFrame(anyFeat.__animHandle);
        anyFeat.__animHandle = null;
      }
      const geom = feat.getGeometry() as Point;
      const from = geom.getCoordinates() as [number, number];
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const dist2 = dx * dx + dy * dy;
      if (dist2 < 1) { // ~ <1m, snap
        geom.setCoordinates(to);
        return;
      }
      // Prefer duration based on real timestamp delta if provided
      let durationMs = 800;
      if (typeof dtSec === 'number' && dtSec > 0) {
        durationMs = Math.max(200, Math.min(15000, dtSec * 1000));
      } else {
        // Fallback: based on distance and reported speed (m/s)
        const distMeters = Math.sqrt(dist2);
        const spd = Number(feat.get('speed'));
        if (!isNaN(spd) && spd > 0) {
          durationMs = Math.max(300, Math.min(10000, (distMeters / spd) * 1000));
        }
      }
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / durationMs);
        const e = easeInOut(t);
        const x = from[0] + dx * e;
        const y = from[1] + dy * e;
        geom.setCoordinates([x, y]);
        if (t < 1 && !cancelled) {
          anyFeat.__animHandle = requestAnimationFrame(step);
        } else {
          anyFeat.__animHandle = null;
          geom.setCoordinates(to);
        }
      };
      anyFeat.__animHandle = requestAnimationFrame(step);
    };

    const fetchAll = async () => {
      if (callsign) return; // only in browse mode
      if (!map.getSize()) return;
      try {
        const view = map.getView();
        const extent = view.calculateExtent(map.getSize()!);
        const [minX, minY, maxX, maxY] = transformExtent(extent, 'EPSG:3857', 'EPSG:4326');
        const bbox = `${minX.toFixed(4)},${minY.toFixed(4)},${maxX.toFixed(4)},${maxY.toFixed(4)}`;
        console.debug('[FlightMap] bbox fetch', bbox);
        const resp = await fetch(`/api/flights?bbox=${bbox}`);
        if (!resp.ok) return;
        const pts = await resp.json(); // array of {icao24,callsign,lon,lat,alt?,track?,speed?,ts}
        if (cancelled) return;

        const seen = new Set<string>();
        for (const p of pts) {
          if (typeof p.lon !== 'number' || typeof p.lat !== 'number') continue;
          const id: string = (p.icao24 && String(p.icao24)) || (p.callsign && String(p.callsign)) || '';
          if (!id) continue;
          seen.add(id);
          let feat = allIndexRef.current.get(id);
          const to = fromLonLat([p.lon, p.lat]) as [number, number];
          if (!feat) {
            feat = new Feature<Point>({ geometry: new Point(to) });
            feat.set('icao24', p.icao24 || '');
            feat.set('callsign', p.callsign || '');
            source.addFeature(feat);
            allIndexRef.current.set(id, feat);
          }
          // Update properties
          feat.set('lat', p.lat);
          feat.set('lon', p.lon);
          if (typeof p.alt === 'number') feat.set('alt', p.alt); else feat.unset('alt', true);
          if (typeof p.track === 'number') feat.set('track', p.track); else feat.unset('track', true);
          if (typeof p.speed === 'number') feat.set('speed', p.speed); else feat.unset('speed', true);
          // Animate to new position
          animateMove(feat, to);
        }
        // Remove features not seen in this update
        for (const [id, feat] of allIndexRef.current.entries()) {
          if (!seen.has(id)) {
            const anyFeat = feat as any;
            if (anyFeat.__animHandle) {
              cancelAnimationFrame(anyFeat.__animHandle);
              anyFeat.__animHandle = null;
            }
            source.removeFeature(feat);
            allIndexRef.current.delete(id);
          }
        }
      } catch (e) {
        console.debug('[FlightMap] bbox error', e);
      }
    };

    // Set visibility based on mode
    layer.setVisible(!callsign);

    const onMoveEnd = () => { if (!callsign) fetchAll(); };
    map.on('moveend', onMoveEnd);
    // initial and periodic refresh
    fetchAll();
    timer = window.setInterval(() => fetchAll(), 12000);

    return () => {
      cancelled = true;
      map.un('moveend', onMoveEnd as any);
      if (timer) window.clearInterval(timer);
      // cancel any running animations
      for (const [, feat] of allIndexRef.current.entries()) {
        const anyFeat = feat as any;
        if (anyFeat.__animHandle) cancelAnimationFrame(anyFeat.__animHandle);
      }
    };
  }, [callsign, theme]);

  // Update marker and track styles when theme changes
  useEffect(() => {
    const f = flightFeatureRef.current;
    const tf = trackFeatureRef.current;
    const accent = theme === 'dark' ? '#f59e0b' : '#1d4ed8';
    const halo = theme === 'dark' ? '#0b1220' : '#ffffff';
    if (f) {
      const svg = `<?xml version="1.0" encoding="UTF-8"?>
      <svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>
        <path d='M2 16l8-3V6.5A1.5 1.5 0 0 1 11.5 5h1A1.5 1.5 0 0 1 14 6.5V13l8 3v2l-8-1.5V22l-2-1-2 1v-5.5L2 18v-2z' fill='${accent}' stroke='${halo}' stroke-width='1.5' stroke-linejoin='round' stroke-linecap='round'/>
      </svg>`;
      const rot = ((f.get('track') as number) || lastTrackDegRef.current || 0) * Math.PI / 180;
      f.setStyle(new Style({
        image: new Icon({ src: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), scale: 1.0, rotation: rot, rotateWithView: true })
      }));
    }
    if (tf) {
      tf.setStyle([
        new Style({ stroke: new Stroke({ color: halo, width: 6, lineCap: 'round', lineJoin: 'round' }) }),
        new Style({ stroke: new Stroke({ color: accent, width: 3, lineCap: 'round', lineJoin: 'round' }) }),
      ]);
    }
    // Update browse layer style function to pick new colors
    const layer = allLayerRef.current;
    if (layer) {
      const planeIconData = (fill: string, stroke: string) => {
        const svg = `<?xml version="1.0" encoding="UTF-8"?>
        <svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>
          <path d='M2 16l8-3V6.5A1.5 1.5 0 0 1 11.5 5h1A1.5 1.5 0 0 1 14 6.5V13l8 3v2l-8-1.5V22l-2-1-2 1v-5.5L2 18v-2z' fill='${fill}' stroke='${stroke}' stroke-width='1.5' stroke-linejoin='round' stroke-linecap='round'/>
        </svg>`;
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
      };
      const styleFn = (feature: Feature<Geometry>) => {
        const th = theme;
        const accent2 = th === 'dark' ? '#93c5fd' : '#1e40af';
        const halo2 = th === 'dark' ? '#0b1220' : '#ffffff';
        const trackDeg = (feature.get('track') as number) || 0;
        const rot = trackDeg * Math.PI / 180;
        return new Style({
          image: new Icon({ src: planeIconData(accent2, halo2), scale: 0.9, rotation: rot, rotateWithView: true })
        });
      };
      layer.setStyle(styleFn as any);
    }
  }, [theme]);

  return <div id="map" style={{ position: 'absolute', inset: 0 }}></div>;
};

export default FlightMap;