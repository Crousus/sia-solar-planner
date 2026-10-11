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
// drawingSnap tests.
//
// `computeDrawingSnap` is CAD-style geometric snapping with five distinct
// branches that fire in priority order:
//   0. Disabled / no anchor / cursor-on-anchor  →  raw passthrough
//   1. POINT snap  (within 10 px of an existing vertex → exact corner snap)
//   2. EDGE snap   (within 8 px of a non-vertex edge point → on-line snap)
//   3. ANGLE snap  (within 3° of a 45°-multiple, parallel, or perpendicular)
//   4. LENGTH snap (within 8 px of an existing edge length → exact length)
//
// Tolerances are tight by design ("magnet, not drag" per the file header)
// so a small refactor that loosens them silently breaks user expectations.
// Each branch gets a fixture that lands clearly inside the tolerance, plus
// a complementary "just outside" case where appropriate to catch threshold
// drift.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { computeDrawingSnap } from './drawingSnap';
import type { ImageEdge, ImageEdgeSource } from './imageEdges';
import type { Point, Roof } from '../types';

// Helper for terse roof literals.
function roof(polygon: Point[]): Roof {
  return {
    id: 'r',
    name: 'r',
    polygon,
    tiltDeg: 0,
    panelOrientation: 'portrait',
  };
}

// ── Passthrough cases (no work to do) ─────────────────────────────────────

describe('computeDrawingSnap — passthrough', () => {
  it('returns raw cursor + zero length when there is no anchor yet', () => {
    // First click of a new polygon: drawingPoints is empty, nothing to
    // snap against. The renderer needs (cursor, 0, no guides).
    const r = computeDrawingSnap({ x: 5, y: 5 }, [], []);
    expect(r.point).toEqual({ x: 5, y: 5 });
    expect(r.guides).toHaveLength(0);
    expect(r.edgeLengthPx).toBe(0);
    expect(r.angleSnapped).toBe(false);
    expect(r.lengthSnapped).toBe(false);
  });

  it('returns raw cursor when snapping is disabled (Shift key held)', () => {
    // The caller passes `enabled: !shiftKey` to implement "hold Shift to
    // disable snapping". Verify we still report the raw length so the
    // length label keeps rendering, but no snap fires.
    const r = computeDrawingSnap(
      { x: 100, y: 0 },
      [{ x: 0, y: 0 }],
      [],
      { enabled: false },
    );
    expect(r.point).toEqual({ x: 100, y: 0 });
    expect(r.edgeLengthPx).toBe(100);
    expect(r.angleSnapped).toBe(false);
    expect(r.guides).toHaveLength(0);
  });

  it('handles cursor exactly on the anchor (zero-length raw vector)', () => {
    // When the user hasn't moved the mouse since the last click, the raw
    // vector is degenerate and we must short-circuit before atan2 of (0,0).
    const r = computeDrawingSnap(
      { x: 0, y: 0 },
      [{ x: 0, y: 0 }],
      [],
    );
    expect(r.edgeLengthPx).toBe(0);
    expect(r.angleSnapped).toBe(false);
  });
});

// ── Point snap (corner) ───────────────────────────────────────────────────

describe('computeDrawingSnap — point snap', () => {
  it('snaps to an existing vertex when cursor is within 10 px', () => {
    // Existing roof has a corner at (100, 100). Cursor at (105, 103) is
    // √(25+9)=5.83 px away — well under POINT_SNAP_TOL_PX=10.
    const existing = roof([
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
      { x: 100, y: 200 },
    ]);
    const r = computeDrawingSnap(
      { x: 105, y: 103 },
      [{ x: 0, y: 0 }],
      [existing],
    );
    expect(r.point).toEqual({ x: 100, y: 100 });
    // Point snap intentionally returns no guides — visual feedback is
    // the cursor "jumping" to the corner, the docstring is explicit.
    expect(r.guides).toHaveLength(0);
    expect(r.angleSnapped).toBe(false);
    expect(r.lengthSnapped).toBe(false);
  });

  it('does not snap to the anchor itself (avoids zero-length self-snap)', () => {
    // The anchor IS the last drawing point — if point-snap matched it,
    // we'd report a zero-length edge every time. The "skip if dist<1e-3
    // from last" guard handles this.
    const r = computeDrawingSnap(
      { x: 0.0001, y: 0.0001 },
      [{ x: 0, y: 0 }],
      [],
    );
    // No anchor-snap → falls through to angle-snap (45° multiples). Either
    // way the point should NOT equal the anchor.
    expect(r.point).not.toEqual({ x: 0, y: 0 });
  });
});

