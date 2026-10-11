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
// drawingSnap — CAD-style geometric snapping for the roof draw tool.
//
// Three kinds of snap, combined into a single pass:
//
//   0. POINT & EDGE SNAP. If the cursor is near an existing vertex or edge,
//      snap exactly to it.
//
//   1. ANGLE SNAP. The new edge's direction is snapped to a "good" angle:
//        a. 45°-multiples relative to the previous edge (so corners come
//           out at 45° / 90° / 135° etc. without eyeballing).
//        b. Parallel / perpendicular to ANY existing edge (current
//           drawing + all committed roofs).
//        c. Absolute 45°-multiples (horizontal, vertical, diagonal).
//      The candidate closest to the cursor's raw angle wins — if none is
//      within ANGLE_TOL_DEG the user's raw direction is kept.
//
//   2. LENGTH SNAP. Once the direction is fixed, if the projected length
//      along that direction is near an EXISTING edge's length, snap to
//      that exact length. Makes it trivial to draw rectangles with equal
//      opposite sides.
//
//   3. GUIDES. Returns a list of lines the renderer should draw to
//      explain WHY the snap happened — e.g. "parallel to this edge",
//      "length matches this edge", "angle direction".
//
// Philosophy: tolerances are tight (3° / 8 screen px) because the user will
// expect raw cursor control most of the time. The snap should feel like
// a gentle magnet, not a drag on the cursor.
// ────────────────────────────────────────────────────────────────────────────

import type { Point, Roof } from '../types';
import { projectOnSegment } from './geometry';
import { lineAngleDiff, pointSegmentDistance, type ImageEdge, type ImageEdgeSource } from './imageEdges';

/** What caused a particular guide to appear — drives its color. */
export type SnapKind =
  | 'angle-direction'   // the infinite ray showing the snapped direction
  | 'edge-parallel'     // reference edge for parallel snap
  | 'edge-perp'         // reference edge for perpendicular snap
  | 'length-match'      // reference edge whose length we're matching
  | 'point-match'       // snapped exactly to a corner
  | 'edge-match'        // reference edge we are snapping onto directly
  | 'vertex-align'      // cursor is in line with an existing vertex
  | 'image-edge';       // straight edge detected in the satellite image

/** A single line the renderer should draw as a snap guide. */
export type SnapGuide = {
  kind: SnapKind;
  from: Point;
  to: Point;
};

export type SnapResult = {
  /** The snapped cursor position — use this for preview + commit. */
  point: Point;
  /** Lines to draw showing what's being snapped to. */
  guides: SnapGuide[];
  /** The final edge length in canvas pixels (for displaying in meters). */
  edgeLengthPx: number;
  /** True if a length-snap fired (for styling the length label). */
  lengthSnapped: boolean;
  /** True if an angle-snap fired (for styling the preview line). */
  angleSnapped: boolean;
};

/** Tolerances — tuned for "magnet" feel, not sticky.
 *
 *  The *_PX values are SCREEN pixels. computeDrawingSnap divides them by
 *  the stage scale (opts.scale) to get world-pixel tolerances, so the
 *  magnet feels the same at every zoom level. Previously they were applied
 *  in world pixels directly: zoomed in 4× the magnet shrank to 2 screen px
 *  (practically unusable), zoomed out to 0.25× it grew to 32+ screen px
 *  and grabbed everything. The angle tolerance is scale-invariant already. */
const ANGLE_TOL_DEG = 3;
const LENGTH_TOL_PX = 8;
const POINT_SNAP_TOL_PX = 10;
const EDGE_SNAP_TOL_PX = 8;
const ALIGN_TOL_PX = 8;
/** Detected image edges (ADR-019). Corner tolerance is a little larger than
 *  the edge one: hitting a roof corner is the most valuable snap, and the
 *  two detected lines' crossing is a precise point even when each line
 *  stops a few px short of it (corners blur). */
const IMAGE_CORNER_TOL_PX = 12;
const IMAGE_EDGE_TOL_PX = 7;
/** How far around the cursor to look for detected edges at all. */
const IMAGE_SEARCH_PX = 40;
/** Two detected lines must differ by this much to form a corner. */
const IMAGE_CORNER_MIN_ANGLE_DEG = 20;

