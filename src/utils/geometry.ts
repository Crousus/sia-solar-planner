// ────────────────────────────────────────────────────────────────────────────
// Geometry utilities — all pure functions, no React, no store.
//
// This file contains:
//   - Basic polygon ops (centroid, area, point-in-polygon)
//   - Rotation helpers (rotatePoint, panelCorners)
//   - Roof-axis detection (roofPrimaryAngle)
//   - The grid-snap core used by panel placement (snapPanelToGrid)
//
// Everything operates in canvas pixel coordinates (see types/index.ts for
// the coordinate convention). Meters only enter the picture via `mpp` when
// converting real panel dimensions into display dimensions.
// ────────────────────────────────────────────────────────────────────────────

import type { Point, Roof, PanelType, Rect } from '../types';

/**
 * Rotate point `p` by `angleRad` around `origin`.
 *
 * Convention: angle is in radians, positive = counter-clockwise when looking
 * at math axes; on a canvas (y-down) that appears clockwise. This matches
 * Math.atan2's convention, so rotating by roofPrimaryAngle() works directly.
 */
export function rotatePoint(p: Point, angleRad: number, origin: Point): Point {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return {
    x: origin.x + dx * cos - dy * sin,
    y: origin.y + dx * sin + dy * cos,
  };
}

/**
 * Area-weighted centroid of a closed polygon using the shoelace formula.
 *
 * Used as the "grid origin" for snap — we want the snap grid anchored to the
 * roof's center so it stays stable as the user tweaks things, rather than
 * to some arbitrary first vertex.
 *
 * Edge case: for degenerate (near-zero area) polygons we fall back to the
 * vertex-average to avoid dividing by zero. Shouldn't happen in practice
 * because the user closes the polygon with ≥3 distinct points.
 */
export function polygonCentroid(polygon: Point[]): Point {
  if (polygon.length === 0) return { x: 0, y: 0 };
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p1 = polygon[i];
    const p2 = polygon[(i + 1) % polygon.length];
    const cross = p1.x * p2.y - p2.x * p1.y;
    area += cross;
    cx += (p1.x + p2.x) * cross;
    cy += (p1.y + p2.y) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-9) {
    // Degenerate polygon (collinear or duplicate points) — fall back to mean.
    const avgX = polygon.reduce((s, p) => s + p.x, 0) / polygon.length;
    const avgY = polygon.reduce((s, p) => s + p.y, 0) / polygon.length;
    return { x: avgX, y: avgY };
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

/**
 * Unsigned polygon area (shoelace), in squared canvas pixels.
 *
 * Multiply by `mpp * mpp` to convert to m² — used in the sidebar's
 * "Projected area" display.
 */
export function polygonArea(polygon: Point[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p1 = polygon[i];
    const p2 = polygon[(i + 1) % polygon.length];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(area) / 2;
}

/**
 * Ray-casting point-in-polygon test.
 *
 * Classic algorithm: cast a horizontal ray from the point to +∞ and count
 * polygon-edge crossings; odd = inside, even = outside. The `|| 1e-12`
 * guards against division-by-zero on horizontal edges.
 *
 * Points exactly on an edge are unspecified (could go either way); for our
 * use case (snap validation) this is fine because the grid is discrete and
 * the user can always nudge the cursor if a specific cell is borderline.
 */
export function isInsidePolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Axis-aligned rect containment — used for lasso-to-panel hit testing. */
export function isPointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/**
 * Angle (radians, atan2 convention) of the polygon's longest edge.
 *
 * Rationale: solar panels are physically installed in rows aligned with the
 * roof's dominant axis. Taking the longest edge as "horizontal" gives a
 * reasonable default for arbitrary-shaped polygons without asking the user.
 * Future enhancement could let the user override this per-roof.
 *
 * For a well-shaped rectangular roof the longest edge is obviously the
 * "horizontal" one from the user's POV. For L-shaped roofs it picks the
 * longest straight run, which is usually what you want.
 */
export function roofPrimaryAngle(polygon: Point[]): number {
  if (polygon.length < 2) return 0;
  let maxLen = 0;
  let bestAngle = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p1 = polygon[i];
    const p2 = polygon[(i + 1) % polygon.length];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len > maxLen) {
      maxLen = len;
      bestAngle = Math.atan2(dy, dx);
    }
  }
  return bestAngle;
}

/**
 * Panel display size in canvas pixels, accounting for tilt projection.
 *
 * This is THE single source of truth for "how big does a panel look on the
 * map?" Every layer (grid snap, placed panels, ghost) calls this. Change
 * the tilt model here — nowhere else.
 *
 * Model:
 *   The satellite imagery shows the HORIZONTAL projection of a sloped roof.
 *   A panel lying on the slope, viewed from above, is foreshortened along
 *   the slope direction by cos(tilt). We treat the roof's long axis as
 *   horizontal (no foreshortening) and the perpendicular axis as the slope
 *   direction (foreshortened).
 *
 *   "Portrait" = panel's long side points up the slope (typical for steep
 *                roofs, maximizes rows).
 *   "Landscape" = panel's long side runs across the slope.
 *
 * Returns { w, h } where w is along the roof's long axis and h is along
 * the slope (compressed). The caller rotates these dimensions into the
 * canvas frame using roofPrimaryAngle().
 */
