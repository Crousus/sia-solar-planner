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
import { isInsidePolygon } from './geometry';

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

  // Edge-projection hit-test. We return whatever parametric `t` the
  // nearest edge projection gives — even if it's close to 0 or 1.
  // Earlier versions had a vertex-preference loop that snapped the
  // returned `t` to 0 whenever the click was within tolPx of any
  // vertex, which caused `splitPolygon` to later yank cut endpoints
  // to the nearest corner of the polygon even when the user had
  // deliberately clicked mid-edge ~8 px from a corner. That was a
  // visible bug: the resulting split line would originate at the
  // corner instead of where the user clicked.
  //
  // Determinism under exact-vertex clicks is preserved by the
  // best-distance tracking below: if the click lies exactly on a
  // vertex, both adjacent edges project with d=0, and the `d <=
  // bestDist` comparison (strict less-equal, lower index wins on a
  // tie — but `<=` updates, so actually the LAST tied edge wins)
  // gives a consistent choice. Either choice is fine for the split
  // algorithm — both halves share that vertex regardless.
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

  // Interior points must be strictly inside the polygon (ray-casting
  // rule in isInsidePolygon — see geometry.ts for exact "on edge"
  // semantics). Any interior cut vertex outside the polygon produces a
  // non-simple split, which splitPolygon below can't meaningfully
  // process, so we reject early.
  for (let i = 1; i < cutLine.length - 1; i++) {
    if (!isInsidePolygon(cutLine[i], polygon)) return null;
  }

  // Snap the actual cut endpoints to the edges (projected along the
  // hit's parametric t). This matters when the caller's snap didn't
  // land exactly on the boundary but within tolerance — we want the
  // resulting polygon halves to share the boundary vertex exactly.
  const snapStart = pointAlongEdge(polygon, hitA.edgeIndex, hitA.t);
  const snapEnd = pointAlongEdge(polygon, hitB.edgeIndex, hitB.t);

  // Insert both cut endpoints into a working copy of `polygon`. Each
  // insertion turns an existing edge into two edges meeting at the new
  // vertex. Afterwards we need to know WHICH index in the modified
  // array each cut endpoint ended up at, because arcA / arcB walk the
  // ring from those indices.
  //
  // Historical bug note: an earlier version sorted insertions in
  // descending `edgeIndex` order under the assumption that splicing at
  // a later position wouldn't shift earlier-tagged indices. That's
  // backwards — splicing at a LOWER position shifts every index AT OR
  // ABOVE the splice point up by one. So if we first tagged snapStart
  // at position 3 on edge 2, then spliced snapEnd in at position 1 on
  // edge 0, snapStart ended up at position 4 while the stored tag was
  // still 3 (pointing at a completely different polygon vertex). The
  // result: `splitPolygon` returned geometrically-wrong-but-still-
  // valid-looking polygons, and the split silently produced garbage.
  //
  // The fix we now use sidesteps the index bookkeeping entirely by
  // tagging endpoints by REFERENCE IDENTITY. For the generic case we
  // insert the exact `snapStart` / `snapEnd` object into `modified`,
  // then resolve indices via `indexOf` after all splices are done. For
  // the t=0 / t=1 boundary cases we tag the existing polygon vertex
  // (which is also in `modified` by reference, because `slice()`
  // copies the array but not the point objects).
  type Insertion = { edgeIndex: number; t: number; point: Point; tag: 'A' | 'B' };
  const insertions: Insertion[] = [
    { edgeIndex: hitA.edgeIndex, t: hitA.t, point: snapStart, tag: 'A' },
    { edgeIndex: hitB.edgeIndex, t: hitB.t, point: snapEnd,   tag: 'B' },
  ];
  // Descending edgeIndex order keeps splice POSITIONS valid without
  // recomputing offsets: inserting at a high position doesn't shift
  // lower positions, so subsequent splices at edgeIndex+1 still refer
  // to the right place. (Index TAGS are handled separately via
  // indexOf — see below.)
  insertions.sort((x, y) =>
    y.edgeIndex !== x.edgeIndex ? y.edgeIndex - x.edgeIndex : y.t - x.t,
  );

  const modified = polygon.slice();
  // Record the POINT OBJECT each cut endpoint maps to. Two cases:
  //   - Generic: the object IS the freshly-spliced ins.point.
  //   - Boundary (t=0/t=1): the object is an existing polygon vertex.
  // Either way we resolve to an index with indexOf at the end.
  const taggedPoint: Record<'A' | 'B', Point | null> = { A: null, B: null };
  for (const ins of insertions) {
    if (ins.t < 1e-6) {
      // Cut endpoint coincides with the START vertex of this edge.
      // No splice needed — the existing vertex already represents it.
      taggedPoint[ins.tag] = polygon[ins.edgeIndex];
      continue;
    }
    if (ins.t > 1 - 1e-6) {
      // Cut endpoint coincides with the END vertex of this edge.
      taggedPoint[ins.tag] = polygon[(ins.edgeIndex + 1) % polygon.length];
      continue;
    }
    // Generic mid-edge: splice the new point in and tag by identity.
    modified.splice(ins.edgeIndex + 1, 0, ins.point);
    taggedPoint[ins.tag] = ins.point;
  }

  // Resolve tagged point objects to their CURRENT indices in `modified`.
  // indexOf uses === comparison, which matches the point objects we
  // stored in taggedPoint even though other Points in `modified` may
  // have the same x/y.
  const idxA = taggedPoint.A ? modified.indexOf(taggedPoint.A) : -1;
  const idxB = taggedPoint.B ? modified.indexOf(taggedPoint.B) : -1;
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
  // B "detour" that replaces the shared edge runs from B[j+2] forward
  // around to B[j-1], EXCLUDING B[j] and B[j+1] (those are already
  // represented by A[i+1] and A[i] in fromA).
  // If not reversed: A[i]→A[i+1] equals B[j]→B[j+1]; detour runs from
  // B[j-1] backward around to B[j+2] excluding both.
  const fromB: Point[] = [];
  if (reversed) {
    // Start one past B[j+1], end one before B[j], going forward.
    // Indices j+2, j+3, ..., j+nB-1 (mod nB) — exactly nB-2 vertices,
    // every B vertex EXCEPT B[j] and B[j+1].
    for (let k = 1; k < nB - 1; k++) {
      fromB.push(polyB[(j + 1 + k) % nB]);
    }
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
