# ADR-019: Snap the roof draw tool to edges detected in the satellite image

**Status:** Accepted (prototype)

**Date:** 2026-10-07

## Requirement

While drawing a roof polygon, the cursor should snap to roof edges that are
visible in the satellite imagery (eaves, ridges, roof-face boundaries) — not
only to geometry the user has already drawn.

## Context

- After map lock, the satellite view is a static raster (`capturedImage`)
  whose pixel frame is the drawing frame up to a uniform factor
  (`capturedWidth / naturalWidth`, i.e. 1/devicePixelRatio). Image-space
  results need no geo-referencing.
- `computeDrawingSnap` already works on reference edges (edge snap,
  parallel/perpendicular directions, ray stops), so detected edges can plug
  into it as one more source.
- Alternatives considered: vector building footprints (OSM / cadastre — clean
  but outlines only, often offset from the imagery, not everywhere), regional
  LoD2 3D roof models (best data but regional, larger effort), ML
  segmentation (heavy). Image edges match "what I see" everywhere and need no
  external service.

## Decision

1. **Detector** (`src/utils/imageEdges.ts`, pure): a reduced LSD — Gaussian
   blur, Sobel gradients, region growing of gradient-aligned pixels, weighted
   PCA line fit with geometric filters, and LSD's a-contrario (NFA) test so
   noise fragments can't masquerade as lines. Runs at full and half
   resolution (the half-res pass makes low-contrast roofs detectable), then
   merges collinear pieces. Defaults are tuned on a synthetic benchmark that
   is part of the test suite (recall ≥ 95 % on clear roofs, no false lines in
   strong noise); ~100–150 ms for a 1.4–1.6 MP capture.
2. **Execution:** once per captured image, in a Web Worker
   (`src/workers/imageEdges.worker.ts`), driven by `useImageEdges` in
   `KonvaOverlay`, which reuses the decoded backdrop, downscales to ≤ 1600 px,
   converts results to world coordinates and builds a grid spatial index
   (`ImageEdgeIndex`). Main-thread fallback if workers are unavailable.
   Results are cached per image; nothing is persisted or synced.
3. **Snapping priority** (in `computeDrawingSnap`): own corner > own edge >
   **image corner** (crossing of two detected lines near the cursor, also for
   the first vertex) > direction snaps / vertex alignment, where a locked
   direction can **stop on a detected edge** > **projection onto a detected
   edge** (no direction lock). Tolerances are screen pixels (corner 12, edge
   7, search radius 40). Shift disables everything, as before.
4. **UI:** toolbar toggle "Edges" (on by default; shows detection progress
   in its tooltip). Detected edges within ~90 screen px of the cursor are
   drawn faintly while drawing so users see what can snap.
   `snapToImageEdges` / `imageEdgeStatus` are UI state in the store
   (`bypass` actions), not part of `project`.

## Consequences

- Drawing along visible eaves and placing corners becomes precise without
  zooming in — the snap pulls only when the cursor is already within a few
  screen pixels.
- Quality depends on the imagery: crisp orthophotos work well; trees, deep
  shadows and blurry tiles yield fewer edges (the snap then simply doesn't
  engage). Shadow edges or existing PV module rows can be detected as lines;
  own geometry always wins over them, and Shift bypasses them.
- The capture only covers what was on screen at lock time, so edges outside
  it can't be detected.
- Detection parameters live in `imageEdges.ts`; change them only together
  with the benchmark tests in `imageEdges.test.ts`.