// ── Edge snap (line) ──────────────────────────────────────────────────────

describe('computeDrawingSnap — edge snap', () => {
  it('snaps onto an existing edge interior when cursor is within 8 px', () => {
    // Existing roof's bottom edge runs y=100 from x=0 to x=200. Cursor at
    // (50, 105) is 5 px above the line — under EDGE_SNAP_TOL_PX=8 — and
    // 50 px from the nearest vertex, so point-snap won't fire first.
    const existing = roof([
      { x: 0, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
      { x: 0, y: 200 },
    ]);
    const r = computeDrawingSnap(
      { x: 50, y: 105 },
      [{ x: 500, y: 500 }], // anchor far away so anchor-self-skip isn't relevant
      [existing],
    );
    expect(r.point.x).toBeCloseTo(50);
    expect(r.point.y).toBeCloseTo(100);
    // Edge-snap emits one 'edge-match' guide highlighting the line we
    // landed on.
    expect(r.guides.some((g) => g.kind === 'edge-match')).toBe(true);
  });
});

// ── Angle snap ────────────────────────────────────────────────────────────

describe('computeDrawingSnap — angle snap', () => {
  it('snaps a near-horizontal cursor to exactly horizontal (within 3°)', () => {
    // Anchor at (0,0); cursor at (100, 2) → atan2(2, 100) ≈ 1.15°, well
    // under ANGLE_TOL_DEG=3 → snaps to angle 0 → snapped point lies on
    // the x-axis at distance 100 (length is unchanged by angle snap).
    const r = computeDrawingSnap({ x: 100, y: 2 }, [{ x: 0, y: 0 }], []);
    expect(r.angleSnapped).toBe(true);
    expect(r.point.y).toBeCloseTo(0);
    expect(r.point.x).toBeCloseTo(100);
  });

  it('does NOT snap when the cursor angle is outside the 3° tolerance', () => {
    // Anchor at (0,0); cursor at (100, 10) → atan2(10, 100) ≈ 5.7°, well
    // outside the 3° tolerance → no angle snap → snapped point equals
    // raw cursor.
    const r = computeDrawingSnap({ x: 100, y: 10 }, [{ x: 0, y: 0 }], []);
    expect(r.angleSnapped).toBe(false);
    expect(r.point.x).toBeCloseTo(100);
    expect(r.point.y).toBeCloseTo(10);
  });

  it('snaps to be parallel to an existing roof edge (highlights ref edge)', () => {
    // Existing roof has a non-cardinal edge from (0,0) to (100,30). Its
    // angle ≈ 16.7° — picked deliberately because a 45°-multiple edge
    // would tie the absolute-angle candidate against the parallel-edge
    // candidate (the first-match-wins tiebreaker would suppress the
    // edge-parallel guide we want to assert here).
    //
    // Anchor at (200,0); cursor at (300, 30) → raw angle ≈ 16.7° → matches
    // the reference edge's parallel candidate within 3° → edge-parallel
    // guide is emitted highlighting the source edge.
    const existing = roof([
      { x: 0, y: 0 },
      { x: 100, y: 30 },
      { x: 0, y: 60 },
    ]);
    const r = computeDrawingSnap(
      { x: 300, y: 30 },
      [{ x: 200, y: 0 }],
      [existing],
    );
    expect(r.angleSnapped).toBe(true);
    expect(r.guides.some((g) => g.kind === 'edge-parallel')).toBe(true);
  });

  it('snapped point always lies along the snap direction at a non-negative distance', () => {
    // The function clamps signed projection length to ≥ 0 so the snapped
    // point can never end up on the opposite side of `last` from the
    // chosen direction. We can't easily construct an input that crosses
    // that threshold via angle-snap (a cursor "behind" the anchor along
    // +x sits near angle 180°, which simply snaps to 180° instead — its
    // own positive projection). Instead we verify the invariant: for any
    // angle-snapped result, the dot product of (point - anchor) with the
    // unit vector of the snap direction equals edgeLengthPx ≥ 0.
    const anchor = { x: 0, y: 0 };
    // Near-horizontal cursor → angle-snaps to 0.
    const r = computeDrawingSnap({ x: 100, y: 2 }, [anchor], []);
    expect(r.angleSnapped).toBe(true);
    expect(r.edgeLengthPx).toBeGreaterThanOrEqual(0);
    // The snapped point's offset from the anchor projected onto the snap
    // direction equals the reported length (within float noise).
    const proj =
      (r.point.x - anchor.x) * 1 + (r.point.y - anchor.y) * 0; // unit vec for angle 0
    expect(proj).toBeCloseTo(r.edgeLengthPx);
  });
});

// ── Length snap ───────────────────────────────────────────────────────────

describe('computeDrawingSnap — length snap', () => {
  it('snaps the edge length to match an existing edge of similar length', () => {
    // Existing roof has a horizontal edge of length 100 (from (500,500) to
    // (600,500)). Anchor at (0,0); cursor at (97, 1) → angle-snap fires
    // (~0.6°), then projected length is 97.0006 — within
    // LENGTH_TOL_PX=8 of the reference length 100 → length-snap to 100.
    const existing = roof([
      { x: 500, y: 500 },
      { x: 600, y: 500 },
      { x: 600, y: 600 },
      { x: 500, y: 600 },
    ]);
    const r = computeDrawingSnap(
      { x: 97, y: 1 },
      [{ x: 0, y: 0 }],
      [existing],
    );
    expect(r.angleSnapped).toBe(true);
    expect(r.lengthSnapped).toBe(true);
    expect(r.edgeLengthPx).toBeCloseTo(100);
    expect(r.point.x).toBeCloseTo(100);
    expect(r.point.y).toBeCloseTo(0);
    // Length-match guide should highlight the reference edge.
    expect(r.guides.some((g) => g.kind === 'length-match')).toBe(true);
  });

  it('does NOT length-snap when the projected length is outside 8 px tolerance', () => {
    const existing = roof([
      { x: 500, y: 500 },
      { x: 600, y: 500 }, // length 100
      { x: 600, y: 600 },
      { x: 500, y: 600 },
    ]);
    // Projected length will be ~80 — 20 px off, way past the 8 px window.
    const r = computeDrawingSnap(
      { x: 80, y: 1 },
      [{ x: 0, y: 0 }],
      [existing],
    );
    expect(r.lengthSnapped).toBe(false);
  });
});

// ── Zoom-aware tolerances + nearest length match ──────────────────────────

describe('computeDrawingSnap — tolerances scale with stage zoom', () => {
  const existing = roof([
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    { x: 200, y: 200 },
    { x: 100, y: 200 },
  ]);

  it('shrinks the world-space point-snap radius when zoomed in', () => {
    // Cursor 5.83 world px from the corner. At scale 1 that's 5.83 screen
    // px (< 10 → snaps). At scale 4 it's 23 screen px (> 10 → no snap).
    const cursor = { x: 105, y: 103 };
    const anchor = [{ x: 0, y: 0 }];
    expect(computeDrawingSnap(cursor, anchor, [existing], { enabled: true, scale: 1 }).point)
      .toEqual({ x: 100, y: 100 });
    expect(computeDrawingSnap(cursor, anchor, [existing], { enabled: true, scale: 4 }).point)
      .not.toEqual({ x: 100, y: 100 });
  });

  it('grows the world-space edge-snap radius when zoomed out', () => {
    // Cursor 12 world px above the edge y=100: outside 8 px at scale 1,
    // but only 6 screen px at scale 0.5 → edge snap fires.
    const cursor = { x: 150, y: 88 };
    const anchor = [{ x: 500, y: -500 }];
    const at1 = computeDrawingSnap(cursor, anchor, [existing], { enabled: true, scale: 1 });
    expect(at1.guides.some((g) => g.kind === 'edge-match')).toBe(false);
    const atHalf = computeDrawingSnap(cursor, anchor, [existing], { enabled: true, scale: 0.5 });
    expect(atHalf.guides.some((g) => g.kind === 'edge-match')).toBe(true);
    expect(atHalf.point.y).toBeCloseTo(100);
  });

  it('falls back to scale 1 for a zero / NaN scale', () => {
    const cursor = { x: 105, y: 103 };
    expect(computeDrawingSnap(cursor, [{ x: 0, y: 0 }], [existing], { enabled: true, scale: 0 }).point)
      .toEqual({ x: 100, y: 100 });
    expect(computeDrawingSnap(cursor, [{ x: 0, y: 0 }], [existing], { enabled: true, scale: NaN }).point)
      .toEqual({ x: 100, y: 100 });
  });
});

describe('computeDrawingSnap — length snap picks the nearest length', () => {
  it('prefers the closest reference length over the first one within tolerance', () => {
    // Two reference edges far away: lengths 100 (first in edge order) and
    // 104. A horizontal drag of 103 is within 8 px of both — the old
    // first-match rule snapped to 100; nearest is 104.
    const a = roof([
      { x: 1000, y: 1000 },
      { x: 1100, y: 1000 }, // 100
      { x: 1100, y: 1300 },
      { x: 1000, y: 1300 },
    ]);
    const b = roof([
      { x: 2000, y: 1000 },
      { x: 2104, y: 1000 }, // 104
      { x: 2104, y: 1300 },
      { x: 2000, y: 1300 },
    ]);
    const r = computeDrawingSnap({ x: 103, y: 0.5 }, [{ x: 0, y: 0 }], [a, b]);
    expect(r.lengthSnapped).toBe(true);
    expect(r.edgeLengthPx).toBeCloseTo(104);
  });
});

describe('computeDrawingSnap — reference-edge guide wins direction ties', () => {
  it('highlights the parallel edge for a rectangle\'s third side (ties with "previous edge + 90°" and absolute 180°)', () => {
    // A(0,0) → B(100,0) → C(100,50); heading left from C is parallel to AB,
    // but also exactly 90° from BC and an absolute 45° multiple. The generic
    // candidates used to win the tie, so only the faint direction ray showed.
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }];
    const r = computeDrawingSnap({ x: 40, y: 51 }, pts, []);
    expect(r.angleSnapped).toBe(true);
    const parallel = r.guides.find((g) => g.kind === 'edge-parallel');
    expect(parallel).toEqual({ kind: 'edge-parallel', from: pts[0], to: pts[1] });
  });

  it('highlights an axis-aligned roof edge instead of the generic 0° direction', () => {
    const r = computeDrawingSnap(
      { x: 260, y: 301 },
      [{ x: 200, y: 300 }],
      [roof([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }])],
    );
    expect(r.guides.some((g) => g.kind === 'edge-parallel')).toBe(true);
  });
});

