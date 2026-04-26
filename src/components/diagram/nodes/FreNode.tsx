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
// FreNode — Frequency Relay / ESS controller.
//
// Drawn as a wireless control device with a small LCD, an embedded
// mini-switch glyph, two control buttons, and a stub antenna with
// radio-wave curves. "FRE" is written into the display, so the device
// is self-labelling (no separate type caption). The editable name
// (data.label) floats absolutely to the right of the symbol so it
// doesn't enlarge the wrapper — keeping the symbol on DiagramCanvas's
// center-snap grid (same trick SwitchNode uses).
//
// Visual hierarchy and stroke weights are tuned to read as a polished
// device illustration rather than a hand sketch:
//
//   2.0 px → case body outline (the "frame")
//   1.5 px → display, buttons, mini-switch glyph, pins
//   1.25 px → radio-wave arcs (decorative, lighter so they recede)
//
// Subtle fills on the case and display — barely perceptible but
// enough to give the device material depth without being a distinct
// colour against the dark canvas:
//
//   case   → rgba(255,255,255,0.02)  (ghosted highlight)
//   display→ rgba(0,0,0,0.30)        (recessed screen well)
//
// SVG layout (viewBox 160 × 84, centerline at x=80, antenna drawn at
// negative Y above the wrapper via `overflow: visible`):
//
//                  ((  )(  ))           ← y < 0  ← waves
//                   (  ▮  )             ← y < 0  ← mast
//                      ●                ← y < 0  ← tip cap
//           ┌─────────────────────┐  ← y=0   wrapper top
//           │ ●  ┌─────────────┐  │
//           │ │  │             │  │
//   ── pin ◄┤ ●  │     FRE     │  ├► pin ──   y=42 (h/2 = wrapper
//           │  ╲ │             │  │           center = case midline)
//           │   ╲└─────────────┘  │
//           │    ◯           ◯    │     ← control buttons
//           └─────────────────────┘  ← y=84  wrapper bottom
//
// Wrapper measures exactly the case body. Antenna content lives
// above it (y<0); the editable label lives to the right of it (via
// `position: absolute` on the wrapper). Both are visual extras that
// don't grow the measured box — the case body alone defines the
// snap-to-grid footprint.
// ────────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';
import { Handle, Position, useNodeConnections, useReactFlow } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import type { DiagramNodeData } from '../../../types';

type FreNodeType = Node<DiagramNodeData, 'fre'>;

// Violet accent — kept from the BaseNode era. Surfaces in the
// selection ring + the connection-pin dots so the FRE retains its
// "control / electronic" identity colour next to the inverter (blue).
const ACCENT = '#8b5cf6';

// Wrapper dimensions: just the case body + the side stubs (no
// vertical room for the antenna). Antenna is drawn at NEGATIVE Y in
// the SVG and rendered with `overflow: visible`, so it sits visually
// above the wrapper without growing the measured box.
//
// Why this matters for grid alignment:
//   DiagramCanvas snaps node CENTERS to an 11 px grid. Chip nodes have
//   their side handles on the wrapper's centerline (handle Y =
//   centerY), so a chip's pin Y is always on the snap grid. For the
//   FRE's pin to land on the same grid (so a horizontal connection to
//   a chip is straight), PIN_Y must equal the wrapper's centerY —
//   i.e. PIN_Y = SYMBOL_H / 2. The earlier 160×140 wrapper with the
//   antenna inside put the case midline at y=86 against a wrapper
//   center at y=70: a 16 px offset that no integer multiple of 11
//   could erase. Wrapper-equals-case-body fixes it: PIN_Y = 42 = h/2,
//   and dropping the FRE on the same row as a chip lines pins up
//   exactly.
const SYMBOL_W = 160;
const SYMBOL_H = 84;

// Connection-pin Y position (relative to wrapper top). Sits on the
// wrapper centerline = the case body midline = SYMBOL_H/2. One pin
// per side reads as a clean, single-channel I/O — appropriate for
// the controller's role in the diagram (one upstream rail in, one
// downstream rail out).
const PIN_Y = SYMBOL_H / 2;

