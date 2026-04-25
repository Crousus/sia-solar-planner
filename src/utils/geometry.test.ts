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
// geometry tests.
//
// `utils/geometry.ts` is the math nucleus of the editor — `panelDisplaySize`
// is THE single source of truth for tilt projection (per the file header) and
// `snapPanelToGrid` is the engine behind every panel placement click. The
// module had zero coverage before this file; given its blast radius (a
// silent off-by-one here cascades into wrong panel sizes on PDF, wrong kWp
// counts, panels overflowing the polygon, etc.) we lock down the contract
// here so future refactors of the spatial primitives don't regress it.
//
// Conventions:
//   - All coordinates are canvas pixels (same convention as the module).
//   - Polygons are closed implicitly (first vertex repeats at index 0); we
//     never include a duplicate close vertex, matching the rest of the app.
//   - The "10×10 unit square" fixture is reused for the same reason as in
//     polygonCut.test.ts: trivial parametric values keep test failures
//     readable.
//   - We use a 1.0 mpp calibration in panel-sizing tests so a panel's
//     reported display dimension equals its physical dimension in meters,
//     making the cos(tilt) factor visible in raw numbers.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  rotatePoint,
  polygonCentroid,
  polygonArea,
  simplifyCollinear,
  isInsidePolygon,
  isPointInRect,
  projectOnSegment,
  roofPrimaryAngle,
  panelDisplaySize,
  panelRealArea,
  panelCorners,
  snapPanelToGrid,
  panelFitsOnRoof,
  getPanelGroupDimensions,
  distance,
} from './geometry';
import type { Point, Roof, PanelType } from '../types';

// ── Shared fixtures ────────────────────────────────────────────────────────

/** Axis-aligned 10×10 square at the origin. Vertices 0..3 walk CCW in math
 *  axes (CW on-screen because canvas y-down). */
const SQUARE: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

/** A 1m × 2m panel — short side 1, long side 2. Real-world (meters). */
const PANEL_1x2: PanelType = {
  id: 'p',
  name: 'test panel',
  widthM: 1,
  heightM: 2,
  wattPeak: 400,
};

/** Roof fixture: a 20×20 axis-aligned square so panels of size 1×2 fit
 *  comfortably in any orientation. tilt=0 keeps `panelDisplaySize` reading
 *  the raw physical dimensions. */
function makeRoof(overrides: Partial<Roof> = {}): Roof {
  return {
    id: 'roof-1',
    name: 'Roof 1',
    polygon: [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ],
    tiltDeg: 0,
    panelOrientation: 'portrait',
    ...overrides,
  };
}

// ── rotatePoint ────────────────────────────────────────────────────────────

describe('rotatePoint', () => {
  it('rotates 90° CCW (math axes) around origin', () => {
    const p = rotatePoint({ x: 1, y: 0 }, Math.PI / 2, { x: 0, y: 0 });
    // (1,0) rotated 90° CCW → (0,1).
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(1);
  });

  it('returns the input unchanged for angle 0', () => {
    const p = rotatePoint({ x: 3, y: 4 }, 0, { x: 1, y: 1 });
    expect(p.x).toBeCloseTo(3);
    expect(p.y).toBeCloseTo(4);
  });

  it('rotates around an arbitrary origin (not just (0,0))', () => {
    // Rotating (2,1) by 180° around (1,1) takes us to (0,1) — straight
    // through the origin point.
    const p = rotatePoint({ x: 2, y: 1 }, Math.PI, { x: 1, y: 1 });
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(1);
  });
});

// ── polygonCentroid ───────────────────────────────────────────────────────