/** Two candidate angles closer than this are "the same direction". Angles
 *  reach the candidate list via different arithmetic (atan2 of an edge vs.
 *  prevAng + k·π/4), so exactly-equal directions differ in the last bits —
 *  a strict `<` let float noise decide which one won the tie. */
const ANGLE_TIE_EPS_DEG = 1e-6;

/** Normalize an angle to (-π, π]. */
function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Unsigned angular distance in degrees between two angles (rad). */
function angleDiffDeg(a: number, b: number): number {
  return (Math.abs(normalizeAngle(a - b)) * 180) / Math.PI;
}

/**
 * Local helper: closest point ON the segment (not the infinite line) from `p`.
 * Clamps the projection parameter into [0,1] — if the perpendicular foot
 * lies outside the segment, returns the nearest endpoint.
 *
 * Edge snap wants this clamped version: a cursor dragged past the end of an
 * edge should snap to that endpoint, not continue as though the line
 * extended infinitely. The shared `projectOnSegment` in geometry.ts
 * intentionally does NOT clamp (stringRouting needs the unclamped t for
 * its T-window test), so we clamp here.
 */
function nearestOnSegment(p: Point, a: Point, b: Point): Point {
  const { t, point } = projectOnSegment(p, a, b);
  if (t <= 0) return { ...a };
  if (t >= 1) return { ...b };
  return point;
}

/**
 * Internal: an edge candidate used for BOTH angle snaps and length snaps.
 *
 * Since edges come from in-progress drawing as well as committed roofs,
 * we flatten them into a single array up-front.
 */
type EdgeRef = { a: Point; b: Point; angle: number; length: number };

function isUsableEdge(a: Point, b: Point): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return Number.isFinite(len) && len > 1e-9;
}

function collectEdges(drawingPoints: Point[], roofs: Roof[]): EdgeRef[] {
  const edges: EdgeRef[] = [];
  // Committed roofs: every closed polygon edge is a candidate reference.
  for (const roof of roofs) {
    for (let i = 0; i < roof.polygon.length; i++) {
      const a = roof.polygon[i];
      const b = roof.polygon[(i + 1) % roof.polygon.length];
      // Zero-length / non-finite edges carry no direction or length to
      // snap to (atan2(0,0) = 0 would inject a bogus "horizontal" ref).
      if (!isUsableEdge(a, b)) continue;
      edges.push({
        a,
        b,
        angle: Math.atan2(b.y - a.y, b.x - a.x),
        length: Math.hypot(b.x - a.x, b.y - a.y),
      });
    }
  }
  // In-progress polygon: each committed segment is also a reference.
  for (let i = 0; i < drawingPoints.length - 1; i++) {
    const a = drawingPoints[i];
    const b = drawingPoints[i + 1];
    if (!isUsableEdge(a, b)) continue;
    edges.push({
      a,
      b,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      length: Math.hypot(b.x - a.x, b.y - a.y),
    });
  }
  return edges;
}

/**
 * Internal: an alignment ("tracking") line through an existing vertex.
 * The cursor snaps onto it when it is in line with that vertex — e.g. the
 * fourth corner of a rectangle directly below the first one.
 */
type AlignLine = { origin: Point; ux: number; uy: number };

/** Lines through every vertex except `last` (the angle ray already covers
 *  directions through the anchor): along the world axes, and along +
 *  perpendicular to each edge touching that vertex (its extension lines).
 *  Deduped per vertex so a vertex with an axis-aligned edge doesn't get
 *  the same line twice. */
