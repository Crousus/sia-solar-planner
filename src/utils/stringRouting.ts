// ────────────────────────────────────────────────────────────────────────────
// stringRouting — computes the polyline path for a PV string's wiring.
//
// Why not just "connect panel centers in order"?
//   When the user lassos a non-contiguous set (e.g. panels A and C in a row
//   but not B), a straight A→C line visually sweeps right through panel B's
//   rectangle. A reader can't tell whether B is part of the string or being
//   skipped. To make the skip unambiguous, we DETOUR the wiring AROUND every
//   off-string panel that sits on the A→C line — the line bumps out
//   perpendicular to the segment direction, clearing the skipped panel's
//   bounding box, then returns to the line. Visually, the wire "goes over
//   or under" the skipped panel, making the skip obvious.
//
// We also try (best effort) to avoid having the final polyline cross itself —
// meaning any two sub-segments of the same string intersecting. Self-crossings
// are confusing to read and don't correspond to any real wiring topology. We
// can't always avoid them (the user's panel selection / wiring order might
// force them), hence "best effort": for each segment with detours, we try
// both perpendicular sides (above vs. below the segment direction) and pick
// the one that produces fewer crossings with the same-string sub-segments
// already committed.
//
// Everything here operates in canvas pixels. Meter awareness only enters via
// `panelDisplaySize` to compute the "near the line" tolerance and the detour
// magnitude, which both need to scale with panel size.
// ────────────────────────────────────────────────────────────────────────────

import type { Panel, Point, Roof, PanelType } from '../types';
import { panelDisplaySize, projectOnSegment } from './geometry';

// Projection-parameter window for treating a panel as "between" the
// segment endpoints. Values near 0 or 1 would put the detour right on top
// of an endpoint, which looks jagged — so we only detour around panels
// in the middle 80% of the segment.
const T_MIN = 0.1;
const T_MAX = 0.9;

// Perpendicular distance tolerance multiplier. An off-string panel counts
// as "in the way" if its center is within `min(panelW, panelH) * NEAR_LINE_RATIO`
// pixels of the straight segment.
//
// Why 0.35 and not 0.5: a line passing cleanly BETWEEN two adjacent panels
// puts each of their centers at exactly half a panel width from the line
// (= 0.5 × min(w,h)). With a 0.5 threshold, one of them usually sneaks in
// due to floating-point jitter, producing a spurious detour. 0.35 leaves
// comfortable headroom for "cleanly between" cases while still catching
// panels the line actually runs through (center distance < ~0.3 × dim).
const NEAR_LINE_RATIO = 0.35;

// Detour magnitude as a multiple of the panel's SHORTER dimension. We
// don't need to clear the whole panel — only the central index-number
// circle drawn in PanelLayer (radius ≈ min(w,h) * 0.25). A 0.35 multiplier
// lands the wire clearly outside that circle with a small visual gap,
// while still staying INSIDE the panel rectangle. The wire therefore
// draws over the skipped panel's body but misses its center dot, which
// reads as "the wire passes over this panel but doesn't terminate here".
const DETOUR_SHORT_RATIO = 0.42;

/**
 * Signed 2× area of triangle p1-p2-p3 (a.k.a. the cross product of the
 * two edges). Sign indicates CCW/CW orientation; zero = collinear.
 * Used by `segmentsCross` — the classic orientation test.
 */
