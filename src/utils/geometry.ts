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
 * polygon-edge crossings; odd = inside, even = outside.
 *
 * Why no horizontal-edge guard: the first clause `yi > p.y !== yj > p.y`
 * is only true when the two endpoints sit on opposite sides of the ray
 * (one strictly above, one at-or-below). That rules out horizontal edges
 * (yi === yj puts both on the same side → skip), so `yj - yi` can't be
 * zero by the time we reach the division. A previous version had a
 * `|| 1e-12` epsilon fallback here; it was dead code.
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
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
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
 * Orientation is taken explicitly (not from the roof) because orientation
 * is now per-panel-group, not per-roof. Callers resolve it from either
 * `panel.orientation` (for an existing panel) or the active group's
 * representative panel (for the ghost), falling back to the roof default
 * when neither is available. Tilt still comes from the roof because a
 * roof has a single physical slope regardless of how its groups are laid
 * out.
 *
 * Returns { w, h } where w is along the roof's long axis and h is along
 * the slope (compressed). The caller rotates these dimensions into the
 * canvas frame using roofPrimaryAngle().
 */
export function panelDisplaySize(
  panelType: PanelType,
  orientation: 'portrait' | 'landscape',
  tiltDeg: number,
  mpp: number
): { w: number; h: number } {
  const tilt = (tiltDeg * Math.PI) / 180;
  const cosT = Math.cos(tilt);
  if (orientation === 'portrait') {
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
  orientation: 'portrait' | 'landscape',
  mpp: number,
  existingCenters: Point[],
  origin: Point | null = null,
  snap: boolean = true
): Point | null {
  const angle = roofPrimaryAngle(roof.polygon);
  const { w: cellW, h: cellH } = panelDisplaySize(panelType, orientation, roof.tiltDeg, mpp);
  if (cellW <= 0 || cellH <= 0) return null; // defensive: degenerate panel

  const gridOrigin = origin || polygonCentroid(roof.polygon);

  let candidate: Point;
  if (snap) {
    // Step 1: cursor → roof-local frame (rotate by -angle around centroid).
    const local = rotatePoint(cursorPos, -angle, gridOrigin);

    // Step 2: snap to grid anchored at the centroid. Snapping `(local - gridOrigin)`
    // and adding origin back keeps the grid stable.
    const snappedLocal = {
      x: gridOrigin.x + Math.round((local.x - gridOrigin.x) / cellW) * cellW,
      y: gridOrigin.y + Math.round((local.y - gridOrigin.y) / cellH) * cellH,
    };

    // Step 3: back to canvas frame.
    candidate = rotatePoint(snappedLocal, angle, gridOrigin);
  } else {
    candidate = cursorPos;
  }

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

export interface PanelDimension {
  centerCanvas: Point;
  lengthM: number;
  textAngle: number;
}

/**
 * Computes the dimensions of outer straight edges of contiguous panel groups.
 * Used to draw length labels for connected panels.
 */
export function getPanelGroupDimensions(
  panels: { cx: number; cy: number }[],
  roof: Roof,
  panelType: PanelType,
  orientation: 'portrait' | 'landscape',
  mpp: number
): PanelDimension[] {
  if (panels.length === 0) return [];
  const angle = roofPrimaryAngle(roof.polygon);
  const { w: cellW, h: cellH } = panelDisplaySize(panelType, orientation, roof.tiltDeg, mpp);
  if (cellW <= 0 || cellH <= 0) return [];

  // Origin is defined by the first panel in the group
  const origin = { x: panels[0].cx, y: panels[0].cy };

  const edges = new Set<string>();

  for (const p of panels) {
    const local = rotatePoint({ x: p.cx, y: p.cy }, -angle, origin);
    const gx = Math.round((local.x - origin.x) / cellW);
    const gy = Math.round((local.y - origin.y) / cellH);

    // 4 directed edges of the cell
    const top = `${gx},${gy}->${gx + 1},${gy}`;
    const right = `${gx + 1},${gy}->${gx + 1},${gy + 1}`;
    const bottom = `${gx + 1},${gy + 1}->${gx},${gy + 1}`;
    const left = `${gx},${gy + 1}->${gx},${gy}`;

    for (const e of [top, right, bottom, left]) {
      const [from, to] = e.split('->');
      const rev = `${to}->${from}`;
      if (edges.has(rev)) {
        edges.delete(rev);
      } else {
        edges.add(e);
      }
    }
  }

  const edgeList = Array.from(edges).map(e => {
    const [from, to] = e.split('->');
    const [x1, y1] = from.split(',').map(Number);
    const [x2, y2] = to.split(',').map(Number);
    return { x1, y1, x2, y2 };
  });

  // Merge contiguous collinear edges
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < edgeList.length; i++) {
      for (let j = 0; j < edgeList.length; j++) {
        if (i === j) continue;
        const e1 = edgeList[i];
        const e2 = edgeList[j];
        const dx1 = Math.sign(e1.x2 - e1.x1);
        const dy1 = Math.sign(e1.y2 - e1.y1);
        const dx2 = Math.sign(e2.x2 - e2.x1);
        const dy2 = Math.sign(e2.y2 - e2.y1);
        
        if (e1.x2 === e2.x1 && e1.y2 === e2.y1 && dx1 === dx2 && dy1 === dy2) {
          e1.x2 = e2.x2;
          e1.y2 = e2.y2;
          edgeList.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  const dimensions: PanelDimension[] = [];

  for (const e of edgeList) {
    const gridLen = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
    if (gridLen > 1) { // Only for edges longer than one panel
      const isHorizontal = (e.y1 === e.y2);
      const lenPx = isHorizontal ? gridLen * cellW : gridLen * cellH;
      const lenM = lenPx * mpp;

      const mx = (e.x1 + e.x2) / 2;
      const my = (e.y1 + e.y2) / 2;

      const px = mx * cellW;
      const py = my * cellH;

      const dx = Math.sign(e.x2 - e.x1);
      const dy = Math.sign(e.y2 - e.y1);
      const nx = dy;
      const ny = -dx;

      // Shift outwards by 15 pixels in local space
      const shiftedPx = px + nx * 15;
      const shiftedPy = py + ny * 15;

      const centerCanvas = rotatePoint(
        { x: origin.x + shiftedPx, y: origin.y + shiftedPy },
        angle,
        origin
      );

      // Text angle
      // Edge goes from e1 to e2, local angle:
      let localAngle = Math.atan2(e.y2 - e.y1, e.x2 - e.x1) * 180 / Math.PI;
      let textAngle = (angle * 180 / Math.PI) + localAngle;
      
      // Normalize text angle to keep it readable
      while (textAngle > 180) textAngle -= 360;
      while (textAngle <= -180) textAngle += 360;
      
      if (textAngle > 90 || textAngle < -90) {
        textAngle += 180;
      }

      dimensions.push({
        centerCanvas,
        lengthM: lenM,
        textAngle
      });
    }
  }

  return dimensions;
}

/** Euclidean distance — convenience wrapper, kept for call-site readability. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Re-validate an *already placed* panel under a (possibly new) panelType.
 *
 * Used when the user edits panelType.widthM / heightM: existing panels keep
 * their stored (cx, cy) center but their rendered rectangle grows/shrinks
 * around that point. A panel that previously fit may now overflow the
 * polygon or collide with neighbours.
 *
 * The check mirrors the two invariants enforced at placement time
 * (see snapPanelToGrid):
 *   1. All 4 corners must lie inside the roof polygon.
 *   2. No neighbour center may sit closer than 0.7 × min(cellW, cellH).
 *
 * NB: The symmetric-overlap check means that if two neighbours each
 * overlap the other, both will report invalid. Callers that auto-prune
 * should remove all at once rather than iteratively — see Sidebar's
 * panel-type edit guard.
 */
export function panelFitsOnRoof(
  panel: { id: string; cx: number; cy: number },
  roof: Roof,
  panelType: PanelType,
  orientation: 'portrait' | 'landscape',
  mpp: number,
  siblings: { id: string; cx: number; cy: number }[]
): boolean {
  const angle = roofPrimaryAngle(roof.polygon);
  const { w, h } = panelDisplaySize(panelType, orientation, roof.tiltDeg, mpp);
  if (w <= 0 || h <= 0) return false;
  const corners = panelCorners({ x: panel.cx, y: panel.cy }, angle, w, h);
  if (!corners.every((c) => isInsidePolygon(c, roof.polygon))) return false;
  const minDist = Math.min(w, h) * 0.7;
  for (const s of siblings) {
    if (s.id === panel.id) continue;
    if (Math.hypot(s.cx - panel.cx, s.cy - panel.cy) < minDist) return false;
  }
  return true;
}
