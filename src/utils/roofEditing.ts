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
// roofEditing — pure geometry used by RoofLayer's delete-edge flow.
//
// Extracted from RoofLayer (Phase 3). The edge-removal click handler had
// 80+ lines of inline geometry buried inside a JSX event callback, which
// made the UI file hard to scan AND hid a nontrivial algorithm (trim-to-
// intersection with two fallbacks + collinearity cleanup) from anyone
// searching the utils tree.
//
// Nothing here touches the store or React — pure functions, testable in
// isolation. The caller is still responsible for the destructive-confirm
// dialog and the actual `updateRoof` / `deleteRoof` dispatch; this module
// only produces the new polygon (or signals that the result would be
// degenerate).
// ────────────────────────────────────────────────────────────────────────────

import type { Point } from '../types';
import { simplifyCollinear } from './geometry';
import { findSharedEdge } from './polygonCut';
import type { Roof } from '../types';

export type EdgeRemovalResult =
  | { kind: 'polygon'; polygon: Point[] }
  | { kind: 'degenerate' }; // <3 vertices after removal → caller should offer roof-delete

/**
 * Compute the new polygon after removing the edge between vertex `i` and
 * vertex `(i+1) % n` using the TRIM-TO-INTERSECTION strategy.
 *
 * Why trim-to-intersection instead of midpoint-collapse:
 *   The naive "collapse both endpoints to their midpoint" approach
 *   shortens the two neighboring edges and leaves a dent where the user
 *   expected a clean corner. Extending the neighbor edges as infinite
 *   lines and using their intersection preserves the DIRECTION of each
 *   adjacent edge — matching the mental model "these two sides, extended
 *   until they meet". For a typical notched rectangle this restores the
 *   sharp corner the user probably wanted when they drew the notch by
 *   accident.
 *
 * Fallbacks (both midpoint — simple and always in-polygon):
 *   (a) Near-parallel neighbors (sin(angle) < ~1°): intersection is at
 *       infinity or wildly far; midpoint is the sane approximation.
 *   (b) Intersection absurdly distant from the removed edge (>8× edge
 *       length): neighbors converge very gradually, projecting a spike
 *       far outside the polygon and usually flipping it inside-out.
 *
 * After vertex replacement, we run simplifyCollinear to coalesce vertices
 * that now lie on a straight line through their neighbors — otherwise a
 * removed short jog in an otherwise-straight boundary leaves what the
 * user perceives as "one long edge" split across two segments with two
 * length labels.
 *
 * @param polygon  Current polygon vertices (world coords; CCW or CW, either works).
 * @param i        Index of the first vertex of the edge to remove (edge goes i → i+1).
 * @returns        `polygon` result, or `degenerate` if <3 vertices remain.
 */
export function computeEdgeRemoval(
  polygon: Point[],
  i: number,
): EdgeRemovalResult {
  const n = polygon.length;
  if (n - 1 < 3) return { kind: 'degenerate' };

  const p1 = polygon[i];
  const p2 = polygon[(i + 1) % n];
  const prev = polygon[(i - 1 + n) % n];
  const nextV = polygon[(i + 2) % n];

  // Direction vectors of the two neighbor edges (the ones we'll extend).
  const d1x = p1.x - prev.x;
  const d1y = p1.y - prev.y;
  const d2x = nextV.x - p2.x;
  const d2y = nextV.y - p2.y;

  // cross = determinant of [d1; d2]. |cross| / (|d1|·|d2|) = |sin(angle)|.
  const cross = d1x * d2y - d1y * d2x;
  const d1Len = Math.hypot(d1x, d1y);
  const d2Len = Math.hypot(d2x, d2y);
  const sinAngle =
    d1Len > 0 && d2Len > 0 ? Math.abs(cross) / (d1Len * d2Len) : 0;
  const edgeLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);

  let replacement: Point;
  if (sinAngle < 0.02) {
    // (a) Near-parallel → midpoint fallback.
    replacement = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  } else {
    // Parametric intersection: prev + t·d1 = p2 + s·d2
    // → t = cross2(p2 - prev, d2) / cross(d1, d2)
    const t =
      ((p2.x - prev.x) * d2y - (p2.y - prev.y) * d2x) / cross;
    const cx = prev.x + t * d1x;
    const cy = prev.y + t * d1y;
    // (b) Sanity check — intersection not absurdly far from deleted edge.
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    const distToMid = Math.hypot(cx - midX, cy - midY);
    if (distToMid > edgeLen * 8) {
      replacement = { x: midX, y: midY };
    } else {
      replacement = { x: cx, y: cy };
    }
  }

  // Build the new ring: at index i push the replacement, skip (i+1) % n,
  // keep everything else. The wrap case (i === n-1) works because we skip
  // index 0 and emit replacement at the tail — the ring is rotationally
  // symmetric so starting index doesn't matter.
  const out: Point[] = [];
  for (let k = 0; k < n; k++) {
    if (k === i) out.push(replacement);
    else if (k === (i + 1) % n) continue;
    else out.push(polygon[k]);
  }

  // Collinearity cleanup — see algorithm header. simplifyCollinear never
  // shrinks below 3 vertices, so we can't accidentally degenerate here.
  const cleaned = simplifyCollinear(out);
  return { kind: 'polygon', polygon: cleaned };
}

/**
 * Find the first OTHER roof that shares an edge (within findSharedEdge's
 * tolerance) with `roof`. Returns null if no merge candidate exists.
 *
 * findSharedEdge walks the full edge ring of both polygons, so the caller
 * doesn't need to know which edge was clicked — any geometric overlap
 * counts.
 */
export function findMergeCandidate(
  roof: Roof,
  allRoofs: readonly Roof[],
): Roof | null {
  for (const candidate of allRoofs) {
    if (candidate.id === roof.id) continue;
    if (findSharedEdge(roof.polygon, candidate.polygon) !== null) {
      return candidate;
    }
  }
  return null;
}
