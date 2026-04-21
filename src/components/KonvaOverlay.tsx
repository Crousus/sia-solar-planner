// ────────────────────────────────────────────────────────────────────────────
// KonvaOverlay — the interaction state machine + the single rendering surface
// once the map is locked.
//
// This component:
//   - Owns a full-size <Stage> sized to match the main pane
//   - When locked, paints the satellite snapshot as a static background
//     AND owns pan + zoom natively (scroll-wheel + middle-mouse/space+drag)
//   - Drives drawing/lasso state per current tool mode
//   - Delegates rendering to RoofLayer / PanelLayer / StringLayer
//
// Why Konva owns pan/zoom now (instead of Leaflet):
//   The previous design (ADR-001, superseded by ADR-007) kept Leaflet mounted
//   after lock and tried to mirror its zoom into a Stage scale. That was
//   fragile: Leaflet's zoom animation suppressed the 'zoom' event for its
//   full 250ms duration while CSS-transforming the tile pane, causing a
//   visible desync between tiles and drawings. The fix was to stop fighting
//   Leaflet: at lock time, rasterize the tiles once (html2canvas in
//   Toolbar.handleLock) and hand Konva a plain PNG background. Konva then
//   owns every pixel and there's exactly one transform to reason about.
//
// Pointer-events toggle: when the map is NOT locked, Leaflet is mounted
// underneath and needs mouse events — so the overlay is passive. When
// locked, Leaflet is unmounted; we take every event.
// ────────────────────────────────────────────────────────────────────────────

import { Stage, Layer, Group, Image as KonvaImage } from 'react-konva';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import RoofLayer from './RoofLayer';
import StringLayer from './StringLayer';
import PanelLayer from './PanelLayer';
import { computeDrawingSnap } from '../utils/drawingSnap';
import { pointOnPolygonBoundary } from '../utils/polygonCut';
import type { Point } from '../types';
import type Konva from 'konva';

interface Props {
  containerRef: React.RefObject<HTMLDivElement>;
  // Kept in the props signature for API compatibility with App; only
  // used for eager cleanup on unlock. All real interaction post-lock
  // goes through our own pan/zoom state — no Leaflet calls.
  mapRef: React.RefObject<L.Map | null>;
}

// Wheel-zoom step. 1.05 gives a gentle, controllable zoom at standard
// scroll granularity. Larger values feel jumpy; smaller values mean the
// user has to spin the wheel forever. Matches what Figma/Miro roughly use.
const ZOOM_STEP = 1.05;
// Min/max zoom clamps. Below ~0.2 the plan is unreadably small; above 8
// the raster is mostly pixel mush (capture was done at CSS-pixel res).
const MIN_SCALE = 0.2;
const MAX_SCALE = 8;

