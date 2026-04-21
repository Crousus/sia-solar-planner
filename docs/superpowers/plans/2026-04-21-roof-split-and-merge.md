# Roof Split and Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users split a roof by drawing a line across it (inside `draw-roof` mode) and merge two adjacent roofs by right-clicking their shared edge, preserving panels, strings, and per-roof settings throughout.

**Architecture:** Three layers. (1) A new pure-geometry module `src/utils/polygonCut.ts` with four functions: boundary hit-test, polygon-split-by-polyline, shared-edge detection, and polygon merge. (2) Two new Zustand actions (`splitRoof`, `mergeRoofs`) plus one ephemeral UI field (`splitCandidateRoofId`). (3) Interaction wiring in `KonvaOverlay.tsx`, `RoofLayer.tsx`, and the hint banner in `App.tsx`.

**Tech Stack:** TypeScript (strict), React 18, Zustand 4 (with `persist` + `partialize`), react-konva. No test framework is configured — acceptance gates are `npx tsc --noEmit`, `npm run build`, and manual browser verification in `npm run dev`.

**Spec:** `docs/superpowers/specs/2026-04-21-roof-split-and-merge-design.md`.

**Convention reminder:** Per `.claude/.../memory/feedback_inline_comments.md`, this project uses generous inline comments explaining WHY. All new code in this plan follows that convention — every non-trivial block gets a block comment covering purpose, approach, and reasoning.

**Commit convention:** Per `feedback_commit_messages.md`, commits in this project must NOT include a `Co-Authored-By: Claude ...` trailer. Plain subject + body only.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/utils/polygonCut.ts` | NEW | Pure geometry: boundary hit-test, split, shared-edge detect, merge |
| `src/store/projectStore.ts` | MODIFY | Add ephemeral `splitCandidateRoofId` + setter, `splitRoof` action, `mergeRoofs` action |
| `src/components/KonvaOverlay.tsx` | MODIFY | Detect split during draw-roof; Enter to commit; Escape clears candidate |
| `src/components/RoofLayer.tsx` | MODIFY | Right-click on per-edge hit-area → merge if shared |
| `src/components/App.tsx` | MODIFY | Extend hint banner when `splitCandidateRoofId` is set (post-lock hint) |

No changes to `src/types/index.ts` (split and merge only rearrange existing arrays).

---

## Task 1: Scaffold `polygonCut.ts` with `pointOnPolygonBoundary`

**Files:**
- Create: `src/utils/polygonCut.ts`

- [ ] **Step 1: Create the file with the function**

```ts
// src/utils/polygonCut.ts
// ────────────────────────────────────────────────────────────────────────────
// polygonCut — pure geometry for splitting a polygon by a polyline and
// merging two adjacent polygons. Used by the store's `splitRoof` /
// `mergeRoofs` actions and by KonvaOverlay's split-detection.
//
// Everything here operates in canvas pixel space (same convention as
// geometry.ts — see AGENTS.md for coordinate-system notes). Tolerances
// are given in CANVAS PIXELS, not meters, because all callers work in
// canvas space and already have mpp available if they want to convert.
//
// No React, no store, no Konva. Deterministic functions only.
// ────────────────────────────────────────────────────────────────────────────

import type { Point } from '../types';

/**
 * Boundary hit-test.
 *
 * Returns the edge index and parametric position `t` ∈ [0,1] along that
 * edge if `p` lies within `tolPx` of the polygon's boundary, else null.
 *
 * Why we care: the split feature needs to know whether a user-placed
 * vertex is "on" an existing roof's boundary. Everything downstream
 * (splitPolygon) assumes the cut endpoints are exactly on the
 * boundary — snapping is the caller's responsibility (via
 * drawingSnap.ts), but we still run this test to decide which roof
 * (if any) is being cut.
 *
 * Preference rule: if the hit straddles a vertex (t=0 or t≈1), we
 * prefer the edge that STARTS at that vertex (t=0) — this keeps the
 * returned index deterministic when the user snaps exactly to a corner.
 *
 * Edge case: degenerate edges (zero-length) are skipped — they can't
 * produce a meaningful `t` and never appear in a valid polygon anyway.
 */
export function pointOnPolygonBoundary(
  p: Point,
  polygon: Point[],
  tolPx: number,
): { edgeIndex: number; t: number } | null {
  if (polygon.length < 3) return null;

  // Prefer a vertex hit first — deterministic (t=0 at the start of the
  // owning edge). This matters because snapping often puts the point
  // exactly on a corner, and without this preference we could return
  // t≈1 on edge i-1 one call and t≈0 on edge i the next, depending on
  // floating-point noise.
  for (let i = 0; i < polygon.length; i++) {
    const v = polygon[i];
    if (Math.hypot(v.x - p.x, v.y - p.y) <= tolPx) {
      return { edgeIndex: i, t: 0 };
    }
  }

  // Fall back to nearest-edge projection. We track the best (smallest
  // distance) hit so the returned index is stable when the point is
  // ambiguously close to two edges at a convex vertex within tol.
  let bestIdx = -1;
  let bestT = 0;
  let bestDist = tolPx;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-9) continue; // degenerate edge
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const d = Math.hypot(p.x - px, p.y - py);
    if (d <= bestDist) {
      bestDist = d;
      bestIdx = i;
      bestT = t;
    }
  }

  return bestIdx === -1 ? null : { edgeIndex: bestIdx, t: bestT };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/utils/polygonCut.ts
git commit -m "Add polygonCut.ts with pointOnPolygonBoundary

