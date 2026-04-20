// ────────────────────────────────────────────────────────────────────────────
// KonvaOverlay — the interaction state machine.
//
// This component:
//   - Owns a full-size <Stage> positioned on top of the Leaflet map
//   - Drives drawing/lasso state per current tool mode
//   - Delegates rendering to RoofLayer / PanelLayer / StringLasso
//
// Why keep the Stage on top of Leaflet rather than rendering into Leaflet's
// SVG layer? Three reasons:
//   1. Performance with many panels (Konva renders to a single <canvas>;
//      Leaflet SVG would create one DOM node per shape).
//   2. Clean event model — Konva's per-shape onClick/onDragMove etc.
//      matches what we need for the ghost panel + lasso.
//   3. Independence from map projection: once the map is locked, everything
//      lives in flat pixel space, which simplifies all the geometry.
//
// Pointer-events toggle: when no tool is active, `.konva-overlay-passive`
// makes the overlay transparent to clicks so Leaflet controls still work
// (e.g. zoom buttons). When a tool is active, `.konva-overlay-active` turns
// on pointer events and shows a crosshair cursor.
// ────────────────────────────────────────────────────────────────────────────

import { Stage, Layer } from 'react-konva';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import RoofLayer from './RoofLayer';
import PanelLayer from './PanelLayer';
import StringLasso from './StringLasso';
import { isPointInRect } from '../utils/geometry';
import { computeDrawingSnap } from '../utils/drawingSnap';
import type { Point, Rect } from '../types';
import type Konva from 'konva';

interface Props {
  containerRef: React.RefObject<HTMLDivElement>;
}