export default function FreNode({ id, data, selected }: NodeProps<FreNodeType>) {
  const { updateNodeData } = useReactFlow();

  // Track which handles currently carry an edge so we can keep their
  // pin dots visible regardless of hover state. Same pattern the chip
  // nodes (BaseNode) and SwitchNode use; the canvas-scoped CSS opts
  // `data-connected="true"` handles out of the hover-fade.
  const connections = useNodeConnections({ id });
  const connectedHandleIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of connections) {
      if (c.source === id && c.sourceHandle) set.add(c.sourceHandle);
      if (c.target === id && c.targetHandle) set.add(c.targetHandle);
    }
    return set;
  }, [connections, id]);

  // Shared handle styling — colored interior + dark ring + accent
  // halo. Matches the rest of the diagram so connection pins read as
  // one system across node families.
  const handleClassName = '!w-2.5 !h-2.5 !rounded-full !border';
  const handleStyle = {
    background: ACCENT,
    borderColor: 'var(--ink-900)',
    boxShadow: `0 0 0 1px rgba(255,255,255,0.1), 0 0 6px -1px ${ACCENT}`,
  };

  return (
    // Wrapper IS the symbol box; width/height pinned to the SYMBOL
    // constants so React Flow measures `SYMBOL_W × SYMBOL_H`. The
    // editable name floats out via `position: absolute` so it doesn't
    // grow the wrapper — keeps the symbol's centerline on the snap grid.
    //
    // `diagram-node` opts the handles into the canvas's hover-to-reveal
    // CSS. `overflow: visible` so radio-wave curves and the absolute
    // label can render past the wrapper bounds without being clipped.
    <div
      className="relative diagram-node"
      style={{
        width: SYMBOL_W,
        height: SYMBOL_H,
        borderRadius: 8,
        overflow: 'visible',
        boxShadow: selected
          ? `0 0 0 2px ${ACCENT}, 0 0 18px -2px ${ACCENT}66`
          : 'none',
        transition: 'box-shadow 140ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      }}
    >
      {/* Two connection handles — one per side, anchored at PIN_Y.
          Stable ids ('left' / 'right') so persisted edges identify
          which side they're pinned to. */}
      <Handle
        type="source"
        position={Position.Left}
        id="left"
        data-connected={connectedHandleIds.has('left') ? 'true' : undefined}
        className={handleClassName}
        style={{ ...handleStyle, top: PIN_Y }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        data-connected={connectedHandleIds.has('right') ? 'true' : undefined}
        className={handleClassName}
        style={{ ...handleStyle, top: PIN_Y }}
      />

      <svg
        width={SYMBOL_W}
        height={SYMBOL_H}
        viewBox={`0 0 ${SYMBOL_W} ${SYMBOL_H}`}
        // The whole symbol inks in `--fre-ink`: a light violet on the
        // dark canvas, swapped to a deep violet under [data-pdf-export]
        // so the printed PDF gets readable contrast on white paper.
        // The token is defined in index.css alongside the other
        // design-system colors. `currentColor` then cascades to every
        // per-element stroke / fill below.
        //
        // `overflow: visible` is critical — the antenna assembly is
        // drawn at NEGATIVE Y values (above the SVG/viewBox top) so it
        // sits visually above the wrapper without growing the wrapper.
        // That keeps the wrapper centerline = case midline = pin Y, so
        // the FRE snaps onto the same grid columns as the chip nodes.
        overflow="visible"
        style={{ color: 'var(--fre-ink)', display: 'block' }}
      >
        {/* ── Antenna assembly (drawn ABOVE the wrapper) ──────────────
            All Y coords are negative: the SVG's overflow:visible lets
            them render above the case. Drawn first so the case body
            painted afterwards cleanly covers the mast's footing at y=0
            without leaving a stroke seam. */}

        {/* Outer wave pair — wider sweep, the "signal radiating out"
            silhouette. Compact 26 px span clustered at the top of the
            antenna so the arcs read as transmitting out of the tip. */}
        <path
          d="M 66 -40 Q 54 -27, 66 -14"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M 94 -40 Q 106 -27, 94 -14"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinecap="round"
          fill="none"
        />

        {/* Inner wave pair — tighter to the mast, shorter span. Same
            vertical centerline as the outer pair so all four arcs
            share an axis of symmetry. */}
        <path
          d="M 72 -36 Q 66 -27, 72 -18"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M 88 -36 Q 94 -27, 88 -18"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinecap="round"
          fill="none"
        />

        {/* Antenna mast — filled rectangle. Sits dead-centre on the
            case top edge (y=0) and rises 30 px above it. */}
        <rect
          x={78.5}
          y={-30}
          width={3}
          height={30}
          rx={1.5}
          ry={1.5}
          fill="currentColor"
        />
        {/* Tip cap — small filled dot capping the mast. */}
        <circle cx={80} cy={-32} r={2.5} fill="currentColor" />

        {/* ── Pins (input/output rails) ──────────────────────────────
            One stub on each side, from the wrapper's outer edge to
            the case body. Pin tip = handle anchor (PIN_Y = h/2). */}
        <line
          x1={0}
          y1={PIN_Y}
          x2={20}
          y2={PIN_Y}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
        <line
          x1={140}
          y1={PIN_Y}
          x2={SYMBOL_W}
          y2={PIN_Y}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        />

        {/* ── Case body ──────────────────────────────────────────────
            120 × 84 rounded rectangle filling the wrapper vertically
            (y=0..84) and inset 20 px on each side for the pin stubs.
            Filled via `--fre-bg` so the case reads as a solid surface
            (and the same fill that's on the display below). */}
        <rect
          x={20}
          y={0}
          width={120}
          height={84}
          rx={10}
          ry={10}
          stroke="currentColor"
          strokeWidth={2}
          fill="var(--fre-bg)"
        />

        {/* ── LCD display ────────────────────────────────────────────
            Centred horizontally inside the case, with the left side
            reserved for the embedded switch glyph. Same `--fre-bg`
            fill as the case body so the device reads as one filled
            object. */}
        <rect
          x={58}
          y={16}
          width={64}
          height={44}
          rx={5}
          ry={5}
          stroke="currentColor"
          strokeWidth={1.5}
          fill="var(--fre-bg)"
        />

        {/* "FRE" centered inside the display. Geist 18/700 with
            letter-spacing reads as a printed display legend. */}
        <text
          x={90}
          y={38}
          textAnchor="middle"
          dominantBaseline="central"
          fill="currentColor"
          style={{
            fontFamily: "'Geist', ui-sans-serif, system-ui, sans-serif",
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: '0.1em',
          }}
        >
          FRE
        </text>

        {/* ── Embedded mini-switch glyph ─────────────────────────────
            On the case's left flank, between the body's left edge and
            the display. Compact version of SwitchNode's geometry. */}
        {/* top wire stub */}
        <line
          x1={38}
          y1={16}
          x2={38}
          y2={28}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
        {/* top contact dot */}
        <circle cx={38} cy={28} r={2} fill="currentColor" />
        {/* pivot dot — offset down-and-LEFT of the top contact */}
        <circle cx={30} cy={38} r={2} fill="currentColor" />
        {/* lever — short ~45° diagonal */}
        <line
          x1={30}
          y1={38}
          x2={44}
          y2={56}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
        {/* bottom wire stub */}
        <line
          x1={44}
          y1={56}
          x2={44}
          y2={72}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        />

        {/* ── Control buttons ────────────────────────────────────────
            Two outlined circles along the case bottom, just below the
            display. Symmetric on either side of the centerline. */}
        <circle
          cx={75}
          cy={73}
          r={4}
          stroke="currentColor"
          strokeWidth={1.5}
          fill="none"
        />
        <circle
          cx={105}
          cy={73}
          r={4}
          stroke="currentColor"
          strokeWidth={1.5}
          fill="none"
        />
      </svg>

      {/* Editable name — same absolute-positioned pattern as
          SwitchNode. No type caption: "FRE" inside the display is the
          type indicator. This field is for the user's identifier
          (e.g. "FRE 01" or a vendor model number). */}
      <div
        className="outline-none cursor-text"
        style={{
          position: 'absolute',
          left: SYMBOL_W + 8,
          top: '50%',
          transform: 'translateY(-50%)',
          fontFamily: "'Geist', ui-sans-serif, system-ui, sans-serif",
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: '-0.005em',
          color: 'var(--ink-50)',
          lineHeight: 1.25,
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