Pure-geometry scaffold for the upcoming roof split/merge feature.
pointOnPolygonBoundary tells callers whether a point lies on a
polygon's boundary (within pixel tolerance) and where — prefers
vertex hits to keep the returned edge index stable across
floating-point noise when snapping to corners."
```

---

## Task 2: Add `splitPolygon` to `polygonCut.ts`

**Files:**
- Modify: `src/utils/polygonCut.ts`

- [ ] **Step 1: Append `splitPolygon` below `pointOnPolygonBoundary`**

```ts
/**
 * Split `polygon` along `cutLine`.
 *
 * Preconditions (enforced inside):
 *   - cutLine has ≥ 2 points
 *   - cutLine[0] and cutLine[last] lie on polygon's boundary (within tolPx)
 *   - The two endpoints lie on DIFFERENT edges (same-edge = degenerate;
 *     we'd produce a zero-area sliver)
 *   - Interior cutLine points (if any) lie strictly INSIDE the polygon
 *
 * Returns [polyA, polyB] or null on any violation. Callers treat a null
 * return as "cut rejected" — the draw-roof tool silently discards the
 * vertex, matching how `snapPanelToGrid` communicates rejection.
 *
 * Algorithm:
 *   1. Find which edge each endpoint sits on (via pointOnPolygonBoundary).
 *   2. Insert both endpoints as new vertices in a working copy of
 *      `polygon` — but CAREFULLY: inserting in one edge shifts later
 *      indices, so we insert the later one first.
 *   3. Identify the two inserted vertex indices in the modified polygon.
 *   4. Walk the modified polygon from insertedA to insertedB (forward
 *      around the ring) to get arcA. Walk the other way to get arcB.
 *   5. polyA = arcA ++ reversed-middle-of-cutLine (so the cut connects
 *      B back to A). polyB = arcB ++ middle-of-cutLine (same idea, other
 *      direction).
 *
 * Why "middle-of-cutLine" and not "cutLine": the first and last points
 * are ALREADY in the polygon (as inserted boundary vertices). Including
 * them again would produce adjacent duplicate vertices.
 *
 * Interior-inside check: we require every interior cut vertex to be
 * strictly inside the polygon. Without this, a user could draw a
 * polyline that leaves and re-enters the polygon, producing more than
 * two boundary intersections — which we explicitly don't support (spec
 * YAGNI: "cuts that cross the boundary more than twice").
 */
export function splitPolygon(
  polygon: Point[],
  cutLine: Point[],
  tolPx: number = 8,
): [Point[], Point[]] | null {
  if (cutLine.length < 2 || polygon.length < 3) return null;

  const start = cutLine[0];
  const end = cutLine[cutLine.length - 1];

  const hitA = pointOnPolygonBoundary(start, polygon, tolPx);
  const hitB = pointOnPolygonBoundary(end, polygon, tolPx);
  if (!hitA || !hitB) return null;

  // Same-edge endpoints would produce a degenerate zero-area sliver.
  // We reject early — the UI treats null the same as any other
  // rejection.
  if (hitA.edgeIndex === hitB.edgeIndex) return null;

  // Interior points must be strictly inside. We import isInsidePolygon
  // lazily via a local implementation to keep this module free of
  // cross-imports from geometry.ts — polygonCut is meant to be a
  // self-contained unit.
  for (let i = 1; i < cutLine.length - 1; i++) {
    if (!isStrictlyInside(cutLine[i], polygon)) return null;
  }

  // Snap the actual cut endpoints to the edges (projected along the
  // hit's parametric t). This matters when the caller's snap didn't
  // land exactly on the boundary but within tolerance — we want the
  // resulting polygon halves to share the boundary vertex exactly.
  const snapStart = pointAlongEdge(polygon, hitA.edgeIndex, hitA.t);
  const snapEnd = pointAlongEdge(polygon, hitB.edgeIndex, hitB.t);

  // Insert the later index first so earlier insertions don't shift it.
  // Build a list of (edgeIndex, t, snappedPoint, tag) and process in
  // descending-edgeIndex order.
  type Insertion = { edgeIndex: number; t: number; point: Point; tag: 'A' | 'B' };
  const insertions: Insertion[] = [
    { edgeIndex: hitA.edgeIndex, t: hitA.t, point: snapStart, tag: 'A' },
    { edgeIndex: hitB.edgeIndex, t: hitB.t, point: snapEnd,   tag: 'B' },
  ];
  // Sort descending by edgeIndex. Tie on t: higher t first (same reason —
  // inserting at higher t on the same edge would shift the lower insertion).
  // But we already rejected same-edge above, so the tie path is unreachable;
  // we still sort defensively.
  insertions.sort((x, y) =>
    y.edgeIndex !== x.edgeIndex ? y.edgeIndex - x.edgeIndex : y.t - x.t,
  );

  const modified = polygon.slice();
  const taggedIndex: Record<'A' | 'B', number> = { A: -1, B: -1 };
  for (const ins of insertions) {
    // t=0 would be identical to the start vertex → skip insertion and
    // reuse that vertex as the tagged index. Same for t=1 → the end
    // vertex of the edge (which is index (edgeIndex+1) % polygon.length,
    // BUT we still need to account for prior insertions shifting it).
    if (ins.t < 1e-6) {
      // Maps to the start vertex of the edge in the CURRENT modified
      // array. Prior insertions at higher edgeIndex don't affect
      // positions at lower edgeIndex, so this is just `ins.edgeIndex`.
      taggedIndex[ins.tag] = ins.edgeIndex;
      continue;
    }
    if (ins.t > 1 - 1e-6) {
      // End vertex = edgeIndex+1 mod length — we treat it as "a vertex
      // already exists here; point the cut at it". Again, no splice
      // needed. Use modulo on the CURRENT length so it's valid if we
      // already inserted at a later edge.
      taggedIndex[ins.tag] = (ins.edgeIndex + 1) % modified.length;
      continue;
    }
    // Generic case: splice a new vertex between edgeIndex and edgeIndex+1.
    modified.splice(ins.edgeIndex + 1, 0, ins.point);
    taggedIndex[ins.tag] = ins.edgeIndex + 1;
  }

  const idxA = taggedIndex.A;
  const idxB = taggedIndex.B;
  if (idxA === -1 || idxB === -1 || idxA === idxB) return null;

  // Walk forward from idxA to idxB around the ring to get arcA.
  const arcA: Point[] = [];
  for (let i = idxA; i !== idxB; i = (i + 1) % modified.length) {
    arcA.push(modified[i]);
  }
  arcA.push(modified[idxB]);

  // Walk forward from idxB to idxA to get arcB.
  const arcB: Point[] = [];
  for (let i = idxB; i !== idxA; i = (i + 1) % modified.length) {
    arcB.push(modified[i]);
  }
  arcB.push(modified[idxA]);

  // Interior cut vertices (everything between endpoints). If the caller
  // passed a straight 2-point cut, this is empty.
  const interior = cutLine.slice(1, cutLine.length - 1);

  // polyA closes by going arcA (idxA → idxB around ring) then back
  // along the cut (reversed interior) to idxA.
  const polyA = [...arcA, ...interior.slice().reverse()];
  // polyB closes by going arcB (idxB → idxA the other way) then
  // forward along the cut to idxB.
  const polyB = [...arcB, ...interior];

  // Sanity check: both halves must have ≥ 3 vertices (not counting
  // duplicate close). If the cut degenerates (e.g. both endpoints
  // hit the same vertex through different edges) we reject.
  if (polyA.length < 3 || polyB.length < 3) return null;

  return [polyA, polyB];
}