export default function KonvaOverlay({ containerRef, mapRef: _mapRef }: Props) {
  const stageRef = useRef<Konva.Stage>(null);

  // Overlay dimensions, kept in sync with the parent container via
  // ResizeObserver (browser resize, sidebar collapse, etc.).
  const [size, setSize] = useState({ w: 0, h: 0 });

  const locked = useProjectStore((s) => s.project.mapState.locked);
  const capturedImage = useProjectStore((s) => s.project.mapState.capturedImage);
  const capturedWidth = useProjectStore((s) => s.project.mapState.capturedWidth);
  const capturedHeight = useProjectStore((s) => s.project.mapState.capturedHeight);
  // User-controlled visibility of the captured satellite backdrop. We
  // intentionally hide only the <KonvaImage>, not the image *data* — the
  // bgImage HTMLImageElement stays loaded so toggling back on is instant
  // (no redecode of a multi-MB base64). When hidden, the nicer CSS
  // fallback on <main> (see App.tsx / index.css) shows through the
  // transparent Konva stage.
  const showBackground = useProjectStore((s) => s.showBackground);
  const toolMode = useProjectStore((s) => s.toolMode);
  const setToolMode = useProjectStore((s) => s.setToolMode);
  const setSelectedRoof = useProjectStore((s) => s.setSelectedRoof);
  const roofs = useProjectStore((s) => s.project.roofs);
  const splitCandidateRoofId = useProjectStore((s) => s.splitCandidateRoofId);
  const setSplitCandidateRoof = useProjectStore((s) => s.setSplitCandidateRoof);
  const splitRoof = useProjectStore((s) => s.splitRoof);
  const mpp = useProjectStore((s) => s.project.mapState.metersPerPixel);

  // ── Konva-native pan/zoom state ──────────────────────────────────────
  // `stageScale` is a single uniform zoom multiplier. `stagePos` is the
  // screen-space translation of world origin (0,0). Both together form
  // the Stage transform: screen = world*scale + pos.
  //
  // on fresh lock, we start at 1:1 (scale=1, pos=(0,0), rotation=0).
  const [stageScale, setStageScale] = useState(1);
  const [stagePos, setStagePos] = useState<Point>({ x: 0, y: 0 });
  const [stageRotation, setStageRotation] = useState(0);

  // Reset pan/zoom/rotation when (un)locking so the first view after re-lock
  // isn't mysteriously altered from a previous session.
  useEffect(() => {
    if (!locked) {
      setStageScale(1);
      setStagePos({ x: 0, y: 0 });
      setStageRotation(0);
    }
  }, [locked]);

  // Shift held = temporarily disable snapping (draw-roof mode).
  const [shiftHeld, setShiftHeld] = useState(false);
  // Space held = pan mode. Middle-mouse also pans, but keyboard is nicer
  // for laptop trackpads. Tracked here so mousedown can branch.
  const [spaceHeld, setSpaceHeld] = useState(false);
  // Active pan drag state. Tracks the last screen position so successive
  // moves can compute deltas without reading the stage transform.
  const panRef = useRef<{ lastX: number; lastY: number } | null>(null);

  // Active rotation drag state via middle mouse button.
  const rotateRef = useRef<{ lastX: number; lastY: number } | null>(null);

  // In-progress polygon (draw-roof mode). Kept local so we don't pollute
  // persisted state with half-drawn polygons.
  const [drawingPoints, setDrawingPoints] = useState<Point[]>([]);

  // Last known cursor position in WORLD coords (after inverse transform).
  // Used for drawing preview lines, ghost panel, etc.
  const [cursor, setCursor] = useState<Point | null>(null);

  // Painting state (assign-string mode): true from mousedown to mouseup.
  const [isPainting, setIsPainting] = useState(false);

  const addRoof = useProjectStore((s) => s.addRoof);
  const assignPanelsToString = useProjectStore((s) => s.assignPanelsToString);

  // ── Background image element ─────────────────────────────────────────
  // Konva's <Image> wants an HTMLImageElement, not a dataURL string. Load
  // async; render nothing for the background until it's ready (the roof
  // layer etc. still render immediately — just no backdrop for a frame).
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!capturedImage) {
      setBgImage(null);
      return;
    }
    // `cancelled` + cleanup prevent two hazards: (1) a late onload from a
    // *previous* dataURL clobbering the current state when the user
    // rapidly re-locks, and (2) a ~1-3 MB base64 decoded image lingering
    // in heap after unmount because its onload callback still held a
    // reference. Clearing src='' lets the browser release the decoded
    // bitmap immediately.
    const img = new window.Image();
    let cancelled = false;
    img.onload = () => { if (!cancelled) setBgImage(img); };
    img.onerror = () => {
      if (cancelled) return;
      console.error('Failed to decode captured background image');
      setBgImage(null);
    };
    img.src = capturedImage;
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
      img.src = '';
    };
  }, [capturedImage]);

  // Keep Stage size matched to container via ResizeObserver (catches
  // sidebar collapses, not just window resize).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  // Escape = universal cancel. Shift = disable-snapping modifier.
  // Space = pan modifier. We ignore all of these when a form input has
  // focus so sidebar typing isn't hijacked (especially Space, which is
  // a legitimate character).
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
      // Enter commits an in-progress polyline as a cut IF the last
      // vertex lies on the candidate roof's boundary. Lets the user
      // finish a polyline cut without needing a perfectly-snapped
      // second edge click. We pull state via getState() because this
      // handler registers once and closure-captured toolMode /
      // splitCandidateRoofId would go stale.
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
            state.splitRoof(state.splitCandidateRoofId, drawingPoints);
            setDrawingPoints([]);
            state.setToolMode('idle');
          }
        }
      }
      if (e.key === 'Shift') setShiftHeld(true);
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftHeld(false);
      if (e.key === ' ' || e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [setToolMode, drawingPoints, setSplitCandidateRoof]);

  // Overlay only intercepts events when the map is locked. In idle mode,
  // this still allows clicking shapes (roofs/panels) for selection.
  const overlayActive = locked;

  /**
   * Drawing snap — only computed in draw-roof mode. Produces both the
   * snapped cursor position (for preview + vertex commit) and the set of
   * guide lines to render. Shift disables snapping entirely.
   */
  const drawingSnap = useMemo(() => {
    if (toolMode !== 'draw-roof' || !cursor) {
      return { point: cursor, guides: [], edgeLengthPx: 0, lengthSnapped: false, angleSnapped: false };
    }
    return computeDrawingSnap(cursor, drawingPoints, roofs, { enabled: !shiftHeld });
  }, [toolMode, cursor, drawingPoints, roofs, shiftHeld]);

  /**
   * Pointer position in WORLD coords. Konva's absolute transform handles
   * scale + translation together, so we don't need to unwind stageScale
   * and stagePos manually — just invert and apply.
   */
  const getPointer = (): Point | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const transform = stage.getAbsoluteTransform().copy().invert();
    const pos = stage.getPointerPosition();
    if (!pos) return null;
    return transform.point(pos);
  };

  /**
   * Wheel-zoom around the cursor. The classic pattern: compute the world
   * point under the cursor before zoom, change scale, then offset
   * stagePos so that same world point stays under the cursor.
   *
   * We guard locked-only — unlocked, Leaflet handles the wheel.
   */
  const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    if (!locked) return;
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const oldScale = stageScale;
    // deltaY < 0 = wheel up = zoom in. ZOOM_STEP^1 per tick; sign on the
    // exponent handles both directions without a branch.
    const direction = e.evt.deltaY < 0 ? 1 : -1;
    const newScaleUnclamped = oldScale * Math.pow(ZOOM_STEP, direction);
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScaleUnclamped));
    if (newScale === oldScale) return;

    // To zoom around the pointer while accounting for rotation, we need
    // the pointer's coordinate in world space, then we shift stagePos
    // so the new scale + rotation combination keeps that world coordinate
    // exactly under the screen pointer.
    const worldPointer = stage.getAbsoluteTransform().copy().invert().point(pointer);
    
    // Rotate world point back into screen space conceptually, before scale
    const rad = (stageRotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const rx = worldPointer.x * cos - worldPointer.y * sin;
    const ry = worldPointer.x * sin + worldPointer.y * cos;

    setStageScale(newScale);
    setStagePos({
      x: pointer.x - rx * newScale,
      y: pointer.y - ry * newScale,
    });
  };

  /**
   * Stage click — only meaningful in draw-roof mode. All other modes
   * handle clicks via shape-level handlers. Panning suppresses click.
   */
  const handleStageClick = () => {
    if (!overlayActive) return;
    // If we just finished a pan/rotate drag, treat this as a drag-end, not a click.
    // (Konva fires click on mouseup even after a drag.)
    if (panRef.current || rotateRef.current) return;
    const pos = getPointer();
    if (!pos) return;

    if (toolMode === 'draw-roof') {
      // Snap the incoming click via the same snap system that drives
      // the preview. This guarantees the committed vertex matches the
      // visual preview exactly, including edge and vertex snaps against
      // existing roof boundaries.
      const snap = computeDrawingSnap(pos, drawingPoints, roofs, { enabled: !shiftHeld });
      const snapped = snap.point ?? pos;

      // ── Boundary-hit test ──────────────────────────────────────────
      // We want to know: does this snapped point lie on the boundary
      // of some existing roof? If yes, we remember that roof id as a
      // "cut candidate" — subsequent clicks on the SAME roof's boundary
      // will commit the cut instead of continuing a regular polygon.
      // We use 8 px (matches the edge-snap tolerance in drawingSnap.ts)
      // — if a point landed close enough to count as snapped, it
      // should count as on-boundary.
      const EDGE_TOL = 8;
      let hitRoofId: string | null = null;
      for (const r of roofs) {
        if (pointOnPolygonBoundary(snapped, r.polygon, EDGE_TOL)) {
          hitRoofId = r.id;
          break;
        }
      }

      // Case 1: first vertex of a fresh polyline AND it's on a roof.
      // Tag that roof as the cut candidate and place the vertex normally.
      if (drawingPoints.length === 0 && hitRoofId) {
        setSplitCandidateRoof(hitRoofId);
        setDrawingPoints([snapped]);
        return;
      }

      // Case 2: we have a cut candidate AND the new vertex is on that
      // same roof's boundary AND we already placed ≥1 vertex. Fire the
      // split. The cut line is everything drawn so far + this snapped
      // endpoint.
      if (
        splitCandidateRoofId &&
        hitRoofId === splitCandidateRoofId &&
        drawingPoints.length >= 1
      ) {
        const cutLine = [...drawingPoints, snapped];
        splitRoof(splitCandidateRoofId, cutLine);
        // splitRoof clears splitCandidateRoofId in the store. We just
        // need to clear local drawing state and exit draw-roof.
        setDrawingPoints([]);
        setToolMode('idle');
        return;
      }

      // Case 3: existing close-path behavior — click near the first
      // vertex to close as a normal new roof.
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
  };

  const handleDblClick = () => {
    if (toolMode !== 'draw-roof') return;

    // If we have a cut candidate AND the last vertex lies on that
    // roof's boundary → this double-click commits the cut (useful for
    // multi-vertex polyline cuts where the user wants to stop drawing
    // without clicking the opposite edge a second time).
    if (splitCandidateRoofId && drawingPoints.length >= 2) {
      const last = drawingPoints[drawingPoints.length - 1];
      const candidateRoof = roofs.find((r) => r.id === splitCandidateRoofId);
      if (candidateRoof && pointOnPolygonBoundary(last, candidateRoof.polygon, 8)) {
        splitRoof(splitCandidateRoofId, drawingPoints);
        setDrawingPoints([]);
        setToolMode('idle');
        return;
      }
    }

    // Fallback to the existing "finish as a new roof" double-click.
    if (drawingPoints.length >= 3) {
      addRoof(drawingPoints);
      setDrawingPoints([]);
      setSplitCandidateRoof(null);
      setToolMode('idle');
    }
  };

  /** Hit-test a world-space point against panels and assign to active string. */
  const paintAssign = (pos: Point) => {
    const state = useProjectStore.getState();
    const sid = state.activeStringId;
    if (!sid) return;
    // Brush radius scales inversely with zoom so it feels the same on
    // screen at any scale: 15 screen-px always.
    const brushWorld = 15 / stageScale;
    const hit = state.project.panels.find((p) => {
      const dist = Math.hypot(p.cx - pos.x, p.cy - pos.y);
      return dist < brushWorld;
    });
    if (hit && hit.stringId !== sid) {
      assignPanelsToString([hit.id], sid);
    }
  };

  /**
   * Mouse move: update cursor, advance pan drag, or continue painting.
   * Pan has highest priority — while a pan is in progress we suppress
   * tool-mode effects (no ghost update, no paint assign) to avoid visual
   * jitter while the whole scene is sliding under the cursor.
   */
  const handleMouseMove = () => {
    const stage = stageRef.current;
    if (!stage) return;
    const screenPos = stage.getPointerPosition();
    if (!screenPos) return;

    if (rotateRef.current) {
      const dx = screenPos.x - rotateRef.current.lastX;
      rotateRef.current = { lastX: screenPos.x, lastY: screenPos.y };
      // Rotate around screen center based on mouse movement horizontally
      handleRotate(dx * 0.3); // 0.3 degree per pixel for smooth feel
      return;
    }

    if (panRef.current) {
      const dx = screenPos.x - panRef.current.lastX;
      const dy = screenPos.y - panRef.current.lastY;
      panRef.current = { lastX: screenPos.x, lastY: screenPos.y };
      setStagePos((p) => ({ x: p.x + dx, y: p.y + dy }));
      return;
    }

    const pos = getPointer();
    if (!pos) return;
    setCursor(pos);
    if (toolMode === 'assign-string' && isPainting) {
      paintAssign(pos);
    }
  };

  const handleMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (!overlayActive) return;
    const stage = stageRef.current;
    if (!stage) return;
    const screenPos = stage.getPointerPosition();
    if (!screenPos) return;

    // Pan and Rotate take precedence over tool modes.
    // Pan trigger: right-mouse button (2) OR space-held left-click. Matches CAD conventions.
    // Rotate trigger: middle-mouse button (1).
    const isRotateTrigger = e.evt.button === 1;
    const isPanTrigger = e.evt.button === 2 || (spaceHeld && e.evt.button === 0);

    if (isRotateTrigger) {
      e.evt.preventDefault();
      rotateRef.current = { lastX: screenPos.x, lastY: screenPos.y };
      return;
    }

    if (isPanTrigger) {
      e.evt.preventDefault();
      panRef.current = { lastX: screenPos.x, lastY: screenPos.y };
      return;
    }

    if (toolMode === 'assign-string') {
      const pos = getPointer();
      if (pos) {
        setIsPainting(true);
        paintAssign(pos); // Assign immediately on click
      }
    }
  };

  const handleMouseUp = () => {
    if (panRef.current || rotateRef.current) {
      // Defer clearing so the synthetic Stage click (Konva fires 'click'
      // right after mouseup) still sees the drag populated and short-
      // circuits. A microtask is enough — the click handler runs in the
      // same event loop tick. No setIsPainting here because pan/rotate and
      // paint are mutually exclusive (handleMouseDown's branches
      // return before touching isPainting).
      queueMicrotask(() => {
        panRef.current = null;
        rotateRef.current = null;
      });
      return;
    }
    setIsPainting(false);
  };

  /**
   * Rotate the canvas around the screen center.
   * `deltaDeg` is the angle to add in degrees.
   */
  const handleRotate = (deltaDeg: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    
    // Find world point currently at the center of the screen
    const centerX = size.w / 2;
    const centerY = size.h / 2;
    const worldCenter = stage.getAbsoluteTransform().copy().invert().point({ x: centerX, y: centerY });
    
    const newRot = stageRotation + deltaDeg;
    setStageRotation(newRot);
    
    // Rotate world point back into screen space conceptually, before scale
    const rad = (newRot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    
    const rx = worldCenter.x * cos - worldCenter.y * sin;
    const ry = worldCenter.x * sin + worldCenter.y * cos;
    
    // Adjust stagePos so that the same world coordinate remains at the screen center
    setStagePos({
      x: centerX - rx * stageScale,
      y: centerY - ry * stageScale,
    });
  };

  /**
   * Set an absolute rotation around the screen center.
   * Used for aligning the view to specific roof edges.
   */
  const setRotationAbsolute = (deg: number) => {
    handleRotate(deg - stageRotation);
  };

  // Guard: Konva crashes if the Stage is mounted at 0×0 (drawImage into
  // a 0-dimension canvas). First render is pre-ResizeObserver — render a
  // placeholder div until we have real dims.
  if (size.w === 0 || size.h === 0) {
    return (
      <div
        className="konva-overlay konva-overlay-passive"
        style={{ width: '100%', height: '100%' }}
      />
    );
  }

  const showCrosshair = locked && toolMode !== 'idle' && !spaceHeld && !panRef.current;
  const showGrab = locked && (spaceHeld || !!panRef.current);

  return (
    <div
      className={`konva-overlay ${
        locked ? 'konva-overlay-locked' : 'konva-overlay-passive'
      } ${showCrosshair ? 'konva-overlay-drawing' : ''} ${
        showGrab ? 'konva-overlay-grab' : ''
      }`}
      style={{ width: size.w, height: size.h }}
    >
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        scaleX={stageScale}
        scaleY={stageScale}
        x={stagePos.x}
        y={stagePos.y}
        rotation={stageRotation}
        onClick={handleStageClick}
        onDblClick={handleDblClick}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        // Suppress the browser context menu on right-click so right-click
        // can be used as "delete panel" shortcut without a popup interfering.
        onContextMenu={(e) => e.evt.preventDefault()}
      >
        {/* Background layer — the rasterized satellite view. Sits below
            everything else; non-interactive so it never eats events.
            Gated on `showBackground` so the user can hide the imagery
            without unlocking; the CSS fallback on <main> shows through. */}
        <Layer listening={false}>
          {showBackground && bgImage && capturedWidth && capturedHeight ? (
            <KonvaImage
              image={bgImage}
              x={0}
              y={0}
              width={capturedWidth}
              height={capturedHeight}
            />
          ) : (
            <Group />
          )}
        </Layer>
        <Layer listening={true}>
          <Group>
            <RoofLayer
              drawingPoints={drawingPoints}
              cursor={drawingSnap.point}
              guides={drawingSnap.guides}
              edgeLengthPx={drawingSnap.edgeLengthPx}
              lengthSnapped={drawingSnap.lengthSnapped}
              angleSnapped={drawingSnap.angleSnapped}
              mpp={mpp}
              setRotationAbsolute={setRotationAbsolute}
              stageScale={stageScale}
            />
            {/* Layering stack:
                1. Base panels (bottom)
                2. Wiring lines (middle)
                3. Labels/Dots (top)
            */}
            <PanelLayer cursor={cursor} stageActive={overlayActive} renderPass="base" />
            <StringLayer />
            <PanelLayer cursor={cursor} stageActive={overlayActive} renderPass="labels" />
          </Group>
        </Layer>
      </Stage>

      {/*
        Compass face — top right. Only visible when the map is locked (it
        reads the stageRotation to keep its needle pointing at real-world
        north regardless of how the canvas has been spun).
        Redesign notes:
          - Faceplate is a radial gradient of ink tones so it reads as a
            brushed-metal dial rather than a flat gray circle.
          - Hairline outer ring + inner dashed ring for engineering-instrument
            detail.
          - N points to amber (sun) instead of red; makes "north" feel like
            "true bearing" with the solar aesthetic. S points to copper.
          - 12 tick marks outside the inner ring, spaced 30° apart, create
            a proper clock-like readout.
          - Tiny live-rotation readout in mono under the compass.
      */}
      {locked && (
        <div className="absolute top-5 right-5 z-[600] pointer-events-none flex flex-col items-center gap-1.5">
          <svg
            width="68"
            height="68"
            viewBox="0 0 68 68"
            style={{
              // Rotate the WHOLE compass by stageRotation; the needle is
              // drawn fixed to the face so this simulates magnetic-compass
              // behavior: the whole body rotates with the canvas while the
              // needle stays "pointing north on the underlying earth".
              transform: `rotate(${stageRotation}deg)`,
              filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.7))',
              transformOrigin: 'center center',
            }}
          >
            <defs>
              <radialGradient id="compass-face" cx="0.35" cy="0.3" r="0.9">
                <stop offset="0%" stopColor="#322e25" />
                <stop offset="65%" stopColor="#1a1812" />
                <stop offset="100%" stopColor="#0a0804" />
              </radialGradient>
              <radialGradient id="compass-center" cx="0.3" cy="0.3" r="0.8">
                <stop offset="0%" stopColor="#fff4d6" />
                <stop offset="100%" stopColor="#f5b544" />
              </radialGradient>
            </defs>
            {/* Outer bezel — hairline amber-tinted border. */}
            <circle cx="34" cy="34" r="32" fill="url(#compass-face)" stroke="rgba(255,228,185,0.22)" strokeWidth="1" />
            <circle cx="34" cy="34" r="30" fill="none" stroke="rgba(255,228,185,0.08)" strokeWidth="0.75" />
            {/* 12-point tick ring — every 30°; the four cardinal ones are longer. */}
            {Array.from({ length: 12 }).map((_, i) => {
              const angle = (i * 30 * Math.PI) / 180;
              const cardinal = i % 3 === 0;
              const r1 = cardinal ? 23 : 26;
              const r2 = 28;
              const x1 = 34 + Math.sin(angle) * r1;
              const y1 = 34 - Math.cos(angle) * r1;
              const x2 = 34 + Math.sin(angle) * r2;
              const y2 = 34 - Math.cos(angle) * r2;
              return (
                <line
                  key={i}
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={cardinal ? 'rgba(255,228,185,0.5)' : 'rgba(255,228,185,0.2)'}
                  strokeWidth={cardinal ? 1.2 : 0.75}
                  strokeLinecap="round"
                />
              );
            })}
            {/* Cardinal labels — N emphasized amber, others dim ink. */}
            <text x="34" y="13" fill="var(--sun-300)" fontSize="10" fontWeight="700" fontFamily="'JetBrains Mono'" textAnchor="middle" dominantBaseline="central">N</text>
            <text x="55" y="34" fill="#c8c1b5" fontSize="8" fontWeight="600" fontFamily="'JetBrains Mono'" textAnchor="middle" dominantBaseline="central">E</text>
            <text x="34" y="55" fill="#ff9c6b" fontSize="8" fontWeight="600" fontFamily="'JetBrains Mono'" textAnchor="middle" dominantBaseline="central">S</text>
            <text x="13" y="34" fill="#c8c1b5" fontSize="8" fontWeight="600" fontFamily="'JetBrains Mono'" textAnchor="middle" dominantBaseline="central">W</text>
            {/* Needle — amber half (north) + ink half (south), diamond shape. */}
            <path d="M34 16 L38 34 L34 32 L30 34 Z" fill="var(--sun-400)" stroke="var(--sun-600)" strokeWidth="0.4" strokeLinejoin="round" />
            <path d="M34 52 L38 34 L34 32 L30 34 Z" fill="#6c6557" stroke="#322e25" strokeWidth="0.4" strokeLinejoin="round" />
            {/* Glowing pivot dot */}
            <circle cx="34" cy="33" r="2.4" fill="url(#compass-center)" />
          </svg>
          {/* Live rotation readout — counter-rotates the outer SVG so text stays upright. */}
          <div
            className="chip font-mono"
            style={{
              fontSize: 10,
              padding: '2px 7px',
              background: 'rgba(18,16,9,0.75)',
              color: 'var(--sun-300)',
            }}
          >
            {stageRotation.toFixed(0)}°
          </div>
        </div>
      )}

      {/*
        Floating rotation dock — bottom right. Uses the shared `.surface`
        primitive so it matches the hint banner's material. Buttons are
        `.btn-tool` sized down to icon-only squares.
      */}
      {locked && (
        <div className="absolute bottom-6 right-6 z-[600]">
          <div
            className="surface rounded-full px-2 py-1.5 flex items-center gap-1"
            style={{ fontSize: 11 }}
          >
            <span
              className="font-mono uppercase tracking-wider px-2"
              style={{ fontSize: 9.5, color: 'var(--ink-400)' }}
            >
              Rotate
            </span>
            <button
              className="btn btn-tool"
              style={{ width: 26, height: 26, padding: 0, justifyContent: 'center', fontSize: 14 }}
              onClick={() => handleRotate(-15)}
              title="Rotate Left 15°"
            >
              ↺
            </button>
            <button
              className="btn btn-tool"
              style={{ width: 26, height: 26, padding: 0, justifyContent: 'center', fontSize: 14 }}
              onClick={() => handleRotate(15)}
              title="Rotate Right 15°"
            >
              ↻
            </button>
            <div className="divider-v mx-0.5" style={{ height: 14 }} />
            <button
              className="btn btn-tool"
              style={{ padding: '4px 8px', fontSize: 11 }}
              onClick={() => handleRotate(-stageRotation)}
              title="Reset Rotation"
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