function collectAlignLines(edges: EdgeRef[], last: Point): AlignLine[] {
  const byVertex = new Map<string, { origin: Point; angles: number[] }>();
  const key = (p: Point) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
  const add = (p: Point, angle: number) => {
    if (Math.hypot(p.x - last.x, p.y - last.y) < 1e-3) return;
    const k = key(p);
    let entry = byVertex.get(k);
    if (!entry) {
      entry = { origin: p, angles: [0, Math.PI / 2] };
      byVertex.set(k, entry);
    }
    for (const a of [angle, angle + Math.PI / 2]) {
      // Lines are undirected: compare angles mod π.
      const dup = entry.angles.some((b) => {
        const d = Math.abs(normalizeAngle(2 * (a - b))) / 2;
        return (d * 180) / Math.PI < 0.5;
      });
      if (!dup) entry.angles.push(a);
    }
  };
  for (const e of edges) {
    add(e.a, e.angle);
    add(e.b, e.angle);
  }
  const lines: AlignLine[] = [];
  for (const { origin, angles } of byVertex.values()) {
    for (const a of angles) lines.push({ origin, ux: Math.cos(a), uy: Math.sin(a) });
  }
  return lines;
}

/** Perpendicular distance from `p` to an alignment line, and the foot. */
function projectOnLine(p: Point, l: AlignLine): { dist: number; foot: Point } {
  const t = (p.x - l.origin.x) * l.ux + (p.y - l.origin.y) * l.uy;
  const foot = { x: l.origin.x + l.ux * t, y: l.origin.y + l.uy * t };
  return { dist: Math.hypot(p.x - foot.x, p.y - foot.y), foot };
}

/** Intersection of the ray `last + t·(ux,uy)` with an alignment line, as the
 *  ray parameter t — null when (near-)parallel. */
function rayLineT(last: Point, ux: number, uy: number, l: AlignLine): number | null {
  const denom = ux * l.uy - uy * l.ux;
  if (Math.abs(denom) < 1e-6) return null;
  const qx = l.origin.x - last.x;
  const qy = l.origin.y - last.y;
  return (qx * l.uy - qy * l.ux) / denom;
}

/** Intersection point of two alignment lines — null when (near-)parallel. */
function lineLineIntersection(a: AlignLine, b: AlignLine): Point | null {
  const denom = a.ux * b.uy - a.uy * b.ux;
  if (Math.abs(denom) < 1e-6) return null;
  const qx = b.origin.x - a.origin.x;
  const qy = b.origin.y - a.origin.y;
  const t = (qx * b.uy - qy * b.ux) / denom;
  return { x: a.origin.x + a.ux * t, y: a.origin.y + a.uy * t };
}

/** Infinite-line intersection of two segments' supporting lines. */
function segmentLinesIntersection(e: ImageEdge, f: ImageEdge): Point | null {
  const ux = Math.cos(e.angle);
  const uy = Math.sin(e.angle);
  const vx = Math.cos(f.angle);
  const vy = Math.sin(f.angle);
  const denom = ux * vy - uy * vx;
  if (Math.abs(denom) < 1e-9) return null;
  const qx = f.a.x - e.a.x;
  const qy = f.a.y - e.a.y;
  const t = (qx * vy - qy * vx) / denom;
  return { x: e.a.x + ux * t, y: e.a.y + uy * t };
}

/** The endpoint of `e` farther from `p` (to draw a guide from a corner). */
function farEnd(e: ImageEdge, p: Point): Point {
  return Math.hypot(e.a.x - p.x, e.a.y - p.y) > Math.hypot(e.b.x - p.x, e.b.y - p.y) ? e.a : e.b;
}

/** Nearest crossing of two detected edges within `tol` of the cursor. The
 *  crossing may lie up to `gap` beyond either edge's end (blurred corners
 *  make detected lines stop short). */
function imageCornerSnap(
  cursor: Point,
  edges: ImageEdge[],
  tol: number,
  gap: number,
  exclude: Point | null,
): { point: Point; guides: SnapGuide[] } | null {
  let best: { point: Point; guides: SnapGuide[]; d: number } | null = null;
  const minAngle = (IMAGE_CORNER_MIN_ANGLE_DEG * Math.PI) / 180;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e = edges[i];
      const f = edges[j];
      if (lineAngleDiff(e.angle, f.angle) < minAngle) continue;
      const x = segmentLinesIntersection(e, f);
      if (!x) continue;
      if (pointSegmentDistance(x, e.a, e.b) > gap || pointSegmentDistance(x, f.a, f.b) > gap) continue;
      if (exclude && Math.hypot(x.x - exclude.x, x.y - exclude.y) < 1e-3) continue;
      const d = Math.hypot(cursor.x - x.x, cursor.y - x.y);
      if (d < tol && (!best || d < best.d)) {
        best = {
          point: x,
          d,
          guides: [
            { kind: 'image-edge', from: x, to: farEnd(e, x) },
            { kind: 'image-edge', from: x, to: farEnd(f, x) },
          ],
        };
      }
    }
  }
  return best && { point: best.point, guides: best.guides };
}