export function panelDisplaySize(
  panelType: PanelType,
  roof: Roof,
  mpp: number
): { w: number; h: number } {
  const tilt = (roof.tiltDeg * Math.PI) / 180;
  const cosT = Math.cos(tilt);
  if (roof.panelOrientation === 'portrait') {
    // Short side across the roof's long axis, long side up the slope.
    return {
      w: panelType.widthM / mpp,
      h: (panelType.heightM * cosT) / mpp,
    };
  }
  // Landscape: long side along the roof's long axis, short side up the slope.
  return {
    w: panelType.heightM / mpp,
    h: (panelType.widthM * cosT) / mpp,
  };
}

/**
 * Real (on-slope) panel area in m² — used for any energy-related math.
 *
 * NB: This is the physical panel area, not the projected shadow area. The
 * projected area equals `realArea * cos(tilt)`.
 */
export function panelRealArea(panelType: PanelType): number {
  return panelType.widthM * panelType.heightM;
}

/**
 * Compute the 4 canvas-space corners of a panel rectangle centered at
 * `center`, rotated by `angleRad` around that center.
 *
 * Used by `snapPanelToGrid` to test "does the candidate panel fit inside
 * the polygon?" — we test all 4 corners rather than just the center,
 * because a rectangle can have its center inside a polygon while a corner
 * pokes outside (e.g. near a notch in an L-shaped roof).
 */
export function panelCorners(
  center: Point,
  angleRad: number,
  w: number,
  h: number
): Point[] {
  const hx = w / 2;
  const hy = h / 2;
  // Corners in panel-local frame (panel center at origin), axis-aligned.
  const corners = [
    { x: -hx, y: -hy },
    { x: hx, y: -hy },
    { x: hx, y: hy },
    { x: -hx, y: hy },
  ];
  // Translate into the panel's world position, then rotate around the center.
  return corners.map((c) =>
    rotatePoint({ x: center.x + c.x, y: center.y + c.y }, angleRad, center)
  );
}

/**
 * The core of panel placement: given a cursor position, return the
 * center-point where a panel should go, or null if this position is invalid.
 *
 * Algorithm:
 *   1. Rotate cursor into the roof-local frame (origin = polygon centroid)
 *      so the grid axes align with the X/Y of our math.
 *   2. Snap to the nearest integer multiple of the cell size (cellW, cellH).
 *      Snapping is anchored to the polygon centroid, not (0,0), so the grid
 *      stays stable as the user redraws the roof.
 *   3. Rotate the snapped point back into canvas space.
 *   4. Reject if any of the panel's 4 corners falls outside the polygon.
 *   5. Reject if the candidate would collide with an existing panel.
 *      (We use 0.7 × min(cell) as the "too close" threshold, allowing
 *      panels to sit edge-to-edge but not overlap.)
 *
 * Returns null → caller paints a red ghost and blocks the click. Returns a
 * point → caller paints a green ghost and allows click-to-place.
 */
export function snapPanelToGrid(
  cursorPos: Point,
  roof: Roof,
  panelType: PanelType,
  mpp: number,
  existingCenters: Point[]
): Point | null {
  const angle = roofPrimaryAngle(roof.polygon);
  const { w: cellW, h: cellH } = panelDisplaySize(panelType, roof, mpp);
  if (cellW <= 0 || cellH <= 0) return null; // defensive: degenerate panel

  const origin = polygonCentroid(roof.polygon);

  // Step 1: cursor → roof-local frame (rotate by -angle around centroid).
  const local = rotatePoint(cursorPos, -angle, origin);

  // Step 2: snap to grid anchored at the centroid. Snapping `(local - origin)`
  // and adding origin back keeps the grid stable when the centroid shifts
  // slightly due to floating-point roundoff.
  const snappedLocal = {
    x: origin.x + Math.round((local.x - origin.x) / cellW) * cellW,
    y: origin.y + Math.round((local.y - origin.y) / cellH) * cellH,
  };

  // Step 3: back to canvas frame.
  const candidate = rotatePoint(snappedLocal, angle, origin);

  // Step 4: polygon containment check on all 4 corners.
  const corners = panelCorners(candidate, angle, cellW, cellH);
  if (!corners.every((c) => isInsidePolygon(c, roof.polygon))) return null;

  // Step 5: overlap check against existing panels on this roof.
  //   0.7 × min(cellW, cellH) is a heuristic: it's close enough to detect
  //   actual overlap while tolerating floating-point jitter in historic
  //   snap results. If panels should butt edge-to-edge, this threshold
  //   must stay below both cellW and cellH.
  const minDist = Math.min(cellW, cellH) * 0.7;
  for (const c of existingCenters) {
    if (Math.hypot(c.x - candidate.x, c.y - candidate.y) < minDist) return null;
  }

  return candidate;
}

/** Euclidean distance — convenience wrapper, kept for call-site readability. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