function ccw(p1: Point, p2: Point, p3: Point): number {
  return (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
}

/**
 * True if the open segments a→b and c→d strictly cross (interiors
 * intersect at a single point). Segments that merely share an endpoint are
 * NOT a crossing — that's the normal "vertex" case in a polyline.
 *
 * Collinear overlap isn't handled (can't arise here — all waypoints are
 * distinct by construction).
 */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const EPS = 1e-6;
  const shared = (p: Point, q: Point) =>
    Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS;
  if (shared(a, c) || shared(a, d) || shared(b, c) || shared(b, d)) return false;
  const d1 = ccw(c, d, a);
  const d2 = ccw(c, d, b);
  const d3 = ccw(a, b, c);
  const d4 = ccw(a, b, d);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

/**
 * Build the wiring polyline for one string.
 *
 * Inputs:
 *   - `stringPanels` — panels of this string, sorted by `indexInString`
 *   - `otherPanels`  — every other panel in the project (different strings
 *                      AND unassigned). Only these are candidates for
 *                      triggering a detour; same-string panels are already
 *                      polyline endpoints.
 *   - `roofsById`    — for per-panel display size (tilt/orientation varies
 *                      per roof → panel dimensions in canvas px vary)
 *   - `panelType`    — project-global panel dimensions in meters
 *   - `mpp`          — meters-per-pixel calibration
 *
 * Output: ordered array of canvas-pixel points ready to flatten into
 *         Konva's `Line.points`. Typically more entries than stringPanels
 *         because each detour inserts one waypoint.
 *
 * Algorithm (per adjacent pair A→B of in-string panels):
 *   1. Find off-string panels whose centers lie near the A→B line and fall
 *      within the (T_MIN, T_MAX) projection window. These are the panels
 *      we have to detour around.
 *   2. Sort by projection parameter t (ascending, so we meet them in order
 *      along A→B).
 *   3. Build TWO candidate sub-paths from A to B:
 *        side +1: every detour offset to the "left" of A→B (perp rotated CCW)
 *        side −1: every detour offset to the "right" (perp rotated CW)
 *      All detours in one pair use the same side — mixing would create a
 *      zigzag that's worse than either consistent choice.
 *   4. Count how many prior same-string sub-segments each candidate crosses;
 *      commit the smaller-crossings candidate (tie → side +1 arbitrarily).
 *
 * Non-goals:
 *   - We don't reorder the input panels. Wiring order is the user's call
 *     (set via lasso / renumber). We only decorate the inter-panel path.
 *   - We don't try to "unknot" an ordering that's already self-crossing at
 *     the panel-center level — only the detour waypoints we add are under
 *     our control.
 */
export function computeStringPath(
  stringPanels: Panel[],
  otherPanels: Panel[],
  roofsById: Map<string, Roof>,
  panelType: PanelType,
  mpp: number,
): Point[] {
  if (stringPanels.length === 0) return [];
  if (mpp <= 0) {
    // No calibration yet — fall back to plain centers so we don't blow up
    // if panels somehow exist pre-lock (shouldn't happen via UI, but
    // defend against imported state).
    return stringPanels.map((p) => ({ x: p.cx, y: p.cy }));
  }

  const path: Point[] = [{ x: stringPanels[0].cx, y: stringPanels[0].cy }];

  // All committed sub-segments of THIS string so far. Used for the
  // crossing-count heuristic when choosing a detour side.
  const segments: Array<[Point, Point]> = [];

  for (let i = 1; i < stringPanels.length; i++) {
    const fromPanel = stringPanels[i - 1];
    const toPanel = stringPanels[i];
    const from: Point = { x: fromPanel.cx, y: fromPanel.cy };
    const to: Point = { x: toPanel.cx, y: toPanel.cy };

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1e-6) {
      // Degenerate (two panels at same spot) — just skip detour logic.
      segments.push([from, to]);
      path.push(to);
      continue;
    }
    // Unit perpendicular to the segment direction, rotated +90° (CCW in math
    // axes; visually "counter-clockwise" on a y-down canvas).
    const perpX = -dy / segLen;
    const perpY = dx / segLen;

    // ── Step 1+2: candidate off-string panels near the segment ───────────
    type Candidate = { center: Point; t: number; detour: number };
    const candidates: Candidate[] = [];
    for (const p of otherPanels) {
      const roof = roofsById.get(p.roofId);
      if (!roof) continue;
      // Orientation is per-panel (group-level). Always populated:
      // migrateProject backfills legacy saves at the persistence
      // boundary, so no roof-default fallback needed here.
      const orientation = p.orientation;
      const { w, h } = panelDisplaySize(panelType, orientation, roof.tiltDeg, mpp);
      const nearThreshold = Math.min(w, h) * NEAR_LINE_RATIO;
      // Detour magnitude: just enough to clear the central index-number
      // circle (see DETOUR_SHORT_RATIO). Scales with panel size.
      const detour = Math.min(w, h) * DETOUR_SHORT_RATIO;
      const center: Point = { x: p.cx, y: p.cy };
      const { t, dist } = projectOnSegment(center, from, to);
      if (t <= T_MIN || t >= T_MAX) continue;
      if (dist > nearThreshold) continue;
      candidates.push({ center, t, detour });
    }
    candidates.sort((a, b) => a.t - b.t);

    // No obstructing panels → simple straight segment, commit and move on.
    if (candidates.length === 0) {
      segments.push([from, to]);
      path.push(to);
      continue;
    }

    // ── Step 3: build both candidate paths (one per side) ────────────────
    const buildWaypoints = (side: 1 | -1): Point[] =>
      candidates.map((c) => ({
        x: c.center.x + perpX * c.detour * side,
        y: c.center.y + perpY * c.detour * side,
      }));

    // ── Step 4: count crossings with already-committed sub-segments ──────
    const countCrossings = (wps: Point[]): number => {
      let count = 0;
      let prev = from;
      for (const w of wps) {
        for (const [sA, sB] of segments) {
          if (segmentsCross(prev, w, sA, sB)) count++;
        }
        prev = w;
      }
      // Final leg into `to`.
      for (const [sA, sB] of segments) {
        if (segmentsCross(prev, to, sA, sB)) count++;
      }
      return count;
    };

    const wpsLeft = buildWaypoints(1);
    const wpsRight = buildWaypoints(-1);
    const crossLeft = countCrossings(wpsLeft);
    const crossRight = countCrossings(wpsRight);
    // Tiebreak: prefer "left" (side +1) for consistency across runs.
    const chosen = crossLeft <= crossRight ? wpsLeft : wpsRight;

    // Commit waypoints + final leg.
    let prev = from;
    for (const wp of chosen) {
      segments.push([prev, wp]);
      path.push(wp);
      prev = wp;
    }
    segments.push([prev, to]);
    path.push(to);
  }

  return path;
}
