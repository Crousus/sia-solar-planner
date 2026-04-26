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
// ConsumerNode — on-site electrical load (Verbraucher / household).
//
// Drawn as a free-floating house silhouette — same "no chip" treatment
// SwitchNode and FreNode use, so the symbol reads as schematic ink on
// the canvas rather than another labelled box. The wrapper measures
// exactly the symbol box; the editable name floats absolutely to the
// right via `position: absolute` so it never grows the wrapper —
// keeping the symbol's centerline on DiagramCanvas's center-snap grid
// (same trick FreNode documents). One pin per side at the wrapper
// centerline (PIN_Y = SYMBOL_H / 2) so a horizontal connection to a
// switch / fuse / FRE on the same row reads as a single straight wire.
//
// Geometry (viewBox 112 × 90, all px):
//
//                    ╱╲                        ← roof apex (centered)
//                   ╱  ╲ ▮▮                    ← chimney on the right slope
//                  ╱    ╲▮                     ← (notches into the slope —
//                 ╱      ╲                       only the visible top + sides
//          ┌─────╱        ╲─────┐                are stroked, the slope itself
//          │                     │               continues underneath)
//   ── pin │       ┌───┐         │ pin ──     ← y = PIN_Y (centerline)
//          │       │   │         │            ← door — U-opening at the
//          └───────┴───┴─────────┘              ground line (no top stroke;
//                                                ground line closes it)
//
// Simpler than the previous five-feature drawing (door + two paned
// windows): just the pentagon outline + a single door + a chimney.
// Stroke weight is 4 px on the main outline so the silhouette reads
// as schematic ink — heavier than the surrounding wiring, the way an
// electrician would draw a primary load symbol on a sketch. The
// chimney sits on the upper-right roof slope (asymmetric placement
// reads more like a real house than centered would).
// ────────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';
import { Handle, Position, useNodeConnections, useReactFlow } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import type { DiagramNodeData } from '../../../types';

type ConsumerNodeType = Node<DiagramNodeData, 'consumer'>;

// Rose accent — distinct from every other diagram color (amber solar,
// blue inverter, slate switch, red fuse, emerald battery, violet FRE,
// sky grid). Surfaces in the selection ring + connection-pin dots so
// the consumer keeps its identity hue alongside the chip nodes.
const ACCENT = '#f43f5e';

// Wrapper dimensions = the symbol's bounding box exactly. The label
// floats out to the right via `position: absolute` so it doesn't
// enlarge this measured box — that keeps the symbol's centerline (and
// therefore the side handles) on the canvas's center-snap grid.
const SYMBOL_W = 112;
const SYMBOL_H = 90;

// Connection-pin Y position — wrapper centerline = symbol vertical
// midpoint. One pin per side reads as a clean single-channel I/O,
// appropriate for the consumer's role as an inline load on the
// distribution rail (one feed in, no downstream pass-through).
const PIN_Y = SYMBOL_H / 2;

// House body geometry — extracted as constants so the wall stubs and
// the pin stubs share the same X coordinates and there's no chance of
// the wires "missing" the wall when one end gets nudged later.
const WALL_LEFT_X = 22;
const WALL_RIGHT_X = SYMBOL_W - WALL_LEFT_X; // 90
const ROOF_APEX_Y = 8;
const ROOF_EAVE_Y = 38;
const GROUND_Y = SYMBOL_H - 8; // 82 — 8 px breathing room above wrapper bottom

// Chimney — a small rectangle planted on the upper-right roof slope.
// Only the top edge + two side edges are stroked; the bottom is
// implicit because the roof line continues underneath. Asymmetric on
// the right (rather than centred) reads as a real chimney rather than
// a decorative ornament.
//
// Right roof slope runs from (SYMBOL_W/2, ROOF_APEX_Y) = (56, 8) to
// (WALL_RIGHT_X, ROOF_EAVE_Y) = (90, 38) — Δx=34, Δy=30. The chimney
// straddles x=68..76 (8 px wide). We compute where each side meets
// the slope so the strokes terminate exactly on the roof line:
//   slope(x) = ROOF_APEX_Y + (Δy/Δx) · (x − SYMBOL_W/2)
const CHIMNEY_LEFT_X = 68;
const CHIMNEY_RIGHT_X = 76;
const CHIMNEY_TOP_Y = 4;
const _slopeY = (x: number) =>
  ROOF_APEX_Y + ((ROOF_EAVE_Y - ROOF_APEX_Y) / (WALL_RIGHT_X - SYMBOL_W / 2)) * (x - SYMBOL_W / 2);
const CHIMNEY_LEFT_BASE_Y = _slopeY(CHIMNEY_LEFT_X);   // ≈ 21.4
const CHIMNEY_RIGHT_BASE_Y = _slopeY(CHIMNEY_RIGHT_X); // ≈ 28.5

// Door — narrow U-opening centred on the X midline, ~30% of the wall
// height. No top stroke at the ground line: the ground line itself
// closes the opening, so a "U" path is enough.
const DOOR_W = 16;
const DOOR_H = 24;
const DOOR_LEFT_X = SYMBOL_W / 2 - DOOR_W / 2;   // 48
const DOOR_RIGHT_X = SYMBOL_W / 2 + DOOR_W / 2;  // 64
const DOOR_TOP_Y = GROUND_Y - DOOR_H;            // 58

