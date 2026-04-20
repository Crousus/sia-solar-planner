// ────────────────────────────────────────────────────────────────────────────
// PanelLayer — renders every placed panel AND the ghost preview used during
// place-panels mode.
//
// Responsibilities:
//   1. Render each Panel as a colored, rotated rectangle
//      - Color = owning string's color, or gray if unassigned
//      - Rotation = roof's primary-axis angle (panels align to roof)
//      - Displays its indexInString if assigned (wiring order)
//   2. In place-panels mode with a selected roof, compute + render a ghost
//      panel at the snapped grid cell under the cursor:
//      - Green + clickable when valid
//      - Red when invalid (outside polygon or colliding)
//   3. Handle click (delete mode) and right-click (anytime) to remove panels
//
// Why the ghost's onClick lives HERE rather than in KonvaOverlay: we need
// access to the selected roof + panel type to compute `addPanel` args, and
// putting it here keeps the per-layer state local.
// ────────────────────────────────────────────────────────────────────────────

import { Group, Rect, Text, Circle } from 'react-konva';
import { useMemo } from 'react';
import { useProjectStore } from '../store/projectStore';
import {
  panelDisplaySize,
  roofPrimaryAngle,
  snapPanelToGrid,
} from '../utils/geometry';
import type { Point } from '../types';

interface Props {
  cursor: Point | null;   // live cursor from KonvaOverlay (for ghost position)
  stageActive: boolean;   // only show ghost when overlay is intercepting events
}

export default function PanelLayer({ cursor, stageActive }: Props) {
  const project = useProjectStore((s) => s.project);
  const toolMode = useProjectStore((s) => s.toolMode);
  const selectedRoofId = useProjectStore((s) => s.selectedRoofId);
  const addPanel = useProjectStore((s) => s.addPanel);
  const deletePanel = useProjectStore((s) => s.deletePanel);

  // ── Lookup maps ────────────────────────────────────────────────────────
  // Cache string/roof lookups so the map of panels below doesn't do an O(n)
  // .find() per panel. For small projects this doesn't matter; with many
  // panels it starts to.
  const stringById = useMemo(() => {
    const map = new Map<string, { color: string; label: string }>();
    project.strings.forEach((s) => map.set(s.id, { color: s.color, label: s.label }));
    return map;
  }, [project.strings]);

  const roofById = useMemo(() => {
    const map = new Map<string, (typeof project.roofs)[number]>();
    project.roofs.forEach((r) => map.set(r.id, r));
    return map;
  }, [project.roofs]);

  // ── Ghost panel computation ────────────────────────────────────────────
  const selectedRoof = selectedRoofId ? roofById.get(selectedRoofId) : null;
  const showGhost = toolMode === 'place-panels' && selectedRoof && cursor && stageActive;

  // Layout of the ghost: its world-space center, display size, rotation
  // in degrees (Konva uses degrees on shapes), and a validity flag that
  // determines its color (green = placeable, red = blocked).
  let ghost: { x: number; y: number; w: number; h: number; angleDeg: number; valid: boolean } | null = null;
  if (showGhost) {
    const mpp = project.mapState.metersPerPixel;
    const existingCenters = project.panels
      .filter((p) => p.roofId === selectedRoof.id)
      .map((p) => ({ x: p.cx, y: p.cy }));

    // Try to snap; null means "this cursor position maps to an invalid cell".
    const snapped = snapPanelToGrid(cursor, selectedRoof, project.panelType, mpp, existingCenters);
    const { w, h } = panelDisplaySize(project.panelType, selectedRoof, mpp);
    const angle = (roofPrimaryAngle(selectedRoof.polygon) * 180) / Math.PI;

    if (snapped) {
      // Valid snap → draw the ghost at the snapped grid cell.
      ghost = { x: snapped.x, y: snapped.y, w, h, angleDeg: angle, valid: true };
    } else {
      // Invalid snap → draw a red ghost AT THE CURSOR (not snapped). This
      // gives immediate feedback "you can't place here" without the ghost
      // sticking to the last valid position and being misleading.
      ghost = { x: cursor.x, y: cursor.y, w, h, angleDeg: angle, valid: false };
    }
  }

  // Clicking the (valid) ghost commits the placement. No-op when invalid.
  const handleGhostClick = () => {
    if (!ghost?.valid || !selectedRoof) return;
    addPanel(selectedRoof.id, ghost.x, ghost.y);
  };

  return (
    <Group>
      {/* ── Placed panels ──────────────────────────────────────────────── */}
      {project.panels.map((panel) => {
        const roof = roofById.get(panel.roofId);
        if (!roof) return null; // defensive: orphaned panel (shouldn't happen post-delete-cascade)
        const { w, h } = panelDisplaySize(project.panelType, roof, project.mapState.metersPerPixel);
        const angleDeg = (roofPrimaryAngle(roof.polygon) * 180) / Math.PI;
        const stringInfo = panel.stringId ? stringById.get(panel.stringId) : null;

        // Unassigned = dark gray so strings read clearly against imagery.
        const fill = stringInfo ? stringInfo.color : '#1f2937';
        const stroke = stringInfo ? '#000' : '#9ca3af';

        return (
          <Group
            key={panel.id}
            x={panel.cx}
            y={panel.cy}
            rotation={angleDeg}
            onContextMenu={(e) => {
              // Right-click anywhere on the panel deletes it. Available in
              // every mode so users can remove mistakes without mode-switching.
              e.evt.preventDefault();
              e.cancelBubble = true;
              deletePanel(panel.id);
            }}
            onClick={(e) => {
              // Left-click delete only in delete mode; elsewhere, clicks
              // are reserved for other interactions (lasso start, etc.).
              if (toolMode === 'delete') {
                e.cancelBubble = true;
                deletePanel(panel.id);
              }
            }}
          >
            <Rect
              x={-w / 2}
              y={-h / 2}
              width={w}
              height={h}
              fill={fill}
              opacity={0.85}
              stroke={stroke}
              strokeWidth={1}
            />
            {/* Central "hitbox halo" shown only during assign-string mode.
                Per user spec: the effective click target for lasso is the
                panel center, not the full rectangle. This circle makes the
                center visually obvious during assignment. listening=false
                so it doesn't interfere with click handling. */}
            {toolMode === 'assign-string' && (
              <Circle
                radius={Math.min(w, h) * 0.18}
                fill="rgba(255,255,255,0.35)"
                listening={false}
              />
            )}
            {/* Show the panel's index within its string, if any. */}
            {panel.indexInString != null && (
              <Text
                x={-w / 2}
                y={-h / 2}
                width={w}
                height={h}
                align="center"
                verticalAlign="middle"
                text={String(panel.indexInString)}
                fontSize={Math.min(w, h) * 0.4}
                fontStyle="bold"
                fill="#fff"
                stroke="#000"
                strokeWidth={0.5}
                listening={false}
              />
            )}
          </Group>
        );
      })}

      {/* ── Ghost panel (placement preview) ────────────────────────────── */}
      {ghost && (
        <Group x={ghost.x} y={ghost.y} rotation={ghost.angleDeg} listening={true}>
          <Rect
            x={-ghost.w / 2}
            y={-ghost.h / 2}
            width={ghost.w}
            height={ghost.h}
            fill={ghost.valid ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.5)'}
            stroke={ghost.valid ? '#22c55e' : '#ef4444'}
            strokeWidth={2}
            dash={[4, 3]}
            onClick={handleGhostClick}
          />
        </Group>
      )}
    </Group>
  );
}
