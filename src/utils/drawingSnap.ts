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
// Philosophy: tolerances are tight (3° / 8 px) because the user will
// expect raw cursor control most of the time. The snap should feel like
// a gentle magnet, not a drag on the cursor.
// ────────────────────────────────────────────────────────────────────────────

import type { Point, Roof } from '../types';
import { projectOnSegment } from './geometry';

/** What caused a particular guide to appear — drives its color. */
export type SnapKind =
  | 'angle-direction'   // the infinite ray showing the snapped direction
  | 'edge-parallel'     // reference edge for parallel snap
  | 'edge-perp'         // reference edge for perpendicular snap
  | 'length-match'      // reference edge whose length we're matching
  | 'point-match'       // snapped exactly to a corner
  | 'edge-match';       // reference edge we are snapping onto directly

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

/** Tolerances — tuned for "magnet" feel, not sticky. */
const ANGLE_TOL_DEG = 3;
const LENGTH_TOL_PX = 8;
const POINT_SNAP_TOL_PX = 10;
const EDGE_SNAP_TOL_PX = 8;

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

function collectEdges(drawingPoints: Point[], roofs: Roof[]): EdgeRef[] {
  const edges: EdgeRef[] = [];
  // Committed roofs: every closed polygon edge is a candidate reference.
  for (const roof of roofs) {
    for (let i = 0; i < roof.polygon.length; i++) {
      const a = roof.polygon[i];
      const b = roof.polygon[(i + 1) % roof.polygon.length];
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
 * Compute snap result for the current draw-roof cursor.
 *
 * Inputs:
 *   cursor         — raw pointer position
 *   drawingPoints  — vertices placed so far in the in-progress polygon
 *   roofs          — committed roofs (their edges are reference lines too)
 *   opts.enabled   — if false, return raw cursor with no guides
 *                    (caller passes `!shiftKey` to implement "hold Shift
 *                    to disable snapping" behavior)
 */
export function computeDrawingSnap(
  cursor: Point,
  drawingPoints: Point[],
  roofs: Roof[],
  opts: { enabled: boolean } = { enabled: true }
): SnapResult {
  // Nothing to snap against yet.
  if (drawingPoints.length === 0) {
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
  let bestPointDist = POINT_SNAP_TOL_PX;
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
  let bestEdgeDist = EDGE_SNAP_TOL_PX;
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
  for (const edge of edges) {
    cands.push({ angle: edge.angle,               kind: 'edge-parallel', refEdge: edge });
    cands.push({ angle: edge.angle + Math.PI,     kind: 'edge-parallel', refEdge: edge });
    cands.push({ angle: edge.angle + Math.PI / 2, kind: 'edge-perp',     refEdge: edge });
    cands.push({ angle: edge.angle - Math.PI / 2, kind: 'edge-perp',     refEdge: edge });
  }

  // Pick the closest candidate within tolerance (if any).
  let bestAngle = rawAngle;
  let bestKind: SnapKind | null = null;
  let bestRefEdge: EdgeRef | undefined;
  let bestDiff = ANGLE_TOL_DEG;
  for (const c of cands) {
    const d = angleDiffDeg(c.angle, rawAngle);
    if (d < bestDiff) {
      bestDiff = d;
      bestAngle = c.angle;
      bestKind = c.kind;
      bestRefEdge = c.refEdge;
    }
  }
  const angleSnapped = bestKind !== null;

  // ── Project cursor onto the snapped direction ray ────────────────────
  // Unit vector of the snapped direction.
  const ux = Math.cos(bestAngle);
  const uy = Math.sin(bestAngle);
  // Signed length along the ray. Clamp to 0 so we never project "behind"
  // `last` — that would flip the edge direction in a confusing way.
  let snappedLen = Math.max(0, rawDx * ux + rawDy * uy);

  // ── Length snap ──────────────────────────────────────────────────────
  // If snappedLen is close to any existing edge's length, jump to it exactly.
  let lengthRefEdge: EdgeRef | undefined;
  for (const edge of edges) {
    if (Math.abs(edge.length - snappedLen) < LENGTH_TOL_PX) {
      snappedLen = edge.length;
      lengthRefEdge = edge;
      break;
    }
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
};