describe('polygonCentroid', () => {
  it('returns the geometric center of a square', () => {
    const c = polygonCentroid(SQUARE);
    expect(c.x).toBeCloseTo(5);
    expect(c.y).toBeCloseTo(5);
  });

  it('returns (0,0) for an empty polygon', () => {
    expect(polygonCentroid([])).toEqual({ x: 0, y: 0 });
  });

  it('falls back to vertex mean for degenerate (collinear) polygons', () => {
    // Three collinear points → shoelace area is 0 → vertex-mean fallback
    // is the only sane answer (centroid formula divides by area).
    const c = polygonCentroid([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(c.x).toBeCloseTo(5);
    expect(c.y).toBeCloseTo(0);
  });

  it('is winding-agnostic (CW vs CCW yields the same centroid)', () => {
    const cw = polygonCentroid(SQUARE);
    const ccw = polygonCentroid([...SQUARE].reverse());
    expect(cw.x).toBeCloseTo(ccw.x);
    expect(cw.y).toBeCloseTo(ccw.y);
  });
});

// ── polygonArea ───────────────────────────────────────────────────────────

describe('polygonArea', () => {
  it('returns the unsigned area of a square', () => {
    expect(polygonArea(SQUARE)).toBeCloseTo(100);
  });

  it('is winding-agnostic — abs() is applied internally', () => {
    expect(polygonArea([...SQUARE].reverse())).toBeCloseTo(100);
  });

  it('computes the area of a right triangle correctly', () => {
    // Right triangle with legs 6 and 8 → area 24.
    const tri: Point[] = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 0, y: 8 },
    ];
    expect(polygonArea(tri)).toBeCloseTo(24);
  });
});

// ── simplifyCollinear ─────────────────────────────────────────────────────

