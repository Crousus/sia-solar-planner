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
// SwitchNode — DC isolator / disconnect switch.
//
// Unlike the other diagram nodes (which all share BaseNode's chip layout),
// the switch renders as a literal schematic symbol: a vertical wire with
// a hinged lever sitting between a top and bottom contact, drawn the way
// an electrician would sketch it on paper.
//
// Rotation:
//   The user can rotate a switch in 90° steps via a small button revealed
//   on hover (top-right corner of the wrapper). Real diagrams need both
//   inline-vertical disconnects (string → switch → inverter) AND
//   inline-horizontal ones (e.g. on a horizontal AC busbar between an
//   inverter and the grid output), so a fixed orientation forced users
//   into L-shaped routing for the second case. Rotation is stored on
//   `data.rotation` (0 / 90 / 180 / 270) and round-trips through the
//   normal node-data sync pipeline — no schema changes needed because
//   `DiagramNodeData`'s `[key: string]: unknown` index signature already
//   admits arbitrary keys.
//
//   The two handle ids are kept stable as 'top' and 'bottom' regardless
//   of rotation: they identify the SVG's logical ends ("top of the
//   drawing"), and the rotation only controls where on the wrapper they
//   physically sit. Keeping the ids invariant means existing edges
//   resolve cleanly across rotation changes (and across pre-rotation
//   saves) without a migration step.
//
//   On rotate we also nudge the node's `position` so the visual centre
//   of the symbol stays anchored — without that, swapping wrapper
//   dimensions (50×130 ↔ 130×50) would make the switch jump 40 px in
//   one axis on every quarter-turn.
//
// Layout: the wrapper's measured box equals the (rotation-aware) SYMBOL
// box exactly. Labels overflow to the right via `position: absolute`,
// so they show next to the symbol without growing the wrapper's
// intrinsic width.
//
// Why this matters for grid alignment:
//   DiagramCanvas snaps node CENTERS to an 11 px grid. For chip nodes,
//   handles sit on each side's centerline, so a center on grid means
//   handles on grid — and two stacked nodes' wires line up. If the
//   switch wrapper measured `symbol + gap + label` wide, its center
//   would float between the symbol and the label and snap would push
//   the symbol's handles OFF the grid by half the label width,
//   breaking vertical alignment. Pulling the labels out of the layout
//   flow keeps the symbol's handles on the same grid columns as every
//   other node's handles.
//
// Geometry of the drawn symbol (SVG viewBox 50 × 130, all in px) — at
// rotation = 0:
//
//      ┌─ 25 (centerX, the wire path) ─┐
//      │                                │
//   y=  4 ─── top wire stub starts at the top edge
//   y= 44 ─── top contact ─────────────────────●  (centerX, 44)
//   pivot dot (3, 50) ●
//                       ╲   tight ~45° lever —
//                        ╲  pivots well outward
//                         ╲ (left of the wire
//                          ╲column) and lands on
//                           ╲the bottom wire just
//                            ╲22 px lower.
//   y= 72 ─── lever tip meets the bottom wire (centerX, 72)
//   y=126 ─── bottom wire stub ends at bottom edge
//
// Important: the lever DOES NOT pass through the top contact. Pivot is
// up-and-LEFT of the top contact, so as the lever swings down-right it
// clears the top contact entirely before joining the bottom wire.
//
// The lever's tip is intentionally undecorated — no terminal dot — so
// the diagonal flows directly into the vertical bottom wire as one
// continuous stroke. The top contact still has its dot because it's a
// free, unconnected fixed contact (no wire takes over from it on the
// lever side); the bottom junction is just a corner.
//
// `diagram-node` class:
//   Same hook BaseNode uses; DiagramCanvas's scoped CSS hides the handle
//   pins and the rotate button until the node is hovered/selected/
//   connected. We mirror BaseNode's `data-connected` attribute on each
//   Handle so a connected pin stays visible at all times.
// ────────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';
import { Handle, Position, useNodeConnections, useReactFlow } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import type { DiagramNodeData } from '../../../types';

