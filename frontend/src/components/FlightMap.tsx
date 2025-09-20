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

// --- Airline code mapping to derive IATA<->ICAO callsign variants (frontend mirror of backend) ---
const IATA_TO_ICAO: Record<string, string> = {
  AA: 'AAL', DL: 'DAL', UA: 'UAL', AS: 'ASA', B6: 'JBU', NK: 'NKS', F9: 'FFT', G4: 'AAY',
  WS: 'WJA', AC: 'ACA', AF: 'AFR', KL: 'KLM', BA: 'BAW', LH: 'DLH', LX: 'SWR', OS: 'AUA',
  SN: 'BEL', IB: 'IBE', VY: 'VLG', TP: 'TAP', AZ: 'ITY', FR: 'RYR', U2: 'EZY', W6: 'WZZ',
  TK: 'THY', EK: 'UAE', QR: 'QTR', EY: 'ETD', FZ: 'FDB', SU: 'AFL', S7: 'SBI', U6: 'SVR',
  UT: 'UTA', LO: 'LOT', SK: 'SAS', AY: 'FIN', DY: 'NOZ', BT: 'BTI', A3: 'AEE', CA: 'CCA',
  MU: 'CES', CZ: 'CSN', NH: 'ANA', JL: 'JAL', QF: 'QFA', NZ: 'ANZ', KE: 'KAL', OZ: 'AAR',
  ET: 'ETH', KQ: 'KQA', MS: 'MSR', SV: 'SVA', SA: 'SAA',
};
const ICAO_TO_IATA: Record<string, string> = Object.create(null);
for (const [iata, icao] of Object.entries(IATA_TO_ICAO)) {
  ICAO_TO_IATA[icao] = iata;
}

function normalizeCallsign(cs: any): string {
  return String(cs || '').trim().toUpperCase();
}

// Returns alternate callsign with airline code converted IATA<->ICAO; empty if not convertible
function convertCallsignAlternate(cs: string): string {
  cs = normalizeCallsign(cs);
  if (!cs) return '';
  let i = 0;
  while (i < cs.length) {
    const ch = cs.charCodeAt(i);
    if (ch < 65 || ch > 90) break; // non A-Z
    i++;
  }
  if (i === 0) return '';
  const prefix = cs.slice(0, i);
  const suffix = cs.slice(i);
  if (prefix.length === 2) {
    const icao = IATA_TO_ICAO[prefix as keyof typeof IATA_TO_ICAO];
    return icao ? icao + suffix : '';
  }
  if (prefix.length === 3) {
    const iata = ICAO_TO_IATA[prefix];
    return iata ? iata + suffix : '';
  }
  return '';
}

interface FlightMapProps {
  callsign: string;
  searchToken: number;
  theme: 'light' | 'dark';
  baseMode: 'osm' | 'hyb';
  // Token to trigger centering on user's current location
  locateToken?: number;
  onSelectCallsign?: (callsign: string) => void;
  onNotFound?: (message: string) => void;
  onFound?: () => void;
}

