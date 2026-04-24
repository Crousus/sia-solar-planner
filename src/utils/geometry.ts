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
 * Remove vertices that lie (within tolerance) on the straight line between
 * their two polygon-ring neighbors. In practical terms: if three consecutive
 * corners V(i-1), V(i), V(i+1) are collinear, V(i) contributes nothing to
 * the shape and should be dropped — otherwise length labels split a
 * visually-single edge into two (30.7m + 18.1m where it should read 48.8m)
 * and the edge hit-areas likewise fragment.
 *
 * Origin of the artifact: edge-delete collapses an edge's two endpoints to
 * their midpoint, which can leave that midpoint dead-center on a now-longer
 * straight run. Similarly, merging two roofs along a shared edge often
 * leaves the shared-edge endpoints as redundant vertices on what should be
 * a clean boundary. Running this pass after such operations keeps the
 * polygon topology aligned with what the user "sees".
 *
 * Tolerance: perpendicular distance from V(i) to the line V(i-1)→V(i+1),
 * measured in the same units as the input (canvas pixels here). 1.5 px is
 * tighter than findSharedEdge's 2 px — we want to be slightly more
 * conservative because false-positive removal distorts the polygon, whereas
 * a false-positive shared-edge match is only surfaced on explicit merge.
 *
 * Iteration: a single sweep over the ring. Removing V(i) never makes a
 * previously non-collinear triple become collinear (the other triples are
 * untouched), so one pass is enough — no fixpoint loop needed. We do
 * build indices against the CURRENT (shrinking) array so the "previous"
 * vertex naturally updates as we remove; this matters when two removable
 * vertices are adjacent.
 *
 * Safety floor: we refuse to shrink below 3 vertices (degenerate polygon).
 * This is a defensive guard — it shouldn't trigger in practice because a
 * truly degenerate input would already have been rejected upstream.
 */
export function simplifyCollinear(polygon: Point[], tolPx: number = 1.5): Point[] {
  if (polygon.length <= 3) return polygon.slice();
  const out = polygon.slice();
  // Walk forward, removing collinear middle vertices in-place. `i`
  // advances only when the current vertex is kept, so removals don't
  // skip the replacement neighbor.
  let i = 0;
  while (i < out.length && out.length > 3) {
    const n = out.length;
    const prev = out[(i - 1 + n) % n];
    const curr = out[i];
    const next = out[(i + 1) % n];
    // Perpendicular distance from curr to the infinite line through
    // prev→next. Formula: |cross(next-prev, curr-prev)| / |next-prev|.
    // Cross product magnitude = 2 × triangle area; dividing by the base
    // length (|next-prev|) yields the height, which IS the perpendicular
    // distance we want.
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const baseLen = Math.hypot(dx, dy);
    // Near-zero base means prev == next (a spike). Treat curr as
    // redundant — the "edge" is actually a degenerate backtrack and
    // removing curr unkinks it. This case mostly protects downstream
    // rendering from divide-by-zero; users shouldn't produce such
    // polygons, but merges occasionally can.
    if (baseLen < 1e-9) {
      out.splice(i, 1);
      continue;
    }
    const cross = Math.abs(dx * (curr.y - prev.y) - dy * (curr.x - prev.x));
    const perpDist = cross / baseLen;
    if (perpDist <= tolPx) {
      out.splice(i, 1);
      // Don't advance i: the new out[i] is the old next, and its
      // collinearity relative to its NEW neighbors hasn't been tested.
      continue;
    }
    i++;
  }
  return out;
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
 * Project point `p` onto the INFINITE line through segment `a→b`.
 *
 * Returns:
 *   - `t`: the parameter along a→b. t=0 is `a`, t=1 is `b`, t<0 or t>1 means
 *     the foot of the perpendicular lies outside the segment extent.
 *   - `dist`: perpendicular distance from `p` to the line.
 *   - `point`: the foot of the perpendicular (unclamped — on the line, not
 *     necessarily on the segment).
 *
 * Callers that need the nearest point ON the segment (e.g. drawing snap)
 * should clamp `t` into [0,1] and compute `a + t·(b−a)` locally — kept out
 * of this helper so the one primitive serves both use cases:
 *   - drawingSnap.projectEdge clamps to the segment (visual "snap to edge").
 *   - stringRouting uses the unclamped t to decide if an off-string panel
 *     sits *within* the wire-routing segment's T-window (0.1..0.9) for
 *     detour eligibility — clamping would defeat that check.
 *
 * Degenerate case (|a−b| ≈ 0): returns t=0, point=a, dist=|p−a|. This
 * keeps callers from having to special-case zero-length segments, which
 * can arise in pathological imported data (two consecutive identical panel
 * centers) and in drawingSnap's edge collection pass.
 */
export function projectOnSegment(
  p: Point,
  a: Point,
  b: Point,
): { t: number; dist: number; point: Point } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  // Threshold is 1e-9 rather than 0 to absorb floating-point noise on
  // numerically-near-coincident endpoints — matters for polygon cuts
  // where a user clicks "on top of" the previous vertex.
  if (len2 < 1e-9) {
    return { t: 0, dist: Math.hypot(p.x - a.x, p.y - a.y), point: { ...a } };
  }
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  return { t, dist: Math.hypot(p.x - px, p.y - py), point: { x: px, y: py } };
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