describe('computeDrawingSnap — alignment with existing vertices', () => {
  it('along a locked direction, stops in line with another vertex and draws a guide from it', () => {
    // Heading left from C(100,50) (direction-snapped to 180°). A neighbour
    // roof has a corner at (30,200): the cursor near x≈31 should stop at
    // x=30 exactly — "in line with that corner".
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }];
    const neighbour = roof([{ x: 30, y: 200 }, { x: 60, y: 200 }, { x: 60, y: 260 }, { x: 30, y: 260 }]);
    const r = computeDrawingSnap({ x: 33, y: 51 }, pts, [neighbour]);
    expect(r.point.x).toBeCloseTo(30, 6);
    expect(r.point.y).toBeCloseTo(50, 6);
    const align = r.guides.find((g) => g.kind === 'vertex-align');
    expect(align?.from).toEqual({ x: 30, y: 200 });
  });

  it('without a direction lock, snaps onto the line through a vertex', () => {
    // Cursor at a ~30.6° heading from the anchor (no 45° / edge direction
    // within 3°) but 4 px from the vertical line through vertex (300,0).
    const r = computeDrawingSnap(
      { x: 304, y: 80 },
      [{ x: 0, y: 0 }, { x: 0, y: -100 }],
      [roof([{ x: 300, y: 0 }, { x: 400, y: 0 }, { x: 400, y: -50 }])],
    );
    expect(r.angleSnapped).toBe(false);
    expect(r.point.x).toBeCloseTo(300, 6);
    expect(r.point.y).toBeCloseTo(80, 6);
    expect(r.guides).toEqual([{ kind: 'vertex-align', from: { x: 300, y: 0 }, to: r.point }]);
  });

  it('snaps to the crossing of two vertex lines (below one vertex, level with another)', () => {
    const r = computeDrawingSnap(
      { x: 303, y: 497 },
      [{ x: 0, y: 0 }, { x: 0, y: -100 }],
      [
        roof([{ x: 300, y: 0 }, { x: 330, y: 20 }, { x: 310, y: 40 }]),
        roof([{ x: 600, y: 500 }, { x: 650, y: 520 }, { x: 610, y: 560 }]),
      ],
    );
    expect(r.point.x).toBeCloseTo(300, 6);
    expect(r.point.y).toBeCloseTo(500, 6);
    expect(r.guides.filter((g) => g.kind === 'vertex-align')).toHaveLength(2);
  });

  it('ignores vertices that are out of alignment tolerance', () => {
    const r = computeDrawingSnap(
      { x: 320, y: 80 },
      [{ x: 0, y: 0 }, { x: 0, y: -100 }],
      [roof([{ x: 300, y: 0 }, { x: 400, y: 0 }, { x: 400, y: -50 }])],
    );
    expect(r.guides.some((g) => g.kind === 'vertex-align')).toBe(false);
    expect(r.point.x).toBeCloseTo(320, 6);
    expect(r.point.y).toBeCloseTo(80, 6);
  });

  it('alignment tolerance is in screen pixels (shrinks when zoomed in)', () => {
    const args = [
      { x: 304, y: 80 },
      [{ x: 0, y: 0 }, { x: 0, y: -100 }],
      [roof([{ x: 300, y: 0 }, { x: 400, y: 0 }, { x: 400, y: -50 }])],
    ] as const;
    // 4 world px = 16 screen px at 4× zoom → beyond the 8 px tolerance.
    const zoomed = computeDrawingSnap(args[0], [...args[1]], [...args[2]], { enabled: true, scale: 4 });
    expect(zoomed.guides.some((g) => g.kind === 'vertex-align')).toBe(false);
  });

  it('does not align through the anchor vertex itself', () => {
    // The only vertex is the anchor; lines through it are the direction
    // ray's job, so no vertex-align guide may appear.
    const r = computeDrawingSnap({ x: 3, y: 170 }, [{ x: 0, y: 0 }], []);
    expect(r.guides.some((g) => g.kind === 'vertex-align')).toBe(false);
  });
});

