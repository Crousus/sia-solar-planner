// ────────────────────────────────────────────────────────────────────────────
// polygonCut tests.
//
// These algorithms (splitPolygon in particular) have a documented history of
// subtle index-bookkeeping bugs — see the "Historical bug note" comment in
// polygonCut.ts. The refactor review flagged this module as having zero test
// coverage despite being the engine behind every roof split/merge user
// interaction (ADR-013). This file exists to lock down the current contract
// so future reshaping (e.g. unifying geometry primitives in a shared
// vecMath module, or relaxing the "no cross-imports" convention so we can
// drop the duplicated `isStrictlyInside`) doesn't silently regress it.
//
// All coordinates are canvas pixels, same convention as the module under test.
// Polygons are wound counter-clockwise in math axes (clockwise on-screen)
// except where a test explicitly inverts to verify winding-agnostic behavior.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  pointOnPolygonBoundary,
  splitPolygon,
  findSharedEdge,
  mergePolygons,
} from './polygonCut';
import type { Point } from '../types';

// A 10×10 square at the origin. Used as the canonical fixture throughout —
// its edges are axis-aligned, so parametric t values along each edge are
// trivial to reason about and the test failure messages stay readable.
//
// Vertices: 0 = (0,0), 1 = (10,0), 2 = (10,10), 3 = (0,10)
// Edges:    0 = 0→1 (bottom), 1 = 1→2 (right), 2 = 2→3 (top), 3 = 3→0 (left)
const SQUARE: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe('pointOnPolygonBoundary', () => {
  it('returns null for degenerate polygons (< 3 vertices)', () => {
    expect(pointOnPolygonBoundary({ x: 0, y: 0 }, [], 5)).toBeNull();
    expect(pointOnPolygonBoundary({ x: 0, y: 0 }, [{ x: 0, y: 0 }], 5)).toBeNull();
    expect(
      pointOnPolygonBoundary({ x: 0, y: 0 }, [{ x: 0, y: 0 }, { x: 1, y: 1 }], 5),
    ).toBeNull();
  });

  it('returns null when the point is outside the tolerance band', () => {
    expect(pointOnPolygonBoundary({ x: 50, y: 50 }, SQUARE, 2)).toBeNull();
  });

  it('returns the mid-edge hit with correct parametric t', () => {
    // Mid-point of the bottom edge (edge 0): (5, 0).
    const hit = pointOnPolygonBoundary({ x: 5, y: 0 }, SQUARE, 1);
    expect(hit).not.toBeNull();
    expect(hit!.edgeIndex).toBe(0);
    expect(hit!.t).toBeCloseTo(0.5);
  });

  it('returns a hit even when the point sits within tolerance but off-edge', () => {
    // 1 pixel below the bottom edge — should still hit edge 0 with t≈0.5.
    const hit = pointOnPolygonBoundary({ x: 5, y: -1 }, SQUARE, 2);
    expect(hit).not.toBeNull();
    expect(hit!.edgeIndex).toBe(0);
    expect(hit!.t).toBeCloseTo(0.5);
  });

  it('resolves vertex hits deterministically', () => {
    // The corner at (10, 10) is the endpoint of edge 1 AND the start of
    // edge 2. Both project with distance 0; whichever wins must be
    // consistent — the current impl's `<=` comparison means the later
    // edge in iteration order wins, so we get edge 2 with t=0.
    // Pinning this behavior so a refactor changing the tiebreak must
    // update the test consciously (splitPolygon depends on the choice).
    const hit = pointOnPolygonBoundary({ x: 10, y: 10 }, SQUARE, 1);
    expect(hit).not.toBeNull();
    expect(hit!.edgeIndex).toBe(2);
    expect(hit!.t).toBeCloseTo(0);
  });

  it('skips zero-length (degenerate) edges', () => {
    // Square with a duplicate vertex: (10, 0) appears twice in a row,
    // producing a zero-length edge between indices 1 and 2. The hit
    // test should route around the degeneracy and still find a match
    // on one of the surviving edges rather than returning null or
    // pointing at the zero-length edge.
    const withDup: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 0 }, // duplicate
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const hit = pointOnPolygonBoundary({ x: 5, y: 0 }, withDup, 1);
    expect(hit).not.toBeNull();
    // Whatever edge is returned, it must not be the zero-length one.
    // (Indices: 0 = (0,0)→(10,0) ✓, 1 = (10,0)→(10,0) degenerate,
    //  2 = (10,0)→(10,10), 3 = (10,10)→(0,10), 4 = (0,10)→(0,0).)
    expect(hit!.edgeIndex).not.toBe(1);
  });
});

