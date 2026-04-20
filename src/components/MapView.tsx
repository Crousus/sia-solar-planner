// ────────────────────────────────────────────────────────────────────────────
// MapView — react-leaflet container + lock/unlock sync.
//
// Responsibilities:
//   1. Render an ESRI World Imagery satellite basemap (no API key needed).
//   2. Hand the `L.Map` instance up to App via onMapReady so other parts
//      of the app can read getCenter()/getZoom() when locking.
//   3. Enable/disable all map interaction when `mapState.locked` toggles.
//      This is essential — a panning map under a drawing overlay would
//      cause disasters (clicks drag the map, drawings "float" away).
//
// We purposely keep react-leaflet as dumb as possible. Roof polygons and
// panels are NOT rendered via Leaflet layers; they go on a separate Konva
// canvas overlay above this component. Reason: Leaflet's per-feature DOM
// (SVG) doesn't scale well to hundreds of panels, and Konva gives us
// object-level event handlers we need for drag/ghost/lasso.
// ────────────────────────────────────────────────────────────────────────────

import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import { useEffect, useRef } from 'react';
import { useProjectStore } from '../store/projectStore';

// ESRI's public satellite tile URL. Free for personal use, no API key.
// Max native zoom is 19; we let Leaflet over-zoom to 22 via pixel scaling
// so users can sketch at close range even if the imagery gets blurry.
const ESRI_SAT =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

/**
 * Bridges the map instance out of react-leaflet's context. This is the
 * documented pattern: a child component uses useMap() and relays the
 * reference upward via a callback.
 */
function MapBinder({ onMapReady }: { onMapReady: (m: L.Map) => void }) {
  const map = useMap();
  useEffect(() => {
    onMapReady(map);
  }, [map, onMapReady]);
  return null;
}

/**
 * Watches the persisted `locked` flag and toggles all Leaflet interaction
 * handlers accordingly. Placed as a child of MapContainer so it has access
 * to the map via useMap().
 *
 * Note `tap` is mobile-only and not in @types/leaflet — we narrow-cast to
 * an optional shape to keep strict TypeScript happy.
 */
function MapLockSync() {
  const map = useMap();
  const locked = useProjectStore((s) => s.project.mapState.locked);

  useEffect(() => {
    if (!map) return;
    if (locked) {
      map.dragging.disable();
      map.touchZoom.disable();
      map.doubleClickZoom.disable();
      map.scrollWheelZoom.disable();
      map.boxZoom.disable();
      map.keyboard.disable();
      const tap = (map as unknown as { tap?: { disable: () => void; enable: () => void } }).tap;
      if (tap) tap.disable();
    } else {
      map.dragging.enable();
      map.touchZoom.enable();
      map.doubleClickZoom.enable();
      map.scrollWheelZoom.enable();
      map.boxZoom.enable();
      map.keyboard.enable();
      const tap = (map as unknown as { tap?: { disable: () => void; enable: () => void } }).tap;
      if (tap) tap.enable();
    }
  }, [map, locked]);

  return null;
}

interface Props {
  onMapReady: (map: L.Map) => void;
}

export default function MapView({ onMapReady }: Props) {
  const center = useProjectStore((s) => s.project.mapState);

  // Initial viewport is captured once in a ref — Leaflet's MapContainer
  // reads center/zoom only on first mount, and we don't want subsequent
  // changes to re-create the map (it would blow away the view).
  const initial = useRef<{ lat: number; lng: number; zoom: number }>({
    lat: center.centerLat,
    lng: center.centerLng,
    zoom: center.zoom,
  });

  return (
    <MapContainer
      center={[initial.current.lat, initial.current.lng]}
      zoom={initial.current.zoom}
      maxZoom={22}
      zoomControl={true}
      attributionControl={false} // keep the UI clean; we credit in PDF/docs instead
      style={{ height: '100%', width: '100%' }}
    >
      <TileLayer url={ESRI_SAT} maxZoom={22} maxNativeZoom={19} />
      <MapBinder onMapReady={onMapReady} />
      <MapLockSync />
    </MapContainer>
  );
}
