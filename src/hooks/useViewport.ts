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
// useViewport — all Stage transform (pan/zoom/rotation) state and handlers.
//
// Extracted from KonvaOverlay (Phase 3). Before this, the god-component
// carried pan refs, zoom handlers, rotation handlers, a ResizeObserver, AND
// tool-mode drawing logic all in one file. Separating the viewport math
// leaves KonvaOverlay free to focus on drawing/tool dispatch.
//
// Contract with the caller:
//   - Caller renders the <Stage> and binds `handleWheel` to `onWheel` and
//     the mouse handlers to the corresponding Stage events.
//   - The viewport's mouse handlers return a boolean "consumed" signal. If
//     true, the caller should SKIP tool-mode logic for that event (e.g.
//     during a pan/rotate drag, we don't want drawing clicks or paint
//     assigns to fire).
//   - Key handlers (space-held) are registered globally; caller receives
//     `spaceHeld` for cursor-style decisions only.
//
// Why a ref, not state, for pan/rotate drag tracking:
//   During a pan drag we want to read & mutate the last position inside the
//   same event tick; state updates are asynchronous. A ref also avoids
//   re-rendering on every mouse move (60+ Hz). We expose `isDragging` as a
//   derived getter for the rendering pass; changing this to state would
//   eat perf for zero UI gain.
//
// Zoom-around-cursor math:
//   Classic trick: capture the WORLD point under the cursor before scaling,
//   then nudge `stagePos` after scaling so that the same world point lands
//   under the same screen pixel. With rotation in the mix, we do it via
//   stage.getAbsoluteTransform().invert() — which bakes in rotation — and
//   then forward-apply the new rotation+scale manually to figure out where
//   to drop the origin.
// ────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useCallback, type RefObject } from 'react';
import type Konva from 'konva';
import type { Point } from '../types';

// Wheel-zoom step. 1.05 gives a gentle, controllable zoom at standard
// scroll granularity. Larger values feel jumpy; smaller values mean the
// user has to spin the wheel forever.
const ZOOM_STEP = 1.05;
// Min/max zoom clamps. Below ~0.2 the plan is unreadably small; above 8
// the raster is mostly pixel mush (capture was done at CSS-pixel res).
const MIN_SCALE = 0.2;
const MAX_SCALE = 8;

interface UseViewportParams {
  stageRef: RefObject<Konva.Stage | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  /** Locking state gates wheel events and pan/rotate starts. Unlocked, Leaflet owns input. */
  locked: boolean;
  /**
   * Initial stage rotation (degrees) to apply when `locked` first becomes
   * true. Sourced from `mapState.initialRotationDeg`, written by lockMap
   * when the user rotated the Leaflet preview before locking. Changes
   * after the lock transition are ignored — this is a one-shot seed, not
   * a live binding (live rotation is owned by the user via middle-mouse
   * drag / the RotationDock). A fresh unlock → re-lock cycle picks up
   * the next seed value.
   */
  initialRotationDeg?: number;
}

export interface UseViewportResult {
  /** Current Stage transform. */
  stageScale: number;
  stagePos: Point;
  stageRotation: number;
  /** Stage dimensions kept in sync with containerRef via ResizeObserver. */
  size: { w: number; h: number };
  /** True while space key is held — caller uses this for cursor styles and
   *  to allow space+left-click panning in the mouse handler below. */
  spaceHeld: boolean;
  /** True while a pan or rotate drag is in progress. Read-only for callers. */
  isDraggingView: () => boolean;

  // ── Event handlers; return `true` if consumed (caller skips tool logic) ──
  handleWheel: (e: Konva.KonvaEventObject<WheelEvent>) => void;
  /** Called on Stage mousedown. Returns true if this starts a pan/rotate
   *  drag and the caller should NOT run tool-mode logic for this down. */
  tryStartViewportDrag: (
    e: Konva.KonvaEventObject<MouseEvent>,
    screenPos: Point,
  ) => boolean;
  /** Called on Stage mousemove. Returns true if consumed (pan or rotate was
   *  advanced). Caller should skip cursor updates + paint-assign on true. */
  handleViewportMouseMove: (screenPos: Point) => boolean;
  /** Called on Stage mouseup. Returns true if a drag ended (ref cleared via
   *  microtask so Konva's follow-up 'click' still sees the drag marker). */
  handleViewportMouseUp: () => boolean;

