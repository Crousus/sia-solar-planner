// ────────────────────────────────────────────────────────────────────────────
// RoofLayer — Konva rendering of committed roofs AND the in-progress
// polygon during draw-roof mode.
//
// Three things on-screen:
//   1. All committed roofs (solid polygons, clickable to select/delete)
//   2. CAD-style snap guides (angle ray, reference edge, length match)
//      — shown while the user hovers during draw-roof mode
//   3. The user's in-progress polygon: vertices as dots, preview line from
//      last vertex to the (possibly-snapped) cursor, first vertex enlarged
//      + green once closing becomes possible (≥3 points), plus a live
//      length label in meters near the cursor.
//
// Visual language:
//   - Unselected roofs: white stroke, translucent white fill
//   - Selected roof:    amber stroke, translucent amber fill
//   - In-progress:      dashed amber line, amber dots, green first-vertex
//     once closable (provides a visual affordance for "click here to close")
//   - Snap guides:      colored dashed lines — see GUIDE_STYLE in drawingSnap.ts
// ────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { Group, Line, Circle, Text, Path } from 'react-konva';
import { useProjectStore } from '../store/projectStore';
import { polygonCentroid, simplifyCollinear } from '../utils/geometry';
import { GUIDE_STYLE, type SnapGuide } from '../utils/drawingSnap';
import { findSharedEdge } from '../utils/polygonCut';
import type { Point, Roof } from '../types';

interface Props {
  drawingPoints: Point[];        // in-progress polygon, owned by KonvaOverlay
  cursor: Point | null;          // snapped cursor position for the preview line
  guides?: SnapGuide[];          // snap guide lines to render
  edgeLengthPx?: number;         // current edge length in px (for label)
  lengthSnapped?: boolean;       // true → style the label as "snapped"
  angleSnapped?: boolean;        // true → style the preview line as "snapped"
  mpp?: number;                  // meters per pixel, for the length label
  setRotationAbsolute?: (deg: number) => void;
  stageScale?: number;
}