type SwitchNodeType = Node<DiagramNodeData, 'switch'>;

// Slate accent — same hue the chip nodes use for the type's identity color.
// Surfaces in selection state and on the connection-handle dots; the symbol
// itself is drawn in the app's regular foreground ink so it photographs
// cleanly into the PDF.
const ACCENT = '#64748b';

// Symbol box dimensions at rotation=0 (vertical orientation). At
// rotation 90/270 these swap so the wrapper measures 130×50 — see
// `wrapperW` / `wrapperH` below. The SVG itself is always drawn in the
// 50×130 frame and rotated via CSS, so the geometry constants above
// (top contact at y=44, lever tip at y=72, etc.) stay valid in every
// orientation; only the wrapper's measured box rotates.
const SYMBOL_W = 50;
const SYMBOL_H = 130;

// Allowed rotation steps. We deliberately don't expose arbitrary
// degrees — schematic diagrams are quarter-turn affairs (vertical or
// horizontal current paths) and a 30° switch would never line up with
// neighbours' handles on the snap grid.
type Rotation = 0 | 90 | 180 | 270;
function isRotation(v: unknown): v is Rotation {
  return v === 0 || v === 90 || v === 180 || v === 270;
}

// Rotation step → physical handle position lookup. Index = rotation/90.
// Reading: at rotation N°, the SVG's "top" end ends up at
// ROTATION_SEQUENCE[N/90], and the "bottom" end is at the index +2 wrap.
//
// rotation=0:   top→Top,    bottom→Bottom
// rotation=90:  top→Right,  bottom→Left
// rotation=180: top→Bottom, bottom→Top
// rotation=270: top→Left,   bottom→Right
const ROTATION_SEQUENCE = [
  Position.Top,
  Position.Right,
  Position.Bottom,
  Position.Left,
] as const;

// Small curved-arrow rotate icon used inside the rotate button. Drawn
// inline so the icon weight matches the rest of the diagram's hand-
// drawn glyphs and so we don't pull in an icon dep for one button.
function RotateIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {/* Three-quarter arc + arrowhead — universal "rotate clockwise" glyph. */}
      <path d="M3 8a5 5 0 1 0 1.5-3.5" />
      <path d="M3 3v3h3" />
    </svg>
  );
}

