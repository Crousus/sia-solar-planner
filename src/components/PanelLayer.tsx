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
import { useMemo, useRef } from 'react';
import type Konva from 'konva';
import { useProjectStore } from '../store/projectStore';
import { darkenColor } from '../utils/colors';
import {
  panelDisplaySize,
  roofPrimaryAngle,
  snapPanelToGrid,
  getPanelGroupDimensions,
} from '../utils/geometry';
import type { Point, Panel } from '../types';

interface Props {
  cursor: Point | null;   // live cursor from KonvaOverlay (for ghost position)
  stageActive: boolean;   // only show ghost when overlay is intercepting events
  renderPass?: 'base' | 'labels';
}

export default function PanelLayer({ cursor, stageActive, renderPass = 'base' }: Props) {
  const project = useProjectStore((s) => s.project);
  const toolMode = useProjectStore((s) => s.toolMode);
  const selectedRoofId = useProjectStore((s) => s.selectedRoofId);
  const activePanelGroupId = useProjectStore((s) => s.activePanelGroupId);
  const setActivePanelGroup = useProjectStore((s) => s.setActivePanelGroup);
  const setSelectedRoof = useProjectStore((s) => s.setSelectedRoof);
  const addPanel = useProjectStore((s) => s.addPanel);
  const deletePanel = useProjectStore((s) => s.deletePanel);
  const moveGroup = useProjectStore((s) => s.moveGroup);

  // Whether panel groups should be draggable in the current tool mode.
  //   - idle:         yes — user is freely manipulating the layout
  //   - place-panels: yes — user may want to reposition a partially-built
  //                   group before adding more cells (the ghost's grid
  //                   origin follows the first panel, so the in-progress
  //                   grid rides along with the move for free)
  //   - draw-roof:    no — left-clicks are reserved for adding polygon
  //                   vertices; dragging over a panel would hijack that
  //   - assign-string: no — mouse-drag is the lasso paint
  //   - delete:       no — left-click is "remove this panel"
  const groupsDraggable = toolMode === 'idle' || toolMode === 'place-panels';

  // Track the mouse down position for right-click so we can distinguish
  // a click (delete panel) from a drag (pan the canvas).
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);

  // Fast lookups so we don't scan arrays per-panel

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
  // Resolve the ghost's orientation. If there's an active group with at
  // least one panel, inherit that group's orientation — otherwise new
  // placements would fight the existing grid. Otherwise fall back to the
  // roof default (applied to new groups created by this click).
  let ghostOrientation: 'portrait' | 'landscape' = selectedRoof?.panelOrientation ?? 'portrait';
  if (showGhost) {
    const mpp = project.mapState.metersPerPixel;
    const existingCenters = project.panels
      .filter((p) => p.roofId === selectedRoof.id)
      .map((p) => ({ x: p.cx, y: p.cy }));

    let origin: Point | null = null;
    let snap = false;

    if (activePanelGroupId) {
      // Find the first panel in this group to use as the grid origin.
      const firstPanel = project.panels.find(p => p.groupId === activePanelGroupId);
      if (firstPanel) {
        origin = { x: firstPanel.cx, y: firstPanel.cy };
        snap = true;
        // Inherit the active group's orientation for the ghost + snap math.
        // Panel.orientation is required (migrateProject backfills legacy saves
        // at the persistence boundary), so no roof-default fallback here.
        ghostOrientation = firstPanel.orientation;
      }
    }

    // Try to snap; null means "this cursor position maps to an invalid cell".
    // If snap is false, it returns the raw cursor position (as long as it's valid).
    const snapped = snapPanelToGrid(
      cursor,
      selectedRoof,
      project.panelType,
      ghostOrientation,
      mpp,
      existingCenters,
      origin,
      snap,
    );
    const { w, h } = panelDisplaySize(project.panelType, ghostOrientation, selectedRoof.tiltDeg, mpp);
    const angle = (roofPrimaryAngle(selectedRoof.polygon) * 180) / Math.PI;

    if (snapped) {
      // Valid snap → draw the ghost at the snapped grid cell (or raw cursor if no snap).
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
    const groupId = activePanelGroupId || Math.random().toString(36).slice(2, 10);
    // ghostOrientation is already resolved (group's orientation if one
    // exists, else roof default) — carry the same value onto the panel
    // so new groups start with a persistent per-panel record.
    addPanel(selectedRoof.id, ghost.x, ghost.y, groupId, ghostOrientation);
  };

  // ── Panel Dimensions ───────────────────────────────────────────────────
  const dimensions = useMemo(() => {
    if (renderPass !== 'base') return [];

    const dims: Array<{ centerCanvas: Point; lengthM: number; textAngle: number }> = [];
    const mpp = project.mapState.metersPerPixel;
    if (mpp <= 0) return dims;

    // Group panels by roofId and groupId
    const grouped = new Map<string, typeof project.panels>();
    for (const p of project.panels) {
      if (!p.groupId) continue;
      const key = `${p.roofId}-${p.groupId}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(p);
    }

    for (const [key, groupPanels] of grouped.entries()) {
      const roofId = key.split('-')[0];
      const roof = roofById.get(roofId);
      if (!roof) continue;
      // All panels in a group share orientation by construction —
      // updateGroupOrientation rewrites them all in one pass. Reading
      // from the first panel is therefore safe. Panel.orientation is
      // required (migrateProject backfills at rehydrate/import), so
      // no roof-default fallback.
      const orientation = groupPanels[0].orientation;
      const d = getPanelGroupDimensions(groupPanels, roof, project.panelType, orientation, mpp);
      dims.push(...d);
    }

    return dims;
  }, [project.panels, project.panelType, project.mapState.metersPerPixel, roofById, renderPass]);

  // ── Group panels by groupId for draggable rendering ───────────────────
  // Each groupId gets its own outer Konva <Group>; that outer group is the
  // thing the user drags. Children stay at their absolute canvas coords
  // (panel.cx/cy) while the outer group's (x, y) is what moves during a
  // drag — on dragend we commit the delta to the store and reset the
  // outer group's position to (0, 0). Grouping by groupId alone (not by
  // roof) is correct because a group already cannot span roofs — addPanel
  // ties groupId to a single roof at creation time.
  //
  // We preserve the label pass as a second iteration below (outside the
  // draggable wrappers) so label z-order stays consistent with the
  // 'labels' render pass semantics elsewhere in the file.
  const panelsByGroup = useMemo(() => {
    const map = new Map<string, Panel[]>();
    for (const p of project.panels) {
      const key = p.groupId || p.id; // legacy safety: ungrouped → solo bucket
      const bucket = map.get(key);
      if (bucket) bucket.push(p);
      else map.set(key, [p]);
    }
    return map;
  }, [project.panels]);

  // Renders the body of a single panel — factored out so both the base
  // pass (rectangles + hit targets) and the labels pass (index bubbles)
  // share the exact same click/hover plumbing, and so the group-by-group
  // draggable wrapper below can just map over its bucket.
  const renderPanel = (panel: Panel) => {
    const roof = roofById.get(panel.roofId);
    if (!roof) return null; // defensive: orphaned panel (shouldn't happen post-delete-cascade)
    // Per-panel orientation. Always present: addPanel writes it at
    // creation time and migrateProject backfills legacy panels at the
    // persistence boundary (Zustand rehydrate + JSON import).
    const orientation = panel.orientation;
    const { w, h } = panelDisplaySize(project.panelType, orientation, roof.tiltDeg, project.mapState.metersPerPixel);
    const angleDeg = (roofPrimaryAngle(roof.polygon) * 180) / Math.PI;
    const stringInfo = panel.stringId ? stringById.get(panel.stringId) : null;

    // Unassigned = dark gray so strings read clearly against imagery.
    const fill = stringInfo ? stringInfo.color : '#1f2937';
    const stroke = stringInfo ? '#000' : '#9ca3af';

    // Active-group highlight: in place-panels mode, panels belonging
    // to the currently active group get an amber outline + glow so the
    // user sees at a glance which grid continues on the next click.
    // Amber matches the rest of the UI's "active" accent (toolbar
    // button, selected string card). Limited to place-panels mode
    // because outside that context the highlight is just noise.
    const isActiveGroup =
      toolMode === 'place-panels' &&
      activePanelGroupId != null &&
      panel.groupId === activePanelGroupId;

    return (
      <Group
        key={panel.id}
        x={panel.cx}
        y={panel.cy}
        rotation={angleDeg}
        onMouseDown={(e) => {
          if (e.evt.button === 2) {
            mouseDownPosRef.current = { x: e.evt.clientX, y: e.evt.clientY };
          }
        }}
        onContextMenu={(e) => {
          // Right-click anywhere on the panel deletes it. Available in
          // every mode so users can remove mistakes without mode-switching.
          e.evt.preventDefault();
          e.cancelBubble = true;

          // If this was a drag (panning the canvas), don't delete the panel.
          if (mouseDownPosRef.current) {
            const dx = e.evt.clientX - mouseDownPosRef.current.x;
            const dy = e.evt.clientY - mouseDownPosRef.current.y;
            if (Math.hypot(dx, dy) > 5) return;
          }

          deletePanel(panel.id);
        }}
        onClick={(e) => {
          // Left-click delete only in delete mode; elsewhere, clicks
          // are reserved for other interactions (lasso start, etc.).
          if (toolMode === 'delete') {
            e.cancelBubble = true;
            deletePanel(panel.id);
          } else if (toolMode === 'place-panels') {
            // Click an existing panel to resume its group's grid.
            //
            // Also switch selectedRoof to this panel's roof — otherwise
            // the ghost keeps computing against the previously selected
            // roof and the user sees placements in the wrong place on
            // their next move. For this click to reach us, the ghost
            // Rect must be non-listening when invalid (see the ghost
            // render below); that's what makes group switching work
            // when hovering over an already-occupied cell.
            e.cancelBubble = true;
            if (panel.roofId !== selectedRoofId) {
              setSelectedRoof(panel.roofId);
            }
            setActivePanelGroup(panel.groupId);
          }
        }}
      >
        {renderPass === 'base' && (
          <>
            <Rect
              x={-w / 2}
              y={-h / 2}
              width={w}
              height={h}
              fill={fill}
              opacity={0.85}
              stroke={isActiveGroup ? '#fbbf24' : stroke}
              strokeWidth={isActiveGroup ? 1.5 : 1}
              listening={true}
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
          </>
        )}

        {/* Show the panel's index within its string, if any. */}
        {renderPass === 'labels' && panel.indexInString != null && (
          <Group listening={false}>
            {/*
              Backing circle: matches the line's white outline.
              Radius is slightly larger than the main dot.
            */}
            <Circle
              radius={Math.min(w, h) * 0.25 + 1}
              fill="white"
              opacity={0.3}
            />
            {/*
              Main circular dot: matches the wiring line's darkened color.
            */}
            <Circle
              radius={Math.min(w, h) * 0.25}
              fill={stringInfo ? darkenColor(stringInfo.color, 0.45) : '#1f2937'}
              shadowColor="black"
              shadowBlur={2}
              shadowOpacity={0.4}
            />
            <Text
              x={-w / 2}
              y={-h / 2}
              width={w}
              height={h}
              align="center"
              verticalAlign="middle"
              text={String(panel.indexInString)}
              fontSize={Math.min(w, h) * 0.35}
              fontStyle="bold"
              fill="#fff"
            />
          </Group>
        )}
      </Group>
    );
  };

  // On dragend: the outer per-group <Group> has been moved by Konva to
  // (x, y) = (dx, dy). We commit that delta to the store — which shifts
  // every panel.cx/cy — and then immediately zero out the node's
  // position via the Konva imperative API. Zeroing is important because
  // Konva's drag system mutated the node directly; if we don't reset it,
  // the next render (with updated panel coords) would render the group
  // DOUBLE-offset (once via the new cx/cy, once via the lingering
  // outer-group x/y). Resetting synchronously avoids a one-frame flash.
  const handleGroupDragEnd = (groupId: string) => (e: Konva.KonvaEventObject<DragEvent>) => {
    const node = e.target;
    const dx = node.x();
    const dy = node.y();
    node.position({ x: 0, y: 0 });
    if (dx !== 0 || dy !== 0) {
      moveGroup(groupId, dx, dy);
    }
  };

  return (
    <Group>
      {/* ── Placed panels, bucketed by groupId ──────────────────────────
          Each bucket is its own <Group> with `draggable` gated on tool
          mode. Konva's drag system distinguishes click from drag by
          motion threshold, so per-panel onClick handlers (delete mode,
          resume-group in place-panels) still work — a pure click fires
          click; a click-with-motion fires drag. We force the wrapper's
          (x, y) to (0, 0) each render and rely on handleGroupDragEnd to
          zero the node after committing the delta, so the outer group
          never ends up with a stale offset on top of freshly-moved
          panel.cx/cy values.

          The labels pass (string index bubbles) also goes through the
          same wrapper. We COULD skip the draggable flag for the labels
          pass — the base pass already covers it — but keeping both
          passes draggable means no matter which pass receives the
          mousedown on a given pixel, the drag still starts. Cheaper
          than hit-testing which pass was on top. */}
      {Array.from(panelsByGroup.entries()).map(([groupId, groupPanels]) => (
        <Group
          key={groupId}
          x={0}
          y={0}
          draggable={groupsDraggable}
          onDragEnd={handleGroupDragEnd(groupId)}
        >
          {groupPanels.map(renderPanel)}
        </Group>
      ))}

      {/* ── Ghost panel (placement preview) ──────────────────────────────
          listening is gated on `ghost.valid`: when the cursor sits over an
          invalid cell — typically because an existing panel is already
          there — we pass-through so the panel underneath catches the click
          and its onClick can switch activePanelGroup. Without this, the
          ghost Rect is topmost and swallows the click, locking the user
          into the most-recently-created group. */}
      {renderPass === 'base' && ghost && (
        <Group x={ghost.x} y={ghost.y} rotation={ghost.angleDeg} listening={ghost.valid}>
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

      {/* ── Panel Dimensions ─────────────────────────────────────────── */}
      {dimensions.map((dim, i) => (
        <Text
          key={`dim-${i}`}
          x={dim.centerCanvas.x}
          y={dim.centerCanvas.y}
          rotation={dim.textAngle}
          text={`${dim.lengthM.toFixed(1)}m`}
          fontSize={12}
          fill="#ffffff"
          shadowColor="black"
          shadowBlur={2}
          offsetX={15} // approximate centering
          offsetY={6}
          listening={false}
        />
      ))}
    </Group>
  );
}
