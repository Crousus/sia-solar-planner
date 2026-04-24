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
// useDrawingController — tool-mode interaction state machine.
//
// Extracted from KonvaOverlay (Phase 3). This is the "what happens when the
// user clicks / moves the mouse in the current tool mode" layer. The caller
// merges its mouse handlers with useViewport's so that pan/rotate drags
// always win over tool-mode intent.
//
// Responsibilities:
//   - Own in-progress polygon vertices (`drawingPoints`) — local state so
//     half-drawn polygons never leak into the persisted store.
//   - Own cursor-in-world (`cursor`) for drawing preview + paint hit-tests.
//   - Own paint-drag state (`isPainting`) and the `shiftHeld` snap-disable.
//   - Wire Escape/Enter/Shift key handlers globally.
//   - Emit committed roofs (addRoof) and cut splits (splitRoof) via the store.
//
// Why a separate hook:
//   Previously all of this lived inline in KonvaOverlay. Pulling it out
//   means a reader of KonvaOverlay can see a 4-handler Stage without
//   wading through 180+ lines of click-dispatch branching. It also makes
//   the split-cut flow (candidate → Enter/Dbl/close-path cases) testable
//   in isolation later — though we haven't written those tests yet.
//
// Store access pattern:
//   Most reads go through selectors so we re-render on changes (e.g.
//   toolMode, drawingSnap). But the Enter-key handler registers ONCE and
//   would otherwise closure-capture stale toolMode / splitCandidateRoofId,
//   so it reads via `useProjectStore.getState()`. Mirrors the original.
// ────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback, type RefObject } from 'react';
import type Konva from 'konva';
import type { Point } from '../types';
import { useProjectStore } from '../store/projectStore';
import { computeDrawingSnap, type SnapGuide } from '../utils/drawingSnap';
import { pointOnPolygonBoundary } from '../utils/polygonCut';

// Widened snap shape: when we're NOT in draw-roof mode, `point` is the raw
// cursor (possibly null), not a snapped Point. RoofLayer tolerates a null
// cursor — it just suppresses the preview line — so we let this propagate.
interface SnapView {
  point: Point | null;
  guides: SnapGuide[];
  edgeLengthPx: number;
  lengthSnapped: boolean;
  angleSnapped: boolean;
}

interface UseDrawingControllerParams {
  stageRef: RefObject<Konva.Stage | null>;
  /** Current Stage scale — needed to scale the paint-brush radius so the
   *  on-screen feel stays constant across zoom levels. */
  stageScale: number;
  /** True while a viewport pan/rotate drag is in progress. Drawing logic
   *  must ignore clicks/moves during a drag to avoid emitting stray
   *  vertices and paint assigns. */
  isDraggingView: () => boolean;
  /** Only intercept events when the overlay is active (map locked).
   *  In the unlocked state Leaflet takes events underneath. */
  overlayActive: boolean;
}

export interface UseDrawingControllerResult {
  drawingPoints: Point[];
  cursor: Point | null;
  /** Snapped cursor + guide lines for the current draw step.
   *  When not in draw-roof mode, `point` is the raw cursor (possibly null)
   *  and guides are empty. */
  drawingSnap: SnapView;

  // Stage event handlers. Caller wires these to the Stage after merging
  // with useViewport's handlers (viewport wins on drag in progress).
  handleStageClick: () => void;
  handleDblClick: () => void;
  handleMouseDown: () => void;
  handleMouseMove: () => void;
  handleMouseUp: () => void;
}