/** Nearest detected edge within `tol`: the clamped foot of the cursor. */
function nearestImageEdge(
  cursor: Point,
  edges: ImageEdge[],
  tol: number,
): { edge: ImageEdge; foot: Point } | null {
  let best: { edge: ImageEdge; foot: Point; d: number } | null = null;
  for (const e of edges) {
    const foot = nearestOnSegment(cursor, e.a, e.b);
    const d = Math.hypot(cursor.x - foot.x, cursor.y - foot.y);
    if (d < tol && (!best || d < best.d)) best = { edge: e, foot, d };
  }
  return best && { edge: best.edge, foot: best.foot };
}

/**
 * Compute snap result for the current draw-roof cursor.
 *
 * Inputs:
 *   cursor         — raw pointer position
 *   drawingPoints  — vertices placed so far in the in-progress polygon
 *   roofs          — committed roofs (their edges are reference lines too)
 *   opts.enabled   — if false, return raw cursor with no guides
 *                    (caller passes `!shiftKey` to implement "hold Shift
 *                    to disable snapping" behavior)
 *   opts.scale     — current stage scale (screen px per world px). Pixel
 *                    tolerances are defined in screen px and divided by
 *                    this. Defaults to 1 (world == screen) for callers and
 *                    tests that don't care about zoom.
 *   opts.imageEdges — straight edges detected in the satellite image
 *                    (world coords). Lower priority than the user's own
 *                    geometry: own corner > own edge > image corner >
 *                    direction snaps / vertex alignment > image edge.
 *                    Also active for the FIRST vertex of a polygon.
 */
