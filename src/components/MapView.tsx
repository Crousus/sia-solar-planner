// ────────────────────────────────────────────────────────────────────────────
// MapView — react-leaflet container, rendered ONLY while the map is unlocked.
//
// Responsibilities:
//   1. Render a satellite basemap (ESRI World Imagery or Bayern DOP/ALKIS).
//   2. Hand the `L.Map` instance up to App via onMapReady so the toolbar
//      can read getCenter()/getZoom() at lock time.
//
// Post-ADR-007, this component is *unmounted* the moment the user locks the
// map — at that point the Konva overlay takes over with a rasterized PNG
// backdrop and owns pan/zoom natively. That's why there's no lock-state
// toggling of Leaflet handlers here anymore: there's nothing to toggle,
// the whole subtree goes away.
//
// Roof polygons and panels are NOT rendered via Leaflet layers; they go on
// a separate Konva canvas above this component. Leaflet's per-feature DOM
// (SVG) doesn't scale well to hundreds of panels, and Konva gives us
// object-level event handlers we need for drag/ghost/lasso.
// ────────────────────────────────────────────────────────────────────────────

import { MapContainer, TileLayer, WMSTileLayer, useMap } from 'react-leaflet';
import { useEffect, useRef } from 'react';
import { useProjectStore } from '../store/projectStore';

// ESRI's public satellite tile URL. Free for personal use, no API key.
// Max native zoom is 19; we let Leaflet over-zoom to 22 via pixel scaling
// so users can sketch at close range even if the imagery gets blurry.
const ESRI_SAT =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

// Geodaten Bayern WMS URL for current 20cm RGB Orthophotos.
const BAYERN_WMS = 'https://geoservices.bayern.de/od/wms/dop/v1/dop20';

// Geodaten Bayern ALKIS WMS URL for building footprints (Parzellarkarte).
const BAYERN_ALKIS_WMS = 'https://geoservices.bayern.de/od/wms/alkis/v1/parzellarkarte';

/**
 * Bridges the map instance out of react-leaflet's context. This is the
 * documented pattern: a child component uses useMap() and relays the
 * reference upward via a callback.
 */
function MapBinder({ onMapReady }: { onMapReady: (m: L.Map) => void }) {
  const map = useMap();
  useEffect(() => {
    if (map) onMapReady(map);
  }, [map, onMapReady]);
  return null;
}

interface Props {
  onMapReady: (map: L.Map) => void;
  /**
   * Pre-lock visual rotation in degrees (clockwise). Applied as a CSS
   * transform to a wrapper around the Leaflet map so the user can
   * preview how their frame will sit once locked. Leaflet itself has no
   * knowledge of this rotation — its internal coordinate system stays
   * axis-aligned, so pan/zoom math remains correct; the rotation is
   * purely a screen-space visualization. On lock, Toolbar.handleLock
   * strips the transform before html2canvas so the captured PNG is
   * axis-aligned, and passes the rotation into lockMap as
   * `initialRotationDeg`, which useViewport applies to the Konva stage.
   */
  rotation?: number;
}

export default function MapView({ onMapReady, rotation = 0 }: Props) {
  const center = useProjectStore((s) => s.project.mapState);
  // Read the project-level address (set via the bootstrap / settings
  // form) so we can auto-center on it when the map hasn't been locked
  // yet. Cheap selector — `meta` is a small object and changes rarely.
  const address = useProjectStore((s) => s.project.meta?.address);

  // Initial viewport is captured once in a ref — Leaflet's MapContainer
  // reads center/zoom only on first mount, and we don't want subsequent
  // changes to re-create the map (it would blow away the view).
  //
  // Priority when the map is UNLOCKED:
  //   1. If the project has a geocoded address, fly there at zoom 19.
  //      This is the bootstrap-driven case: the user typed an address
  //      on the new-project page and expects the map to already be
  //      over that building. Zoom 19 matches the default "ready to
  //      draw" zoom level we use elsewhere.
  //   2. Otherwise use whatever mapState held (either a user-panned
  //      position from a previous session, or the factory default).
  //
  // We intentionally do NOT overwrite the center when `locked === true`:
  //   - MapView only renders in the unlocked state (see the App.tsx
  //     check), so that branch is never reached. Mentioning it here
  //     just so future readers understand the full design: if we
  //     started honoring address post-lock we'd risk yanking the user
  //     out of their in-progress drawing.
  //
  // We do NOT mutate mapState to persist this override. Two reasons:
  //   - The user hasn't actually panned — writing centerLat/centerLng
  //     back would show up as an unsolicited outbound patch on the
  //     sync client's next diff.
  //   - The address IS already persisted in meta; keeping mapState as
  //     the user's manual pan history keeps those concerns separated.
  const initial = useRef<{ lat: number; lng: number; zoom: number }>(
    address && !center.locked
      ? { lat: address.lat, lng: address.lon, zoom: 19 }
      : { lat: center.centerLat, lng: center.centerLng, zoom: center.zoom }
  );

  return (
    <div
      // `data-map-rotate-wrapper` is the hook Toolbar.handleLock uses to
      // temporarily strip the transform before html2canvas. The wrapper
      // fills its parent and transforms only the visual — the parent
      // `<main>` has overflow-hidden so rotated corners clip cleanly.
      data-map-rotate-wrapper
      style={{
        width: '100%',
        height: '100%',
        transform: `rotate(${rotation}deg)`,
        transformOrigin: 'center center',
      }}
    >
    <MapContainer
      center={[initial.current.lat, initial.current.lng]}
      zoom={initial.current.zoom}
      maxZoom={22}
      zoomControl={true}
      attributionControl={false} // keep the UI clean; we credit in PDF/docs instead
      style={{ height: '100%', width: '100%' }}
    >
      {(!center.mapProvider || center.mapProvider === 'esri') && (
        <TileLayer url={ESRI_SAT} maxZoom={22} maxNativeZoom={19} />
      )}
      {(center.mapProvider === 'bayern' || center.mapProvider === 'bayern_alkis') && (
        <WMSTileLayer
          url={BAYERN_WMS}
          layers="by_dop20c"
          format="image/png"
          transparent={true}
          version="1.3.0"
          maxZoom={22}
        />
      )}
      {center.mapProvider === 'bayern_alkis' && (
        <WMSTileLayer
          url={BAYERN_ALKIS_WMS}
          layers="by_alkis_parzellarkarte_umr_gelb"
          format="image/png"
          transparent={true}
          version="1.3.0"
          maxZoom={22}
          zIndex={10}
        />
      )}
      <MapBinder onMapReady={onMapReady} />
    </MapContainer>
    </div>
  );
}
