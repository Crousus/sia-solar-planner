// ────────────────────────────────────────────────────────────────────────────
// StringLasso — a "dumb" rect renderer for the rubber-band selection
// used during assign-string mode.
//
// Purposely minimal: all the state (lassoRect, lassoActive) is owned by
// KonvaOverlay, which also does the commit on mouseup. We just draw the
// rect. Splitting this out keeps KonvaOverlay's JSX a bit cleaner.
//
// listening=false: the rect is visual feedback only — we don't want it
// eating clicks or blocking panels underneath from being hit-tested.
// ────────────────────────────────────────────────────────────────────────────

import { Rect } from 'react-konva';
import type { Rect as RectT } from '../types';

interface Props {
  lassoRect: RectT | null;
  lassoActive: boolean;
}

export default function StringLasso({ lassoRect, lassoActive }: Props) {
  // Render nothing unless both are true. Guards against stale rects
  // flashing on screen when mode switches mid-drag.
  if (!lassoRect || !lassoActive) return null;
  return (
    <Rect
      x={lassoRect.x}
      y={lassoRect.y}
      width={lassoRect.w}
      height={lassoRect.h}
      stroke="#ffcb47"
      strokeWidth={1.5}
      dash={[4, 4]}
      fill="rgba(255,203,71,0.12)"
      listening={false}
    />
  );
}
