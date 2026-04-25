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
// KonvaOverlay — thin composition layer after the Phase 3 decomposition.
//
// What lives here now:
//   - The <Stage> itself + its <Layer> children (RoofLayer / StringLayer /
//     PanelLayer) + the captured-satellite background image.
//   - Event dispatch: merges the viewport hook's pan/zoom/rotate drag
//     handlers with the drawing controller's tool-mode handlers. Viewport
//     drags always win (so a mid-drag click doesn't commit a stray vertex).
//   - Overlay chrome: CompassWidget + RotationDock, both rendered when locked.
//
// What moved out:
//   - Pan/zoom/rotation state + math → `hooks/useViewport.ts`
//   - ResizeObserver → `hooks/useViewport.ts`
//   - Space-key pan modifier → `hooks/useViewport.ts`
//   - drawingPoints / paint / cut state machine + key bindings
//       (Escape / Enter / Shift) → `hooks/useDrawingController.ts`
//   - Inline SVG compass → `components/CompassWidget.tsx`
//   - Inline rotation dock → `components/RotationDock.tsx`
//
// Why Konva owns pan/zoom now (instead of Leaflet):
//   ADR-001 (superseded by ADR-007) kept Leaflet mounted after lock and
//   mirrored its zoom into a Stage scale — fragile because Leaflet
//   suppresses the 'zoom' event during its ~250ms animation, causing a
//   visible desync between tiles and drawings. Current design: rasterize
//   the tiles once at lock time (html2canvas in Toolbar.handleLock) and
//   hand Konva a plain PNG background. One transform, no fight.
//
// Pointer-events toggle:
//   When the map is NOT locked, Leaflet is mounted underneath and needs
//   the mouse → this overlay is passive (CSS pointer-events: none). When
//   locked, Leaflet is unmounted; we take every event.
// ────────────────────────────────────────────────────────────────────────────

import { Stage, Layer, Group, Image as KonvaImage } from 'react-konva';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../store/projectStore';
import { pushToast } from '../store/toastStore';
import RoofLayer from './RoofLayer';
import StringLayer from './StringLayer';
import PanelLayer from './PanelLayer';
import CompassWidget from './CompassWidget';
import RotationDock from './RotationDock';
import { useViewport } from '../hooks/useViewport';
import { useDrawingController } from '../hooks/useDrawingController';
import { getActiveSyncClient } from './ProjectEditor';
import type Konva from 'konva';

interface Props {
  containerRef: React.RefObject<HTMLDivElement>;
  // Kept in the props signature for API compatibility with App; only
  // used for eager cleanup on unlock. All real interaction post-lock
  // goes through our own pan/zoom state — no Leaflet calls.
  mapRef: React.RefObject<L.Map | null>;
}