export default function ConsumerNode({ id, data, selected }: NodeProps<ConsumerNodeType>) {
  const { updateNodeData } = useReactFlow();

  // Mirror FreNode/SwitchNode/BaseNode connected-handle tracking so a
  // pin stays visible whenever it carries a wire, regardless of hover.
  // The canvas-scoped CSS opts handles with `data-connected="true"`
  // out of the hover-fade so wire endpoints never appear to float.
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
  // halo, matching the rest of the diagram so connection pins read as
  // one system across node families.
  const handleClassName = '!w-2.5 !h-2.5 !rounded-full !border';
  const handleStyle = {
    background: ACCENT,
    borderColor: 'var(--ink-900)',
    boxShadow: `0 0 0 1px rgba(255,255,255,0.1), 0 0 6px -1px ${ACCENT}`,
  };

  return (
    // Wrapper IS the symbol box; width/height pinned to SYMBOL_* so
    // React Flow measures `SYMBOL_W × SYMBOL_H`. The editable name
    // floats out via `position: absolute` so it doesn't grow the
    // wrapper — same snap-grid trick FreNode + SwitchNode use.
    //
    // `diagram-node` opts the handles into the canvas's hover-to-reveal
    // CSS. `overflow: visible` so the absolute label can render past
    // the wrapper bounds without being clipped.
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
      {/* Two connection handles — one per side, anchored at PIN_Y. The
          stable ids ('left' / 'right') let persisted edges identify
          which side they're pinned to across save/load round-trips. */}
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
        // Match the connector stroke tone so the house reads as part of
        // the same wiring system rather than a foreground fixture in a
        // brighter ink. `currentColor` lets every child inherit, so we
        // set it once on the <svg>. Same `data-switch-symbol` hook
        // SwitchNode + FreNode use isn't applied here — composeStageImage
        // doesn't need to swap this symbol's color for PDF export
        // because the consumer is rendered with `currentColor` inheriting
        // from the surrounding text color, which the PDF pipeline already
        // handles via [data-pdf-export] on the wrapper.
        overflow="visible"
        style={{ color: 'rgba(255, 255, 255, 0.7)', display: 'block' }}
      >
        {/* ── Pins (input/output rails) ──────────────────────────────
            One stub on each side, from the wrapper's outer edge into
            the wall. Pin tip = handle anchor (PIN_Y = h/2). Drawn
            FIRST so the wall outline painted afterwards covers the
            stub's seam at the wall coordinate cleanly. */}
        <line
          x1={0}
          y1={PIN_Y}
          x2={WALL_LEFT_X}
          y2={PIN_Y}
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        />
        <line
          x1={WALL_RIGHT_X}
          y1={PIN_Y}
          x2={SYMBOL_W}
          y2={PIN_Y}
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        />

        {/* ── Chimney ────────────────────────────────────────────────
            Open path (no bottom edge) — the roof slope drawn next
            paints right through the chimney's footprint, which gives
            the visual effect of a chimney emerging from the roof. The
            sides terminate exactly at the slope intersections so the
            joint reads as one continuous outline. Drawn BEFORE the
            house path so the house's heavy roof stroke sits on top
            of any sub-pixel overlap at the meeting point. */}
        <path
          d={`
            M ${CHIMNEY_LEFT_X} ${CHIMNEY_LEFT_BASE_Y}
            L ${CHIMNEY_LEFT_X} ${CHIMNEY_TOP_Y}
            L ${CHIMNEY_RIGHT_X} ${CHIMNEY_TOP_Y}
            L ${CHIMNEY_RIGHT_X} ${CHIMNEY_RIGHT_BASE_Y}
          `}
          stroke="currentColor"
          strokeWidth={4}
          strokeLinejoin="round"
          strokeLinecap="round"
          fill="none"
        />

        {/* ── House outline ──────────────────────────────────────────
            One closed pentagon: left wall up → roof apex → right
            wall down → ground line back to start. Drawn as a single
            path with rounded corners (linejoin=round + linecap=round)
            so the heavy 4 px stroke joins crisply at the eaves and
            the apex without producing miter spikes. No fill — the
            outline alone IS the silhouette, which matches the
            "schematic ink" treatment the user asked for (lighter the
            interior, heavier the line). */}
        <path
          d={`
            M ${WALL_LEFT_X} ${ROOF_EAVE_Y}
            L ${SYMBOL_W / 2} ${ROOF_APEX_Y}
            L ${WALL_RIGHT_X} ${ROOF_EAVE_Y}
            L ${WALL_RIGHT_X} ${GROUND_Y}
            L ${WALL_LEFT_X} ${GROUND_Y}
            Z
          `}
          stroke="currentColor"
          strokeWidth={4}
          strokeLinejoin="round"
          strokeLinecap="round"
          fill="none"
        />

        {/* ── Door ───────────────────────────────────────────────────
            U-shape (no top stroke at the ground line — the ground
            line itself closes the opening). Centered on the house's
            X midline. Stroked at 3 px so it sits as a clearly
            secondary feature against the 4 px main outline — keeps
            the eye on the house silhouette first, door second. */}
        <path
          d={`
            M ${DOOR_LEFT_X} ${GROUND_Y}
            L ${DOOR_LEFT_X} ${DOOR_TOP_Y}
            L ${DOOR_RIGHT_X} ${DOOR_TOP_Y}
            L ${DOOR_RIGHT_X} ${GROUND_Y}
          `}
          stroke="currentColor"
          strokeWidth={3}
          strokeLinejoin="round"
          strokeLinecap="round"
          fill="none"
        />
      </svg>

      {/* Editable name — same absolute-positioned pattern as
          FreNode + SwitchNode. No type caption inside the symbol:
          the house silhouette itself announces "consumer", and a
          stamped "CONSUMER" caption alongside the icon would print
          the type twice. The text field is the user's identifier
          (e.g. "Hauptverteilung" or "Workshop"). */}
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