/**
 * Point along edge `edgeIndex` of `polygon` at parametric t.
 * t=0 is the edge's start vertex; t=1 is the end vertex.
 */
function pointAlongEdge(polygon: Point[], edgeIndex: number, t: number): Point {
  const a = polygon[edgeIndex];
  const b = polygon[(edgeIndex + 1) % polygon.length];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * Strict ray-casting point-in-polygon. Identical algorithm to
 * isInsidePolygon in geometry.ts but duplicated here to keep
 * polygonCut self-contained (per the "no cross-imports within utils"
 * convention noted in AGENTS.md — utils depend only on types).
 */
function isStrictlyInside(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/utils/polygonCut.ts
git commit -m "Add splitPolygon to polygonCut.ts

Given a polygon and a polyline with endpoints on the boundary, produce
two closed polygons. Rejects degenerate cases (same-edge endpoints,
interior vertices outside the polygon) by returning null — callers
treat null as 'cut refused' per the existing geometry-utility
convention."
```

---

## Task 3: Add `findSharedEdge` and `mergePolygons` to `polygonCut.ts`

**Files:**
- Modify: `src/utils/polygonCut.ts`

- [ ] **Step 1: Append to the file**

```ts
/**
 * Shared-edge descriptor — two polygons share an edge if there exist
 * consecutive vertex pairs (A[i], A[i+1]) and (B[j], B[j+1]) where the
 * endpoints match within tolPx, in EITHER direction.
 *
 * `reversed` = true is the usual case: adjacent polygons traverse
 * their shared edge in opposite winding, because both polygons are
 * wound the same way (e.g. both clockwise) around their own interiors.
 * reversed = false would indicate identical orientation — rare but
 * possible if the user drew both polygons in opposite winding orders.
 *
 * We return the first match found; if polygons share multiple edges
 * (which shouldn't happen with the simple shapes this tool produces,
 * but isn't mathematically forbidden), the caller only merges one.
 */
export type SharedEdge = {
  aEdgeIndex: number;
  bEdgeIndex: number;
  reversed: boolean;
};

export function findSharedEdge(
  polyA: Point[],
  polyB: Point[],
  tolPx: number = 2,
): SharedEdge | null {
  const near = (p: Point, q: Point) =>
    Math.hypot(p.x - q.x, p.y - q.y) <= tolPx;
  for (let i = 0; i < polyA.length; i++) {
    const a0 = polyA[i];
    const a1 = polyA[(i + 1) % polyA.length];
    for (let j = 0; j < polyB.length; j++) {
      const b0 = polyB[j];
      const b1 = polyB[(j + 1) % polyB.length];
      // Two polygons adjacent on a shared edge normally traverse it in
      // opposite directions — try reversed first, then same-direction
      // as a fallback for weirdly-wound inputs.
      if (near(a0, b1) && near(a1, b0)) {
        return { aEdgeIndex: i, bEdgeIndex: j, reversed: true };
      }
      if (near(a0, b0) && near(a1, b1)) {
        return { aEdgeIndex: i, bEdgeIndex: j, reversed: false };
      }
    }
  }
  return null;
}

/**
 * Stitch two polygons into one by removing their shared edge.
 *
 * Concept: walk A starting from the END vertex of the shared edge
 * all the way around (skipping the shared edge itself) back to the
 * START vertex. Then jump to B at the matching point and do the same,
 * finishing by returning to where we started on A.
 *
 * Concretely, given shared edge A[i]→A[i+1] matched to B's edge:
 *   result = [A[i+1], A[i+2], ..., A[i], then B's boundary from
 *             the matching start vertex around back to the matching
 *             end vertex]
 *
 * The `reversed` flag flips which direction we walk B.
 *
 * Post-processing: we do NOT dedupe adjacent near-duplicate vertices —
 * if two polygons were drawn with almost-but-not-quite coincident
 * shared-edge endpoints, the merged polygon will have a 2-vertex
 * "zigzag" at each end. Per spec YAGNI, we accept that; visually it's
 * imperceptible at tolPx=2, and cleanup can be added later if needed.
 */
export function mergePolygons(
  polyA: Point[],
  polyB: Point[],
  shared: SharedEdge,
): Point[] {
  const { aEdgeIndex: i, bEdgeIndex: j, reversed } = shared;
  const nA = polyA.length;
  const nB = polyB.length;

  // Walk A from (i+1) to (i) around the ring, INCLUDING both endpoints.
  // These are the vertices that survive from A (everything except the
  // shared-edge pair that gets replaced by the B detour).
  const fromA: Point[] = [];
  for (let k = 0; k < nA; k++) {
    const idx = (i + 1 + k) % nA;
    fromA.push(polyA[idx]);
  }
  // fromA now starts at A[i+1] and ends at A[i].

  // Walk B to get the interior path between B's matching vertices.
  // If reversed (normal case): A[i]→A[i+1] equals B[j+1]→B[j]. So the
  // B "detour" that replaces the shared edge runs from B[j+1] back
  // around to B[j], EXCLUDING those two vertices (they're already
  // represented by A[i] and A[i+1]).
  // If not reversed: A[i]→A[i+1] equals B[j]→B[j+1]; detour runs from
  // B[j] around to B[j+1] excluding both.
  const fromB: Point[] = [];
  if (reversed) {
    // Start one past B[j+1], end one before B[j], going forward.
    for (let k = 1; k < nB - 1; k++) {
      fromB.push(polyB[(j + 2 + k) % nB]);
    }
    // The loop above yields nB - 2 vertices, which is every B vertex
    // EXCEPT B[j] and B[j+1] — correct.
  } else {
    // Walk B backward from B[j-1] around to B[j+2].
    for (let k = 1; k < nB - 1; k++) {
      fromB.push(polyB[(j - k + nB) % nB]);
    }
  }

  // Composition: A's arc then B's detour. fromA already ends at A[i];
  // fromB begins with B's next vertex after the shared edge's end on
  // A's side; they stitch naturally.
  return [...fromA, ...fromB];
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/utils/polygonCut.ts
git commit -m "Add findSharedEdge and mergePolygons to polygonCut.ts

Closes the polygonCut module: boundary hit-test + split + shared-edge
detection + merge. All four functions are pure and self-contained —
the module imports only from types, never from sibling utils."
```

---

## Task 4: Add ephemeral `splitCandidateRoofId` state to the store

**Files:**
- Modify: `src/store/projectStore.ts`

- [ ] **Step 1: Extend the `UIState` interface**

Find the `UIState` interface (around line 79). Add a new field at the bottom of the interface — next to `showBackground`:

```ts
  showBackground: boolean;
  /**
   * Ephemeral cut-target tracking. When the user is in `draw-roof` mode
   * and has placed their first vertex on the boundary of an existing
   * roof, we remember THAT roof's id here so subsequent clicks / Enter
   * can decide whether to fire a split vs. an `addRoof` close-path.
   *
   * Kept in the store (rather than KonvaOverlay local state) because
   * App.tsx's hint banner also needs to read it — and plumbing a prop
   * through would mean changing KonvaOverlay's interface unnecessarily.
   * Excluded from persistence via the existing `partialize` which
   * only persists `project`.
   */
  splitCandidateRoofId: string | null;
```

- [ ] **Step 2: Add the setter to the `ProjectStore` interface**

Find the `ProjectStore` interface (around line 98). Add near the other setters (after `setActivePanelGroup`):

```ts
  setActivePanelGroup: (id: string | null) => void;
  setSplitCandidateRoof: (id: string | null) => void;
```

- [ ] **Step 3: Initialize the field + implement the setter**

Near the `toolMode: 'idle'` initial value (around line 213) and the other setters, add:

Find:
```ts
      project: initialProject,
      toolMode: 'idle',
```

Add below `toolMode: 'idle'`:
```ts
      splitCandidateRoofId: null,
```

Then find `setActivePanelGroup` (grep for it) and add after its closing `,`:

```ts
      setSplitCandidateRoof: (id) => set({ splitCandidateRoofId: id }),
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/store/projectStore.ts
git commit -m "Add splitCandidateRoofId ephemeral state to store

New field + setter for tracking which roof's boundary the user's
in-progress polyline started on. Not persisted (excluded via the
existing partialize). Consumed next by KonvaOverlay's split
detection and App's hint banner."
```

---

## Task 5: Add `splitRoof` store action

**Files:**
- Modify: `src/store/projectStore.ts`

- [ ] **Step 1: Add to the `ProjectStore` interface**

Find the interface block (near line 98). Add after `deleteRoof`:

```ts
  deleteRoof: (id: string) => void;
  /** Split a roof along a polyline cut. No-op if the cut is invalid.
   *  Panels all stay assigned to the original roofId; the half with
   *  MORE panel centers inside it becomes the survivor (keeps id,
   *  name, tilt, orientation). The other half becomes a new empty
   *  roof. See ADR / design doc for rationale. */
  splitRoof: (roofId: string, cutLine: Point[]) => void;
```

- [ ] **Step 2: Add the `polygonCut` import at the top of the file**

Find the existing imports block. Add:

```ts
import { polygonArea, panelDisplaySize, roofPrimaryAngle, rotatePoint, isInsidePolygon } from '../utils/geometry';
import { splitPolygon, findSharedEdge, mergePolygons } from '../utils/polygonCut';
```

Note: the existing import line for `geometry` may already include some of the names; merge carefully. Also make sure `isInsidePolygon` is exported from `geometry.ts` (it is — verified during planning). Keep any other existing imports untouched.

- [ ] **Step 3: Implement `splitRoof` after `deleteRoof`**

Find the `deleteRoof` action (around line 246). Directly after its closing `}),`, add:

```ts
      // ── Split a roof into two by a polyline cut ────────────────────
      // All panels stay on the original roofId (grouped). The half with
      // MORE panel centers inside it becomes the original (keeps id,
      // name, tilt, orientation). The other half is a brand-new empty
      // roof. If `splitPolygon` rejects the cut (same-edge endpoints,
      // interior vertex outside the polygon, degenerate result), this
      // action is a no-op — callers in KonvaOverlay treat that the
      // same as "polyline not committable yet".
      //
      // Edge-case: panels that geometrically fall inside the NEW half
      // still keep `roofId = original`. They'll visually overlap the
      // new roof's polygon. This is intentional per the design doc
      // (Q3b); the user can move them manually if desired.
      splitRoof: (roofId, cutLine) =>
        set((s) => {
          const roof = s.project.roofs.find((r) => r.id === roofId);
          if (!roof) return s;
          const result = splitPolygon(roof.polygon, cutLine);
          if (!result) return s;
          const [polyA, polyB] = result;

          // Count panels in each half. Panels belong to this roofId
          // (we filter first), and for each we test which half its
          // center (cx, cy) falls into. Centers exactly on the cut
          // line are rare and resolved by isInsidePolygon's
          // unspecified-boundary behavior — good enough here.
          const roofPanels = s.project.panels.filter((p) => p.roofId === roofId);
          let countA = 0;
          let countB = 0;
          for (const p of roofPanels) {
            if (isInsidePolygon({ x: p.cx, y: p.cy }, polyA)) countA++;
            else if (isInsidePolygon({ x: p.cx, y: p.cy }, polyB)) countB++;
          }

          // Survivor selection: majority panel count wins. Ties broken
          // by greater area so the "dominant" half visually keeps the
          // id. If both have 0 panels AND equal area (essentially
          // impossible in practice), A wins by default.
          const areaA = polygonArea(polyA);
          const areaB = polygonArea(polyB);
          const aWins =
            countA > countB ||
            (countA === countB && areaA >= areaB);
          const survivorPoly = aWins ? polyA : polyB;
          const newPoly = aWins ? polyB : polyA;

          // New roof inherits tilt + orientation, gets a fresh id and
          // an auto-numbered name using the same pattern as `addRoof`.
          const newId = uid();
          const newRoof: Roof = {
            id: newId,
            name: `Roof ${s.project.roofs.length + 1}`,
            polygon: newPoly,
            tiltDeg: roof.tiltDeg,
            panelOrientation: roof.panelOrientation,
          };

          const updatedRoofs = s.project.roofs.map((r) =>
            r.id === roofId ? { ...r, polygon: survivorPoly } : r,
          );
          // Clear the cut-candidate marker on commit — the draw flow
          // that created it is done with.
          return {
            project: { ...s.project, roofs: [...updatedRoofs, newRoof] },
            splitCandidateRoofId: null,
          };
        }),
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/store/projectStore.ts
git commit -m "Add splitRoof store action

Splits a roof along a polyline cut. Panels stay grouped on the
original roofId; the half with more panel centers wins (ties by
area). The other half becomes a new empty roof inheriting tilt
and orientation. A rejected cut is a silent no-op."
```

---

## Task 6: Add `mergeRoofs` store action

**Files:**
- Modify: `src/store/projectStore.ts`

- [ ] **Step 1: Extend the `ProjectStore` interface**

Add right after the `splitRoof` declaration:

```ts
  splitRoof: (roofId: string, cutLine: Point[]) => void;
  /** Merge two adjacent roofs. No-op if they don't share an edge.
   *  The larger-area roof survives (keeps id/name/tilt/orientation);
   *  the smaller is absorbed — its panels are reassigned to the
   *  survivor's id and affected strings are renumbered. */
  mergeRoofs: (roofAId: string, roofBId: string) => void;
```

- [ ] **Step 2: Implement `mergeRoofs` after `splitRoof`**

Directly after `splitRoof`'s closing `}),`, add:

```ts
      // ── Merge two adjacent roofs ────────────────────────────────────
      // Triggered by right-click on a shared edge (see RoofLayer.tsx).
      // Survivor = larger-area roof (keeps id, name, tilt, orientation);
      // absorbed roof's polygon is stitched into the survivor and the
      // absorbed roof is deleted. Panels with absorbed.roofId get
      // reassigned to survivor.id — their positions stay exactly where
      // they were. Strings can span roofs, but their index-in-string
      // snake ordering is relative to panel positions on the (possibly
      // differently-shaped) merged roof, so we renumber every string
      // that had members on either side.
      //
      // If the two roofs don't share an edge (caller passed the wrong
      // pair, or the user right-clicked an edge that happens to only
      // belong to one roof), this is a no-op.
      mergeRoofs: (roofAId, roofBId) =>
        set((s) => {
          if (roofAId === roofBId) return s;
          const roofA = s.project.roofs.find((r) => r.id === roofAId);
          const roofB = s.project.roofs.find((r) => r.id === roofBId);
          if (!roofA || !roofB) return s;

          const shared = findSharedEdge(roofA.polygon, roofB.polygon);
          if (!shared) return s;

          // Larger-area roof survives. Ties broken by id sort (stable).
          const areaA = polygonArea(roofA.polygon);
          const areaB = polygonArea(roofB.polygon);
          const aSurvives =
            areaA > areaB || (areaA === areaB && roofAId < roofBId);
          const survivor = aSurvives ? roofA : roofB;
          const absorbed = aSurvives ? roofB : roofA;

          // When survivor is B, we need to swap `shared`'s A/B roles
          // so mergePolygons is called with (survivor, absorbed, ...).
          // findSharedEdge returns indices relative to its input order,
          // so we invert the mapping here.
          const sharedForSurvivor = aSurvives
            ? shared
            : {
                aEdgeIndex: shared.bEdgeIndex,
                bEdgeIndex: shared.aEdgeIndex,
                reversed: shared.reversed,
              };

          const mergedPolygon = mergePolygons(
            survivor.polygon,
            absorbed.polygon,
            sharedForSurvivor,
          );

          // Reassign absorbed's panels to survivor. Track which
          // stringIds were touched so we can renumber them after the
          // reassignment is in place.
          const affectedStringIds = new Set<string>();
          const updatedPanels = s.project.panels.map((p) => {
            if (p.roofId === absorbed.id) {
              if (p.stringId) affectedStringIds.add(p.stringId);
              return { ...p, roofId: survivor.id };
            }
            // Panels already on the survivor are also part of strings
            // that may need renumbering if the survivor itself had
            // strings spanning the shared edge. Collect those ids too.
            if (p.roofId === survivor.id && p.stringId) {
              affectedStringIds.add(p.stringId);
            }
            return p;
          });

          const renumbered = renumberStrings(updatedPanels, affectedStringIds);

          return {
            project: {
              ...s.project,
              roofs: s.project.roofs
                .filter((r) => r.id !== absorbed.id)
                .map((r) =>
                  r.id === survivor.id ? { ...r, polygon: mergedPolygon } : r,
                ),
              panels: renumbered,
            },
            // If the absorbed roof was selected, move selection to
            // survivor so the sidebar doesn't jump to "nothing selected".
            selectedRoofId:
              s.selectedRoofId === absorbed.id
                ? survivor.id
                : s.selectedRoofId,
          };
        }),
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/store/projectStore.ts
git commit -m "Add mergeRoofs store action