export function useDrawingController({
  stageRef,
  stageScale,
  isDraggingView,
  overlayActive,
}: UseDrawingControllerParams): UseDrawingControllerResult {
  // ── Store subscriptions ──────────────────────────────────────────────
  const toolMode = useProjectStore((s) => s.toolMode);
  const setToolMode = useProjectStore((s) => s.setToolMode);
  const setSelectedRoof = useProjectStore((s) => s.setSelectedRoof);
  const roofs = useProjectStore((s) => s.project.roofs);
  const splitCandidateRoofId = useProjectStore((s) => s.splitCandidateRoofId);
  const setSplitCandidateRoof = useProjectStore((s) => s.setSplitCandidateRoof);
  const splitRoof = useProjectStore((s) => s.splitRoof);
  const addRoof = useProjectStore((s) => s.addRoof);
  const assignPanelsToString = useProjectStore((s) => s.assignPanelsToString);

  // ── Local interaction state ──────────────────────────────────────────
  const [shiftHeld, setShiftHeld] = useState(false);
  const [drawingPoints, setDrawingPoints] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [isPainting, setIsPainting] = useState(false);

  // ── Keyboard handlers: Escape / Enter / Shift ────────────────────────
  // Escape = universal cancel; Shift = disable snapping modifier;
  // Enter = commit in-progress cut if last vertex lies on candidate roof.
  // Ignored when a typing context has focus so sidebar inputs keep Enter
  // as "submit" and Escape as "blur".
  useEffect(() => {
    const isTypingContext = (target: EventTarget | null) =>
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingContext(e.target)) return;
      if (e.key === 'Escape') {
        setDrawingPoints([]);
        setIsPainting(false);
        setSplitCandidateRoof(null);
        setToolMode('idle');
      }
      // Enter commits a polyline cut if the last vertex lies on the
      // candidate roof's boundary. Lets the user finish a multi-vertex
      // cut without perfectly snapping the final click. getState() used
      // because the closure-captured values would go stale otherwise.
      if (e.key === 'Enter') {
        const state = useProjectStore.getState();
        if (
          state.toolMode === 'draw-roof' &&
          state.splitCandidateRoofId &&
          drawingPoints.length >= 2
        ) {
          const candidateRoof = state.project.roofs.find(
            (r) => r.id === state.splitCandidateRoofId,
          );
          const last = drawingPoints[drawingPoints.length - 1];
          if (
            candidateRoof &&
            pointOnPolygonBoundary(last, candidateRoof.polygon, 8)
          ) {
            // Only tear down state if the split committed. A rejected cut
            // keeps the polyline so the user can adjust it.
            if (state.splitRoof(state.splitCandidateRoofId, drawingPoints)) {
              setDrawingPoints([]);
              state.setToolMode('idle');
            }
          }
        }
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
    // drawingPoints intentionally in deps so Enter sees the current polyline.
    // setToolMode/setSplitCandidateRoof are stable Zustand refs.
  }, [setToolMode, drawingPoints, setSplitCandidateRoof]);

  // ── Drawing snap (preview + guides) ──────────────────────────────────
  const drawingSnap = useMemo(() => {
    if (toolMode !== 'draw-roof' || !cursor) {
      return { point: cursor, guides: [], edgeLengthPx: 0, lengthSnapped: false, angleSnapped: false };
    }
    return computeDrawingSnap(cursor, drawingPoints, roofs, { enabled: !shiftHeld });
  }, [toolMode, cursor, drawingPoints, roofs, shiftHeld]);

  // ── Pointer helpers ──────────────────────────────────────────────────
  // World-space pointer via the inverted absolute transform — this folds
  // in rotation too, so callers don't need to unwind scale/pos/rotation.
  const getPointer = useCallback((): Point | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const transform = stage.getAbsoluteTransform().copy().invert();
    const pos = stage.getPointerPosition();
    if (!pos) return null;
    return transform.point(pos);
  }, [stageRef]);

  // Brush hit-test for assign-string. Screen-space 15px radius regardless
  // of zoom: feels identical at any scale.
  const paintAssign = useCallback(
    (pos: Point) => {
      const state = useProjectStore.getState();
      const sid = state.activeStringId;
      if (!sid) return;
      const brushWorld = 15 / stageScale;
      const hit = state.project.panels.find((p) => {
        const dist = Math.hypot(p.cx - pos.x, p.cy - pos.y);
        return dist < brushWorld;
      });
      if (hit && hit.stringId !== sid) {
        assignPanelsToString([hit.id], sid);
      }
    },
    [stageScale, assignPanelsToString],
  );

  // ── Click: the big draw-roof state machine ───────────────────────────
  const handleStageClick = useCallback(() => {
    if (!overlayActive) return;
    // If a pan/rotate drag just ended, Konva still fires 'click' on
    // mouseup. Short-circuit so the drag doesn't also commit a vertex.
    if (isDraggingView()) return;
    const pos = getPointer();
    if (!pos) return;

    if (toolMode === 'draw-roof') {
      // Snap the committed vertex through the same pipeline as the preview
      // so the visual and the stored vertex never disagree.
      const snap = computeDrawingSnap(pos, drawingPoints, roofs, { enabled: !shiftHeld });
      const snapped = snap.point ?? pos;

      // Boundary-hit test: does the snapped point lie on any existing
      // roof's edge? If so, we might be starting or completing a cut.
      // 8 px matches the edge-snap tolerance in drawingSnap.ts — if the
      // point snapped, it should count as on-boundary.
      const EDGE_TOL = 8;
      let hitRoofId: string | null = null;
      for (const r of roofs) {
        if (pointOnPolygonBoundary(snapped, r.polygon, EDGE_TOL)) {
          hitRoofId = r.id;
          break;
        }
      }

      // Case 1: first vertex of a fresh polyline AND it hit a roof →
      // remember that roof as the cut candidate, then place the vertex.
      if (drawingPoints.length === 0 && hitRoofId) {
        setSplitCandidateRoof(hitRoofId);
        setDrawingPoints([snapped]);
        return;
      }

      // Case 2: we have a cut candidate AND the new vertex is on that
      // same roof's boundary AND ≥1 vertex is already placed → fire split.
      if (
        splitCandidateRoofId &&
        hitRoofId === splitCandidateRoofId &&
        drawingPoints.length >= 1
      ) {
        const cutLine = [...drawingPoints, snapped];
        // splitRoof returns false for invalid cuts (e.g. interior vertex
        // outside the polygon). On failure we fall through to the default
        // vertex-append so the polyline survives for the user to fix.
        if (splitRoof(splitCandidateRoofId, cutLine)) {
          setDrawingPoints([]);
          setToolMode('idle');
          return;
        }
      }

      // Case 3: click near the first vertex → close as a new roof.
      if (drawingPoints.length >= 3) {
        const first = drawingPoints[0];
        const dist = Math.hypot(first.x - snapped.x, first.y - snapped.y);
        if (dist < 12) {
          addRoof(drawingPoints);
          setDrawingPoints([]);
          setSplitCandidateRoof(null);
          setToolMode('idle');
          return;
        }
      }

      // Default: append a vertex, continue drawing.
      setDrawingPoints((prev) => [...prev, snapped]);
    } else if (toolMode === 'idle') {
      // Empty-background click deselects. Shapes use e.cancelBubble.
      setSelectedRoof(null);
    }
  }, [
    overlayActive,
    isDraggingView,
    getPointer,
    toolMode,
    drawingPoints,
    roofs,
    shiftHeld,
    splitCandidateRoofId,
    setSplitCandidateRoof,
    splitRoof,
    setToolMode,
    addRoof,
    setSelectedRoof,
  ]);

  const handleDblClick = useCallback(() => {
    if (toolMode !== 'draw-roof') return;

    // Cut-candidate + last vertex on boundary → commit multi-vertex cut
    // without needing a perfectly-snapped second edge click.
    if (splitCandidateRoofId && drawingPoints.length >= 2) {
      const last = drawingPoints[drawingPoints.length - 1];
      const candidateRoof = roofs.find((r) => r.id === splitCandidateRoofId);
      if (candidateRoof && pointOnPolygonBoundary(last, candidateRoof.polygon, 8)) {
        if (splitRoof(splitCandidateRoofId, drawingPoints)) {
          setDrawingPoints([]);
          setToolMode('idle');
          return;
        }
      }
    }

    // Fallback to "finish as a new roof" double-click.
    if (drawingPoints.length >= 3) {
      addRoof(drawingPoints);
      setDrawingPoints([]);
      setSplitCandidateRoof(null);
      setToolMode('idle');
    }
  }, [
    toolMode,
    splitCandidateRoofId,
    drawingPoints,
    roofs,
    splitRoof,
    setToolMode,
    addRoof,
    setSplitCandidateRoof,
  ]);

  // ── Mouse move/down/up for tool interactions ─────────────────────────
  // Caller has already filtered out viewport-drag moves, so we can freely
  // update cursor / paint-assign.
  const handleMouseMove = useCallback(() => {
    const pos = getPointer();
    if (!pos) return;
    setCursor(pos);
    if (toolMode === 'assign-string' && isPainting) {
      paintAssign(pos);
    }
  }, [getPointer, toolMode, isPainting, paintAssign]);

  const handleMouseDown = useCallback(() => {
    if (!overlayActive) return;
    if (toolMode === 'assign-string') {
      const pos = getPointer();
      if (pos) {
        setIsPainting(true);
        paintAssign(pos); // Assign immediately on click
      }
    }
  }, [overlayActive, toolMode, getPointer, paintAssign]);

  const handleMouseUp = useCallback(() => {
    // Caller has already absorbed viewport drag-end via microtask; safe to
    // release paint unconditionally. paint and pan/rotate are mutually
    // exclusive at mousedown-time so nothing can race here.
    setIsPainting(false);
  }, []);

  return {
    drawingPoints,
    cursor,
    drawingSnap,
    handleStageClick,
    handleDblClick,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
  };
}