  // ── Programmatic rotation controls (toolbar dock + roof-edge align) ──
  /** Add `deltaDeg` degrees to the current rotation, pivoting around screen center. */
  rotateBy: (deltaDeg: number) => void;
  /** Set an absolute rotation (degrees) around screen center. */
  setRotationAbsolute: (deg: number) => void;
}

export function useViewport({
  stageRef,
  containerRef,
  locked,
  initialRotationDeg,
}: UseViewportParams): UseViewportResult {
  // ── Overlay dimensions via ResizeObserver ────────────────────────────
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  // ── Stage transform ──────────────────────────────────────────────────
  const [stageScale, setStageScale] = useState(1);
  const [stagePos, setStagePos] = useState<Point>({ x: 0, y: 0 });
  const [stageRotation, setStageRotation] = useState(0);

  // Reset pan/zoom/rotation when (un)locking so the first view after re-lock
  // isn't mysteriously altered from a previous session.
  //
  // On lock → true we also SEED stageRotation from `initialRotationDeg`
  // (written by lockMap when the user rotated the Leaflet preview). This
  // is a one-shot seed per lock session, guarded by `seededForLockRef`
  // so subsequent renders don't clobber live user rotation via
  // middle-mouse / RotationDock.
  //
  // IMPORTANT — when seeding a non-zero rotation, we must also adjust
  // `stagePos` so the rotation pivots around the screen center. Konva's
  // Stage `rotation` pivots around the stage origin (local 0,0). With
  // `stagePos = (0,0)` that origin coincides with the viewport's
  // top-left, so seeding rotation alone would make the captured imagery
  // swing out around the top-left corner — looking very different from
  // the pre-lock preview (which rotates around the visible center via
  // CSS) and giving the impression that the "rotation was reset".
  //
  // We include `size` + `initialRotationDeg` in the deps (not just
  // `locked`) so the seed retries if it fires before the ResizeObserver
  // has populated `size` — otherwise the first lock after mount would
  // fall through to the `size.w === 0` fallback and apply rotation
  // around (0,0). The `seededForLockRef` ref makes the retry one-shot.
  const seededForLockRef = useRef(false);
  useEffect(() => {
    if (!locked) {
      seededForLockRef.current = false;
      setStageScale(1);
      setStagePos({ x: 0, y: 0 });
      setStageRotation(0);
      return;
    }
    if (seededForLockRef.current) return;
    // Wait for size to be measured so the pivot math has real dimensions.
    if (size.w <= 0 || size.h <= 0) return;
    const seedDeg = initialRotationDeg ?? 0;
    seededForLockRef.current = true;
    setStageScale(1);
    setStageRotation(seedDeg);
    if (seedDeg === 0) {
      setStagePos({ x: 0, y: 0 });
      return;
    }
    // Before-seed state is identity: scale=1, pos=(0,0), rotation=0.
    // So world_center == screen_center == (w/2, h/2). We want that same
    // screen point to remain fixed after applying `rotation = seedDeg`.
    //   screen = rotate(seedDeg)(world) * scale + pos
    //   pos    = screen - rotate(seedDeg)(world)   // scale=1
    const rad = (seedDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = size.w / 2;
    const cy = size.h / 2;
    setStagePos({
      x: cx - (cos * cx - sin * cy),
      y: cy - (sin * cx + cos * cy),
    });
  }, [locked, size.w, size.h, initialRotationDeg]);

  // ── Drag refs (pan via right-click/space, rotate via middle-click) ───
  const panRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const rotateRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const isDraggingView = useCallback(
    () => panRef.current !== null || rotateRef.current !== null,
    [],
  );

  // ── Space-held (pan modifier) ─────────────────────────────────────────
  // Space is a legitimate character in form inputs, so we ignore the key
  // when a typing context has focus — otherwise the sidebar text fields
  // would stutter every time the user pressed space.
  const [spaceHeld, setSpaceHeld] = useState(false);
  useEffect(() => {
    const isTypingContext = (target: EventTarget | null) =>
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingContext(e.target)) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // ── Rotate helper (used by both middle-mouse drag and programmatic buttons) ──
  // Pivots around screen CENTER so the user's eye doesn't get yanked when
  // the rotation applies. Pivoting around the cursor would feel erratic for
  // a "set rotation to N°" toolbar action.
  const rotateBy = useCallback(
    (deltaDeg: number) => {
      const stage = stageRef.current;
      if (!stage) return;

      const centerX = size.w / 2;
      const centerY = size.h / 2;
      const worldCenter = stage
        .getAbsoluteTransform()
        .copy()
        .invert()
        .point({ x: centerX, y: centerY });

      setStageRotation((prev) => {
        const newRot = prev + deltaDeg;
        const rad = (newRot * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const rx = worldCenter.x * cos - worldCenter.y * sin;
        const ry = worldCenter.x * sin + worldCenter.y * cos;
        // Adjust stagePos so the same world coordinate stays at screen center.
        // Must use the *latest* scale — we capture via functional set below
        // to avoid a stale-closure bug if scale changed between the rotation
        // start and this commit.
        setStagePos({
          x: centerX - rx * stageScale,
          y: centerY - ry * stageScale,
        });
        return newRot;
      });
    },
    [size.w, size.h, stageScale, stageRef],
  );

  const setRotationAbsolute = useCallback(
    (deg: number) => {
      rotateBy(deg - stageRotation);
    },
    [rotateBy, stageRotation],
  );

  // ── Wheel zoom around cursor ─────────────────────────────────────────
  const handleWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      if (!locked) return;
      e.evt.preventDefault();
      const stage = stageRef.current;
      if (!stage) return;
      const pointer = stage.getPointerPosition();
      if (!pointer) return;

      const oldScale = stageScale;
      // deltaY < 0 = wheel up = zoom in. Sign on the exponent handles both
      // directions without a branch.
      const direction = e.evt.deltaY < 0 ? 1 : -1;
      const newScaleUnclamped = oldScale * Math.pow(ZOOM_STEP, direction);
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScaleUnclamped));
      if (newScale === oldScale) return;

      // Invert through the current (pre-change) absolute transform to get
      // the world point under the cursor. This respects rotation already,
      // so we only need to re-apply rotation+scale manually to figure out
      // where the origin should sit after the change.
      const worldPointer = stage
        .getAbsoluteTransform()
        .copy()
        .invert()
        .point(pointer);

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
    },
    [locked, stageScale, stageRotation, stageRef],
  );

  // ── Mouse handlers: return "consumed" so caller can skip tool logic ──
  const tryStartViewportDrag = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>, screenPos: Point): boolean => {
      if (!locked) return false;
      // Pan trigger: right-mouse button (2) OR space-held left-click (CAD convention).
      // Rotate trigger: middle-mouse button (1).
      const isRotateTrigger = e.evt.button === 1;
      const isPanTrigger = e.evt.button === 2 || (spaceHeld && e.evt.button === 0);

      if (isRotateTrigger) {
        e.evt.preventDefault();
        rotateRef.current = { lastX: screenPos.x, lastY: screenPos.y };
        return true;
      }
      if (isPanTrigger) {
        e.evt.preventDefault();
        panRef.current = { lastX: screenPos.x, lastY: screenPos.y };
        return true;
      }
      return false;
    },
    [locked, spaceHeld],
  );

  const handleViewportMouseMove = useCallback(
    (screenPos: Point): boolean => {
      if (rotateRef.current) {
        const dx = screenPos.x - rotateRef.current.lastX;
        rotateRef.current = { lastX: screenPos.x, lastY: screenPos.y };
        // 0.3°/px feels smooth in practice — faster than that overshoots on
        // a trackpad, slower feels sticky with a mouse.
        rotateBy(dx * 0.3);
        return true;
      }
      if (panRef.current) {
        const dx = screenPos.x - panRef.current.lastX;
        const dy = screenPos.y - panRef.current.lastY;
        panRef.current = { lastX: screenPos.x, lastY: screenPos.y };
        setStagePos((p) => ({ x: p.x + dx, y: p.y + dy }));
        return true;
      }
      return false;
    },
    [rotateBy],
  );

  const handleViewportMouseUp = useCallback((): boolean => {
    if (panRef.current || rotateRef.current) {
      // Defer clearing so the synthetic Stage 'click' (Konva fires it right
      // after mouseup) still sees the drag populated and short-circuits in
      // the caller. A microtask is enough — the click handler runs in the
      // same event-loop tick.
      queueMicrotask(() => {
        panRef.current = null;
        rotateRef.current = null;
      });
      return true;
    }
    return false;
  }, []);

  return {
    stageScale,
    stagePos,
    stageRotation,
    size,
    spaceHeld,
    isDraggingView,
    handleWheel,
    tryStartViewportDrag,
    handleViewportMouseMove,
    handleViewportMouseUp,
    rotateBy,
    setRotationAbsolute,
  };
}
