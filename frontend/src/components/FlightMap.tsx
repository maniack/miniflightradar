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
import { toLonLat } from "ol/proj";
import { startUISpan, addEvent, withSpan } from '../otel-ui';
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
  // Hover preview track feature (separate from selected flight track)
  const hoverTrackFeatureRef = useRef<Feature<LineString> | null>(null);
  // Source/layer for all flights in viewport (underneath)
  const allSourceRef = useRef<VectorSource<Feature<Geometry>>>(new VectorSource<Feature<Geometry>>());
  const allLayerRef = useRef<VectorLayer<Feature<Geometry>> | null>(null);
  // Dedicated layer/source for tracks drawn under plane icons (hover previews etc.)
  const tracksSourceRef = useRef<VectorSource<Feature<Geometry>>>(new VectorSource<Feature<Geometry>>());
  const tracksLayerRef = useRef<VectorLayer<Feature<Geometry>> | null>(null);
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

    const tracksLayer = new VectorLayer({ source: tracksSourceRef.current });
    tracksLayerRef.current = tracksLayer;

    const vectorLayer = new VectorLayer({ source: vectorSourceRef.current });
    vectorLayerRef.current = vectorLayer;

    const map = new OlMap({
      target: "map",
      layers: [osmLight, osmDark, hybImagery, hybLabelsPlaces, hybLabelsTransport, tracksLayer, allLayer, vectorLayer],
      view: new View({
        center: fromLonLat([0, 20]),
        zoom: 2,
      }),
    });

    mapRef.current = map;

    // On first load, center on user's location only if no callsign is present in the URL
    try {
      const u = new URL(window.location.href);
      const q = (u.searchParams.get('q') || u.searchParams.get('callsign') || '').trim();
      if (!q) {
        geolocate();
      }
    } catch (_) {
      geolocate();
    }

    return () => {
      map.setTarget(undefined as unknown as string);
    };
  }, []);

  // Setup tooltip overlay, hover highlight, hover track preview, and click-to-select/toggle
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

    // Helpers for hover highlight & track preview (only in browse mode when no callsign is selected)
    let hoverCS: string | null = null;
    let hoverFeat: Feature<Point> | null = null;
    let hoverTimer: number | null = null;
    let hoverAbort: AbortController | null = null;

    const clearHover = () => {
      // Remove highlight style
      if (hoverFeat) {
        hoverFeat.setStyle(undefined as any);
        hoverFeat = null;
      }
      hoverCS = null;
      // Clear preview track (drawn on dedicated tracks layer under planes)
      const vs = tracksSourceRef.current;
      if (vs) vs.clear();
      hoverTrackFeatureRef.current = null;
    };

    const planeIconData = (fill: string, stroke: string) => {
      const svg = `<?xml version="1.0" encoding="UTF-8"?>\n      <svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>\n        <path d='M2 16l8-3V6.5A1.5 1.5 0 0 1 11.5 5h1A1.5 1.5 0 0 1 14 6.5V13l8 3v2l-8-1.5V22l-2-1-2 1v-5.5L2 18v-2z' fill='${fill}' stroke='${stroke}' stroke-width='1.5' stroke-linejoin='round' stroke-linecap='round'/>\n      </svg>`;
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    };

    const makeHoverStyle = (feature: Feature<Point>) => {
      const th = theme;
      const accent = th === 'dark' ? '#f59e0b' : '#1d4ed8';
      const halo = th === 'dark' ? '#0b1220' : '#ffffff';
      const trackDeg = (feature.get('track') as number) || 0;
      const rot = trackDeg * Math.PI / 180;
      const ring = new Style({
        image: new CircleStyle({ radius: 12, stroke: new Stroke({ color: accent, width: 3 }), fill: new Fill({ color: th === 'dark' ? 'rgba(11,18,32,0.25)' : 'rgba(255,255,255,0.35)' }) })
      });
      const icon = new Style({ image: new Icon({ src: planeIconData(accent, halo), scale: 1.05, rotation: rot, rotateWithView: true }) });
      return [ring, icon];
    };

    const getLineStyles = (th: 'light' | 'dark') => {
      const accent = th === 'dark' ? '#f59e0b' : '#1d4ed8';
      const halo = th === 'dark' ? '#0b1220' : '#ffffff';
      return [
        new Style({ stroke: new Stroke({ color: halo, width: 6, lineCap: 'round', lineJoin: 'round' }) }),
        new Style({ stroke: new Stroke({ color: accent, width: 3, lineCap: 'round', lineJoin: 'round' }) }),
      ];
    };

    const previewTrackFromFeature = (point: Feature<Point>) => {
      try {
        const trail = point.get('trail') as Array<any> | undefined;
        if (!trail || !Array.isArray(trail) || trail.length === 0) return;
        const lonlats: [number, number][] = trail.slice(-100).map((p: any) => [p.lon, p.lat]);
        const coords = lonlats.map(([lo, la]) => fromLonLat([lo, la]));
        const ls = new LineString(coords);
        const vs = tracksSourceRef.current;
        if (!vs) return;
        vs.clear();
        let tf = hoverTrackFeatureRef.current as Feature<LineString> | null;
        if (!tf) {
          tf = new Feature<LineString>({ geometry: ls });
          tf.setStyle(getLineStyles(theme));
          hoverTrackFeatureRef.current = tf as any;
          vs.addFeature(tf);
        } else {
          tf.setGeometry(ls);
          tf.setStyle(getLineStyles(theme));
        }
      } catch (_) {
        // ignore
      }
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
      const icao24 = String(props.icao24 || '')
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
      // base content
      el.innerHTML = `<div><strong>${titleText}</strong><br/>lat: ${latStr}, lon: ${lonStr}${altStr}${spdStr}</div>`;
      el.style.display = 'block';
      ov.setPosition([x, y]);

    };

    const onMove = (evt: any) => {
      const feat = hitAtPixel(evt.pixel) as Feature<Geometry> | null;
      showTooltip(feat);

      // Hover preview logic only when no flight is selected
      if (!callsign) {
        // If moved off any feature
        if (!feat) {
          if (hoverTimer) window.clearTimeout(hoverTimer);
          hoverTimer = null;
          clearHover();
          return;
        }
        // Only for points in all-flights layer
        const geomAny = (feat as any).getGeometry?.();
        if (!geomAny || typeof geomAny.getType !== 'function' || geomAny.getType() !== 'Point') {
          return;
        }
        const point = feat as Feature<Point>;
        const cs = normalizeCallsign((point.get('callsign') as any) || (point.get('CALLSIGN') as any) || '');
        if (!cs) {
          return;
        }
        if (hoverCS === cs) {
          return; // nothing changed
        }
        // New hover target: clear previous highlight and track
        if (hoverTimer) window.clearTimeout(hoverTimer);
        hoverTimer = null;
        clearHover();
        hoverCS = cs;
        hoverFeat = point;
        // Highlight feature
        point.setStyle(makeHoverStyle(point) as any);
        // Debounce track preview to avoid spamming
        hoverTimer = window.setTimeout(() => {
          if (hoverCS === cs && point) previewTrackFromFeature(point);
        }, 180);
      }
    };

    const onClick = (evt: any) => {
      try {
        const map = mapRef.current;
        const view = map?.getView();
        const coord3857 = map?.getCoordinateFromPixel ? map.getCoordinateFromPixel(evt.pixel) : (evt.coordinate || null);
        const [lon, lat] = coord3857 ? toLonLat(coord3857) : [undefined, undefined];
        const zoom = view?.getZoom?.();
        const { end, span } = startUISpan('ui.map.click', {
          lon: typeof lon === 'number' ? Number(lon.toFixed(6)) : undefined,
          lat: typeof lat === 'number' ? Number(lat.toFixed(6)) : undefined,
          zoom: typeof zoom === 'number' ? zoom : undefined,
          has_callsign: !!callsign,
        });
        const feat = hitAtPixel(evt.pixel) as any;
        if (feat && onSelectCallsign) {
          const cs = normalizeCallsign((feat.get('callsign') || feat.get('CALLSIGN') || ''));
          if (!cs) { end(); return; }
          if (cs === normalizeCallsign(callsign)) {
            addEvent(span, 'select.toggle', { action: 'clear', callsign: cs });
            onSelectCallsign('');
          } else {
            addEvent(span, 'select.toggle', { action: 'select', callsign: cs });
            onSelectCallsign(String(cs));
          }
        }
        end();
      } catch (_) {
        // fallthrough
      }
    };

    map.on('pointermove', onMove);
    map.on('singleclick', onClick);

    return () => {
      if (hoverTimer) window.clearTimeout(hoverTimer);
      hoverAbort?.abort();
      clearHover();
      map.un('pointermove', onMove as any);
      map.un('singleclick', onClick as any);
    };
  }, [onSelectCallsign, callsign, theme]);

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
      } else {
        // Update meta
        const ff = f as Feature<Point>;
        // Capture previous timestamp to compute smooth duration
        const oldTs = Number(ff.get('ts') || 0);
        ff.set('lat', lat);
        ff.set('lon', lon);
        if (typeof alt === 'number') ff.set('alt', alt);
        if (typeof speedMs === 'number') ff.set('speed', speedMs);
        if (typeof tsSec === 'number') ff.set('ts', tsSec);
        if (typeof trackDeg === 'number') {
          lastTrackDegRef.current = trackDeg;
          ff.set('track', trackDeg);
        }
        // Update style rotation
        const rot2 = ((ff.get('track') as number) || 0) * Math.PI / 180;
        ff.setStyle(getPointStyle(theme, rot2));
        // Animate to the new sampled position with duration based on ts delta
        const geom = ff.getGeometry() as Point;
        const curXY = geom.getCoordinates() as [number, number];
        const prevRaf = (ff.get('__animRaf') as number) || 0;
        if (prevRaf) cancelAnimationFrame(prevRaf);
        const start = performance.now();
        const fromXY = curXY.slice() as [number, number];
        const deltaSec = (typeof tsSec === 'number' && oldTs > 0) ? Math.max(0.8, Math.min(15, tsSec - oldTs)) : 10;
        const dur = Math.round(deltaSec * 1000);
        const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
        const step = (now: number) => {
          let t = (now - start) / dur;
          if (t >= 1) {
            geom.setCoordinates(sampleXY);
            ff.set('__animRaf', null);
            return;
          }
          if (t < 0) t = 0;
          const k = ease(t);
          geom.setCoordinates([fromXY[0] + (sampleXY[0] - fromXY[0]) * k, fromXY[1] + (sampleXY[1] - fromXY[1]) * k]);
          const id = requestAnimationFrame(step);
          ff.set('__animRaf', id);
        };
        const id = requestAnimationFrame(step);
        ff.set('__animRaf', id);
      }
    };

    const recenter = (lon: number, lat: number) => {
      if (!mapRef.current) return;
      const v = mapRef.current.getView();
      let z = v.getZoom() || 6;
      if (z < 6) z = 6;
      v.animate({ center: fromLonLat([lon, lat]), zoom: z, duration: 400 });
    };


    const syncFromGlobal = () => {
      if (!callsign) return;
      try {
        const targetCS = normalizeCallsign(callsign);
        let target: Feature<Point> | null = null;
        for (const [, feat] of allIndexRef.current.entries()) {
          const cs = normalizeCallsign((feat.get('callsign') as any) || '');
          if (cs === targetCS) { target = feat; break; }
        }
        if (!target) return;
        const lat = target.get('lat') as number;
        const lon = target.get('lon') as number;
        const alt = (target.get('alt') as number) ?? undefined;
        const trackDeg = (target.get('track') as number) ?? undefined;
        const speed = (target.get('speed') as number) ?? undefined;
        const ts = (target.get('ts') as number) ?? undefined;
        ensurePoint(lon, lat, callsign, alt, trackDeg, speed, ts);
        const trail = target.get('trail') as Array<any> | undefined;
        if (trail && Array.isArray(trail) && trail.length) {
          const lonlats: [number, number][] = trail.slice(-MAX_TRACK_POINTS).map((p: any) => [p.lon, p.lat]);
          setFullTrack(lonlats);
        }
        if (!flightFeatureRef.current?.get('__centered')) {
          recenter(lon, lat);
          flightFeatureRef.current?.set('__centered', true);
        }
      } catch (_) {
        // ignore
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

    // APM: Track flight lifecycle span
    const track = startUISpan('ui.track.flight', { callsign, token: searchToken });
    let foundLogged = false;

    // Predictive animation removed
    // Initial sync from global stream and periodic refresh
    const doSync = () => {
      syncFromGlobal();
      if (!cancelled && flightFeatureRef.current) {
        if (!foundLogged) { try { addEvent(track.span, 'found'); } catch {} ; foundLogged = true; }
        onFound && onFound();
      }
    };
    doSync();
    let checkTimer: number | null = window.setInterval(doSync, 1000);

    // Using global stream; no per-flight WebSocket

    return () => {
      cancelled = true;
      if (checkTimer) window.clearInterval(checkTimer);
      const f = flightFeatureRef.current;
      if (f) {
        const rid = (f.get('__animRaf') as number) || 0;
        if (rid) cancelAnimationFrame(rid);
        f.unset('__animRaf', true);
      }
    };
  }, [callsign, searchToken]);

  const getCsrfTokenFromCookie = (): string => {
    try {
      const m = document.cookie.match(/(?:^|; )mfr_csrf=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    } catch {
      return '';
    }
  };

  // Browse mode: show all flights within current viewport over a single persistent WS connection
  // Variant A: do NOT reconnect WS when callsign changes; filtering by callsign happens only on the frontend.
  useEffect(() => {
    const map = mapRef.current;
    const layer = allLayerRef.current;
    const source = allSourceRef.current;
    if (!map || !layer) return;

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



    // Process incoming points array to update features and index
    const processPoints = (pts: any[]) => {
      const seen = new Set<string>();
      for (const p of pts) {
        if (typeof p?.lon !== 'number' || typeof p?.lat !== 'number') continue;
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
        if (Array.isArray((p as any).trail)) feat.set('trail', (p as any).trail); else feat.unset('trail', true);
        if (typeof (p as any).ts === 'number') feat.set('ts', (p as any).ts); else feat.unset('ts', true);
        // Animate to new sample (no predictive motion)
        if (typeof p.track === 'number') feat.set('track', p.track);
        const ffa = feat as Feature<Point>;
        const geom = ffa.getGeometry() as Point;
        const curXY = geom.getCoordinates() as [number, number];
        const prevRaf = (ffa.get('__animRaf') as number) || 0;
        if (prevRaf) cancelAnimationFrame(prevRaf);
        const start = performance.now();
        const fromXY = curXY.slice() as [number, number];
        const dur = 700;
        const ease = (t: number) => 1 - Math.pow(1 - t, 3);
        const step = (now: number) => {
          let t = (now - start) / dur;
          if (t >= 1) {
            geom.setCoordinates(sampleXY);
            ffa.set('__animRaf', null);
            return;
          }
          if (t < 0) t = 0;
          const k = ease(t);
          geom.setCoordinates([fromXY[0] + (sampleXY[0] - fromXY[0]) * k, fromXY[1] + (sampleXY[1] - fromXY[1]) * k]);
          const rafId = requestAnimationFrame(step);
          ffa.set('__animRaf', rafId);
        };
        const rafId = requestAnimationFrame(step);
        ffa.set('__animRaf', rafId);
      }
      // Remove features not seen in this update
      for (const [id, feat] of allIndexRef.current.entries()) {
        if (!seen.has(id)) {
          source.removeFeature(feat);
          allIndexRef.current.delete(id);
        }
      }
    };

    // Storage helpers (IndexedDB + localStorage fallback)
    const pruneForLocalStorage = (items: any[]) => items.slice(0, 400).map((p) => { const { trail, ...rest } = p || {}; return rest; });

    const saveSnapshotNow = async (items: any[]) => {
      try {
        // IndexedDB primary
        await (async () => {
          if (!('indexedDB' in window)) return;
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = window.indexedDB.open('mfrdb', 1);
            req.onupgradeneeded = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains('kv')) {
                db.createObjectStore('kv', { keyPath: 'k' });
              }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('kv', 'readwrite');
            const store = tx.objectStore('kv');
            store.put({ k: 'snapshot', ts: Date.now(), items });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
          db.close();
        })();
        // localStorage fallback with pruned payload
        try {
          const slim = { ts: Date.now(), items: pruneForLocalStorage(items) };
          localStorage.setItem('mfr_snapshot_v1', JSON.stringify(slim));
        } catch {}
      } catch {}
    };

    const loadSnapshotNow = async (): Promise<{ ts: number; items: any[] } | null> => {
      // Try IndexedDB
      try {
        if ('indexedDB' in window) {
          const db: IDBDatabase = await new Promise((resolve, reject) => {
            const req = window.indexedDB.open('mfrdb', 1);
            req.onupgradeneeded = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains('kv')) {
                db.createObjectStore('kv', { keyPath: 'k' });
              }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const rec: any = await new Promise((resolve, reject) => {
            const tx = db.transaction('kv', 'readonly');
            const store = tx.objectStore('kv');
            const getReq = store.get('snapshot');
            getReq.onsuccess = () => resolve(getReq.result || null);
            getReq.onerror = () => reject(getReq.error);
          });
          db.close();
          if (rec && Array.isArray(rec.items)) return { ts: Number(rec.ts) || 0, items: rec.items };
        }
      } catch {}
      // Fallback to localStorage
      try {
        const raw = localStorage.getItem('mfr_snapshot_v1');
        if (raw) {
          const data = JSON.parse(raw);
          if (Array.isArray(data?.items)) return { ts: Number(data.ts) || 0, items: data.items };
        }
      } catch {}
      return null;
    };

    const fetchAll = async () => {
      if (callsign) return; // only in browse mode
      if (!map.getSize()) return;
      try {
        const csrf = getCsrfTokenFromCookie();
        const resp = await fetch(`/api/flights`, { credentials: 'include', headers: csrf ? { 'X-CSRF-Token': csrf } : {} });
        if (!resp.ok) return;
        const pts = await resp.json(); // array of {icao24,callsign,lon,lat,alt?,track?,speed?,ts}
        if (cancelled) return;
        processPoints(pts);
        await saveSnapshotNow(pts);
      } catch (e) {
        console.debug('[FlightMap] bbox error', e);
      }
    };

    // Set initial visibility; tracking effect will toggle this based on callsign
    layer.setVisible(true);

    // WebSocket subscription for viewport flights
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let resubTimer: number | null = null;

    const bboxStr = (): string | null => {
      if (!map.getSize()) return null;
      const view = map.getView();
      const extent = view.calculateExtent(map.getSize()!);
      const [minX, minY, maxX, maxY] = transformExtent(extent, 'EPSG:3857', 'EPSG:4326');
      return `${minX.toFixed(4)},${minY.toFixed(4)},${maxX.toFixed(4)},${maxY.toFixed(4)}`;
    };

    const sendViewport = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const bbox = bboxStr();
      if (!bbox) return;
      try { ws.send(JSON.stringify({ type: 'viewport', bbox })); } catch {}
    };

    const subscribe = () => {
      if (ws) { try { ws.close(); } catch (_) {} ws = null; }
      try {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const token = getCsrfTokenFromCookie();
        const url = `${proto}://${window.location.host}/ws/flights${token ? `?csrf=${encodeURIComponent(token)}` : ''}`;
        const conn = startUISpan('ws.connect', { url, mode: callsign ? 'track' : 'browse' });
        ws = new WebSocket(url);
        ws.onopen = () => { try { addEvent(conn.span, 'open'); conn.end({ ok: true }); } catch {} ; try { sendViewport(); } catch {} };
        ws.onmessage = async (ev) => {
          await withSpan('ws.message.batch', async (span) => {
            try {
              const data = JSON.parse(ev.data);
              // Backward-compat: full array snapshot
              if (Array.isArray(data)) {
                addEvent(span, 'received', { count: data.length, kind: 'full' });
                processPoints(data);
                await saveSnapshotNow(data);
                try { ws && ws.send(JSON.stringify({ type: 'ack', seq: 0, buffered: ws.bufferedAmount })); } catch {}
                return;
              }
              if (data && typeof data === 'object' && data.type === 'diff') {
                const seq = Number(data.seq) || 0;
                const up: any[] = Array.isArray(data.upsert) ? data.upsert : [];
                const del: string[] = Array.isArray(data.delete) ? data.delete : [];
                addEvent(span, 'received', { upsert: up.length, delete: del.length, seq });
                if (up.length) processPoints(up);
                if (del.length) {
                  for (const id of del) {
                    const feat = allIndexRef.current.get(String(id));
                    if (feat) {
                      source.removeFeature(feat);
                      allIndexRef.current.delete(String(id));
                    }
                  }
                }
                // Note: we don't persist diffs to snapshot to avoid heavy rebuild each tick
                try { ws && ws.send(JSON.stringify({ type: 'ack', seq, buffered: ws.bufferedAmount })); } catch {}
              }
            } catch (e) {
              // ignore parse errors
            }
          }, { mode: callsign ? 'track' : 'browse' });
        };
        ws.onclose = () => {
          try { addEvent(conn.span, 'close'); } catch {}
          if (reconnectTimer) window.clearTimeout(reconnectTimer);
          reconnectTimer = window.setTimeout(() => subscribe(), 2500);
        };
        ws.onerror = () => {
          try { addEvent(conn.span, 'error'); conn.end({ ok: false }); } catch {}
          try { ws && ws.close(); } catch (_) {}
        };
      } catch (_) {
        // ignore
      }
    };

    // Keep layer visible here; tracking effect manages visibility on callsign changes
    layer.setVisible(true);

    const onMoveEnd = () => {
      try {
        const map = mapRef.current;
        const view = map?.getView();
        const c = view?.getCenter?.();
        const [lon, lat] = c ? toLonLat(c) : [undefined, undefined];
        const zoom = view?.getZoom?.();
        const extent = view?.calculateExtent ? view.calculateExtent(map?.getSize() || [0,0]) : null;
        const bbox = extent ? transformExtent(extent, 'EPSG:3857', 'EPSG:4326') : null;
        const { end } = startUISpan('ui.map.moveend', {
          lon: typeof lon === 'number' ? Number(lon.toFixed(6)) : undefined,
          lat: typeof lat === 'number' ? Number(lat.toFixed(6)) : undefined,
          zoom: typeof zoom === 'number' ? zoom : undefined,
          bbox: bbox ? `${bbox[0].toFixed(4)},${bbox[1].toFixed(4)},${bbox[2].toFixed(4)},${bbox[3].toFixed(4)}` : undefined,
        });
        end();
      } catch {}
      if (resubTimer) window.clearTimeout(resubTimer);
      resubTimer = window.setTimeout(() => { sendViewport(); }, 200);
    };
    map.on('moveend', onMoveEnd);

    // Predictive animation removed

    // restore from cache then initial subscribe
    (async () => {
      try {
        const snap = await loadSnapshotNow();
        if (snap && Array.isArray(snap.items)) {
          processPoints(snap.items);
        }
      } catch {}
    })();
    subscribe();

    return () => {
      cancelled = true;
      map.un('moveend', onMoveEnd as any);
      if (ws) { try { ws.close(); } catch (_) {} }
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (resubTimer) window.clearTimeout(resubTimer);
      // cancel any in-flight feature animations
      for (const [, feat] of allIndexRef.current.entries()) {
        const rid = (feat.get('__animRaf') as number) || 0;
        if (rid) cancelAnimationFrame(rid);
        feat.unset('__animRaf', true);
      }
    };
  }, []);

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