# ADR-007: Snapshot-on-Lock — Replace Leaflet With Rasterized Background

- **Status:** Accepted
- **Date:** 2026-04-20
- **Supersedes:** [ADR-001](ADR-001-zoom-synchronization.md)
- **Requirement:** When the map is locked, zooming and panning must keep the satellite imagery pixel-aligned with roof polygons, panels, and strings at all times.

## Context
ADR-001 kept Leaflet live after lock and tried to mirror its zoom into a Konva Stage scale (`2^(currentZoom − lockedZoom)`). That architecture was intrinsically racey:

- Leaflet runs a **250 ms CSS-transform animation** on every zoom step (`Map._animateZoom` in leaflet/src/map/Map.js line 1711).
- During that window Leaflet **suppresses** its own `zoom` event (`_move(…, supressEvent=true)` at line 1711; next emission is at `_onZoomTransitionEnd` on line 1729).
- Our zoom listener therefore didn't fire until the animation ended, so tiles visually grew for 250 ms while the Stage stayed at the old scale — drawings appeared to float and shrink relative to the imagery.
- Adding a `zoomanim` listener (which fires at animation start with the target zoom) closed some of the gap but didn't fully solve it: CSS-transform scaling isn't pixel-exact against a separate canvas-space transform, and the two compositors (browser CSS on the tile pane, Konva on the canvas) diverged subtly at every step.

The root problem is that we were **running two independent scene graphs** (Leaflet's tile pane, Konva's Stage) and asking them to stay in lockstep across an animation boundary we don't control. Every fix made it more fragile.

## Decision

**Stop running Leaflet after lock.** Capture a raster snapshot of the tiles at lock time and let Konva own the locked scene entirely.

### Flow
1. User navigates Leaflet to find their building (unlocked state — Konva overlay is a passthrough, Leaflet handles pan/zoom).
2. User clicks **Lock Map**. `Toolbar.handleLock`:
   - Reads Leaflet center + zoom.
   - Computes `metersPerPixel` from Web Mercator (unchanged).
   - Calls `html2canvas` on `.leaflet-container` → PNG dataURL at the container's CSS pixel size.
   - Commits to the store via `lockMap({ …, capturedImage, capturedWidth, capturedHeight })`.
3. `App.tsx` conditionally renders `<MapView />` only when `!locked` — Leaflet is fully unmounted post-lock.
4. `KonvaOverlay` renders the captured PNG as a `<Konva.Image>` in a non-listening background `<Layer>`, then Konva-native pan + zoom drive the user's view from there.

### Konva-native pan/zoom
- **Wheel**: zoom around cursor. Classic pattern — compute the world point under cursor before zoom, scale, offset so that same world point stays under cursor. Clamped to `[0.2, 8]`. Step `1.05` per wheel tick.
- **Pan triggers**: middle-mouse-button drag, or left-drag while Space is held. Both are conventional in CAD/design tools. `panRef` tracks last screen position for delta-based updates; `queueMicrotask` defers clearing so the Stage's synthetic `click` (fired after `mouseup`) sees the flag and short-circuits.
- **World coordinates are unchanged**: the Stage transform is `screen = world × scale + pos`. All roofs/panels remain stored in the same pixel frame they were drawn in — scale and pos only affect the viewport, not the data.
- **Brush/hit-test radii**: scaled by `1/stageScale` so a "15 px brush" stays 15 screen-px at any zoom.

### State additions (`MapState`)
```ts
capturedImage?: string        // PNG dataURL
capturedWidth?: number        // == .leaflet-container clientWidth at lock
capturedHeight?: number       // == .leaflet-container clientHeight at lock
```
These are dropped on `unlockMap` — stale after the user pans Leaflet again, and each is ~1–3 MB of base64 that would otherwise bloat localStorage (5 MB cap under Zustand's `persist` middleware).

### PDF export
`pdfExport.ts` previously composited two rasters (html2canvas on `.leaflet-container` + the Konva canvas). With Konva owning the whole scene we now single-shot html2canvas on `.konva-overlay` — the background image + all drawing layers come through in one pass. Tile CORS is no longer relevant at export time because the tiles were already sanitized into a same-origin PNG at lock.

## Consequences

- **Pros**
  - Zero desync between background and drawings at any zoom level. There's one transform to reason about.
  - No dependency on Leaflet's animation timing or undocumented internals (`_animateZoom`, `supressEvent`, etc.).
  - Konva-native pan is a new UX improvement ADR-001 never offered — the user can slide the view around without re-locking.
  - PDF export is simpler (one html2canvas call).
  - Project JSON is now **self-contained**: a saved project includes its satellite backdrop, so reloading doesn't require re-fetching tiles.
- **Cons**
  - Zooming past the capture resolution gets pixelated. Mitigation: users should zoom Leaflet to native max (z=19) before locking. We could capture at 2× or 3× device-pixel-ratio via `html2canvas({ scale: 2 })` in a follow-up if blur becomes a problem.
  - localStorage payload grows by ~1–3 MB per project (base64 PNG overhead). Cleared on unlock; still within Zustand's effective ~5 MB per-origin cap for a single-project-per-browser workflow. If multiple saved projects become a use case, we'd need IndexedDB.
  - The lock action is now async (html2canvas is ~100–300 ms on a typical viewport). Hanging briefly is acceptable; we should show a spinner if it ever becomes user-visibly slow.
  - Re-lock after unlock always re-captures from scratch. That's correct behavior (position may have changed) but means the user can't quickly toggle lock without paying the capture cost again.