describe('splitPolygon — happy paths', () => {
  it('splits a square by a horizontal cut into two rectangles', () => {
    // Horizontal cut at y=5 from left edge to right edge.
    const result = splitPolygon(SQUARE, [
      { x: 0, y: 5 },
      { x: 10, y: 5 },
    ]);
    expect(result).not.toBeNull();
    const [polyA, polyB] = result!;
    // Each half has 4 vertices (3 original corners would be wrong; the
    // two cut endpoints introduce 2 new vertices per half — but one
    // corner of the original is no longer on that half's boundary, so
    // the net is 4 vertices each).
    expect(polyA.length).toBe(4);
    expect(polyB.length).toBe(4);
    // Combined vertex set should contain all four original corners plus
    // the two new cut endpoints (6 distinct points).
    const all = [...polyA, ...polyB];
    const keyed = new Set(all.map((p) => `${p.x},${p.y}`));
    expect(keyed.has('0,0')).toBe(true);
    expect(keyed.has('10,0')).toBe(true);
    expect(keyed.has('10,10')).toBe(true);
    expect(keyed.has('0,10')).toBe(true);
    expect(keyed.has('0,5')).toBe(true);
    expect(keyed.has('10,5')).toBe(true);
  });

  it('splits a square by a multi-point (bent) cut', () => {
    // Bent cut: enters left edge at (0,5), elbows to (5,3) inside, exits
    // right edge at (10,5). Interior waypoint must end up in both halves
    // of the result (mirrored winding on each side).
    const result = splitPolygon(SQUARE, [
      { x: 0, y: 5 },
      { x: 5, y: 3 }, // interior
      { x: 10, y: 5 },
    ]);
    expect(result).not.toBeNull();
    const [polyA, polyB] = result!;
    // polyA (bottom) gets the interior vertex in reverse (from end
    // back to start of cut). polyB (top) gets it forward. Either way,
    // both halves must contain (5,3) exactly once.
    const countInterior = (poly: Point[]) =>
      poly.filter((p) => p.x === 5 && p.y === 3).length;
    expect(countInterior(polyA)).toBe(1);
    expect(countInterior(polyB)).toBe(1);
  });

  it('splits a square by a diagonal cut into two triangles', () => {
    // Cut from (0,0) corner diagonally to (10,10) corner. Endpoints
    // land AT vertices (t=0 on edge 3 via iteration tiebreak → gets
    // routed to an adjacent edge). This exercises the boundary-case
    // branch in splitPolygon that skips the splice and tags the
    // existing polygon vertex by reference.
    const result = splitPolygon(SQUARE, [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]);
    expect(result).not.toBeNull();
    const [polyA, polyB] = result!;
    // Each triangle: 3 vertices.
    expect(polyA.length).toBe(3);
    expect(polyB.length).toBe(3);
  });
});