export function computeDrawingSnap(
  cursor: Point,
  drawingPoints: Point[],
  roofs: Roof[],
  opts: { enabled: boolean; scale?: number; imageEdges?: ImageEdgeSource | null } = { enabled: true }
): SnapResult {
  // Guard against 0 / negative / NaN scale (pre-measure render) — fall
  // back to 1 rather than producing Infinity tolerances.
  const scale = opts.scale !== undefined && Number.isFinite(opts.scale) && opts.scale > 0 ? opts.scale : 1;
  const pointTol = POINT_SNAP_TOL_PX / scale;
  const edgeTol = EDGE_SNAP_TOL_PX / scale;
  const lengthTol = LENGTH_TOL_PX / scale;
  const alignTol = ALIGN_TOL_PX / scale;
  const imgCornerTol = IMAGE_CORNER_TOL_PX / scale;
  const imgEdgeTol = IMAGE_EDGE_TOL_PX / scale;
  // Detected edges near the cursor — queried once per pointer move.
  const nearImage =
    opts.enabled && opts.imageEdges ? opts.imageEdges.near(cursor, IMAGE_SEARCH_PX / scale) : [];

  // First vertex: no anchor, so no direction / length / alignment snaps —
  // but the first roof corner is exactly where an image-corner snap helps
  // most. (Own-geometry snapping for the first click stays the split /
  // boundary flow's business in the click handler.)
  if (drawingPoints.length === 0) {
    const corner = imageCornerSnap(cursor, nearImage, imgCornerTol, imgCornerTol, null);
    if (corner) {
      return { point: corner.point, guides: corner.guides, edgeLengthPx: 0, lengthSnapped: false, angleSnapped: false };
    }
    const onEdge = nearestImageEdge(cursor, nearImage, imgEdgeTol);
    if (onEdge) {
      return {
        point: onEdge.foot,
        guides: [{ kind: 'image-edge', from: onEdge.edge.a, to: onEdge.edge.b }],
        edgeLengthPx: 0,
        lengthSnapped: false,
        angleSnapped: false,
      };
    }
    return { point: cursor, guides: [], edgeLengthPx: 0, lengthSnapped: false, angleSnapped: false };
  }
  const last = drawingPoints[drawingPoints.length - 1];
  const prev = drawingPoints.length >= 2 ? drawingPoints[drawingPoints.length - 2] : null;

  // Raw vector last → cursor.
  const rawDx = cursor.x - last.x;
  const rawDy = cursor.y - last.y;
  const rawLen = Math.hypot(rawDx, rawDy);

  // Degenerate (cursor exactly on last point) — nothing to do.
  if (rawLen < 1e-3) {
    return { point: cursor, guides: [], edgeLengthPx: 0, lengthSnapped: false, angleSnapped: false };
  }
  const rawAngle = Math.atan2(rawDy, rawDx);

  // Snap disabled → return raw values but still report the raw length
  // so the renderer can display it.
  if (!opts.enabled) {
    return {
      point: cursor,
      guides: [],
      edgeLengthPx: rawLen,
      lengthSnapped: false,
      angleSnapped: false,
    };
  }

  const edges = collectEdges(drawingPoints, roofs);

  // ── 1. Point Snap (Corners) ──────────────────────────────────────────
  let bestPointDist = pointTol;
  let pointSnapPoint: Point | null = null;

  for (const edge of edges) {
    for (const pt of [edge.a, edge.b]) {
      // Don't snap to the exact same point we just started from
      if (Math.hypot(pt.x - last.x, pt.y - last.y) < 1e-3) continue;

      const d = Math.hypot(cursor.x - pt.x, cursor.y - pt.y);
      if (d < bestPointDist) {
        bestPointDist = d;
        pointSnapPoint = { x: pt.x, y: pt.y };
      }
    }
  }

  if (pointSnapPoint) {
    const dx = pointSnapPoint.x - last.x;
    const dy = pointSnapPoint.y - last.y;
    return {
      point: pointSnapPoint,
      guides: [], // The visual feedback is the cursor jumping exactly to the corner
      edgeLengthPx: Math.hypot(dx, dy),
      lengthSnapped: false,
      angleSnapped: false,
    };
  }

  // ── 2. Edge Snap (Lines) ─────────────────────────────────────────────
  let bestEdgeDist = edgeTol;
  let edgeSnapPoint: Point | null = null;
  let edgeSnapRef: EdgeRef | null = null;

  for (const edge of edges) {
    const proj = nearestOnSegment(cursor, edge.a, edge.b);
    // Don't snap to the segment we are currently starting from
    if (Math.hypot(proj.x - last.x, proj.y - last.y) < 1e-3) continue;

    const d = Math.hypot(cursor.x - proj.x, cursor.y - proj.y);
    if (d < bestEdgeDist) {
      bestEdgeDist = d;
      edgeSnapPoint = proj;
      edgeSnapRef = edge;
    }
  }

  if (edgeSnapPoint && edgeSnapRef) {
    const dx = edgeSnapPoint.x - last.x;
    const dy = edgeSnapPoint.y - last.y;
    return {
      point: edgeSnapPoint,
      guides: [{ kind: 'edge-match', from: edgeSnapRef.a, to: edgeSnapRef.b }],
      edgeLengthPx: Math.hypot(dx, dy),
      lengthSnapped: false,
      angleSnapped: false, // Edge snaps don't get angle preview styling
    };
  }

  // ── 2b. Image corner (crossing of two detected roof edges) ───────────
  const imgCorner = imageCornerSnap(cursor, nearImage, imgCornerTol, imgCornerTol, last);
  if (imgCorner) {
    return {
      point: imgCorner.point,
      guides: imgCorner.guides,
      edgeLengthPx: Math.hypot(imgCorner.point.x - last.x, imgCorner.point.y - last.y),
      lengthSnapped: false,
      angleSnapped: false,
    };
  }

  // ── 3. Gather angle candidates ───────────────────────────────────────
  // Each candidate is an angle (radians) plus metadata describing WHY
  // it's a candidate — used later to build the right guide.
  type AngleCand = { angle: number; kind: SnapKind; refEdge?: EdgeRef };
  const cands: AngleCand[] = [];

  // (a) Absolute 45°-multiples.
  for (let k = 0; k < 8; k++) {
    cands.push({ angle: (k * Math.PI) / 4, kind: 'angle-direction' });
  }

  // (b) 45°-multiples relative to the previous edge (only if it exists).
  if (prev) {
    const prevAng = Math.atan2(last.y - prev.y, last.x - prev.x);
    for (let k = 0; k < 8; k++) {
      // Kind is 'angle-direction' because these have no specific reference
      // edge to highlight — they're relative to the most recent edge only.
      cands.push({ angle: prevAng + (k * Math.PI) / 4, kind: 'angle-direction' });
    }
  }

  // (c) Parallel / perpendicular to every other edge in the scene.
  //     Parallel = same angle (and +π); perpendicular = ±π/2.
  //     We tag with refEdge so the renderer can highlight the actual edge
  //     we're aligned with, not just the direction.
  //     All parallels first, then all perpendiculars, so on a tie the
  //     more telling "parallel to that edge" wins over "perpendicular to
  //     some other edge" (a rectangle's third side is both).
  for (const edge of edges) {
    cands.push({ angle: edge.angle,               kind: 'edge-parallel', refEdge: edge });
    cands.push({ angle: edge.angle + Math.PI,     kind: 'edge-parallel', refEdge: edge });
  }
  for (const edge of edges) {
    cands.push({ angle: edge.angle + Math.PI / 2, kind: 'edge-perp',     refEdge: edge });
    cands.push({ angle: edge.angle - Math.PI / 2, kind: 'edge-perp',     refEdge: edge });
  }

  // Pick the closest candidate within tolerance (if any).
  //
  // Tie-break: candidates describing the SAME direction (within float
  // noise) are common — a horizontal edge coincides with the absolute 0°
  // candidate, a rectangle's third side with "previous edge + 90°". The
  // generic 'angle-direction' entries come first in the list, so a plain
  // `d < bestDiff` let them win and the reference-edge highlight (the
  // magenta "you are parallel to THIS edge" guide) only showed when float
  // rounding happened to favour it. On a tie, prefer a candidate that has
  // a reference edge.
  let bestAngle = rawAngle;
  let bestKind: SnapKind | null = null;
  let bestRefEdge: EdgeRef | undefined;
  let bestDiff = ANGLE_TOL_DEG;
  for (const c of cands) {
    const d = angleDiffDeg(c.angle, rawAngle);
    const clearlyBetter = d < bestDiff - ANGLE_TIE_EPS_DEG;
    const tieButReferenced =
      bestKind !== null &&
      Math.abs(d - bestDiff) <= ANGLE_TIE_EPS_DEG &&
      c.refEdge !== undefined &&
      bestRefEdge === undefined;
    if (clearlyBetter || tieButReferenced) {
      bestDiff = d;
      bestAngle = c.angle;
      bestKind = c.kind;
      bestRefEdge = c.refEdge;
    }
  }
  const angleSnapped = bestKind !== null;

  const alignLines = collectAlignLines(edges, last);

  // ── 4a. No direction snap: free alignment with existing vertices ─────
  // The cursor isn't locked to a direction, but it may be in line with one
  // (or two) existing vertices. Snap onto that line — or onto the crossing
  // of two such lines (e.g. "below vertex A AND level with vertex B").
  if (!angleSnapped) {
    let first: { line: AlignLine; dist: number; foot: Point } | null = null;
    for (const line of alignLines) {
      const { dist, foot } = projectOnLine(cursor, line);
      if (dist < alignTol && (!first || dist < first.dist)) first = { line, dist, foot };
    }
    const onEdge = nearestImageEdge(cursor, nearImage, imgEdgeTol);
    // In line with a vertex AND on a detected edge → their crossing
    // (e.g. the eave, exactly level with the neighbouring roof's corner).
    if (first && onEdge) {
      const e = onEdge.edge;
      const crossT = rayLineT(e.a, Math.cos(e.angle), Math.sin(e.angle), first.line);
      if (crossT !== null && crossT >= -imgEdgeTol && crossT <= e.length + imgEdgeTol) {
        const point = { x: e.a.x + Math.cos(e.angle) * crossT, y: e.a.y + Math.sin(e.angle) * crossT };
        if (Math.hypot(point.x - cursor.x, point.y - cursor.y) < alignTol + imgEdgeTol) {
          return {
            point,
            guides: [
              { kind: 'vertex-align', from: first.line.origin, to: point },
              { kind: 'image-edge', from: e.a, to: e.b },
            ],
            edgeLengthPx: Math.hypot(point.x - last.x, point.y - last.y),
            lengthSnapped: false,
            angleSnapped: false,
          };
        }
      }
    }
    if (first) {
      let second: { line: AlignLine; dist: number } | null = null;
      for (const line of alignLines) {
        if (line === first.line) continue;
        if (Math.abs(line.ux * first.line.uy - line.uy * first.line.ux) < 1e-6) continue;
        const { dist } = projectOnLine(cursor, line);
        if (dist < alignTol && (!second || dist < second.dist)) second = { line, dist };
      }
      const crossing = second ? lineLineIntersection(first.line, second.line) : null;
      const point = crossing ?? first.foot;
      const guides: SnapGuide[] = [{ kind: 'vertex-align', from: first.line.origin, to: point }];
      if (crossing && second) guides.push({ kind: 'vertex-align', from: second.line.origin, to: point });
      return {
        point,
        guides,
        edgeLengthPx: Math.hypot(point.x - last.x, point.y - last.y),
        lengthSnapped: false,
        angleSnapped: false,
      };
    }
    if (onEdge) {
      return {
        point: onEdge.foot,
        guides: [{ kind: 'image-edge', from: onEdge.edge.a, to: onEdge.edge.b }],
        edgeLengthPx: Math.hypot(onEdge.foot.x - last.x, onEdge.foot.y - last.y),
        lengthSnapped: false,
        angleSnapped: false,
      };
    }
  }

  // ── Project cursor onto the snapped direction ray ────────────────────
  // Unit vector of the snapped direction.
  const ux = Math.cos(bestAngle);
  const uy = Math.sin(bestAngle);
  // Signed length along the ray. Clamp to 0 so we never project "behind"
  // `last` — that would flip the edge direction in a confusing way.
  const rawT = Math.max(0, rawDx * ux + rawDy * uy);
  let snappedLen = rawT;

  // ── Length snap ──────────────────────────────────────────────────────
  // If snappedLen is close to any existing edge's length, jump to it exactly.
  // Pick the NEAREST matching length, not the first one in edge order: with
  // several similar edges (e.g. 100 px and 104 px) the first-match rule
  // could yank a 103 px drag down to 100 when 104 was right there.
  let lengthRefEdge: EdgeRef | undefined;
  let bestLengthDiff = lengthTol;
  for (const edge of edges) {
    const diff = Math.abs(edge.length - rawT);
    if (diff < bestLengthDiff) {
      bestLengthDiff = diff;
      lengthRefEdge = edge;
    }
  }

  // ── 4b. Direction snap + vertex alignment ────────────────────────────
  // Along the locked direction, stop where the ray crosses an alignment
  // line through another vertex (closing a rectangle onto its first
  // corner's line, lining a ridge up with a neighbour's corner, …).
  // Competes with the length snap: whichever lands nearer to the raw
  // projection wins.
  let alignHit: { line: AlignLine; t: number } | null = null;
  // Also stop where the locked direction crosses a detected image edge —
  // draw exactly parallel AND land exactly on the eave.
  let imageHit: { edge: ImageEdge; t: number } | null = null;
  if (angleSnapped) {
    let bestStopDiff = Math.min(alignTol, bestLengthDiff);
    for (const line of alignLines) {
      const t = rayLineT(last, ux, uy, line);
      if (t === null || t <= 1e-6) continue;
      const diff = Math.abs(t - rawT);
      if (diff < bestStopDiff) {
        bestStopDiff = diff;
        alignHit = { line, t };
      }
    }
    for (const e of nearImage) {
      const eu = { origin: e.a, ux: Math.cos(e.angle), uy: Math.sin(e.angle) };
      const t = rayLineT(last, ux, uy, eu);
      if (t === null || t <= 1e-6) continue;
      // The crossing must be on the detected segment (± tolerance).
      const cross = { x: last.x + ux * t, y: last.y + uy * t };
      if (pointSegmentDistance(cross, e.a, e.b) > imgEdgeTol) continue;
      const diff = Math.abs(t - rawT);
      if (diff < Math.min(bestStopDiff, imgEdgeTol)) {
        bestStopDiff = diff;
        imageHit = { edge: e, t };
        alignHit = null;
      }
    }
  }
  if (imageHit) {
    snappedLen = imageHit.t;
    lengthRefEdge = undefined;
  } else if (alignHit) {
    snappedLen = alignHit.t;
    lengthRefEdge = undefined;
  } else if (lengthRefEdge) {
    snappedLen = lengthRefEdge.length;
  }
  const lengthSnapped = lengthRefEdge !== undefined;

  const snappedPoint = {
    x: last.x + ux * snappedLen,
    y: last.y + uy * snappedLen,
  };

  // ── Build guides ─────────────────────────────────────────────────────
  const guides: SnapGuide[] = [];

  // Angle direction line: infinite dashed line through `last` in the
  // snapped direction. "Infinite" = extends EXTEND_PX either way; we don't
  // know the viewport size here, but a few thousand px is enough.
  if (angleSnapped) {
    const EXTEND_PX = 4000;
    guides.push({
      kind: 'angle-direction',
      from: { x: last.x - ux * EXTEND_PX, y: last.y - uy * EXTEND_PX },
      to:   { x: last.x + ux * EXTEND_PX, y: last.y + uy * EXTEND_PX },
    });

    // If the snap was based on a reference edge, highlight THAT edge so
    // the user understands the relationship.
    if (bestRefEdge) {
      guides.push({ kind: bestKind!, from: bestRefEdge.a, to: bestRefEdge.b });
    }
  }

  if (alignHit) {
    guides.push({ kind: 'vertex-align', from: alignHit.line.origin, to: snappedPoint });
  }
  if (imageHit) {
    guides.push({ kind: 'image-edge', from: imageHit.edge.a, to: imageHit.edge.b });
  }

  if (lengthRefEdge) {
    guides.push({ kind: 'length-match', from: lengthRefEdge.a, to: lengthRefEdge.b });
  }

  return {
    point: snappedPoint,
    guides,
    edgeLengthPx: snappedLen,
    lengthSnapped,
    angleSnapped,
  };
}

/** Style per guide kind — kept here so RoofLayer can import from one place. */
export const GUIDE_STYLE: Record<SnapKind, { stroke: string; dash: number[]; strokeWidth: number }> = {
  'angle-direction': { stroke: '#60a5fa', dash: [4, 4],  strokeWidth: 1    }, // soft blue
  'edge-parallel':   { stroke: '#d946ef', dash: [8, 4],  strokeWidth: 2.5  }, // magenta
  'edge-perp':       { stroke: '#d946ef', dash: [2, 4],  strokeWidth: 2.5  }, // magenta (dotted)
  'length-match':    { stroke: '#22c55e', dash: [10, 3], strokeWidth: 3    }, // green
  'point-match':     { stroke: '#f59e0b', dash: [],      strokeWidth: 2.5  }, // amber
  'edge-match':      { stroke: '#f59e0b', dash: [],      strokeWidth: 2.5  }, // solid amber to highlight the line we are on
  'vertex-align':    { stroke: '#22d3ee', dash: [3, 3],  strokeWidth: 1.5  }, // cyan: in line with a vertex
  'image-edge':      { stroke: '#a3e635', dash: [6, 3],  strokeWidth: 2    }, // lime: edge detected in the imagery
};

