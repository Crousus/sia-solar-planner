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
// roofEditing tests.
//
// `computeEdgeRemoval` has three behavioural branches (intersection,
// near-parallel midpoint fallback, "absurd intersection" midpoint fallback)
// plus a degenerate-result short-circuit. The branches are picked by
// numeric thresholds (sin(angle) < 0.02 and intersection >8× edge length)
// that are easy to break with a refactor — these tests pin each branch
// down with a fixture that lands squarely inside it.
//
// `findMergeCandidate` is a thin wrapper around findSharedEdge but the
// "skip self" guard is the kind of one-line invariant that gets lost in a
// rewrite, so we test it explicitly.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { computeEdgeRemoval, findMergeCandidate } from './roofEditing';
import type { Point, Roof } from '../types';

// Helper for terse roof literals — only `id` and `polygon` matter for these
// tests; tilt/orientation/name are irrelevant to the geometry we're testing.
function roof(id: string, polygon: Point[]): Roof {
  return {
    id,
    name: id,
    polygon,
    tiltDeg: 30,
    panelOrientation: 'portrait',
  };
}

describe('computeEdgeRemoval', () => {
  it('extends two perpendicular neighbours to their intersection (chamfer removal)', () => {
    // 10×10 square with the top-right corner cut off by a 2-unit chamfer.
    //   (0,0) (10,0) (10,8) (8,10) (0,10)
    // Removing the chamfer edge (10,8) → (8,10) (i=2) should extend the
    // right edge ((10,0)→(10,8), vertical) and the top edge ((8,10)→
    // (0,10), horizontal — but flipped: nextV - p2 = (-8, 0)) to meet at
    // their perpendicular intersection (10, 10) — restoring the missing
    // corner. After collinearity cleanup we expect a clean 4-vertex square.
    const chamfered: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 8 },
      { x: 8, y: 10 },
      { x: 0, y: 10 },
    ];
    const result = computeEdgeRemoval(chamfered, 2);
    expect(result.kind).toBe('polygon');
    if (result.kind !== 'polygon') return;
    expect(result.polygon).toHaveLength(4);
    expect(result.polygon).toContainEqual({ x: 10, y: 10 });
  });

  it('falls back to midpoint when neighbour edges are near-parallel (sin<0.02)', () => {
    // Quadrilateral whose two neighbours of the removed edge run almost
    // parallel. We construct one where d1 = (1, 0) and d2 = (-1, 0.01) so
    // |sin(angle)| = 0.01/√(1²+0.01²) ≈ 0.01 < 0.02 → midpoint fallback.
    //
    //   prev=(0,0)  →  p1=(10,0) → p2=(20,0.5) →  next=(10,0.51)
    //
    // d1 = p1 - prev = (10, 0)         (horizontal right)
    // d2 = next - p2 = (-10, 0.01)     (horizontal left with tiny tilt)
    // → sin(angle) ≈ 0.001 → fallback path.
    // Expected replacement = midpoint of (p1, p2) = (15, 0.25).
    const polygon: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0.5 },
      { x: 10, y: 0.51 },
    ];
    const result = computeEdgeRemoval(polygon, 1);
    expect(result.kind).toBe('polygon');
    if (result.kind !== 'polygon') return;
    expect(result.polygon).toContainEqual({ x: 15, y: 0.25 });
  });

  it('falls back to midpoint when the intersection is absurdly far (>8× edge length)', () => {
    // Near-parallel-but-not-quite: two neighbour rays that converge far
    // beyond the deleted edge. The intersection-distance guard kicks in
    // (>8×edgeLen) and we use the midpoint instead, sparing the polygon
    // from a giant spike.
    //
    //   prev=(0,0) → p1=(10,0) → p2=(11,0) → next=(20.05,0.05)
    //
    // d1 = (10, 0); d2 = (9.05, 0.05). The rays converge gently many tens
    // of edge-lengths away from the (10,0)-(11,0) edge of length 1.
    const polygon: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 11, y: 0 },
      { x: 20.05, y: 0.05 },
    ];
    const result = computeEdgeRemoval(polygon, 1);
    expect(result.kind).toBe('polygon');
    if (result.kind !== 'polygon') return;
    // Replacement should be the midpoint of (10,0) and (11,0) = (10.5, 0).
    expect(result.polygon).toContainEqual({ x: 10.5, y: 0 });
  });

  it('returns degenerate when the result would have <3 vertices', () => {
    // Triangle has only 3 vertices — removing any edge would leave 2,
    // which the function explicitly refuses (caller is expected to offer
    // delete-roof instead).
    const tri: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    expect(computeEdgeRemoval(tri, 0).kind).toBe('degenerate');
  });

  it('handles edge wrap (last edge — i = n-1, pairing index n-1 with 0)', () => {
    // Removing the closing edge of an L-shape exercises the (i+1) % n
    // wrap arithmetic. We don't pin the exact replacement coordinate
    // here — the important contract is "still produces a valid polygon
    // with one fewer vertex (modulo collinearity cleanup)". Using a
    // simple square: removing edge 3→0 should leave a triangle.
    const square: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const result = computeEdgeRemoval(square, 3);
    expect(result.kind).toBe('polygon');
    if (result.kind !== 'polygon') return;
    expect(result.polygon.length).toBeGreaterThanOrEqual(3);
    // We removed one edge → at most n-1 = 3 vertices remain (collinearity
    // cleanup may shrink further but won't grow).
    expect(result.polygon.length).toBeLessThanOrEqual(3);
  });
});

describe('findMergeCandidate', () => {
  it('returns the other roof when they share an edge', () => {
    // Two unit squares stacked along their shared horizontal edge at y=10.
    //   roof A: (0,0)(10,0)(10,10)(0,10)
    //   roof B: (0,10)(10,10)(10,20)(0,20)
    const a = roof('A', [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    const b = roof('B', [
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 20 },
      { x: 0, y: 20 },
    ]);
    expect(findMergeCandidate(a, [a, b])?.id).toBe('B');
  });

  it('skips the input roof itself even if it appears in the list', () => {
    // Real call sites pass `state.project.roofs` — so the input roof IS
    // in the list. The "skip self" guard prevents us from declaring a
    // roof a merge candidate with itself (its edges trivially match).
    const a = roof('A', [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    expect(findMergeCandidate(a, [a])).toBeNull();
  });

  it('returns null when no roof shares an edge', () => {
    const a = roof('A', [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    // Roof B sits well off to the side — no shared edge.
    const b = roof('B', [
      { x: 100, y: 100 },
      { x: 110, y: 100 },
      { x: 110, y: 110 },
      { x: 100, y: 110 },
    ]);
    expect(findMergeCandidate(a, [a, b])).toBeNull();
  });
});
