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

import { Group, Line, Circle, Text } from 'react-konva';
import { useProjectStore } from '../store/projectStore';
import { polygonCentroid } from '../utils/geometry';
import { GUIDE_STYLE, type SnapGuide } from '../utils/drawingSnap';
import type { Point } from '../types';

interface Props {
  drawingPoints: Point[];        // in-progress polygon, owned by KonvaOverlay
  cursor: Point | null;          // snapped cursor position for the preview line
  guides?: SnapGuide[];          // snap guide lines to render
  edgeLengthPx?: number;         // current edge length in px (for label)
  lengthSnapped?: boolean;       // true → style the label as "snapped"
  angleSnapped?: boolean;        // true → style the preview line as "snapped"
  mpp?: number;                  // meters per pixel, for the length label
}

export default function RoofLayer({
  drawingPoints,
  cursor,
  guides = [],
  edgeLengthPx = 0,
  lengthSnapped = false,
  angleSnapped = false,
  mpp = 0,
}: Props) {
  const roofs = useProjectStore((s) => s.project.roofs);
  const selectedRoofId = useProjectStore((s) => s.selectedRoofId);
  const setSelectedRoof = useProjectStore((s) => s.setSelectedRoof);
  const toolMode = useProjectStore((s) => s.toolMode);
  const deleteRoof = useProjectStore((s) => s.deleteRoof);

  const drawing = toolMode === 'draw-roof' && drawingPoints.length > 0;

  return (
    <Group>
      {/* ── Committed roofs ───────────────────────────────────────────── */}
      {roofs.map((roof) => {
        // Konva's Line with `closed` wants a flat number array, not Points.
        const flat = roof.polygon.flatMap((p) => [p.x, p.y]);
        const isSelected = roof.id === selectedRoofId;
        const center = polygonCentroid(roof.polygon);
        return (
          <Group key={roof.id}>
            <Line
              points={flat}
              closed
              fill={isSelected ? 'rgba(255, 220, 100, 0.18)' : 'rgba(255, 255, 255, 0.10)'}
              stroke={isSelected ? '#ffcb47' : '#ffffff'}
              strokeWidth={isSelected ? 3 : 2}
              onClick={(e) => {
                // cancelBubble stops the event from reaching the Stage's
                // click handler — which would otherwise (in draw-roof mode)
                // try to add a new vertex on top of this roof.
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
