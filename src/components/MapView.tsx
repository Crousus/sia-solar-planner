// Solar Planner - Frontend web application for designing and planning rooftop solar panel installations
// Copyright (C) 2026  Johannes Wenz github.com/Crousus
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

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
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useProjectStore } from '../store/projectStore';

// ESRI's public satellite tile URL. Free for personal use, no API key.
// Max native zoom is 19; we let Leaflet over-zoom to 22 via pixel scaling
// so users can sketch at close range even if the imagery gets blurry.
const ESRI_SAT =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

// Geodaten Bayern WMS URL for current 20cm RGB Orthophotos.
const BAYERN_WMS = 'https://geoservices.bayern.de/od/wms/dop/v1/dop20';

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

  // Outer shell fills <main> and serves two purposes:
  //   - It's the element we measure for the rotator sizing below.
  //   - It provides a positioned containing block so the absolutely
  //     positioned rotator anchors correctly.
  const shellRef = useRef<HTMLDivElement | null>(null);
  // Internal Leaflet map instance (separate from the onMapReady relay to
  // App) so we can call invalidateSize() on shell resize without forcing
  // App to re-fire anything.
  const mapInstanceRef = useRef<L.Map | null>(null);
  const [shellSize, setShellSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Measure <main> (the shell's parent, via shellRef.current) and track
  // size changes. We need this because the rotator's pixel dimensions
  // below are derived from main's diagonal — a constant percentage can
  // never be both correct AND tight for arbitrary aspect ratios (a 2:1
  // main at 90° rotation needs ≥ 200% height; a 1:1 main needs only
  // sqrt(2) ≈ 141%). Computing from actual pixels is simpler than doing
  // the per-aspect math in CSS.
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setShellSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // When the shell resizes after initial mount, Leaflet's container has
  // new dimensions but Leaflet doesn't re-measure on its own. Calling
  // invalidateSize keeps tile math aligned with the container bounds.
  useEffect(() => {
    if (mapInstanceRef.current && shellSize.w > 0 && shellSize.h > 0) {
      mapInstanceRef.current.invalidateSize();
    }
  }, [shellSize.w, shellSize.h]);

  const handleMapReady = (m: L.Map) => {
    mapInstanceRef.current = m;
    onMapReady(m);
  };

  // Rotator dimensions. A square of side = sqrt(w² + h²) (main's
  // diagonal) centered on main guarantees full coverage at ANY rotation
  // angle: every point within main falls inside the inscribed circle of
  // that square, which is invariant to rotation. This is the minimum
  // oversizing that works for all aspect ratios — narrower than a fixed
  // percentage that errs wide, so fewer tiles to fetch.
  //
  // Round to whole pixels. `shellSize.w/h` come from
  // `getBoundingClientRect` which returns fractional pixels; if we
  // passed those through, the rotator's absolute `top/left` would land
  // on sub-pixel offsets, Leaflet would then position its 256×256 tiles
  // at non-integer coords, and the browser would render thin seams
  // between tiles (visible as a grid-line pattern over the imagery).
  // `Math.ceil` on both the size floor AND the offset via `Math.round`
  // keeps Leaflet's internal math on integer pixel boundaries.
  const shellW = Math.ceil(shellSize.w);
  const shellH = Math.ceil(shellSize.h);
  const diagonal = Math.ceil(Math.sqrt(shellW ** 2 + shellH ** 2));
  const offsetX = Math.round((diagonal - shellW) / 2);
  const offsetY = Math.round((diagonal - shellH) / 2);
  const rotatorReady = shellSize.w > 0 && shellSize.h > 0;

  return (
    <div
      ref={shellRef}
      data-map-shell
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}
    >
    {rotatorReady && (
    <div
      // `data-map-rotate-wrapper` is the hook Toolbar.handleLock uses to
      // temporarily strip the transform before html2canvas.
      //
      // Sizing note: the wrapper is a square of side = main's diagonal,
      // centered on main via negative px offsets. This is the tightest
      // size that fully covers the visible frame at every rotation angle
      // — main's corners all lie inside the inscribed circle of a
      // diagonal-sided square, and rotation of that square preserves the
      // circle. Using pixel values (rather than percentages) lets us hit
      // the diagonal exactly; a percentage-based approach would either
      // fall short at wide aspect ratios or waste tiles by erring wide.
      //
      // The parent `<main>` has overflow-hidden so the rotated corners
      // clip cleanly at the sidebar / toolbar boundaries.
      //
      // Leaflet still reads the wrapper as its own canvas — getCenter()
      // and getZoom() remain correct because Leaflet's internal
      // coordinate system is unaffected by the CSS rotate().
      data-map-rotate-wrapper
      // `--preview-rotation` is consumed by index.css to counter-rotate
      // `.leaflet-control-container` so the +/- zoom buttons and the
      // attribution stay upright while the tiles tilt underneath.
      style={{
        position: 'absolute',
        top: `${-offsetY}px`,
        left: `${-offsetX}px`,
        width: `${diagonal}px`,
        height: `${diagonal}px`,
        transform: `rotate(${rotation}deg)`,
        transformOrigin: 'center center',
        ['--preview-rotation' as string]: `${rotation}deg`,
        // Offsets (in px) for the Leaflet control container so its
        // corners land on main's corners even though the rotator is
        // bigger than main. index.css reads these to position
        // `.leaflet-top / -bottom / -left / -right`.
        ['--preview-offset-x' as string]: `${offsetX}px`,
        ['--preview-offset-y' as string]: `${offsetY}px`,
      } as CSSProperties}
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
      {center.mapProvider === 'bayern' && (
        <WMSTileLayer
          url={BAYERN_WMS}
          layers="by_dop20c"
          format="image/png"
          transparent={true}
          version="1.3.0"
          maxZoom={22}
        />
      )}
      <MapBinder onMapReady={handleMapReady} />
    </MapContainer>
    </div>
    )}
    </div>
  );
}
