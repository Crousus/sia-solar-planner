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
  );
}