const FlightMap: React.FC<FlightMapProps> = ({ callsign, searchToken, theme, baseMode, locateToken = 0, onSelectCallsign, onNotFound, onFound }) => {
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

    // Escape HTML to avoid XSS when rendering values coming from backend
    const esc = (s: any) => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

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
      // Compose title with ICAO callsign and IATA in parentheses when available
      const csNorm = normalizeCallsign(cs);
      const altCS = convertCallsignAlternate(csNorm);
      let titleText: string;
      if (csNorm) {
        titleText = esc(csNorm) + (altCS ? ` (${esc(altCS)})` : '');
      } else if (altCS) {
        titleText = esc(altCS);
      } else {
        titleText = 'Unknown';
      }
      const latStr = typeof lat === 'number' ? lat.toFixed(4) : '';
      const lonStr = typeof lon === 'number' ? lon.toFixed(4) : '';
      const altStr = typeof alt === 'number' ? `<br/>alt: ${Math.round(alt)} m` : '';
      const spdStr = typeof knots === 'number' ? `<br/>spd: ${knots} kt` : '';
      el.innerHTML = `<div><strong>${titleText}</strong><br/>lat: ${latStr}, lon: ${lonStr}${altStr}${spdStr}</div>`;
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

  // Track a single flight: draw historical track, and predict current position for continuous motion
  useEffect(() => {
    const source = vectorSourceRef.current;
    let cancelled = false;
    let timer: number | null = null;
    let rafId: number | null = null;

    const MAX_TRACK_POINTS = 100;
    const MAX_PREDICT_SEC = 90; // do not extrapolate further than this

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

    const setAnchor = (f: Feature<Point>, sampleXY: [number, number], trackDeg?: number, speedMs?: number) => {
      const nowSec = Date.now() / 1000;
      const geom = f.getGeometry() as Point;
      const curXY = geom.getCoordinates() as [number, number];
      // If our predicted position is close to the sample, anchor at current to avoid a jump
      const dx = sampleXY[0] - curXY[0];
      const dy = sampleXY[1] - curXY[1];
      const dist = Math.hypot(dx, dy);
      const anchorXY = dist < 3000 ? curXY : sampleXY; // 3 km threshold
      f.set('__anchorX', anchorXY[0]);
      f.set('__anchorY', anchorXY[1]);
      f.set('__anchorTs', nowSec);
      if (typeof trackDeg === 'number') f.set('track', trackDeg);
      if (typeof speedMs === 'number') f.set('speed', speedMs);
      // Update style rotation if needed
      const rot = ((f.get('track') as number) || 0) * Math.PI / 180;
      f.setStyle(getPointStyle(theme, rot));
    };

    const ensurePoint = (lon: number, lat: number, callsignVal?: string, alt?: number, trackDeg?: number, speedMs?: number, tsSec?: number) => {
      let f = flightFeatureRef.current;
      const sampleXY = fromLonLat([lon, lat]) as [number, number];
      const rot = typeof trackDeg === 'number' ? (trackDeg * Math.PI / 180) : (lastTrackDegRef.current * Math.PI / 180);
      if (!f) {
        const geom = new Point(sampleXY);
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
        // Initialize anchor at this sample
        f.set('__anchorX', sampleXY[0]);
        f.set('__anchorY', sampleXY[1]);
        f.set('__anchorTs', Date.now() / 1000);
      } else {
        // Update meta
        f.set('lat', lat);
        f.set('lon', lon);
        if (typeof alt === 'number') f.set('alt', alt);
        if (typeof speedMs === 'number') f.set('speed', speedMs);
        if (typeof tsSec === 'number') f.set('ts', tsSec);
        if (typeof trackDeg === 'number') {
          lastTrackDegRef.current = trackDeg;
        }
        setAnchor(f, sampleXY, trackDeg, speedMs);
      }
    };

    const recenter = (lon: number, lat: number) => {
      if (!mapRef.current) return;
      const v = mapRef.current.getView();
      let z = v.getZoom() || 6;
      if (z < 6) z = 6;
      v.animate({ center: fromLonLat([lon, lat]), zoom: z, duration: 400 });
    };

    const predictLoop = () => {
      if (cancelled) return;
      const f = flightFeatureRef.current;
      if (f) {
        const geom = f.getGeometry() as Point;
        const ax = Number(f.get('__anchorX'));
        const ay = Number(f.get('__anchorY'));
        const ats = Number(f.get('__anchorTs'));
        const spd = Number(f.get('speed')) || 0;
        const trackDeg = Number(f.get('track')) || 0;
        if (isFinite(ax) && isFinite(ay) && isFinite(ats) && spd > 0) {
          const nowSec = Date.now() / 1000;
          let dt = Math.max(0, nowSec - ats);
          if (dt > MAX_PREDICT_SEC) dt = MAX_PREDICT_SEC;
          const th = (trackDeg * Math.PI) / 180;
          const dx = Math.sin(th) * spd * dt; // meters east
          const dy = Math.cos(th) * spd * dt; // meters north
          const x = ax + dx;
          const y = ay + dy;
          geom.setCoordinates([x, y]);
        }
      }
      rafId = requestAnimationFrame(predictLoop);
    };

    const fetchTrackLive = async () => {
      if (!callsign) return;
      try {
        console.debug('[FlightMap] track fetch (live)', { callsign });
        const resp = await fetch(`/api/track?callsign=${encodeURIComponent(callsign)}`);
        if (!resp.ok) {
          console.debug('[FlightMap] track not ok', resp.status);
          if (!cancelled) {
            onNotFound && onNotFound(`Flight "${callsign}" was not found. Try a different flight number. Both IATA and ICAO airline codes are supported.`);
          }
          return;
        }
        const data = await resp.json();
        if (cancelled) return;
        const pts = Array.isArray(data?.points) ? (data.points as Array<any>) : [];
        if (!pts.length) {
          onNotFound && onNotFound(`Flight "${callsign}" was not found. Try a different flight number. Both IATA and ICAO airline codes are supported.`);
          return;
        }
        // Full track (last N for perf)
        const lonlats: [number, number][] = pts.slice(-MAX_TRACK_POINTS).map((p: any) => [p.lon, p.lat]);
        setFullTrack(lonlats);
        const cur = pts[pts.length - 1];
        if (typeof cur?.track === 'number') { lastTrackDegRef.current = cur.track; }
        ensurePoint(cur.lon, cur.lat, callsign, cur.alt, cur.track, typeof cur?.speed === 'number' ? cur.speed : undefined, typeof cur?.ts === 'number' ? cur.ts : undefined);
        // recenter on first success only
        if (!flightFeatureRef.current?.get('__centered')) {
          recenter(cur.lon, cur.lat);
          flightFeatureRef.current?.set('__centered', true);
        }
        onFound && onFound();
      } catch (e) {
        console.debug('[FlightMap] track error', e);
        if (!cancelled) {
          onNotFound && onNotFound(`Couldn't load flight "${callsign}". Please try again.`);
        }
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

    // Start prediction loop
    rafId = requestAnimationFrame(predictLoop);
    // Initial and periodic refresh (fetch latest samples; prediction loop handles motion)
    fetchTrackLive();
    timer = window.setInterval(() => fetchTrackLive(), 12000);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      if (rafId) cancelAnimationFrame(rafId);
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
    let rafId: number | null = null;
    const MAX_PREDICT_SEC = 90;

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

    const setAnchor = (feat: Feature<Point>, sampleXY: [number, number], trackDeg?: number, speedMs?: number) => {
      const nowSec = Date.now() / 1000;
      const geom = feat.getGeometry() as Point;
      const curXY = geom.getCoordinates() as [number, number];
      const dx = sampleXY[0] - curXY[0];
      const dy = sampleXY[1] - curXY[1];
      const dist = Math.hypot(dx, dy);
      const anchorXY = dist < 3000 ? curXY : sampleXY; // 3 km threshold
      feat.set('__anchorX', anchorXY[0]);
      feat.set('__anchorY', anchorXY[1]);
      feat.set('__anchorTs', nowSec);
      if (typeof trackDeg === 'number') feat.set('track', trackDeg);
      if (typeof speedMs === 'number') feat.set('speed', speedMs);
    };

    const predictLoop = () => {
      if (cancelled) return;
      for (const [, feat] of allIndexRef.current.entries()) {
        const geom = feat.getGeometry() as Point;
        const ax = Number(feat.get('__anchorX'));
        const ay = Number(feat.get('__anchorY'));
        const ats = Number(feat.get('__anchorTs'));
        const spd = Number(feat.get('speed')) || 0;
        const trackDeg = Number(feat.get('track')) || 0;
        if (isFinite(ax) && isFinite(ay) && isFinite(ats) && spd > 0) {
          const nowSec = Date.now() / 1000;
          let dt = Math.max(0, nowSec - ats);
          if (dt > MAX_PREDICT_SEC) dt = MAX_PREDICT_SEC;
          const th = (trackDeg * Math.PI) / 180;
          const dx = Math.sin(th) * spd * dt;
          const dy = Math.cos(th) * spd * dt;
          const x = ax + dx;
          const y = ay + dy;
          geom.setCoordinates([x, y]);
        }
      }
      rafId = requestAnimationFrame(predictLoop);
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
          const sampleXY = fromLonLat([p.lon, p.lat]) as [number, number];
          if (!feat) {
            feat = new Feature<Point>({ geometry: new Point(sampleXY) });
            feat.set('icao24', p.icao24 || '');
            feat.set('callsign', p.callsign || '');
            source.addFeature(feat);
            allIndexRef.current.set(id, feat);
            // initialize anchor
            feat.set('__anchorX', sampleXY[0]);
            feat.set('__anchorY', sampleXY[1]);
            feat.set('__anchorTs', Date.now() / 1000);
          }
          // Update properties (sampled)
          feat.set('lat', p.lat);
          feat.set('lon', p.lon);
          if (typeof p.alt === 'number') feat.set('alt', p.alt); else feat.unset('alt', true);
          if (typeof p.track === 'number') feat.set('track', p.track); else feat.unset('track', true);
          if (typeof p.speed === 'number') feat.set('speed', p.speed); else feat.unset('speed', true);
          // Update anchor based on new sample
          setAnchor(feat, sampleXY, p.track, p.speed);
        }
        // Remove features not seen in this update
        for (const [id, feat] of allIndexRef.current.entries()) {
          if (!seen.has(id)) {
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
    // Start prediction loop
    rafId = requestAnimationFrame(predictLoop);
    // initial and periodic refresh
    fetchAll();
    timer = window.setInterval(() => fetchAll(), 12000);

    return () => {
      cancelled = true;
      map.un('moveend', onMoveEnd as any);
      if (timer) window.clearInterval(timer);
      if (rafId) cancelAnimationFrame(rafId);
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