export default function KonvaOverlay({ containerRef }: Props) {
  const stageRef = useRef<Konva.Stage>(null);

  // Overlay dimensions, kept in sync with the parent container via
  // ResizeObserver (browser resize, sidebar collapse, etc.).
  const [size, setSize] = useState({ w: 0, h: 0 });

  const locked = useProjectStore((s) => s.project.mapState.locked);
  const toolMode = useProjectStore((s) => s.toolMode);
  const setToolMode = useProjectStore((s) => s.setToolMode);
  const roofs = useProjectStore((s) => s.project.roofs);
  const mpp = useProjectStore((s) => s.project.mapState.metersPerPixel);

  // Shift held = temporarily disable snapping. The user can still see the
  // raw cursor drag out the edge. Tracked here (not in drawingSnap) so the
  // key state re-triggers the useMemo cleanly.
  const [shiftHeld, setShiftHeld] = useState(false);

  // ── In-progress polygon (draw-roof mode) ──────────────────────────────
  // Kept in local state — only promoted to the store as a full Roof when
  // the user closes the polygon. This avoids polluting the persisted
  // project with partial drawings.
  const [drawingPoints, setDrawingPoints] = useState<Point[]>([]);

  // Last known cursor position in Stage pixel coords. Used for:
  //   - drawing the preview line from the last polygon vertex
  //   - positioning the ghost panel in place-panels mode
  //   - sizing the lasso rect in assign-string mode
  const [cursor, setCursor] = useState<Point | null>(null);

  // ── Lasso state (assign-string mode) ──────────────────────────────────
  // `lassoStart` is set on mousedown, cleared on mouseup. `lassoRect` is
  // the normalized rect (positive w/h regardless of drag direction).
  const [lassoStart, setLassoStart] = useState<Point | null>(null);
  const [lassoRect, setLassoRect] = useState<Rect | null>(null);

  const addRoof = useProjectStore((s) => s.addRoof);

  // Keep Stage size matched to container. Using ResizeObserver rather than
  // window.resize so collapses/expansions of neighboring layout also update.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  // Escape = universal cancel:
  //   - Discards in-progress roof drawing
  //   - Clears any active lasso
  //   - Returns to idle mode
  // Shift = hold to temporarily disable snapping in draw-roof mode.
  // This is handled here (not in App) because we also need to clear the
  // local drawing/lasso state, which only this component owns.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawingPoints([]);
        setLassoStart(null);
        setLassoRect(null);
        setToolMode('idle');
      }
      if (e.key === 'Shift') setShiftHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [setToolMode]);

  // Overlay only intercepts events when the map is locked AND a tool is
  // active. In idle mode the user may still want to click Leaflet controls.
  const overlayActive = locked && toolMode !== 'idle';

  /**
   * Drawing snap — only computed in draw-roof mode. Produces both the
   * snapped cursor position (for preview + vertex commit) and the set of
   * guide lines (angle rays, reference edges, length matches) to render.
   *
   * Memoized so RoofLayer re-renders only when inputs actually change.
   * Shift disables snapping entirely — user sees raw cursor control.
   */
  const drawingSnap = useMemo(() => {
    if (toolMode !== 'draw-roof' || !cursor) {
      return { point: cursor, guides: [], edgeLengthPx: 0, lengthSnapped: false, angleSnapped: false };
    }
    return computeDrawingSnap(cursor, drawingPoints, roofs, { enabled: !shiftHeld });
  }, [toolMode, cursor, drawingPoints, roofs, shiftHeld]);

  // Helper: pointer position in Stage coords. Returns null if the stage
  // isn't mounted yet (guards against rare race conditions on first paint).
  const getPointer = (): Point | null => {
    const pos = stageRef.current?.getPointerPosition();
    return pos ? { x: pos.x, y: pos.y } : null;
  };

  /**
   * Stage click — only meaningful in draw-roof mode. All other modes handle
   * clicks via shape-level handlers (e.g. panel ghost's onClick).
   *
   * Close-on-first-vertex: if there are already ≥3 points and the user
   * clicks within 12 px of the first vertex, treat as "close the polygon".
   * This is more intuitive than requiring a double-click, which is also
   * supported as a fallback.
   */
  const handleStageClick = () => {
    if (!overlayActive) return;
    const pos = getPointer();
    if (!pos) return;

    if (toolMode === 'draw-roof') {
      // Use the snapped cursor, not the raw click position — otherwise the
      // committed vertex would drift off the guide line the user was
      // following. Recompute here so we don't rely on the possibly-stale
      // memoized value (rare but possible on fast clicks without move).
      const snap = computeDrawingSnap(pos, drawingPoints, roofs, { enabled: !shiftHeld });
      const snapped = snap.point ?? pos;
      if (drawingPoints.length >= 3) {
        const first = drawingPoints[0];
        const dist = Math.hypot(first.x - snapped.x, first.y - snapped.y);
        if (dist < 12) {
          addRoof(drawingPoints);
          setDrawingPoints([]);
          setToolMode('idle');
          return;
        }
      }
      setDrawingPoints((prev) => [...prev, snapped]);
    }
  };

  // Double-click fallback for closing polygons (some trackpad users may
  // struggle to hit the 12 px close-radius reliably).
  const handleDblClick = () => {
    if (toolMode === 'draw-roof' && drawingPoints.length >= 3) {
      addRoof(drawingPoints);
      setDrawingPoints([]);
      setToolMode('idle');
    }
  };

  /**
   * Mouse move: update cursor ref, and if we're lassoing, update the rect.
   *
   * The rect is normalized (x,y = top-left; w,h positive) so downstream
   * code doesn't have to handle negative widths from dragging right-to-left
   * or bottom-to-top.
   */
  const handleMouseMove = () => {
    const pos = getPointer();
    if (!pos) return;
    setCursor(pos);
    if (lassoStart) {
      setLassoRect({
        x: Math.min(lassoStart.x, pos.x),
        y: Math.min(lassoStart.y, pos.y),
        w: Math.abs(pos.x - lassoStart.x),
        h: Math.abs(pos.y - lassoStart.y),
      });
    }
  };

  // Start a lasso drag. Only fires in assign-string mode; other modes
  // either ignore mouse-down (click-driven) or use shape-level handlers.
  const handleMouseDown = () => {
    if (!overlayActive) return;
    if (toolMode === 'assign-string') {
      const pos = getPointer();
      if (pos) {
        setLassoStart(pos);
        setLassoRect({ x: pos.x, y: pos.y, w: 0, h: 0 });
      }
    }
  };

  /**
   * Mouse up: commit the lasso.
   *
   * We do the commit INLINE here (not in StringLasso's effect) because:
   *   - State transitions from "active" to "inactive" need to happen in one
   *     go to avoid rendering a stale rect for a frame
   *   - We want to read `activeStringId` at commit time, not at render time
   *     (the user could have changed active string mid-drag)
   *
   * Tiny drags (<4 px in either dimension) are treated as a click, not a
   * lasso — prevents accidental empty assignments when the user clicks
   * without dragging.
   */
  const handleMouseUp = () => {
    if (toolMode === 'assign-string' && lassoStart && lassoRect) {
      const state = useProjectStore.getState();
      const sid = state.activeStringId;
      if (sid && (lassoRect.w > 4 || lassoRect.h > 4)) {
        // Hit test: panel center must be inside rect AND not already in a
        // different string (panels already in the active string are re-added,
        // which is a no-op but harmless).
        const hits = state.project.panels
          .filter(
            (p) =>
              isPointInRect({ x: p.cx, y: p.cy }, lassoRect) &&
              (p.stringId === null || p.stringId === sid)
          )
          .map((p) => p.id);
        if (hits.length > 0) state.assignPanelsToString(hits, sid);
      }
    }
    // Always clear lasso state on mouseup, even if nothing was committed.
    setLassoStart(null);
    setLassoRect(null);
  };

  // Guard: Konva crashes if the Stage is mounted at 0×0 (it tries to
  // drawImage into a 0-dimension canvas). On first render, `size` is still
  // {0,0} — the ResizeObserver hasn't fired yet. Render an empty placeholder
  // div until we have real dimensions.
  if (size.w === 0 || size.h === 0) {
    return (
      <div
        className="konva-overlay konva-overlay-passive"
        style={{ width: '100%', height: '100%' }}
      />
    );
  }

  return (
    <div
      className={`konva-overlay ${overlayActive ? 'konva-overlay-active' : 'konva-overlay-passive'}`}
      style={{ width: size.w, height: size.h }}
    >
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        onClick={handleStageClick}
        onDblClick={handleDblClick}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        // Suppress the browser context menu on right-click so right-click
        // can be used as "delete panel" shortcut without a popup interfering.
        onContextMenu={(e) => e.evt.preventDefault()}
      >
        <Layer listening={true}>
          <RoofLayer
            drawingPoints={drawingPoints}
            cursor={drawingSnap.point}
            guides={drawingSnap.guides}
            edgeLengthPx={drawingSnap.edgeLengthPx}
            lengthSnapped={drawingSnap.lengthSnapped}
            angleSnapped={drawingSnap.angleSnapped}
            mpp={mpp}
          />
          <PanelLayer cursor={cursor} stageActive={overlayActive} />
          <StringLasso lassoRect={lassoRect} lassoActive={lassoStart !== null} />
        </Layer>
      </Stage>
    </div>
  );
}