export default function KonvaOverlay({ containerRef, mapRef: _mapRef }: Props) {
  const stageRef = useRef<Konva.Stage>(null);
  const { t } = useTranslation();

  // ── Store subscriptions (narrow-slice selectors) ─────────────────────
  const locked = useProjectStore((s) => s.project.mapState.locked);
  // MapState is a discriminated union on `locked`; capturedImage/Width/Height
  // only exist on the locked variant. Selectors narrow inline so downstream
  // code can treat the fields as "X | undefined" without pulling the whole
  // mapState object (which would subscribe to every unrelated mapState
  // change). When unlocked, selectors return undefined and the render
  // guard below handles the gap.
  const capturedImage = useProjectStore((s) =>
    s.project.mapState.locked ? s.project.mapState.capturedImage : undefined,
  );
  const capturedWidth = useProjectStore((s) =>
    s.project.mapState.locked ? s.project.mapState.capturedWidth : undefined,
  );
  const capturedHeight = useProjectStore((s) =>
    s.project.mapState.locked ? s.project.mapState.capturedHeight : undefined,
  );
  // Seed value for the Konva stage's initial rotation on lock. Written by
  // lockMap when the user rotated the Leaflet preview before pressing
  // Lock Map — see types/index.ts MapStateLocked.initialRotationDeg. Only
  // consumed by useViewport's lock-transition effect; live rotation is
  // owned by the viewport after that.
  const initialRotationDeg = useProjectStore((s) =>
    s.project.mapState.locked ? s.project.mapState.initialRotationDeg : undefined,
  );
  // User-controlled visibility of the captured satellite backdrop. We
  // intentionally hide only the <KonvaImage>, not the image *data* — the
  // bgImage HTMLImageElement stays loaded so toggling back on is instant
  // (no redecode of a multi-MB base64). When hidden, the CSS fallback on
  // <main> shows through the transparent Konva stage.
  const showBackground = useProjectStore((s) => s.showBackground);
  const toolMode = useProjectStore((s) => s.toolMode);
  const mpp = useProjectStore((s) => s.project.mapState.metersPerPixel);

  // Overlay only intercepts events when the map is locked. In idle mode,
  // this still allows clicking shapes (roofs/panels) for selection.
  const overlayActive = locked;

  // ── Viewport (pan/zoom/rotation/size/space-held) ─────────────────────
  const viewport = useViewport({ stageRef, containerRef, locked, initialRotationDeg });

  // ── Drawing controller (tool-mode state machine) ─────────────────────
  const drawing = useDrawingController({
    stageRef,
    stageScale: viewport.stageScale,
    isDraggingView: viewport.isDraggingView,
    overlayActive,
  });

  // ── Background image element ─────────────────────────────────────────
  // Konva's <Image> wants an HTMLImageElement, not a dataURL string. Load
  // async; render nothing for the background until it's ready (the other
  // layers still render immediately — just no backdrop for a frame).
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!capturedImage) {
      setBgImage(null);
      return;
    }
    // `cancelled` + cleanup prevent two hazards: (1) a late onload from a
    // previous dataURL clobbering state when the user rapidly re-locks,
    // and (2) a ~1-3 MB base64 decoded image lingering in heap after
    // unmount because its onload callback still held a reference.
    // Clearing src='' lets the browser release the decoded bitmap.
    const img = new window.Image();
    let cancelled = false;
    img.onload = () => { if (!cancelled) setBgImage(img); };
    img.onerror = () => {
      if (cancelled) return;
      // Fires when the captured base64 PNG fails to decode — usually
      // means the data URL was truncated by a localStorage quota limit
      // or hand-edited. Toast surfaces it visibly; without this the
      // canvas would just render empty and the user would have no
      // signal that something is wrong.
      console.error('Failed to decode captured background image');
      pushToast('error', t('errors.captureDecodeFailed'), {
        dedupeKey: 'capture-decode',
      });
      setBgImage(null);
    };
    img.src = capturedImage;
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
      img.src = '';
    };
  }, [capturedImage, t]);

  // ── Merged Stage mouse handlers ──────────────────────────────────────
  // Order matters: viewport first. If the viewport consumes the event
  // (pan/rotate in progress), we skip drawing logic entirely — otherwise
  // a mid-drag move would also update the drawing cursor and emit paint
  // assigns while the user is just repositioning the canvas.
  const onMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current;
    if (!stage) return;
    const screenPos = stage.getPointerPosition();
    if (!screenPos) return;
    // Notify syncClient so it queues inbound patches and suspends outbound
    // debounce until pointerup. Pure pan/zoom drags are still notified —
    // no harm if the subsequent diff is empty.
    getActiveSyncClient()?.beginGesture();
    if (viewport.tryStartViewportDrag(e, screenPos)) return;
    drawing.handleMouseDown();
  };

  const onMouseMove = () => {
    const stage = stageRef.current;
    if (!stage) return;
    const screenPos = stage.getPointerPosition();
    if (!screenPos) return;
    if (viewport.handleViewportMouseMove(screenPos)) return;
    drawing.handleMouseMove();
  };

  const onMouseUp = () => {
    // If a pan/rotate drag was ending, the viewport hook defers its ref
    // clear to a microtask so Konva's follow-up synthetic 'click' still
    // sees the drag and short-circuits. Either way we release the paint
    // state so no stuck paint-assign can outlive the mouseup.
    viewport.handleViewportMouseUp();
    drawing.handleMouseUp();
    // Fire AFTER drawing.handleMouseUp so the store reflects the final
    // gesture state when syncClient computes aliceDiff.
    getActiveSyncClient()?.endGesture();
  };

  // Guard: Konva crashes if the Stage is mounted at 0×0 (drawImage into
  // a 0-dimension canvas). First render is pre-ResizeObserver — render a
  // placeholder div until we have real dims.
  if (viewport.size.w === 0 || viewport.size.h === 0) {
    return (
      <div
        className="konva-overlay konva-overlay-passive"
        style={{ width: '100%', height: '100%' }}
      />
    );
  }

  const showCrosshair =
    locked && toolMode !== 'idle' && !viewport.spaceHeld && !viewport.isDraggingView();
  const showGrab = locked && (viewport.spaceHeld || viewport.isDraggingView());

  return (
    <div
      className={`konva-overlay ${
        locked ? 'konva-overlay-locked' : 'konva-overlay-passive'
      } ${showCrosshair ? 'konva-overlay-drawing' : ''} ${
        showGrab ? 'konva-overlay-grab' : ''
      }`}
      style={{ width: viewport.size.w, height: viewport.size.h }}
    >
      <Stage
        ref={stageRef}
        width={viewport.size.w}
        height={viewport.size.h}
        scaleX={viewport.stageScale}
        scaleY={viewport.stageScale}
        x={viewport.stagePos.x}
        y={viewport.stagePos.y}
        rotation={viewport.stageRotation}
        onClick={drawing.handleStageClick}
        onDblClick={drawing.handleDblClick}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onWheel={viewport.handleWheel}
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
              drawingPoints={drawing.drawingPoints}
              cursor={drawing.drawingSnap.point}
              guides={drawing.drawingSnap.guides}
              edgeLengthPx={drawing.drawingSnap.edgeLengthPx}
              lengthSnapped={drawing.drawingSnap.lengthSnapped}
              angleSnapped={drawing.drawingSnap.angleSnapped}
              mpp={mpp}
              setRotationAbsolute={viewport.setRotationAbsolute}
              stageScale={viewport.stageScale}
            />
            {/* Layering stack:
                1. Base panels (bottom)
                2. Wiring lines (middle)
                3. Labels/Dots (top)
            */}
            <PanelLayer cursor={drawing.cursor} stageActive={overlayActive} renderPass="base" />
            <StringLayer />
            <PanelLayer
              cursor={drawing.cursor}
              stageActive={overlayActive}
              renderPass="labels"
              stageRotation={viewport.stageRotation}
            />
          </Group>
        </Layer>
      </Stage>

      {locked && <CompassWidget stageRotation={viewport.stageRotation} />}
      {locked && (
        <RotationDock
          onRotate={viewport.rotateBy}
          onReset={() => viewport.setRotationAbsolute(0)}
        />
      )}
    </div>
  );
}
