# Roof Split and Merge — Design

- **Status:** Proposed
- **Date:** 2026-04-21
- **Related:** ADR-010 (group-based snapping), drawingSnap edge-snap (already exists)

## Problem

Today, turning one roof polygon into two (e.g. splitting an L-shape into two rectangles to represent a ridge) requires deleting the existing roof and redrawing both halves from scratch — losing panels, strings, and per-roof settings. Symmetrically, merging two adjacent roofs back into one requires the same destructive redraw.

Users naturally want to **draw a line across an existing roof** to split it, and **delete a shared edge** to merge two adjacent roofs. The current `draw-roof` tool closes polygons back to the first vertex and never consults existing roof boundaries as geometry — so an open polyline that starts and ends on an existing roof's edge has no effect.

This design adds non-destructive split and merge operations that preserve panels, strings, and roof settings wherever possible.

## Goals

1. Split one roof into two by drawing a line (2 clicks, both on the roof's boundary) or polyline (3+ clicks) across it.
2. Merge two adjacent roofs by right-clicking the edge they share.
3. Existing roof edges become geometric references for the draw-roof tool (snapping & guides — already mostly there; verify).
4. No new tool mode — split and merge both live inside `draw-roof` mode.
5. Preserve panels, strings, tilt, orientation, roof id, name.

## Non-goals (YAGNI)

- Cutting through multiple roofs in one gesture.
- Cuts that self-intersect or cross a polygon boundary more than twice.
- Rebalancing panels across halves after a split (panels stay on the roofId that already owns them; the user can move strays manually).
- Auto-cleanup of zero-area slivers on merge.
- Merging non-adjacent roofs.
- Undo for split/merge (the project has no undo anywhere yet — deferred per AGENTS.md).

## Interaction model

### Splitting

Trigger: user is in `draw-roof` mode.

1. User clicks a point that — via the existing snap system — lies on an existing roof R's boundary. KonvaOverlay tags `cutCandidateRoofId = R.id` in local state. Visible behavior unchanged: a vertex appears.
2. The hint banner shows: *"Click another edge of this roof to split it, or continue to draw a new polygon."*
3. User places 0+ more interior vertices.
4. Split commit fires when EITHER:
   - The next clicked vertex lies on R's boundary (auto-finish — the common "straight cut" case), OR
   - User presses Enter / double-clicks AND the last vertex lies on R's boundary.
5. On commit: `splitRoof(R.id, drawingPoints)` is called. Drawing state is cleared. Tool returns to `idle`.
6. If the polyline is rejected by `splitPolygon` (e.g. the interior vertices leave and re-enter the polygon, producing >2 boundary intersections) → commit is silently suppressed, the vertex is discarded, the user continues drawing. Same failure mode as "can't place panel here."

Escape cancels as today — clears `drawingPoints` and `cutCandidateRoofId`.

A polyline that starts on R's boundary but whose user closes back to the first vertex (existing close-path gesture) falls through to `addRoof` and creates an overlapping new roof, same as today. Split never fires unless both endpoints are on R's boundary AND the user did not close back.

### Merging

Trigger: user is in `draw-roof` mode. Each committed roof's edges already expose an invisible hit-line (see `RoofLayer.tsx:244` — currently used for drag-to-insert and for the hover-align button).

- Right-click the edge → if it is geometrically shared with another roof's edge (within tolerance), call `mergeRoofs`. If either roof has panels or strings, confirm first. If the edge is not shared, no-op.

This mirrors the existing convention of right-click-on-vertex-handle = remove vertex in the same mode.

### Snap & guides

`drawingSnap.collectEdges` already walks all committed roof edges as snap/guide candidates (lines 102-114 of `drawingSnap.ts`). We verify this holds for both edge-snap and angle-direction candidates during implementation, and document it. No code change expected here.

## Data decisions (from brainstorm)

- **Panel retention on split (Q3):** all panels stay on the original `roofId`, grouped. The half with the majority of panel centers inside it becomes the surviving original; the other half becomes a new empty roof. Panels that end up visually inside the new half remain logically on the original roof (user can move them manually). Rationale: preserves string membership without geometric guessing.
- **Survivor selection on merge (Q4):** the roof with greater area survives (keeps id, name, tilt, orientation). The absorbed roof's panels are reassigned to the survivor's id. Strings span roofs already; we call `renumberStrings` on any string whose membership was touched.
- **Tolerances:** reuse existing `POINT_SNAP_TOL_PX = 10` and `EDGE_SNAP_TOL_PX = 8` from `drawingSnap.ts` for "is this cut endpoint on the boundary?" Checks are done AFTER snapping, so a cursor within snap tolerance of an edge is already snapped onto it before we test.

## Architecture

Three units, each with a single responsibility:

### 1. `src/utils/polygonCut.ts` (new)

Pure geometry. No React, no store imports.

```ts
/** Returns the edge index and parametric t∈[0,1] if p lies within tolPx of
 *  the polygon boundary, else null. Used to verify a proposed cut endpoint
 *  touches the polygon. If p coincides with an existing vertex, prefers
 *  t=0 on the edge starting at that vertex. */
export function pointOnPolygonBoundary(
  p: Point,
  polygon: Point[],
  tolPx: number,
): { edgeIndex: number; t: number } | null;

/** Splits `polygon` along `cutLine`. Requires:
 *    - cutLine.length >= 2
 *    - cutLine[0] and cutLine[last] both on polygon boundary
 *    - interior cutLine points strictly inside polygon
 *    - cutLine does not self-intersect
 *  Returns [polyA, polyB] as two closed polygons (vertex arrays).
 *  Returns null on any violation — caller must treat as "cut rejected". */
export function splitPolygon(
  polygon: Point[],
  cutLine: Point[],
): [Point[], Point[]] | null;

/** Returns a shared-edge descriptor if polyA and polyB share a common edge
 *  (two consecutive vertices that match within tolPx, in either direction),
 *  else null. `reversed` = true iff B traverses the edge in the opposite
 *  direction to A (the normal case for two polygons sharing a boundary). */
export function findSharedEdge(
  polyA: Point[],
  polyB: Point[],
  tolPx: number,
): { aEdgeIndex: number; bEdgeIndex: number; reversed: boolean } | null;

/** Stitches two polygons into one by removing their shared edge.
 *  Walks A from sharedEdge's end vertex around to its start vertex,
 *  then jumps into B and walks from B's matching end back to its start. */
export function mergePolygons(
  polyA: Point[],
  polyB: Point[],
  shared: { aEdgeIndex: number; bEdgeIndex: number; reversed: boolean },
): Point[];
```

`polygonArea` already lives in `geometry.ts` — reused directly, not re-exported.

### 2. `src/store/projectStore.ts` — two new actions

```ts
splitRoof(roofId: string, cutLine: Point[]): void
mergeRoofs(roofAId: string, roofBId: string): void
```

**`splitRoof` behavior:**
1. Look up roof; call `splitPolygon(roof.polygon, cutLine)`. On null → return silently.
2. Compute `polygonArea` of each half (for the name — not used for survivor selection here; panel count decides).
3. Walk panels with `panel.roofId === roofId`; count how many centers fall inside half A vs half B (`pointInPolygon` from `geometry.ts`).
4. The majority-count half = original (`roof.id`, name, tilt, orientation all preserved; `polygon` replaced). Ties broken by greater area.
5. The other half becomes a new roof with a fresh `uid()`, auto-numbered name (`Roof N` — match the pattern `addRoof` uses), and the same tilt and orientation as the original.
6. Panels are NOT modified — they all keep `panel.roofId = original`. No `renumberStrings` call (string membership untouched).
7. One `set` call updates both `roofs` entries (replace original polygon, push new).

**`mergeRoofs` behavior:**
1. Load both roofs. Call `findSharedEdge(A.polygon, B.polygon, tol)`. On null → return silently.
2. Compute areas; pick the larger as `survivor`, smaller as `absorbed`. Ties broken by id sort (deterministic).
3. `mergePolygons(...)` → new polygon. Assign to survivor. Remove absorbed from `roofs`.
4. Walk panels with `panel.roofId === absorbed.id` → reassign to `survivor.id`. Collect the set of `stringId`s those panels belong to (ignoring null).
5. Call `renumberStrings(Array.from(affectedStringIds))` so the wiring snake reflects the merged roof.
6. If `selectedRoofId === absorbed.id`, update to `survivor.id`.

### 3. Interaction wiring — `KonvaOverlay.tsx` + `RoofLayer.tsx`

**`KonvaOverlay.tsx` changes**

- New local state: `const [cutCandidateRoofId, setCutCandidateRoofId] = useState<string | null>(null)`.
- In `handleStageClick` for `toolMode === 'draw-roof'`:
  - After computing the snapped point, BEFORE deciding close-vs-add, test against all roofs: which roof (if any) has this point on its boundary? Call it `hitRoofId`.
  - If `drawingPoints.length === 0` AND `hitRoofId`: set `cutCandidateRoofId = hitRoofId`. Append vertex as usual.
  - If `drawingPoints.length >= 1` AND `cutCandidateRoofId` AND `hitRoofId === cutCandidateRoofId`: this is a split commit. Build `cutLine = [...drawingPoints, snapped]`. Call `splitRoof`. Clear state, exit mode. Return.
  - Else: existing behavior (close-if-near-first-vertex, else append).
- `handleDblClick` for `toolMode === 'draw-roof'`:
  - If `drawingPoints.length >= 2` AND `cutCandidateRoofId` AND last vertex is on that roof's boundary → `splitRoof`. Clear state, exit. Return.
  - Else: existing `addRoof` path.
- Add Enter-to-commit key handler (scoped to draw-roof, ignored in input elements, same pattern as Escape). Same branch logic as double-click.
- Escape also clears `cutCandidateRoofId`.

**`RoofLayer.tsx` changes**

- The per-edge `<Line>` hit-area (around line 244) gains an `onContextMenu` handler active only when `toolMode === 'draw-roof'`:
  - `e.evt.preventDefault(); e.cancelBubble = true;`
  - Iterate other roofs, call `findSharedEdge` with this roof. First hit wins.
  - If found: if either roof has panels or strings touching it, `window.confirm(...)`. Then `mergeRoofs(survivorId, absorbedId)`.
  - If not shared: no-op (log to console for debuggability, no user-visible feedback).

**Hint banner (`App.tsx` or wherever the hint lives)**

- When `toolMode === 'draw-roof'` AND `cutCandidateRoofId !== null`, append/replace the hint text with the split-specific hint. Requires plumbing `cutCandidateRoofId` up from KonvaOverlay — cleanest via a small piece of ephemeral store state (`splitCandidateRoofId` on the store, partialized out so it doesn't persist), OR via prop-drilling from the shared parent. Choose store state; it matches the existing pattern for `toolMode`, `selectedRoofId`, `activeStringId`.

## Data flow summary

```
User click in draw-roof
   ▼
KonvaOverlay.handleStageClick
   ▼
snap → pointOnPolygonBoundary against every roof
   ▼
  ┌─ first-vertex case ──────► set cutCandidateRoofId, append vertex
  ├─ matching-boundary case ─► store.splitRoof(roofId, cutLine) ──► polygonCut.splitPolygon
  │                                                            └─► pointInPolygon × panels
  │                                                            └─► set(roofs updated)
  ├─ close-to-first case ────► store.addRoof (unchanged)
  └─ else ───────────────────► append vertex
```

```
Right-click on edge in draw-roof
   ▼
RoofLayer edge onContextMenu
   ▼
polygonCut.findSharedEdge (loop other roofs)
   ▼
store.mergeRoofs ──► polygonArea (pick survivor)
             └────► polygonCut.mergePolygons
             └────► reassign panels, renumberStrings
             └────► set(roofs, panels, selectedRoofId?)
```

## Testing & verification

No automated tests in this repo (per AGENTS.md). Manual acceptance gate:

- **Happy split:** draw a rectangle, then split with a vertical line → two rectangles, original id preserved on whichever half has more panels (or equal-area tiebreak).
- **Polyline split:** split with a 3-vertex polyline (L-cut) → two non-rectangular polygons, commit on Enter.
- **Invalid split rejected:** polyline that enters and leaves the polygon multiple times → `splitPolygon` returns null → draw continues or is cleared by Escape, no crash.
- **Merge adjacent rectangles:** split a roof, then right-click the shared edge → back to a single roof with the original id. Panels and strings intact.
- **Merge with panels on both:** place panels on both halves, merge, verify all panels now have `roofId = survivor` and strings renumber correctly.
- **Non-shared edge right-click:** right-click a boundary edge that is NOT shared with any other roof → no crash, no merge.
- **Typecheck:** `npx tsc --noEmit` clean.
- **Build gate:** `npm run build` clean.

Verification step: spot-check `collectEdges` in `drawingSnap.ts` during implementation to confirm existing roof edges are still being included for angle snap and edge snap after any refactor (no change expected, but note as a regression surface).

## File impact summary

| File | Change |
|---|---|
| `src/utils/polygonCut.ts` | NEW — four pure-geometry functions |
| `src/store/projectStore.ts` | Add `splitRoof`, `mergeRoofs`, plus ephemeral `splitCandidateRoofId` state + setter |
| `src/components/KonvaOverlay.tsx` | Split-detection in `handleStageClick` / `handleDblClick`; Enter key; Escape clears candidate; plumb hint |
| `src/components/RoofLayer.tsx` | Add `onContextMenu` to the per-edge `<Line>` hit-area (draw-roof only) |
| `src/App.tsx` | Extend hint banner text when `splitCandidateRoofId` is set |
| `src/types/index.ts` | No new persisted types (split/merge modify existing Roof/Panel arrays) |

## Risks

- `splitPolygon` correctness is the single biggest risk. Cases like "cut endpoint exactly on an existing vertex" and "cut tangent to an edge" need explicit handling in tests. Implementation will include boundary-case code comments per project convention.
- Right-click already has a Stage-level `onContextMenu` preventDefault in `KonvaOverlay` and also drives pan. Merging must not conflict with pan activation. The Stage handler fires on empty space; the per-edge handler will `cancelBubble` to stop the Stage handler. Pan is triggered by `button === 2` on `mousedown`, which is a different event from `contextmenu` — verify during implementation that we don't accidentally begin a pan when merging.
- The "panels stay on original roof" rule means after a split you can have panels geometrically inside a different roof's polygon. This is known and accepted (Q3 answer). Document in inline comments so a future reader doesn't "fix" it.