Merges two adjacent roofs (shared edge required). Larger-area roof
survives; absorbed roof's panels reassign to survivor's id; affected
strings renumber. Silently no-ops when no shared edge exists."
```

---

## Task 7: Split detection in `KonvaOverlay.tsx`

**Files:**
- Modify: `src/components/KonvaOverlay.tsx`

- [ ] **Step 1: Import what we need**

Near the existing imports at the top of the file, add:

```ts
import { pointOnPolygonBoundary } from '../utils/polygonCut';
```

- [ ] **Step 2: Wire the store selector and setter**

Near the other `useProjectStore` selectors (around line 72), add:

```ts
  const splitCandidateRoofId = useProjectStore((s) => s.splitCandidateRoofId);
  const setSplitCandidateRoof = useProjectStore((s) => s.setSplitCandidateRoof);
  const splitRoof = useProjectStore((s) => s.splitRoof);
```

- [ ] **Step 3: Replace `handleStageClick`'s draw-roof branch**

Find `handleStageClick` (around line 283). Replace the entire `if (toolMode === 'draw-roof') { ... }` block with:

```ts
    if (toolMode === 'draw-roof') {
      // Snap the incoming click via the same snap system that drives
      // the preview. This guarantees the committed vertex matches the
      // visual preview exactly, including edge and vertex snaps against
      // existing roof boundaries.
      const snap = computeDrawingSnap(pos, drawingPoints, roofs, { enabled: !shiftHeld });
      const snapped = snap.point ?? pos;

      // ── Boundary-hit test ──────────────────────────────────────────
      // We want to know: does this snapped point lie on the boundary
      // of some existing roof? If yes, we remember that roof id as a
      // "cut candidate" — subsequent clicks on the SAME roof's boundary
      // will commit the cut instead of continuing a regular polygon.
      // We use the existing EDGE_SNAP_TOL_PX (8) because that's the
      // tolerance the snap system itself uses — if a point landed
      // close enough to count as snapped, it should count as on-boundary.
      const EDGE_TOL = 8;
      let hitRoofId: string | null = null;
      for (const r of roofs) {
        if (pointOnPolygonBoundary(snapped, r.polygon, EDGE_TOL)) {
          hitRoofId = r.id;
          break;
        }
      }

      // Case 1: first vertex of a fresh polyline AND it's on a roof.
      // Tag that roof as the cut candidate and place the vertex normally.
      if (drawingPoints.length === 0 && hitRoofId) {
        setSplitCandidateRoof(hitRoofId);
        setDrawingPoints([snapped]);
        return;
      }

      // Case 2: we have a cut candidate AND the new vertex is on that
      // same roof's boundary AND we already placed ≥1 vertex. Fire the
      // split. The cut line is everything drawn so far + this snapped
      // endpoint.
      if (
        splitCandidateRoofId &&
        hitRoofId === splitCandidateRoofId &&
        drawingPoints.length >= 1
      ) {
        const cutLine = [...drawingPoints, snapped];
        splitRoof(splitCandidateRoofId, cutLine);
        // splitRoof clears splitCandidateRoofId in the store. We just
        // need to clear local drawing state and exit draw-roof.
        setDrawingPoints([]);
        setToolMode('idle');
        return;
      }

      // Case 3: existing close-path behavior — click near the first
      // vertex to close as a normal new roof.
      if (drawingPoints.length >= 3) {
        const first = drawingPoints[0];
        const dist = Math.hypot(first.x - snapped.x, first.y - snapped.y);
        if (dist < 12) {
          addRoof(drawingPoints);
          setDrawingPoints([]);
          setSplitCandidateRoof(null);
          setToolMode('idle');
          return;
        }
      }

      // Default: append a vertex, continue drawing.
      setDrawingPoints((prev) => [...prev, snapped]);
    } else if (toolMode === 'idle') {
      // Empty-background click deselects. Shapes use e.cancelBubble.
      setSelectedRoof(null);
    }