// ── Snapping to edges detected in the satellite image (ADR-019) ────────────

function imgEdge(ax: number, ay: number, bx: number, by: number): ImageEdge {
  return {
    a: { x: ax, y: ay },
    b: { x: bx, y: by },
    angle: Math.atan2(by - ay, bx - ax),
    length: Math.hypot(bx - ax, by - ay),
    strength: 10,
  };
}
/** Brute-force source: the snap layer must not depend on the real index. */
function source(edges: ImageEdge[]): ImageEdgeSource {
  return {
    near: (p, r) =>
      edges.filter((e) => {
        const dx = e.b.x - e.a.x;
        const dy = e.b.y - e.a.y;
        const t = Math.max(0, Math.min(1, ((p.x - e.a.x) * dx + (p.y - e.a.y) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(p.x - (e.a.x + dx * t), p.y - (e.a.y + dy * t)) <= r;
      }),
  };
}
// An L-shaped roof corner in the imagery at (300, 200), edges stopping a
// few px short of it (as detected corners do).
const eave = imgEdge(304, 200, 500, 200);
const gable = imgEdge(300, 204, 300, 380);

describe('computeDrawingSnap — image edges', () => {
  it('snaps the FIRST vertex to a detected roof corner', () => {
    const r = computeDrawingSnap({ x: 306, y: 207 }, [], [], { enabled: true, imageEdges: source([eave, gable]) });
    expect(r.point.x).toBeCloseTo(300, 6);
    expect(r.point.y).toBeCloseTo(200, 6);
    expect(r.guides.filter((g) => g.kind === 'image-edge')).toHaveLength(2);
  });

  it('snaps the first vertex onto a detected edge when no corner is near', () => {
    const r = computeDrawingSnap({ x: 400, y: 204 }, [], [], { enabled: true, imageEdges: source([eave]) });
    expect(r.point).toEqual({ x: 400, y: 200 });
    expect(r.guides).toEqual([{ kind: 'image-edge', from: eave.a, to: eave.b }]);
  });

  it('own roof corners beat image corners', () => {
    const own = roof([{ x: 309, y: 206 }, { x: 360, y: 206 }, { x: 360, y: 260 }]);
    const r = computeDrawingSnap({ x: 307, y: 206 }, [{ x: 100, y: 100 }], [own], {
      enabled: true,
      imageEdges: source([eave, gable]),
    });
    expect(r.point).toEqual({ x: 309, y: 206 });
  });

  it('along a locked direction, stops exactly on a detected edge', () => {
    // Drawing straight up from (420, 330): vertical direction snap; the eave
    // at y = 200 is crossed near the cursor → land on it.
    const r = computeDrawingSnap({ x: 420.5, y: 204 }, [{ x: 420, y: 330 }], [], {
      enabled: true,
      imageEdges: source([eave]),
    });
    expect(r.angleSnapped).toBe(true);
    expect(r.point.x).toBeCloseTo(420, 6);
    expect(r.point.y).toBeCloseTo(200, 6);
    expect(r.guides.some((g) => g.kind === 'image-edge')).toBe(true);
  });

  it('without a direction lock, projects onto the nearest detected edge', () => {
    // ~30° heading from the anchor: no direction snap.
    const r = computeDrawingSnap({ x: 440, y: 205 }, [{ x: 200, y: 66 }], [], {
      enabled: true,
      imageEdges: source([eave]),
    });
    expect(r.angleSnapped).toBe(false);
    expect(r.point).toEqual({ x: 440, y: 200 });
  });

  it('is fully disabled by Shift (enabled: false)', () => {
    const r = computeDrawingSnap({ x: 306, y: 207 }, [], [], { enabled: false, imageEdges: source([eave, gable]) });
    expect(r.point).toEqual({ x: 306, y: 207 });
    expect(r.guides).toHaveLength(0);
  });

  it('image tolerances are screen pixels (zoomed in 4× the corner is out of reach)', () => {
    const r = computeDrawingSnap({ x: 306, y: 207 }, [], [], {
      enabled: true,
      scale: 4,
      imageEdges: source([eave, gable]),
    });
    expect(r.guides.filter((g) => g.kind === 'image-edge')).toHaveLength(0);
  });

  it('does not form a corner from two nearly parallel detected lines', () => {
    const r = computeDrawingSnap({ x: 400, y: 203 }, [], [], {
      enabled: true,
      imageEdges: source([eave, imgEdge(300, 206, 500, 207)]),
    });
    // Snaps onto a line (nearest), never to a bogus far-away "corner".
    expect(r.guides).toHaveLength(1);
  });
});