export default function SwitchNode({ id, data, selected }: NodeProps<SwitchNodeType>) {
  // `updateNodeData` is the targeted helper for in-place label edits;
  // `updateNode` is needed for rotate because we must patch position +
  // data atomically (one keep-centre nudge, one rotation step).
  const { updateNode, updateNodeData } = useReactFlow();

  // Pull rotation off `data` defensively. Pre-rotation saves have no
  // `rotation` key at all → treat as 0. A malformed value (e.g. someone
  // typed 45 in the JSON) also falls back to 0 rather than mounting a
  // broken state.
  const rotation: Rotation = isRotation(data.rotation) ? data.rotation : 0;
  const isHorizontal = rotation === 90 || rotation === 270;
  const wrapperW = isHorizontal ? SYMBOL_H : SYMBOL_W;
  const wrapperH = isHorizontal ? SYMBOL_W : SYMBOL_H;

  // Step in [0..3] for the rotation lookup table.
  const stepIdx = rotation / 90;
  const topHandlePosition = ROTATION_SEQUENCE[stepIdx];
  const bottomHandlePosition = ROTATION_SEQUENCE[(stepIdx + 2) % 4];

  // Mirror BaseNode's connected-handle tracking so a wire endpoint stays
  // visible when the node isn't hovered. `useNodeConnections` re-runs on
  // any edge add/remove touching this node, so the set stays in sync.
  const connections = useNodeConnections({ id });
  const connectedHandleIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of connections) {
      if (c.source === id && c.sourceHandle) set.add(c.sourceHandle);
      if (c.target === id && c.targetHandle) set.add(c.targetHandle);
    }
    return set;
  }, [connections, id]);

  // Shared handle styling — colored interior + dark ring + accent halo,
  // matching BaseNode so the two node families read as one system.
  const handleClassName = '!w-2.5 !h-2.5 !rounded-full !border';
  const handleStyle = {
    background: ACCENT,
    borderColor: 'var(--ink-900)',
    boxShadow: `0 0 0 1px rgba(255,255,255,0.1), 0 0 6px -1px ${ACCENT}`,
  };

  // Rotate by one quarter turn AND compensate position so the visual
  // centre of the symbol stays anchored. Without the position nudge,
  // swapping wrapper dimensions (50×130 ↔ 130×50) makes the switch
  // appear to jump 40 px in one axis on every click — disorienting
  // when wires were already attached. We compute the delta as half the
  // dimension change in each axis, applied OPPOSITE so the centre is
  // preserved (wrapper grows wider → position shifts left by Δw/2;
  // wrapper grows taller → position shifts up by Δh/2).
  //
  // Reading rotation from inside the updater (rather than the closure-
  // captured `rotation` above) makes back-to-back clicks compose
  // correctly: each invocation sees the live state and advances by
  // exactly one quarter turn. Closure-captured `rotation` would let
  // two fast clicks both target the same `(rotation + 90) % 360`,
  // applying the position nudge twice for one effective rotation.
  const onRotate = () => {
    updateNode(id, (n) => {
      const currRot: Rotation = isRotation(n.data.rotation) ? n.data.rotation : 0;
      const currIsHorizontal = currRot === 90 || currRot === 270;
      const currW = currIsHorizontal ? SYMBOL_H : SYMBOL_W;
      const currH = currIsHorizontal ? SYMBOL_W : SYMBOL_H;
      const newRot = ((currRot + 90) % 360) as Rotation;
      const newIsHorizontal = newRot === 90 || newRot === 270;
      const newW = newIsHorizontal ? SYMBOL_H : SYMBOL_W;
      const newH = newIsHorizontal ? SYMBOL_W : SYMBOL_H;
      const dx = (currW - newW) / 2;
      const dy = (currH - newH) / 2;
      return {
        position: { x: n.position.x + dx, y: n.position.y + dy },
        data: { ...n.data, rotation: newRot },
      };
    });
  };

  return (
    // Outer wrapper IS the (rotation-aware) symbol box — width and
    // height pinned to the wrapperW × wrapperH derived above so React
    // Flow measures the correct box for either orientation. The label
    // group below uses `position: absolute` to overflow to the right
    // without contributing to the measured size.
    //
    // `diagram-node` opts the handles into the canvas's scoped hover-to-
    // reveal CSS (same hook BaseNode uses), and is also where the
    // canvas-level CSS finds the rotate button to fade in on hover.
    // `overflow: visible` so the absolutely-positioned label, the
    // rotate button (positioned slightly outside the wrapper), and the
    // pivot-dot bleed past the SVG's left edge can all render without
    // being clipped.
    <div
      className="relative diagram-node"
      style={{
        width: wrapperW,
        height: wrapperH,
        borderRadius: 4,
        overflow: 'visible',
        // Selection: outer ring + ambient glow in the slate accent. Idle:
        // nothing — we want the symbol to read as ink on canvas. Transition
        // matches BaseNode for visual coherence across node types.
        boxShadow: selected
          ? `0 0 0 2px ${ACCENT}, 0 0 18px -2px ${ACCENT}66`
          : 'none',
        transition: 'box-shadow 140ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      }}
    >
      {/* Top handle — physical position depends on rotation. The id
          stays 'top' regardless: it identifies the SVG's logical "top"
          end so existing edges keep resolving across rotation changes
          (and across pre-rotation saves). */}
      <Handle
        type="source"
        position={topHandlePosition}
        id="top"
        // `data-connected` is read by the scoped CSS in DiagramCanvas —
        // connected handles opt out of the hover-to-reveal fade so the
        // wire endpoints stay visible at all times.
        data-connected={connectedHandleIds.has('top') ? 'true' : undefined}
        className={handleClassName}
        style={handleStyle}
      />

      {/*
        Rotated SVG container.

        We keep the SVG itself drawn in its native 50×130 frame (so all
        the geometry constants — top contact at y=44, lever tip at y=72
        — stay valid regardless of orientation) and rotate VIA CSS on
        this absolute-positioned wrapper, anchored to the wrapper's
        centre. The wrapper is sized to the (rotation-aware) wrapperW ×
        wrapperH, and the SVG box is centred + rotated to land its
        rotated bounds onto the wrapper bounds.

        `pointer-events: none` on the rotated container so the wrapper
        itself receives pointer events for node-drag (the SVG would
        otherwise eat the events with its rotated bounding box, which
        for non-square dimensions extends slightly past the wrapper at
        intermediate angles — though we only allow quarter-turns, so
        this is mostly belt-and-braces).
      */}
      <div
        style={{
          position: 'absolute',
          width: SYMBOL_W,
          height: SYMBOL_H,
          top: '50%',
          left: '50%',
          transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
          transformOrigin: 'center center',
          pointerEvents: 'none',
        }}
      >
        <svg
          width={SYMBOL_W}
          height={SYMBOL_H}
          viewBox={`0 0 ${SYMBOL_W} ${SYMBOL_H}`}
          // `overflow: visible` lets the pivot dot render past the SVG's
          // left edge — the dot is centered at x=3 with r=3.5, so it
          // extends to x=-0.5, which the default `overflow: hidden` on
          // outer <svg> elements would clip. We deliberately keep the
          // viewBox flush at 0 (rather than padding it leftward) so the
          // wire stub at x=25 remains on the SVG's centerline; that
          // centerline is what the top/bottom React Flow handles anchor
          // to (after rotation), and what the canvas's center-snap grid
          // aligns nodes by.
          //
          // Match the connector edge stroke tone so the switch reads as part
          // of the same wiring system rather than a foreground fixture in a
          // brighter ink. `currentColor` lets the SVG children inherit, so
          // we set it once on the <svg> instead of repeating per-element.
          // For PDF export, composeStageImage.ts swaps this to dark at
          // capture time alongside the edge stroke (data-switch-symbol is
          // the hook for that swap) — keeps editor and print views unified.
          overflow="visible"
          data-switch-symbol="true"
          style={{ color: 'rgba(255, 255, 255, 0.6)', display: 'block' }}
          fill="currentColor"
          stroke="currentColor"
        >
          {/* Top wire stub — from the top edge down to the top contact
              dot. The handle aligns with x=25 here (post-rotation) so an
              attached edge reads as a continuation of this line. */}
          <line
            x1={25}
            y1={4}
            x2={25}
            y2={44}
            strokeWidth={2}
            strokeLinecap="round"
            fill="none"
          />
          {/* Top contact dot — fixed contact at the bottom of the top wire. */}
          <circle cx={25} cy={44} r={3.5} />

          {/* Pivot dot — the lever's hinge. Pulled hard to the LEFT
              (x=3) so the lever leans noticeably outward from the wire
              column. Y is now BELOW the top contact (50 vs 44), which
              (a) shortens the lever by reducing its vertical span, and
              (b) keeps the diagonal well clear of the top contact dot
              (the lever's whole path stays under y≈50, so the top
              contact at y=44 is never crossed). */}
          <circle cx={3} cy={50} r={3.5} />

          {/* Lever — short ~45° diagonal from the pivot to where the
              bottom wire begins. Equal X and Y travel (22 px each)
              gives a clean 1:1 angle — reads as a deliberate
              open-position disconnect, not a wire that's just casually
              leaning over. No mid-stroke kink: one stroke into the
              bottom wire. */}
          <line
            x1={3}
            y1={50}
            x2={25}
            y2={72}
            strokeWidth={2}
            strokeLinecap="round"
            fill="none"
          />

          {/* Bottom wire stub — runs from where the lever lands down to
              the bottom edge of the symbol box, where the bottom handle
              sits. Longer than the top stub by design: it pairs with
              the short lever above to give the symbol a "short outward
              bend on a long vertical run" silhouette. */}
          <line
            x1={25}
            y1={72}
            x2={25}
            y2={126}
            strokeWidth={2}
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </div>

      {/* Bottom handle — physical position depends on rotation; id is
          stable as 'bottom' (the SVG's logical "bottom" end). */}
      <Handle
        type="source"
        position={bottomHandlePosition}
        id="bottom"
        data-connected={connectedHandleIds.has('bottom') ? 'true' : undefined}
        className={handleClassName}
        style={handleStyle}
      />

      {/* Rotate button — small circular control in the wrapper's top-
          right corner, revealed on hover/select via the canvas-scoped
          CSS (`.diagram-rotate-btn` selector in DiagramCanvas). Outside
          the wrapper bounds (-12 / -12) so it doesn't overlap the
          symbol or the editable label.

          `nodrag` opts out of React Flow's pointer-down → start-drag
          behaviour, so clicking the button never starts a node drag.
          We additionally stop propagation on the click handler — defence
          in depth in case `nodrag` is ever lifted upstream. */}
      <button
        type="button"
        className="diagram-rotate-btn nodrag"
        title="Rotate 90°"
        aria-label="Rotate 90°"
        onClick={(e) => {
          e.stopPropagation();
          onRotate();
        }}
        style={{
          position: 'absolute',
          top: -12,
          right: -12,
          width: 22,
          height: 22,
          borderRadius: 999,
          background: 'rgba(17, 17, 19, 0.92)',
          border: '1px solid var(--hairline)',
          color: 'var(--ink-100)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          padding: 0,
          boxShadow:
            '0 1px 0 rgba(255,255,255,0.04) inset, 0 4px 10px -4px rgba(0,0,0,0.6)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      >
        <RotateIcon />
      </button>

      {/* Editable name — floated to the right of the (rotation-aware)
          wrapper via `position: absolute` so it doesn't enlarge the
          measured box. Vertically centred against the wrapper via
          50%/-50% so the label stays beside the symbol's midline in
          both vertical and horizontal orientations.

          No type caption: the schematic glyph itself already announces
          "this is a switch". The text field is only the user-supplied
          identifier (e.g. "DC isolator 1"). */}
      <div
        className="outline-none cursor-text"
        style={{
          position: 'absolute',
          // 8 px breathing room past the wrapper's right edge so the
          // label flows outward in either orientation. Using wrapperW
          // (not SYMBOL_W) means the label correctly tracks the wider
          // horizontal box at rotation 90/270.
          left: wrapperW + 8,
          top: '50%',
          transform: 'translateY(-50%)',
          fontFamily: "'Geist', ui-sans-serif, system-ui, sans-serif",
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: '-0.005em',
          color: 'var(--ink-50)',
          lineHeight: 1.25,
          // Min-width gives short / empty labels a sensible click target
          // so users can re-enter the field even after deleting all text.
          minWidth: 60,
          whiteSpace: 'nowrap',
        }}
        contentEditable
        // contentEditable footgun: managing this as React state causes
        // caret jumps every keystroke. Let the DOM own it; sync on blur.
        suppressContentEditableWarning
        onBlur={(e) =>
          updateNodeData(id, { label: e.currentTarget.textContent ?? data.label })
        }
      >
        {data.label}
      </div>
    </div>
  );
}