```

- [ ] **Step 4: Update `handleDblClick` for the cut commit path**

Replace `handleDblClick` with:

```ts
  const handleDblClick = () => {
    if (toolMode !== 'draw-roof') return;

    // If we have a cut candidate AND the last vertex lies on that
    // roof's boundary → this double-click commits the cut (useful for
    // multi-vertex polyline cuts where the user wants to stop drawing
    // without clicking the opposite edge a second time).
    if (splitCandidateRoofId && drawingPoints.length >= 2) {
      const last = drawingPoints[drawingPoints.length - 1];
      const candidateRoof = roofs.find((r) => r.id === splitCandidateRoofId);
      if (candidateRoof && pointOnPolygonBoundary(last, candidateRoof.polygon, 8)) {
        splitRoof(splitCandidateRoofId, drawingPoints);
        setDrawingPoints([]);
        setToolMode('idle');
        return;
      }
    }

    // Fallback to the existing "finish as a new roof" double-click.
    if (drawingPoints.length >= 3) {
      addRoof(drawingPoints);
      setDrawingPoints([]);
      setSplitCandidateRoof(null);
      setToolMode('idle');
    }
  };
```

- [ ] **Step 5: Add Enter-to-commit and extend Escape**

Find the `useEffect` that registers keyboard handlers (around line 173). Extend `onKeyDown`:

```ts
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingContext(e.target)) return;
      if (e.key === 'Escape') {
        setDrawingPoints([]);
        setIsPainting(false);
        setSplitCandidateRoof(null);
        setToolMode('idle');
      }
      // Enter commits an in-progress polyline as a cut IF the last
      // vertex lies on the candidate roof's boundary. Lets the user
      // finish a polyline cut without needing a perfectly-snapped
      // second edge click.
      if (e.key === 'Enter') {
        const state = useProjectStore.getState();
        if (
          state.toolMode === 'draw-roof' &&
          state.splitCandidateRoofId &&
          drawingPoints.length >= 2
        ) {
          const candidateRoof = state.project.roofs.find(
            (r) => r.id === state.splitCandidateRoofId,
          );
          const last = drawingPoints[drawingPoints.length - 1];
          if (
            candidateRoof &&
            pointOnPolygonBoundary(last, candidateRoof.polygon, 8)
          ) {
            state.splitRoof(state.splitCandidateRoofId, drawingPoints);
            setDrawingPoints([]);
            state.setToolMode('idle');
          }
        }
      }
      if (e.key === 'Shift') setShiftHeld(true);
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
```

The `Enter` branch pulls state live from the store (via `getState()`) instead of from the closure because this handler is registered once and the closure's `toolMode` / `splitCandidateRoofId` would be stale. `drawingPoints` IS in the useEffect's dependency array so the closure closes over the current value.

Update the dependency array of the `useEffect`:

```ts
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [setToolMode, drawingPoints, setSplitCandidateRoof]);
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/KonvaOverlay.tsx
git commit -m "Wire split detection into draw-roof in KonvaOverlay