describe('splitPolygon — rejections', () => {
  it('returns null for cutLine with fewer than 2 points', () => {
    expect(splitPolygon(SQUARE, [])).toBeNull();
    expect(splitPolygon(SQUARE, [{ x: 5, y: 0 }])).toBeNull();
  });

  it('returns null for a polygon with fewer than 3 vertices', () => {
    expect(
      splitPolygon([{ x: 0, y: 0 }, { x: 10, y: 0 }], [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toBeNull();
  });

  it('returns null when both cut endpoints sit on the same edge', () => {
    // Both endpoints on the bottom edge (edge 0): would produce a
    // zero-area degenerate sliver. Module explicitly guards against this.
    const result = splitPolygon(SQUARE, [
      { x: 2, y: 0 },
      { x: 8, y: 0 },
    ]);
    expect(result).toBeNull();
  });

  it('returns null when an endpoint lies outside the tolerance of any edge', () => {
    // (50, 50) is far from every edge of the 10×10 square.
    const result = splitPolygon(SQUARE, [
      { x: 0, y: 5 },
      { x: 50, y: 50 },
    ]);
    expect(result).toBeNull();
  });

  it('returns null when an interior cut vertex is outside the polygon', () => {
    // The interior waypoint (20, 5) lies well outside the square.
    // splitPolygon requires every interior cut point to be strictly
    // inside — otherwise the cut would cross the boundary more than
    // twice, which the module doesn't support.
    const result = splitPolygon(SQUARE, [
      { x: 0, y: 5 },
      { x: 20, y: 5 }, // outside
      { x: 10, y: 5 },
    ]);
    expect(result).toBeNull();
  });
});

describe('splitPolygon — index-bookkeeping regression', () => {
  // Pre-fix: the old code sorted insertions in descending edgeIndex order
  // and tagged endpoints by NUMERIC index. Splicing at a lower position
  // shifted the earlier-tagged index, silently producing geometrically
  // wrong (but still plausibly-shaped) halves. Current code tags by
  // object identity and resolves indices via indexOf afterwards. This
  // test exercises a configuration that would have tripped the old bug:
  // endpoints on non-adjacent edges with different t values, so at least
  // one splice happens at a position that would have shifted the other.
  it('produces halves whose vertices are all drawn from polygon ∪ cut endpoints', () => {
    const result = splitPolygon(SQUARE, [
      { x: 3, y: 0 }, // mid-edge 0
      { x: 10, y: 7 }, // mid-edge 1
    ]);
    expect(result).not.toBeNull();
    const [polyA, polyB] = result!;
    const allowed = new Set([
      '0,0',
      '10,0',
      '10,10',
      '0,10',
      '3,0',
      '10,7',
    ]);
    for (const p of [...polyA, ...polyB]) {
      expect(allowed.has(`${p.x},${p.y}`)).toBe(true);
    }
    // Each cut endpoint appears in BOTH halves (they share the cut).
    const has = (poly: Point[], x: number, y: number) =>
      poly.some((p) => p.x === x && p.y === y);
    expect(has(polyA, 3, 0)).toBe(true);
    expect(has(polyB, 3, 0)).toBe(true);
    expect(has(polyA, 10, 7)).toBe(true);
    expect(has(polyB, 10, 7)).toBe(true);
  });

  it('assigns each original corner to exactly one of the two halves', () => {
    const result = splitPolygon(SQUARE, [
      { x: 3, y: 0 },
      { x: 10, y: 7 },
    ]);
    const [polyA, polyB] = result!;
    const cornerCounts: Record<string, number> = {
      '0,0': 0,
      '10,0': 0,
      '10,10': 0,
      '0,10': 0,
    };
    for (const p of [...polyA, ...polyB]) {
      const key = `${p.x},${p.y}`;
      if (key in cornerCounts) cornerCounts[key]++;
    }
    // Each original corner must appear on exactly one side of the cut.
    // A count of 0 would mean it got deleted; 2 would mean the splits
    // overlap at that vertex (the old bug's smoking gun).
    for (const count of Object.values(cornerCounts)) {
      expect(count).toBe(1);
    }
  });
});

describe('findSharedEdge', () => {
  // Two axis-aligned squares sharing the x=10 edge. A is 0..10, B is 10..20.
  // A's edge 1 runs (10,0)→(10,10); B's edge 3 runs (10,10)→(10,0) —
  // opposite direction, so `reversed: true` is the expected discriminant
  // for normally-wound adjacent polygons.
  const SQUARE_RIGHT: Point[] = [
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 10 },
    { x: 10, y: 10 },
  ];

  it('finds the shared edge with reversed=true for same-winding adjacent polygons', () => {
    const shared = findSharedEdge(SQUARE, SQUARE_RIGHT);
    expect(shared).not.toBeNull();
    expect(shared!.aEdgeIndex).toBe(1);
    expect(shared!.bEdgeIndex).toBe(3);
    expect(shared!.reversed).toBe(true);
  });

  it('returns null when polygons share only a single vertex', () => {
    // Diagonally-touching squares: they share the point (10,10) but no edge.
    const diagonal: Point[] = [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
      { x: 10, y: 20 },
    ];
    expect(findSharedEdge(SQUARE, diagonal)).toBeNull();
  });

  it('returns null when polygons are disjoint', () => {
    const far: Point[] = [
      { x: 100, y: 100 },
      { x: 110, y: 100 },
      { x: 110, y: 110 },
      { x: 100, y: 110 },
    ];
    expect(findSharedEdge(SQUARE, far)).toBeNull();
  });

  it('detects same-direction shared edges with reversed=false', () => {
    // Construct B so its edge runs in the SAME direction as A's edge 1.
    // B's edge 0 is (10,0)→(10,10) — identical orientation. This
    // shouldn't happen with user-drawn polygons (they wind consistently)
    // but the module supports it, and the merge path depends on the
    // reversed flag being set correctly.
    const sameWinding: Point[] = [
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 0 },
    ];
    const shared = findSharedEdge(SQUARE, sameWinding);
    expect(shared).not.toBeNull();
    expect(shared!.reversed).toBe(false);
  });
});

describe('mergePolygons', () => {
  const SQUARE_RIGHT: Point[] = [
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 10 },
    { x: 10, y: 10 },
  ];

  it('stitches two adjacent squares into a 6-vertex rectangle', () => {
    const shared = findSharedEdge(SQUARE, SQUARE_RIGHT)!;
    const merged = mergePolygons(SQUARE, SQUARE_RIGHT, shared);
    // 4 + 4 - 2 = 6 (the two shared-edge vertices contribute once each
    // from A; the equivalents from B are replaced by the A-side pair).
    expect(merged.length).toBe(6);
    // Verify the merged outline hits every unique vertex exactly once.
    const keyed = new Set(merged.map((p) => `${p.x},${p.y}`));
    expect(keyed.size).toBe(6);
    expect(keyed.has('0,0')).toBe(true);
    expect(keyed.has('0,10')).toBe(true);
    expect(keyed.has('20,0')).toBe(true);
    expect(keyed.has('20,10')).toBe(true);
    expect(keyed.has('10,0')).toBe(true);
    expect(keyed.has('10,10')).toBe(true);
  });

  it('produces a traversal that closes back on its starting vertex', () => {
    // Any simple polygon is closed implicitly. Verify that walking
    // merged[last] → merged[0] gives a finite-length edge (not a
    // zero-length degeneracy from duplicated endpoints).
    const shared = findSharedEdge(SQUARE, SQUARE_RIGHT)!;
    const merged = mergePolygons(SQUARE, SQUARE_RIGHT, shared);
    const last = merged[merged.length - 1];
    const first = merged[0];
    const closingLen = Math.hypot(first.x - last.x, first.y - last.y);
    expect(closingLen).toBeGreaterThan(0);
  });
});