export default function RoofLayer({
  drawingPoints,
  cursor,
  guides = [],
  edgeLengthPx = 0,
  lengthSnapped = false,
  angleSnapped = false,
  mpp = 0,
  setRotationAbsolute,
  stageScale = 1,
}: Props) {
  const roofs = useProjectStore((s) => s.project.roofs);
  const selectedRoofId = useProjectStore((s) => s.selectedRoofId);
  const setSelectedRoof = useProjectStore((s) => s.setSelectedRoof);
  const toolMode = useProjectStore((s) => s.toolMode);
  const deleteRoof = useProjectStore((s) => s.deleteRoof);
  const updateRoof = useProjectStore((s) => s.updateRoof);
  const mergeRoofs = useProjectStore((s) => s.mergeRoofs);

  const drawing = toolMode === 'draw-roof' && drawingPoints.length > 0;

  // When draw-roof mode is active but no new polygon is in progress, we
  // treat it as "vertex edit" mode for committed roofs: every polygon
  // vertex gets a draggable handle. The two predicates are NOT mutually
  // exclusive — handles stay visible even while a new polygon is being
  // drawn, because the user might want to align a new roof to an edge
  // of an existing one.
  const editHandlesVisible = toolMode === 'draw-roof';

  // Track which roof edge is currently hovered to show the align button
  // Key format: "roofId-edgeIndex"
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);

  // Active polygon-edit state — one of:
  //   move   → an existing vertex is being dragged to a new position
  //   insert → a new vertex is being created mid-edge and dragged around
  //            before being committed (drag-to-insert UX: user grabs an
  //            edge midpoint, pulls it to where they want the corner,
  //            releases)
  //
  // Held LOCALLY rather than in the store because both kinds of edit
  // fire at ~60 Hz during the drag, and only the final state is worth
  // persisting. While set, getLivePolygon returns an overridden polygon
  // so edges, length labels, and centroid labels all track the cursor
  // in real time. On dragend the final polygon is written back via a
  // single updateRoof call — downstream effects (panel fit, roof
  // primary angle) flow from that one store update.
  //
  // `atIdx` for the insert kind is the polygon index where the new
  // vertex will be spliced in — i.e., between the edge's two endpoints.
  // Edge `i` connects polygon[i] → polygon[(i+1) % n], so inserting
  // between them means atIdx = i + 1.
  type EditState =
    | { kind: 'move'; roofId: string; idx: number; x: number; y: number }
    | { kind: 'insert'; roofId: string; atIdx: number; x: number; y: number }
    | null;
  const [editState, setEditState] = useState<EditState>(null);

  // Given a roof, return the polygon that should be rendered right now —
  // either its stored polygon, or a modified copy reflecting the active
  // edit (move replaces a vertex; insert splices in a new one). Callers
  // use the returned array for BOTH the fill outline and any per-edge
  // derivations (length labels, centroid), so every visual element
  // stays consistent during a drag.
  const getLivePolygon = (roof: Roof): Point[] => {
    if (!editState || editState.roofId !== roof.id) return roof.polygon;
    if (editState.kind === 'move') {
      const pts = roof.polygon.slice();
      pts[editState.idx] = { x: editState.x, y: editState.y };
      return pts;
    }
    // insert: splice a new vertex at atIdx
    const pts = roof.polygon.slice();
    pts.splice(editState.atIdx, 0, { x: editState.x, y: editState.y });
    return pts;
  };

  return (
    <Group>
      {/* ── Committed roofs ───────────────────────────────────────────── */}
      {roofs.map((roof) => {
        // If a vertex of this roof is currently being dragged, render
        // everything from the overridden polygon so the user sees the
        // two adjacent edges track the cursor in real time.
        const livePolygon = getLivePolygon(roof);
        // Konva's Line with `closed` wants a flat number array, not Points.
        const flat = livePolygon.flatMap((p) => [p.x, p.y]);
        const isSelected = roof.id === selectedRoofId;
        const center = polygonCentroid(livePolygon);
        return (
          <Group key={roof.id}>
            <Line
              points={flat}
              closed
              fill={isSelected ? 'rgba(255, 220, 100, 0.18)' : 'rgba(255, 255, 255, 0.10)'}
              stroke={isSelected ? '#ffcb47' : '#ffffff'}
              strokeWidth={isSelected ? 3 : 2}
              onMouseEnter={(e) => {
                const stage = e.target.getStage();
                if (stage) stage.container().style.cursor = 'pointer';
              }}
              onMouseLeave={(e) => {
                const stage = e.target.getStage();
                if (stage) stage.container().style.cursor = '';
              }}
              onClick={(e) => {
                // If a cut polyline is in progress, let the click bubble
                // up to Stage so the cut can commit (case 2) or append an
                // intermediate vertex (default). Otherwise Konva hit-tests
                // this Line first because the roof fill covers the whole
                // polygon interior (and the stroke, when drawing is active
                // and the edge hit-overlays are hidden). Swallowing the
                // click here would make "click the opposite edge to
                // complete the cut" fail silently — the click would just
                // reselect the roof the user is trying to split.
                //
                // When no polyline is in progress, the historical "click a
                // roof fill to select it" behavior wins. In delete mode we
                // still eat the click here (confirm prompt, destructive).
                if (drawingPoints.length > 0) {
                  return;
                }
                e.cancelBubble = true;
                if (toolMode === 'delete') {
                  if (confirm(`Delete ${roof.name} and all its panels?`)) deleteRoof(roof.id);
                } else {
                  setSelectedRoof(roof.id);
                }
              }}
            />
            {/* Label at the centroid. listening=false keeps it click-through
                so users can still click the polygon fill underneath. */}
            <Text
              x={center.x - 30}
              y={center.y - 8}
              width={60}
              align="center"
              text={roof.name}
              fontSize={12}
              fill="#ffffff"
              shadowColor="black"
              shadowBlur={3}
              listening={false}
            />

            {/* Individual edges for rotation alignment button (only visible when not drawing) */}
            {!drawing && livePolygon.map((p1, i) => {
              const p2 = livePolygon[(i + 1) % livePolygon.length];
              const edgeKey = `${roof.id}-${i}`;
              const isHovered = hoveredEdge === edgeKey;
              
              // Edge midpoint
              const mx = (p1.x + p2.x) / 2;
              const my = (p1.y + p2.y) / 2;
              
              // Edge angle and length
              const dx = p2.x - p1.x;
              const dy = p2.y - p1.y;
              let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
              const lenPx = Math.hypot(dx, dy);
              const lenM = lenPx * (mpp || 1);

              // Size the hit area and button relative to zoom
              const hitRadius = 15 / stageScale;
              const btnScale = 1 / stageScale;

              // Text rotation (keep it readable, not upside down)
              let textAngle = angle;
              if (textAngle > 90 || textAngle < -90) {
                textAngle += 180;
              }

              // Normal vector for text offset
              const nx = -dy / lenPx;
              const ny = dx / lenPx;
              const textOffset = 15 / stageScale;

              return (
                <Group
                  key={edgeKey}
                  onMouseEnter={(e) => {
                    const stage = e.target.getStage();
                    // Cursor by mode:
                    //   draw-roof → 'copy': edge is a drag-to-insert target
                    //                       ("click here to add a vertex").
                    //   delete    → 'pointer': edge is a click target that
                    //                          either merges adjoining roofs
                    //                          or collapses this edge.
                    //   other     → 'crosshair': only the rotation-align
                    //                            affordance is available.
                    if (stage) {
                      stage.container().style.cursor = editHandlesVisible
                        ? 'copy'
                        : toolMode === 'delete'
                          ? 'pointer'
                          : 'crosshair';
                    }
                    setHoveredEdge(edgeKey);
                  }}
                  onMouseLeave={(e) => {
                    const stage = e.target.getStage();
                    if (stage) stage.container().style.cursor = '';
                    setHoveredEdge(null);
                  }}
                >
                  {/*
                    Invisible hit area covering the edge segment.

                    In draw-roof mode this line is draggable for
                    vertex insertion: pressing anywhere along the edge
                    and dragging creates a new vertex AT THE POINTER
                    POSITION (not the midpoint) and lets the user pull
                    it immediately. We read world coordinates from
                    stage.getPointerPosition() on each drag event — we
                    can't use e.target.x()/y() because the Line was
                    never given a meaningful position to offset from
                    (its geometry lives entirely in `points`). On
                    dragend we splice the new vertex into the polygon
                    and reset the Line's position so Konva's drag
                    offset doesn't linger into the next render.

                    Outside draw-roof mode the Line is a passive hit
                    target — it still triggers hover (for the rotate
                    button to appear) but doesn't start a drag, so
                    click-through behaviour in other modes is
                    unchanged.
                  */}
                  {/* Red delete-highlight.
                      Rendered BEFORE the transparent hit-area so the hit
                      area stays on top (= wins hit-testing) — the
                      highlight is purely visual.
                      listening=false is belt-and-suspenders: with the
                      stacking order above, the hit area already eats
                      events, but explicit non-listening prevents any
                      future reorder from breaking click handling.
                      Stroke width scales with zoom (divided by
                      stageScale) so the highlight stays visually
                      consistent without overwhelming the polygon at
                      low zoom. Only shown in delete mode on the
                      currently-hovered edge to preview "this is what
                      will be removed". */}
                  {isHovered && toolMode === 'delete' && (
                    <Line
                      points={[p1.x, p1.y, p2.x, p2.y]}
                      stroke="#ef4444"
                      strokeWidth={4 / stageScale}
                      lineCap="round"
                      shadowColor="#ef4444"
                      shadowBlur={6 / stageScale}
                      shadowOpacity={0.7}
                      listening={false}
                    />
                  )}
                  <Line
                    points={[p1.x, p1.y, p2.x, p2.y]}
                    stroke="transparent"
                    strokeWidth={hitRadius * 2}
                    draggable={editHandlesVisible}
                    onClick={toolMode === 'delete' ? (e) => {
                      // ─────────────────────────────────────────────────
                      // Delete-mode edge click.
                      //
                      // Semantics by edge type:
                      //   1. Shared edge (this edge is geometrically
                      //      coincident with another roof's edge) →
                      //      MERGE the two roofs. Inverse of the split
                      //      operation; mirrors the existing right-click-
                      //      in-draw-roof-mode merge flow, reused here so
                      //      delete mode has a single "click this thing
                      //      to remove it" affordance regardless of
                      //      whether the edge is internal or boundary.
                      //
                      //   2. Boundary edge (unique to this roof) →
                      //      REMOVE the edge by collapsing its two
                      //      endpoints into their midpoint. Net: -1
                      //      vertex, -1 edge. The "pinch" gives a
                      //      symmetric, predictable result (the user's
                      //      edge literally vanishes to a point at its
                      //      middle). If the resulting polygon would
                      //      have <3 vertices, fall back to deleting
                      //      the whole roof — per user spec: "the roof
                      //      can be deleted if this results in an
                      //      invalid roof".
                      //
                      // cancelBubble so the click doesn't also trigger
                      // the roof-fill onClick (sibling Line with
                      // delete-whole-roof behavior) or the Stage-level
                      // handler. Without it, clicks near the edge would
                      // cascade into double-handling.
                      // ─────────────────────────────────────────────────
                      e.cancelBubble = true;

                      // Try merge first. findSharedEdge walks the full
                      // edge ring of each candidate, so we don't need to
                      // filter by which edge index — any match wins.
                      const other = roofs.find((candidate) => {
                        if (candidate.id === roof.id) return false;
                        return findSharedEdge(roof.polygon, candidate.polygon) !== null;
                      });
                      if (other) {
                        // Panel-preservation confirm, matching the
                        // right-click merge path. Silent for empty
                        // roofs where the geometry change is obviously
                        // what the user wants.
                        const state = useProjectStore.getState();
                        const hasPanels = state.project.panels.some(
                          (pp) => pp.roofId === roof.id || pp.roofId === other.id,
                        );
                        if (hasPanels) {
                          const ok = window.confirm(
                            `Merge "${roof.name}" and "${other.name}"? Panels will be reassigned to the larger roof.`,
                          );
                          if (!ok) return;
                        }
                        mergeRoofs(roof.id, other.id);
                        return;
                      }

                      // Boundary edge: collapse endpoints to midpoint.
                      const n = roof.polygon.length;
                      if (n - 1 < 3) {
                        // Degenerate result → delete the whole roof.
                        // Uses the same confirm text as the roof-fill
                        // delete path so users see a consistent
                        // destructive prompt.
                        if (confirm(`Delete ${roof.name} and all its panels?`)) {
                          deleteRoof(roof.id);
                        }
                        return;
                      }
                      // ── Replacement vertex: TRIM-TO-INTERSECTION ──
                      // Rather than collapsing the two endpoints to
                      // their midpoint (which shortens the adjacent
                      // edges and leaves a dent), extend the two
                      // neighbor edges as infinite lines and use their
                      // intersection as the single replacement vertex.
                      // This preserves the DIRECTION of each adjacent
                      // edge — the user's mental model is "this side
                      // and that side, extended until they meet" — and
                      // the adjacent edges' lengths recalculate
                      // naturally from the new corner position. For a
                      // typical notched rectangle this restores the
                      // sharp corner the user probably wanted when
                      // they drew the notch by accident.
                      //
                      // Line equations:
                      //   prev edge direction d1 = p1 - prev
                      //   next edge direction d2 = nextV - p2
                      // Parametric intersection of
                      //   prev + t·d1 = p2 + s·d2
                      // Cross product of d1,d2 is the determinant; t
                      // solves via the standard 2D line-line formula.
                      //
                      // Fallbacks (both use midpoint — simple and
                      // always safe):
                      //   (a) Near-parallel neighbors (sin(angle) <
                      //       ~1°): intersection is at infinity or
                      //       wildly far, midpoint is the sane
                      //       approximation.
                      //   (b) Intersection is absurdly distant from
                      //       the deleted edge (>8× edge length):
                      //       neighbors converge but very gradually,
                      //       which projects a spike far outside the
                      //       polygon and usually flips it inside-
                      //       out. Midpoint keeps the shape sane.
                      const prev = roof.polygon[(i - 1 + n) % n];
                      const nextV = roof.polygon[(i + 2) % n];
                      const d1x = p1.x - prev.x;
                      const d1y = p1.y - prev.y;
                      const d2x = nextV.x - p2.x;
                      const d2y = nextV.y - p2.y;
                      const cross = d1x * d2y - d1y * d2x;
                      const d1Len = Math.hypot(d1x, d1y);
                      const d2Len = Math.hypot(d2x, d2y);
                      const sinAngle =
                        d1Len > 0 && d2Len > 0
                          ? Math.abs(cross) / (d1Len * d2Len)
                          : 0;
                      const edgeLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);

                      let replacement: Point;
                      if (sinAngle < 0.02) {
                        // (a) Near-parallel → midpoint fallback.
                        replacement = {
                          x: (p1.x + p2.x) / 2,
                          y: (p1.y + p2.y) / 2,
                        };
                      } else {
                        const t =
                          ((p2.x - prev.x) * d2y - (p2.y - prev.y) * d2x) /
                          cross;
                        const cx = prev.x + t * d1x;
                        const cy = prev.y + t * d1y;
                        // (b) Sanity: intersection shouldn't be
                        // absurdly far from the edge we're removing.
                        const midX = (p1.x + p2.x) / 2;
                        const midY = (p1.y + p2.y) / 2;
                        const distToMid = Math.hypot(cx - midX, cy - midY);
                        if (distToMid > edgeLen * 8) {
                          replacement = { x: midX, y: midY };
                        } else {
                          replacement = { x: cx, y: cy };
                        }
                      }

                      // Build the new ring: at index i push the
                      // replacement, skip index (i+1) % n, keep
                      // everything else. Works for the wrap case
                      // (i === n-1) because we skip index 0 and emit
                      // replacement at the tail — the ring is
                      // rotationally symmetric so starting index
                      // doesn't matter.
                      const out: Point[] = [];
                      for (let k = 0; k < n; k++) {
                        if (k === i) out.push(replacement);
                        else if (k === (i + 1) % n) continue;
                        else out.push(roof.polygon[k]);
                      }
                      // Collinearity cleanup:
                      // The midpoint we just inserted often lands on
                      // (or near) the straight line through the
                      // adjacent vertices — most obviously when the
                      // deleted edge was a short jog in an otherwise-
                      // straight boundary. Without cleanup, what the
                      // user perceives as "one long edge" stays split
                      // into multiple edges, showing multiple length
                      // labels (30.7m + 18.1m instead of 48.8m) and
                      // giving ghostly extra hit regions. simplifyCollinear
                      // walks the ring once and drops any vertex within
                      // a tight perpendicular tolerance of the line
                      // through its neighbors, restoring the clean
                      // single-edge topology.
                      //
                      // Safety: simplifyCollinear never shrinks below
                      // 3 vertices, so we can't accidentally degenerate
                      // the polygon via cleanup. If cleanup returns
                      // exactly the same ring, updateRoof is a no-op
                      // diff and nothing downstream reacts — cheap.
                      const cleaned = simplifyCollinear(out);
                      updateRoof(roof.id, { polygon: cleaned });
                    } : undefined}
                    onContextMenu={editHandlesVisible ? (e) => {
                      // Right-click on an edge in draw-roof mode attempts
                      // a merge. If the clicked edge happens to be
                      // geometrically shared with another roof's edge
                      // (within tolerance), we fire mergeRoofs. If not,
                      // no-op — a future enhancement could surface a
                      // toast, but per YAGNI we stay silent.
                      //
                      // preventDefault stops the browser's context menu;
                      // cancelBubble stops Stage's onContextMenu from
                      // also firing (it already no-ops, but belt-and-
                      // suspenders against future changes).
                      e.evt.preventDefault();
                      e.cancelBubble = true;

                      // Look for any OTHER roof that shares any edge
                      // with this one. findSharedEdge walks ALL of each
                      // polygon's edges, so we just call it per
                      // candidate roof and accept the first match.
                      const other = roofs.find((candidate) => {
                        if (candidate.id === roof.id) return false;
                        return findSharedEdge(roof.polygon, candidate.polygon) !== null;
                      });
                      if (!other) return;

                      // Confirm if either roof has panels (destructive-
                      // adjacent — panels will get reassigned and the
                      // smaller roof will vanish). Silent for empty
                      // roofs where the user clearly just wants the
                      // geometry change.
                      const state = useProjectStore.getState();
                      const hasPanels = state.project.panels.some(
                        (p) => p.roofId === roof.id || p.roofId === other.id,
                      );
                      if (hasPanels) {
                        const ok = window.confirm(
                          `Merge "${roof.name}" and "${other.name}"? Panels will be reassigned to the larger roof.`,
                        );
                        if (!ok) return;
                      }

                      mergeRoofs(roof.id, other.id);
                    } : undefined}
                    onDragStart={editHandlesVisible ? (e) => {
                      e.cancelBubble = true;
                      const stage = e.target.getStage();
                      const pointer = stage?.getPointerPosition();
                      if (!stage || !pointer) return;
                      const world = stage.getAbsoluteTransform().copy().invert().point(pointer);
                      setEditState({
                        kind: 'insert',
                        roofId: roof.id,
                        atIdx: i + 1,
                        x: world.x,
                        y: world.y,
                      });
                    } : undefined}
                    onDragMove={editHandlesVisible ? (e) => {
                      const stage = e.target.getStage();
                      const pointer = stage?.getPointerPosition();
                      if (!stage || !pointer) return;
                      const world = stage.getAbsoluteTransform().copy().invert().point(pointer);
                      setEditState({
                        kind: 'insert',
                        roofId: roof.id,
                        atIdx: i + 1,
                        x: world.x,
                        y: world.y,
                      });
                    } : undefined}
                    onDragEnd={editHandlesVisible ? (e) => {
                      const stage = e.target.getStage();
                      const pointer = stage?.getPointerPosition();
                      // Reset the Line's drag offset unconditionally —
                      // if we skip this on an early-return, Konva
                      // leaves the line translated by (dx, dy) and
                      // the hit region drifts off the rendered edge
                      // until the next roof-wide re-render.
                      e.target.position({ x: 0, y: 0 });
                      if (!stage || !pointer) {
                        setEditState(null);
                        return;
                      }
                      const world = stage.getAbsoluteTransform().copy().invert().point(pointer);
                      const newPolygon = roof.polygon.slice();
                      newPolygon.splice(i + 1, 0, { x: world.x, y: world.y });
                      updateRoof(roof.id, { polygon: newPolygon });
                      setEditState(null);
                    } : undefined}
                  />

                  {/* Edge Length Label */}
                  {lenM > 0 && (
                    <Text
                      x={mx + nx * textOffset}
                      y={my + ny * textOffset}
                      rotation={textAngle}
                      text={`${lenM.toFixed(1)}m`}
                      fontSize={12 / stageScale}
                      fill="#ffffff"
                      shadowColor="black"
                      shadowBlur={2 / stageScale}
                      offsetX={20 / stageScale} // approximate center of text
                      offsetY={6 / stageScale}
                      listening={false}
                    />
                  )}

                  {/* Rotate Align Button */}
                  {isHovered && setRotationAbsolute && (

                    <Group 
                      x={mx} 
                      y={my}
                      scaleX={btnScale}
                      scaleY={btnScale}
                      rotation={angle}
                      onClick={(e) => {
                        e.cancelBubble = true;
                        // Align the canvas so this edge is horizontal (0 or 180 deg)
                        // If we want it strictly horizontal, we just subtract the angle
                        setRotationAbsolute(-angle);
                      }}
                    >
                      <Circle radius={14} fill="#171717" stroke="#ffcb47" strokeWidth={1.5} />
                      <Text 
                        text="⇄" 
                        x={-7} 
                        y={-8} 
                        fontSize={16} 
                        fill="#ffcb47" 
                        fontStyle="bold"
                        listening={false} 
                      />
                    </Group>
                  )}
                </Group>
              );
            })}

            {/* ── Draggable vertex handles ──────────────────────────────
                Shown whenever the user is in draw-roof mode — even if a
                new polygon is also in progress — so the user can refine
                any previously-drawn shape without switching tool modes.
                Each handle is one vertex of the committed polygon; the
                two edges adjacent to it follow the drag via the
                `livePolygon` override above, without committing to the
                store until dragend.

                The handle radius and stroke are divided by stageScale so
                the on-screen size stays constant regardless of zoom —
                otherwise handles would become unclickably tiny at the
                zoom levels where precise vertex editing matters most.

                cancelBubble on both click and dragstart is important:
                draw-roof's Stage-level click handler would otherwise add
                a NEW polygon vertex at the handle's location the moment
                the user releases the mouse (a pure drag ends with a
                click event in Konva if no motion was registered). */}
            {editHandlesVisible && livePolygon.map((p, i) => (
              <Circle
                key={`vhandle-${i}`}
                x={p.x}
                y={p.y}
                radius={6 / stageScale}
                fill="#ffcb47"
                stroke="#000"
                strokeWidth={1.5 / stageScale}
                draggable
                onMouseEnter={(e) => {
                  const stage = e.target.getStage();
                  if (stage) stage.container().style.cursor = 'move';
                }}
                onMouseLeave={(e) => {
                  const stage = e.target.getStage();
                  if (stage) stage.container().style.cursor = '';
                }}
                onClick={(e) => {
                  // When a polyline is in progress we must NOT swallow
                  // this click. The cut workflow ends exactly by clicking
                  // a boundary point of the candidate roof — and corners
                  // ARE boundary points. If we cancelBubble here, the
                  // Stage's draw-roof handler never sees the click, the
                  // cut never commits, and the polyline quietly dies on
                  // the next unrelated click. Passing the click through
                  // lets Stage route it to "commit cut" (case 2) or the
                  // close-path check (case 3), whichever applies.
                  //
                  // When NO polyline is in progress the legacy reason
                  // still holds: Stage would otherwise start a brand-new
                  // drawing vertex at the handle's exact position, which
                  // the user almost never wants — they're fiddling with
                  // the existing vertex, not starting a new shape on top
                  // of it. In that case we swallow.
                  if (drawingPoints.length === 0) {
                    e.cancelBubble = true;
                  }
                }}
                onContextMenu={(e) => {
                  // Right-click removes this vertex, as long as the
                  // polygon would still have ≥3 corners left (anything
                  // less isn't a polygon). We cancelBubble + preventDefault
                  // so the browser's context menu doesn't pop up AND the
                  // Stage-level right-click (which KonvaOverlay uses to
                  // trigger canvas pan) doesn't fire. This matches the
                  // PanelLayer convention where right-click = remove.
                  e.evt.preventDefault();
                  e.cancelBubble = true;
                  if (roof.polygon.length <= 3) return;
                  // Use the edit-state index if we happen to be mid-drag
                  // on this same vertex (shouldn't really happen — a
                  // drag eats right-click — but defensive). Otherwise
                  // the iteration index IS the polygon index, because
                  // livePolygon matches roof.polygon 1:1 when no insert
                  // is active.
                  if (editState?.kind === 'insert' && editState.roofId === roof.id) return;
                  const removeIdx =
                    editState?.kind === 'move' && editState.roofId === roof.id && editState.idx === i
                      ? editState.idx
                      : i;
                  const newPolygon = roof.polygon.slice();
                  newPolygon.splice(removeIdx, 1);
                  updateRoof(roof.id, { polygon: newPolygon });
                }}
                onDragStart={(e) => {
                  e.cancelBubble = true;
                  setEditState({ kind: 'move', roofId: roof.id, idx: i, x: p.x, y: p.y });
                }}
                onDragMove={(e) => {
                  setEditState({
                    kind: 'move',
                    roofId: roof.id,
                    idx: i,
                    x: e.target.x(),
                    y: e.target.y(),
                  });
                }}
                onDragEnd={(e) => {
                  const nx = e.target.x();
                  const ny = e.target.y();
                  // Commit against the STORED vertex, not the live
                  // override — see the original move commit for the
                  // longer rationale (short version: comparing against
                  // `p` would always read ~0 distance because `p` IS
                  // the override during drag, so nothing would persist).
                  const orig = roof.polygon[i];
                  if (Math.hypot(nx - orig.x, ny - orig.y) > 0.5) {
                    const newPolygon = roof.polygon.slice();
                    newPolygon[i] = { x: nx, y: ny };
                    updateRoof(roof.id, { polygon: newPolygon });
                  }
                  setEditState(null);
                }}
              />
            ))}

          </Group>
        );
      })}

      {/* ── Snap guide lines (only while drawing) ─────────────────────── */}
      {/* Rendered BEFORE the in-progress polygon so the user's active line
          sits on top of the guides. listening=false throughout — guides are
          purely visual and must not intercept clicks. */}
      {drawing && guides.map((g, i) => {
        const style = GUIDE_STYLE[g.kind];
        return (
          <Line
            key={i}
            points={[g.from.x, g.from.y, g.to.x, g.to.y]}
            stroke={style.stroke}
            strokeWidth={style.strokeWidth}
            dash={style.dash}
            opacity={0.9}
            listening={false}
          />
        );
      })}

      {/* ── In-progress polygon (only shown in draw-roof mode) ────────── */}
      {drawing && (
        <Group>
          {/*
            Dashed line through all committed vertices, with the tail
            continuing to the live cursor. Looks like a "rubber band"
            tracking the cursor as the user considers the next vertex.
            When an angle snap is active we thicken the preview slightly as
            reinforcement of "you're locked onto a direction".
          */}
          <Line
            points={[
              ...drawingPoints.flatMap((p) => [p.x, p.y]),
              ...(cursor ? [cursor.x, cursor.y] : []),
            ]}
            stroke="#ffcb47"
            strokeWidth={angleSnapped ? 3 : 2}
            dash={[6, 4]}
            listening={false}
          />
          {drawingPoints.map((p, i) => {
            // First vertex gets enlarged + turned green once the polygon
            // has ≥3 points — visual cue for "click here to close".
            const isCloseTarget = i === 0 && drawingPoints.length >= 3;
            return (
              <Circle
                key={i}
                x={p.x}
                y={p.y}
                radius={isCloseTarget ? 8 : 4}
                fill={isCloseTarget ? '#22c55e' : '#ffcb47'}
                stroke="#000"
                strokeWidth={1}
                // listening=false so vertex dots don't block Stage clicks
                // (KonvaOverlay's handler does the close-distance math).
                listening={false}
              />
            );
          })}

          {/* ── Live edge-length label near the cursor ────────────────── */}
          {/* Only meaningful once the user has committed at least one
              vertex AND we have a calibrated mpp. The label offset (12, -20)
              places it just above-right of the cursor, out of the way of
              the line itself. Green fill when length-snapped to echo the
              guide color. */}
          {cursor && edgeLengthPx > 0 && mpp > 0 && (
            <Text
              x={cursor.x + 12}
              y={cursor.y - 20}
              text={`${(edgeLengthPx * mpp).toFixed(2)} m`}
              fontSize={13}
              fontStyle="bold"
              fill={lengthSnapped ? '#22c55e' : '#ffffff'}
              shadowColor="black"
              shadowBlur={3}
              listening={false}
            />
          )}
        </Group>
      )}
    </Group>
  );
}