First click on an existing roof's boundary tags it as a cut
candidate. A subsequent click on the same roof's boundary, or Enter
/ double-click while the last vertex is on boundary, fires splitRoof.
Existing close-to-first-vertex path (addRoof) is preserved. Escape
also clears the candidate."
```

---

## Task 8: Right-click-on-edge merge in `RoofLayer.tsx`

**Files:**
- Modify: `src/components/RoofLayer.tsx`

- [ ] **Step 1: Import what we need**

Near the top of the file, add:

```ts
import { findSharedEdge } from '../utils/polygonCut';
```

Also read `mergeRoofs` from the store selectors (around line 57 where other actions are pulled):

```ts
  const mergeRoofs = useProjectStore((s) => s.mergeRoofs);
```

- [ ] **Step 2: Add `onContextMenu` to the per-edge hit-line**

Find the per-edge hit-area `<Line>` inside the edge `<Group>` (around line 244). It currently has `onDragStart` / `onDragMove` / `onDragEnd` handlers that are active in draw-roof mode for drag-to-insert.

Add an `onContextMenu` handler alongside those — active only in draw-roof mode:

```tsx
                  <Line
                    points={[p1.x, p1.y, p2.x, p2.y]}
                    stroke="transparent"
                    strokeWidth={hitRadius * 2}
                    draggable={editHandlesVisible}
                    onContextMenu={editHandlesVisible ? (e) => {
                      // Right-click on an edge in draw-roof mode attempts
                      // a merge. If the clicked edge happens to be
                      // geometrically shared with another roof's edge
                      // (within tolerance), we fire mergeRoofs. If not,
                      // no-op — a future enhancement could surface a
                      // toast, but per YAGNI we stay silent.
                      //
                      // preventDefault stops the browser's context menu;
                      // cancelBubble stops Stage's onContextMenu from
                      // also firing (it already no-ops, but belt-and-
                      // suspenders against future changes).
                      e.evt.preventDefault();
                      e.cancelBubble = true;

                      // Look for any OTHER roof that shares this edge.
                      // findSharedEdge walks ALL of each polygon's
                      // edges, so we just call it per candidate roof
                      // and accept the first match.
                      const other = roofs.find((candidate) => {
                        if (candidate.id === roof.id) return false;
                        return findSharedEdge(roof.polygon, candidate.polygon) !== null;
                      });
                      if (!other) return;

                      // Confirm if either roof has panels (destructive-
                      // adjacent — panels will get reassigned and the
                      // smaller roof will vanish). Silent for empty
                      // roofs where the user clearly just wants the
                      // geometry change.
                      const state = useProjectStore.getState();
                      const hasPanels = state.project.panels.some(
                        (p) => p.roofId === roof.id || p.roofId === other.id,
                      );
                      if (hasPanels) {
                        const ok = window.confirm(
                          `Merge "${roof.name}" and "${other.name}"? Panels will be reassigned to the larger roof.`,
                        );
                        if (!ok) return;
                      }

                      mergeRoofs(roof.id, other.id);
                    } : undefined}
                    onDragStart={editHandlesVisible ? (e) => {
                      // ... existing code unchanged ...
```

Leave all existing handlers (`onDragStart`, `onDragMove`, `onDragEnd`) exactly as they are — only ADD the `onContextMenu` prop.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/RoofLayer.tsx
git commit -m "Right-click shared edge to merge roofs (RoofLayer)

In draw-roof mode, right-clicking a roof edge that is geometrically
shared with another roof's edge fires mergeRoofs. Confirms first if
either roof has panels; silent no-op if the edge is not shared.
Left-click drag-to-insert behavior unchanged."
```

---

## Task 9: Hint banner for cut candidate (App.tsx)

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Read `splitCandidateRoofId` and `toolMode` from the store**

Find the existing store reads near the top of `App()` (around line 38):

```ts
  const setToolMode = useProjectStore((s) => s.setToolMode);
  const locked = useProjectStore((s) => s.project.mapState.locked);
```

Add below them:

```ts
  const toolMode = useProjectStore((s) => s.toolMode);
  const splitCandidateRoofId = useProjectStore((s) => s.splitCandidateRoofId);
```

- [ ] **Step 2: Render a split-specific hint banner when appropriate**

Find the existing hint banner (around line 101). It only renders when `!locked`. Immediately AFTER that `{!locked && ...}` block (still inside `<main>`), add a second banner:

```tsx
          {locked && toolMode === 'draw-roof' && splitCandidateRoofId && (
            // Split-mode hint. Same visual treatment as the pre-lock
            // hint but positioned the same way so the user sees
            // instructions in a consistent place. Only rendered while
            // the user is mid-cut — no clutter in normal drawing.
            <div
              className="surface absolute top-4 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 z-[600] pointer-events-none flex items-center gap-2.5"
              style={{ fontSize: 12.5 }}
            >
              <span className="relative flex items-center justify-center" style={{ width: 10, height: 10 }}>
                <span
                  className="absolute inset-0 rounded-full animate-pulse-sun"
                  style={{ background: 'var(--sun-400)', filter: 'blur(4px)' }}
                />
                <span
                  className="relative rounded-full"
                  style={{ width: 6, height: 6, background: 'var(--sun-300)' }}
                />
              </span>
              <span style={{ color: 'var(--ink-100)' }}>
                Click another edge of this roof to
              </span>
              <span
                className="font-display font-semibold"
                style={{ color: 'var(--sun-300)', letterSpacing: '-0.01em' }}
              >
                split
              </span>
              <span style={{ color: 'var(--ink-300)' }}>
                it, or press Enter to commit a polyline cut.
              </span>
            </div>
          )}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "Hint banner for active roof-split cut

Shows a post-lock hint banner whenever the user is mid-cut inside
draw-roof mode (splitCandidateRoofId set). Visual treatment matches
the pre-lock hint. Disappears when the cut commits or is cancelled."
```

---

## Task 10: End-to-end verification

**Files:**
- None (manual testing only)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: success, no TypeScript errors.

- [ ] **Step 2: Start dev server**

Run: `npm run dev`
Expected: server on http://localhost:5173.

- [ ] **Step 3: Manual acceptance — straight split**

In the browser:
1. Navigate to a building, Lock Map.
2. Press `r`. Draw a rectangle (4 vertices, click first vertex to close).
3. Place a panel on it (`p` + click on the roof).
4. Press `r`. Click once on the left edge of the rectangle — observe the hint banner appear ("Click another edge of this roof to split...").
5. Click once on the right edge of the rectangle.
Expected: The rectangle splits into two. The half containing the panel keeps the original roof's id/name (visible in the sidebar). The other half becomes "Roof 2" (empty).

- [ ] **Step 4: Manual acceptance — polyline split via Enter**

1. Press `r`. Click on an edge of an existing roof.
2. Click 2 interior points inside the roof.
3. Click on a different edge of the same roof.
Expected: split fires on the final boundary click (matches Step 3 behavior).

Alternative path — polyline that doesn't land on an opposite edge:
1. Click on an edge. Click 2 interior points. Press Enter while last vertex is NOT on boundary.
Expected: no split, polyline stays (or is discarded by Escape).

- [ ] **Step 5: Manual acceptance — merge adjacent roofs**

1. After step 3, press `r` again (to re-enter draw-roof if exited).
2. Right-click on the shared edge between the two halves.
3. If either has panels: confirm dialog appears. Accept.
Expected: The two halves merge into a single polygon. The larger roof's id survives; the smaller roof is removed. Panels from the smaller roof now report roofId = survivor (inspect via React DevTools if desired, or verify by deleting the surviving roof and confirming all panels vanish).

- [ ] **Step 6: Manual acceptance — edge cases**

- Draw a polyline that starts on roof R's boundary, goes outside the roof, re-enters, and ends on R's boundary. `splitRoof` should reject silently (splitPolygon returns null because an interior point is outside the polygon).
- Right-click a roof edge that is NOT shared with any other roof. Expected: no action, no crash.
- Press Escape during a cut. Expected: drawing + cut candidate cleared; hint banner disappears.
- Close-to-first-vertex while mid-cut (click first vertex to close a ring): Expected: a normal new roof is created via `addRoof`; the cut candidate is cleared.

- [ ] **Step 7: If everything passes, commit the verification record**

This task has no code changes to commit — but if you found bugs that required fixes in earlier tasks, stash those fixes into fix-up commits (one per bug) rather than silently amending earlier ones.

---

## Self-Review Notes

Spec coverage:
- ✅ Polygon geometry (`polygonCut.ts`): Tasks 1–3
- ✅ Store actions (`splitRoof`, `mergeRoofs`, `splitCandidateRoofId`): Tasks 4–6
- ✅ Split detection in `draw-roof`: Task 7
- ✅ Merge via right-click on shared edge: Task 8
- ✅ Hint banner: Task 9
- ✅ "Line guides already consider existing roof edges" — verified during planning; no code change needed. Regression surface noted in Task 10 edge-case tests.

Placeholder scan: none found.

Type consistency: `pointOnPolygonBoundary` returns `{ edgeIndex, t } | null` throughout. `SharedEdge` type used by both `findSharedEdge` return and `mergePolygons` input. `splitRoof(roofId, cutLine)` / `mergeRoofs(roofAId, roofBId)` signatures match between interface, implementation, and call sites.