describe('simplifyCollinear', () => {
  it('removes a midpoint that lies on the line between its neighbours', () => {
    // (0,0)–(5,0)–(10,0)–(10,10)–(0,10) → the (5,0) midpoint sits dead-
    // center on what should be one straight bottom edge from (0,0) to (10,0).
    // After cleanup the polygon is the 10×10 square again.
    const out = simplifyCollinear([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    expect(out).toHaveLength(4);
    // The square's four corners are preserved exactly.
    for (const corner of SQUARE) {
      expect(out).toContainEqual(corner);
    }
  });

  it('keeps non-collinear vertices untouched (square stays a square)', () => {
    const out = simplifyCollinear(SQUARE);
    expect(out).toHaveLength(4);
    expect(out).toEqual(SQUARE);
  });

  it('refuses to shrink below 3 vertices (degenerate polygon guard)', () => {
    // Three collinear points: any pairing of the three would normally be
    // removable (each lies on the line through its neighbours), but the
    // safety floor stops the loop at length 3.
    const tri: Point[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ];
    expect(simplifyCollinear(tri)).toHaveLength(3);
  });

  it('removes a "spike" where prev == next (degenerate backtrack)', () => {
    // (10,0) → (10,10) → (10,0) → (0,10): the middle (10,10) is reached
    // and immediately backtracked, so its prev and next are identical.
    // The base length |next - prev| is zero, triggering the spike branch.
    const out = simplifyCollinear([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ]);
    // We can't make a strong claim on the exact remaining vertices because
    // a follow-up pass may discover further collinearity, but at minimum
    // the redundant spike vertex must be gone.
    expect(out.length).toBeLessThan(5);
  });

  it('never mutates the input array', () => {
    const input = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const before = JSON.stringify(input);
    simplifyCollinear(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

// ── isInsidePolygon / isPointInRect ───────────────────────────────────────

describe('isInsidePolygon', () => {
  it('reports a clearly-interior point as inside', () => {
    expect(isInsidePolygon({ x: 5, y: 5 }, SQUARE)).toBe(true);
  });

  it('reports a clearly-exterior point as outside', () => {
    expect(isInsidePolygon({ x: 50, y: 50 }, SQUARE)).toBe(false);
  });

  it('handles concave (L-shaped) polygons — rejects the notch', () => {
    // L-shape: 10×10 square with the top-right 5×5 quadrant removed.
    //   (0,0)–(10,0)–(10,5)–(5,5)–(5,10)–(0,10)
    // Point (7,7) sits in the removed notch → must be reported as outside.
    const lShape: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(isInsidePolygon({ x: 7, y: 7 }, lShape)).toBe(false);
    // And a point in the L's solid bottom-right is still inside.
    expect(isInsidePolygon({ x: 7, y: 2 }, lShape)).toBe(true);
  });
});

describe('isPointInRect', () => {
  it('treats points exactly on the rect edge as inside (inclusive bounds)', () => {
    const r = { x: 0, y: 0, w: 10, h: 10 };
    expect(isPointInRect({ x: 0, y: 0 }, r)).toBe(true);
    expect(isPointInRect({ x: 10, y: 10 }, r)).toBe(true);
  });

  it('rejects points outside any axis', () => {
    const r = { x: 0, y: 0, w: 10, h: 10 };
    expect(isPointInRect({ x: -1, y: 5 }, r)).toBe(false);
    expect(isPointInRect({ x: 5, y: 11 }, r)).toBe(false);
  });
});

// ── projectOnSegment ──────────────────────────────────────────────────────

describe('projectOnSegment', () => {
  it('returns t in [0,1] for the perpendicular foot on the segment', () => {
    // p=(5,5) projected onto the bottom edge (0,0)→(10,0) lands at (5,0)
    // with t=0.5, perpendicular distance 5.
    const r = projectOnSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(r.t).toBeCloseTo(0.5);
    expect(r.dist).toBeCloseTo(5);
    expect(r.point.x).toBeCloseTo(5);
    expect(r.point.y).toBeCloseTo(0);
  });

  it('returns t < 0 when the foot lies past `a` (caller must clamp)', () => {
    // p=(-5,0): foot is at x=-5 on the line, before the segment start.
    // Returning unclamped t lets stringRouting tell "outside the wire-
    // routing T-window" from "inside but to the side of it".
    const r = projectOnSegment({ x: -5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(r.t).toBeLessThan(0);
  });

  it('returns t > 1 when the foot lies past `b`', () => {
    const r = projectOnSegment({ x: 15, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(r.t).toBeGreaterThan(1);
  });

  it('handles a degenerate zero-length segment by returning t=0 and |p−a|', () => {
    // a == b: avoids divide-by-zero. Distance is straight-line from p to a.
    const r = projectOnSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 });
    expect(r.t).toBe(0);
    expect(r.dist).toBeCloseTo(5);
    expect(r.point).toEqual({ x: 0, y: 0 });
  });
});

// ── roofPrimaryAngle ──────────────────────────────────────────────────────

describe('roofPrimaryAngle', () => {
  it('returns 0 for a square (any axis-aligned edge wins; the first one is horizontal)', () => {
    expect(roofPrimaryAngle(SQUARE)).toBeCloseTo(0);
  });

  it('picks the longest edge — wide rectangle reports horizontal angle', () => {
    // 30×10 rectangle. Longest edges are the top/bottom (length 30) running
    // horizontally → angle ~ 0 (or π if the longest one walks right→left;
    // either way |cos(angle)|≈1).
    const wide: Point[] = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 10 },
      { x: 0, y: 10 },
    ];
    const a = roofPrimaryAngle(wide);
    expect(Math.abs(Math.cos(a))).toBeCloseTo(1);
    expect(Math.abs(Math.sin(a))).toBeCloseTo(0);
  });

  it('picks a diagonal edge when that is the longest', () => {
    // Triangle whose longest edge is a 45° diagonal of length √200.
    const tri: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 5, y: 0 },
    ];
    // Longest edge is (5,0)→(0,0) (length 5) vs (0,0)→(10,10) (length √200).
    // The diagonal wins; its angle is atan2(10,10) = π/4.
    expect(roofPrimaryAngle(tri)).toBeCloseTo(Math.PI / 4);
  });

  it('returns 0 for a degenerate (single-point) polygon', () => {
    expect(roofPrimaryAngle([{ x: 0, y: 0 }])).toBe(0);
  });
});

// ── panelDisplaySize ──────────────────────────────────────────────────────
//
// The single source of truth for the tilt projection — see geometry.ts
// header. Tests use mpp=1 so the on-screen number equals the physical one
// in meters and the cos(tilt) factor is visible in raw values.

describe('panelDisplaySize', () => {
  it('portrait, tilt 0: long side foreshortened by cos(0)=1 → equals physical h', () => {
    const { w, h } = panelDisplaySize(PANEL_1x2, 'portrait', 0, 1);
    expect(w).toBeCloseTo(1);
    expect(h).toBeCloseTo(2);
  });

  it('landscape swaps long/short along the roof axis', () => {
    const { w, h } = panelDisplaySize(PANEL_1x2, 'landscape', 0, 1);
    expect(w).toBeCloseTo(2); // long side along roof axis
    expect(h).toBeCloseTo(1); // short side up the slope
  });

  it('compresses the slope-axis dimension by cos(tilt) in portrait', () => {
    // tilt 60° → cos = 0.5 → the long side (along slope) shrinks to 1.
    const { w, h } = panelDisplaySize(PANEL_1x2, 'portrait', 60, 1);
    expect(w).toBeCloseTo(1);   // along-axis side: untouched
    expect(h).toBeCloseTo(1);   // 2 * cos(60°) = 1
  });

  it('compresses the slope-axis dimension by cos(tilt) in landscape', () => {
    // In landscape the SHORT side runs up the slope, so 1 * cos(60°) = 0.5.
    const { w, h } = panelDisplaySize(PANEL_1x2, 'landscape', 60, 1);
    expect(w).toBeCloseTo(2);
    expect(h).toBeCloseTo(0.5);
  });

  it('mpp scales both dimensions inversely (smaller mpp → bigger pixels)', () => {
    // mpp=0.5 means 1 pixel covers half a meter, so a 1m side spans 2 px.
    const { w, h } = panelDisplaySize(PANEL_1x2, 'portrait', 0, 0.5);
    expect(w).toBeCloseTo(2);
    expect(h).toBeCloseTo(4);
  });

  it('tilt 90° collapses the slope axis to zero (degenerate but mathematically right)', () => {
    // Not a realistic roof tilt, but verifies the formula's continuity.
    // No code path special-cases the result; callers (snapPanelToGrid)
    // refuse zero-area panels via cellH > 0 guard, but THIS function
    // happily returns h=0.
    const { h } = panelDisplaySize(PANEL_1x2, 'portrait', 90, 1);
    expect(h).toBeCloseTo(0);
  });
});

describe('panelRealArea', () => {
  it('returns the on-slope physical area in m²', () => {
    expect(panelRealArea(PANEL_1x2)).toBeCloseTo(2);
  });
});

// ── panelCorners ──────────────────────────────────────────────────────────

describe('panelCorners', () => {
  it('returns 4 corners for an axis-aligned panel centred at origin', () => {
    const corners = panelCorners({ x: 0, y: 0 }, 0, 4, 2);
    // Half-extents: hx=2, hy=1. Corners walk (-2,-1)(2,-1)(2,1)(-2,1).
    expect(corners).toHaveLength(4);
    expect(corners[0].x).toBeCloseTo(-2);
    expect(corners[0].y).toBeCloseTo(-1);
    expect(corners[2].x).toBeCloseTo(2);
    expect(corners[2].y).toBeCloseTo(1);
  });

  it('rotates the corners by the given angle around the centre', () => {
    // 90° rotation of a 4×2 panel → corners that were horizontal flip vertical.
    const corners = panelCorners({ x: 0, y: 0 }, Math.PI / 2, 4, 2);
    // Corner (-2,-1) → after 90° CCW around origin → (1,-2).
    expect(corners[0].x).toBeCloseTo(1);
    expect(corners[0].y).toBeCloseTo(-2);
  });
});

// ── snapPanelToGrid ───────────────────────────────────────────────────────

describe('snapPanelToGrid', () => {
  it('snaps cursor to the centroid-anchored grid (cursor near centre returns centre)', () => {
    // 20×20 roof, centroid (10,10). 1×2 panel portrait at tilt 0, mpp 1
    // → cellW=1, cellH=2. A cursor at (10.2, 10.3) should snap to (10,10).
    const roof = makeRoof();
    const result = snapPanelToGrid(
      { x: 10.2, y: 10.3 },
      roof,
      PANEL_1x2,
      'portrait',
      1,
      [], // no existing panels
    );
    expect(result).not.toBeNull();
    expect(result!.x).toBeCloseTo(10);
    expect(result!.y).toBeCloseTo(10);
  });

  it('rejects placement when a corner pokes outside the polygon', () => {
    // Cursor near the roof edge: snap candidate (19.5, 10) would have its
    // right corner at x=20, but a small jitter past that puts it outside.
    // Easier construction: place at (20, 10) — half the panel width sticks
    // out beyond the roof's right edge → null.
    const roof = makeRoof();
    const result = snapPanelToGrid(
      { x: 20, y: 10 },
      roof,
      PANEL_1x2,
      'portrait',
      1,
      [],
    );
    expect(result).toBeNull();
  });

  it('rejects placement when a sibling panel is closer than 0.7 × min(cellW, cellH)', () => {
    // cellW=1, cellH=2 → min*0.7 = 0.7. Sibling at the snap target itself
    // (10,10) → distance 0 < 0.7 → rejected.
    const roof = makeRoof();
    const result = snapPanelToGrid(
      { x: 10, y: 10 },
      roof,
      PANEL_1x2,
      'portrait',
      1,
      [{ x: 10, y: 10 }],
    );
    expect(result).toBeNull();
  });

  it('allows placement at one full grid cell away from a sibling', () => {
    // The grid spacing is `cellW` along the axis (1px here for portrait
    // 1m × 2m at mpp=1). Sibling at (10,10), cursor at (11.1, 10.2) → snap
    // candidate (11, 10), distance 1 > 0.7 → accepted.
    const roof = makeRoof();
    const result = snapPanelToGrid(
      { x: 11.1, y: 10.2 },
      roof,
      PANEL_1x2,
      'portrait',
      1,
      [{ x: 10, y: 10 }],
    );
    expect(result).not.toBeNull();
    expect(result!.x).toBeCloseTo(11);
    expect(result!.y).toBeCloseTo(10);
  });

  it('returns the raw cursor (sans grid snap) when snap=false but still validates fit', () => {
    const roof = makeRoof();
    const result = snapPanelToGrid(
      { x: 10.37, y: 10.62 },
      roof,
      PANEL_1x2,
      'portrait',
      1,
      [],
      null,
      false, // snap disabled
    );
    expect(result).not.toBeNull();
    expect(result!.x).toBeCloseTo(10.37);
    expect(result!.y).toBeCloseTo(10.62);
  });

  it('honours an explicit grid origin override (panel-group anchoring)', () => {
    // When a group is active the store passes the first panel's centre as
    // the origin so subsequent panels in the same group land on that
    // anchor's grid, not the polygon centroid's.
    const roof = makeRoof();
    const origin = { x: 7, y: 7 };
    const result = snapPanelToGrid(
      { x: 8.1, y: 7.2 },
      roof,
      PANEL_1x2,
      'portrait',
      1,
      [],
      origin,
    );
    expect(result).not.toBeNull();
    // cellW=1 → snaps to x=8 (one cell over from x=7).
    expect(result!.x).toBeCloseTo(8);
    expect(result!.y).toBeCloseTo(7);
  });
});

// ── panelFitsOnRoof ───────────────────────────────────────────────────────

describe('panelFitsOnRoof', () => {
  it('returns true when an existing panel still fits with no neighbours', () => {
    const roof = makeRoof();
    expect(
      panelFitsOnRoof(
        { id: 'a', cx: 10, cy: 10 },
        roof,
        PANEL_1x2,
        'portrait',
        1,
        [],
      ),
    ).toBe(true);
  });

  it('returns false when the panel now overflows the polygon', () => {
    const roof = makeRoof();
    expect(
      panelFitsOnRoof(
        { id: 'a', cx: 19.9, cy: 10 }, // right edge sticks out
        roof,
        PANEL_1x2,
        'portrait',
        1,
        [],
      ),
    ).toBe(false);
  });

  it('returns false when a sibling sits inside the overlap radius', () => {
    const roof = makeRoof();
    expect(
      panelFitsOnRoof(
        { id: 'a', cx: 10, cy: 10 },
        roof,
        PANEL_1x2,
        'portrait',
        1,
        [{ id: 'b', cx: 10.3, cy: 10 }],
      ),
    ).toBe(false);
  });

  it('excludes the panel itself from the sibling overlap check', () => {
    // The siblings list includes the panel's own row in real call sites
    // (the store passes `project.panels`). The function must not flag
    // itself as a collision via id matching.
    const roof = makeRoof();
    expect(
      panelFitsOnRoof(
        { id: 'a', cx: 10, cy: 10 },
        roof,
        PANEL_1x2,
        'portrait',
        1,
        [{ id: 'a', cx: 10, cy: 10 }], // same id
      ),
    ).toBe(true);
  });
});

// ── getPanelGroupDimensions ───────────────────────────────────────────────
//
// The dimension labelling pass walks the union of panel cells, cancels
// internal edges (each cell's neighbours emit the same edge in opposite
// directions), then merges contiguous collinear edge-runs into one segment
// per polygon side. We test the post-merge edge-count, not the exact
// label positions — those are renderer concerns.

describe('getPanelGroupDimensions', () => {
  it('returns no labels for a single 1×1 group (every edge length is 1 cell)', () => {
    // The function only labels edges longer than ONE panel cell to avoid
    // peppering the canvas with redundant 1m markers.
    const roof = makeRoof();
    const dims = getPanelGroupDimensions(
      [{ cx: 10, cy: 10 }],
      roof,
      PANEL_1x2,
      'portrait',
      1,
    );
    expect(dims).toHaveLength(0);
  });

  it('produces 2 long-edge labels for a 2×1 row of panels', () => {
    // Two panels side-by-side along the roof's long axis (cellW=1):
    //   centres (10,10) and (11,10). The merged silhouette is a 2×1 cell
    //   rectangle with two long edges (top + bottom, length 2 cells) and
    //   two short edges (left + right, length 1 cell each — too short to
    //   label). Expect exactly 2 labels.
    const roof = makeRoof();
    const dims = getPanelGroupDimensions(
      [
        { cx: 10, cy: 10 },
        { cx: 11, cy: 10 },
      ],
      roof,
      PANEL_1x2,
      'portrait',
      1,
    );
    expect(dims).toHaveLength(2);
    // Both labels report 2m (2 cells × cellW=1px × mpp=1).
    for (const d of dims) {
      expect(d.lengthM).toBeCloseTo(2);
    }
  });

  it('returns no labels for an empty input list (defensive guard)', () => {
    const roof = makeRoof();
    expect(
      getPanelGroupDimensions([], roof, PANEL_1x2, 'portrait', 1),
    ).toHaveLength(0);
  });
});

// ── distance ──────────────────────────────────────────────────────────────

describe('distance', () => {
  it('returns the Euclidean distance between two points', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5);
  });

  it('is symmetric', () => {
    const a = { x: 1, y: 2 };
    const b = { x: 7, y: 11 };
    expect(distance(a, b)).toBeCloseTo(distance(b, a));
  });
});
