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
// BaseNode — shared visual shell for every electrical-block-diagram node.
//
// Every node type (SolarGenerator, Inverter, Switch, Fuse, Battery, FRE,
// GridOutput) renders the same card: a dark chip with an accent-colored
// swatch in the top-left (icon + type label in JetBrains Mono), a
// hairline divider, and a contentEditable body label. The only per-type
// variation is the accent color and the icon — those come in as props.
// Keeping one component means one place to fix spacing / shadows /
// handle positioning.
//
// Aesthetic notes:
//   An earlier revision used full colored header bands (amber / red /
//   emerald) which made the diagram read as a rainbow child's toy against
//   the app's restrained Raycast-inspired chrome. The intermediate
//   paper-white card fixed the rainbow but fought the dark surround. The
//   current form is a dark chip (--ink-800 gradient) with the node's
//   identity color showing as both a 22×22 filled accent swatch top-left
//   AND a 3px left-edge rule, so selection and type are unambiguous from
//   a glance while the chip melts into the app's near-black chrome.
//
// Why four handles per side as `source`:
//   React Flow models edges as source→target, but for our block diagram the
//   direction of power flow is what matters visually, not which side is the
//   "source handle" in the JSX. By giving every node four source handles on
//   all four sides we let the user drag an edge FROM any side of ANY node,
//   and React Flow will still snap the edge to the nearest handle on the
//   target node. Using source-only handles (instead of mixing source+target)
//   avoids the common footgun where a node refuses to accept incoming
//   connections because the handle was typed `source` but the user grabbed
//   from a `target`-typed sibling handle.
//
// Why `useReactFlow().updateNodeData`:
//   The label is edited in place via contentEditable. React Flow v12 exposes
//   `updateNodeData(id, patch)` from the `useReactFlow` hook specifically for
//   this case — it merges the patch into the node's `data` and triggers the
//   normal React Flow render pipeline, so the change shows up in `onNodesChange`
//   and propagates to whoever owns the nodes state (the diagram store, later).
// ────────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';
import { Handle, Position, useNodeConnections, useReactFlow } from '@xyflow/react';
import type { DiagramNodeData } from '../../../types';
import { useDiagramSymbolStyle } from '../symbolStyle';
import { IEC_GLYPH_SIZE, type IecGlyph } from './IecSymbols';

interface BaseNodeProps {
  id: string;
  data: DiagramNodeData;
  selected?: boolean;
  /** Identity color — the accent swatch + left bar + selection ring. */
  color: string;
  /** Type label shown in the accent swatch row (e.g., "SOLARGENERATOR"). */
  typeLabel: string;
  /** SVG icon rendered in the accent swatch — the type-specific iconography. */
  icon: React.ReactNode;
  /** IEC 60617 symbol drawn instead of the chip in the 'iec' symbol style
   *  (export only, ADR-020). */
  iecGlyph: IecGlyph;
  /** Extra designation line above the label in the IEC style — for nodes
   *  whose header carries a user-given name (the inverter's name) rather
   *  than a generic type caption the symbol already conveys. */
  iecDesignation?: string;
}

// Four handles — one on each side. All typed as `source` so users can drag
// edges from any side of the node (React Flow auto-snaps to the nearest
// handle on the target node). Stable ids ('top'/'right'/'bottom'/'left')
// so persisted edges can pin to a specific side if we ever want to.
const HANDLES = [
  { pos: Position.Top, id: 'top' },
  { pos: Position.Right, id: 'right' },
  { pos: Position.Bottom, id: 'bottom' },
  { pos: Position.Left, id: 'left' },
];

export default function BaseNode({
  id,
  data,
  selected,
  color,
  typeLabel,
  icon,
  iecGlyph,
  iecDesignation,
}: BaseNodeProps) {
  const { updateNodeData } = useReactFlow();
  const iec = useDiagramSymbolStyle() === 'iec';

  // Which of our four handles currently have an edge attached. Handles in
  // this set stay visible regardless of hover state — the CSS below keys
  // off the `data-connected` attribute to opt out of the default fade.
  // `useNodeConnections` re-runs whenever any edge touching this node
  // changes, so connects/disconnects update without manual wiring.
  const connections = useNodeConnections({ id });
  const connectedHandleIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of connections) {
      if (c.source === id && c.sourceHandle) set.add(c.sourceHandle);
      if (c.target === id && c.targetHandle) set.add(c.targetHandle);
    }
    return set;
  }, [connections, id]);

  return (
    // `diagram-node` is a CSS hook — scoped rules in DiagramCanvas hide
    // the connection handles by default and reveal them on hover/select,
    // so idle nodes read as clean chips without dangling pins.
    <div
      className="relative diagram-node"
      // IEC style: the chip turns into an invisible sizer (below) so the
      // node keeps EXACTLY the same box — same handle positions, same
      // edge routing, same snap-grid centre — and only the drawing
      // changes. No chip paint: transparent fill, transparent 1px border
      // (kept so the box doesn't shrink by 2 px), no accent shadow.
      style={iec ? {
        minWidth: 156,
        border: '1px solid transparent',
        borderRadius: 6,
      } : {
        // Dark chip body, lifted two steps above the --ink-950 surround
        // (roughly --ink-600 → --ink-700 gradient, fully opaque) so the
        // node reads as a distinct card rather than a ghost on the canvas.
        // The earlier --ink-800 tone at 95% alpha blended too far into the
        // atmospheric background; opacity + a brighter mid-value fixes the
        // contrast without leaving the palette.
        background: 'linear-gradient(180deg, #2d2d32 0%, #1e1e22 100%)',
        minWidth: 156,
        // Brighter 1px outline in the --hairline-strong palette bumped up
        // to ~15% alpha so the chip's edge is visible against the dark
        // surround. Paired with the 3px accent bar on the left edge, the
        // node now has both a chromatic and a tonal handhold.
        border: '1px solid rgba(255,255,255,0.16)',
        borderRadius: 6,
        boxShadow: selected
          ? // When selected: outer 2px ring in the node's own accent plus an
            // ambient colored glow, so the selection signal is unambiguous
            // against neighbouring chips.
            `inset 3px 0 0 0 ${color}, 0 0 0 2px ${color}, 0 0 18px -2px ${color}66, 0 8px 22px -8px rgba(0,0,0,0.7)`
          : // Idle: accent left bar + a subtle cool drop shadow for depth.
            `inset 3px 0 0 0 ${color}, 0 1px 0 rgba(0,0,0,0.5), 0 8px 20px -12px rgba(0,0,0,0.7)`,
        transition: 'box-shadow 140ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      }}
    >
      {HANDLES.map(({ pos, id: hid }) => (
        <Handle
          key={hid}
          type="source"
          position={pos}
          id={hid}
          // `data-connected` is read by the scoped CSS in DiagramCanvas —
          // connected handles opt out of the hover-to-reveal fade so the
          // wire endpoints stay visible at all times.
          data-connected={connectedHandleIds.has(hid) ? 'true' : undefined}
          // Tailwind `!` = important, needed to override React Flow's default
          // handle styles which ship as inline styles in the library CSS.
          // Colored interior + thin dark ring + a soft outer halo in the
          // accent hue — reads as an illuminated pin against the dark chip.
          className="!w-2.5 !h-2.5 !rounded-full !border"
          style={{
            background: color,
            borderColor: 'var(--ink-900)',
            boxShadow: `0 0 0 1px rgba(255,255,255,0.1), 0 0 6px -1px ${color}`,
          }}
        />
      ))}

      {iec && (
        <IecOverlay
          glyph={iecGlyph}
          connected={connectedHandleIds}
          designation={iecDesignation}
          label={data.label}
          sublabel={data.sublabel}
        />
      )}

      {/* Chip content. In IEC style it stays laid out but invisible: it is
          what gives the node its (label-dependent) size. visibility:hidden
          also keeps it out of the PDF text-extraction pass. */}
      <div style={iec ? { visibility: 'hidden' } : undefined}>
      {/* Header row — small accent swatch (icon) + JetBrains Mono type label.
          Hairline separator below. Sits inside the 3px left-bar rule. */}
      <div
        className="flex items-center gap-2 pl-3.5 pr-3 pt-2.5 pb-2"
        style={{ borderBottom: '1px solid var(--hairline)' }}
      >
        <span
          className="flex items-center justify-center shrink-0"
          style={{
            width: 22,
            height: 22,
            borderRadius: 4,
            background: color,
            color: '#ffffff',
            // Tiny inner highlight so the swatch reads as inked, not painted.
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.25), 0 1px 2px rgba(0,0,0,0.35)',
          }}
        >
          {icon}
        </span>
        <span
          className="uppercase"
          style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 9.5,
            fontWeight: 600,
            letterSpacing: '0.14em',
            color: 'var(--ink-300)',
          }}
        >
          {typeLabel}
        </span>
      </div>

      {/* Body — user-editable label + optional sublabel (specs/counts/etc.). */}
      <div className="pl-3.5 pr-3 py-2.5">
        <div
          className="outline-none cursor-text"
          style={{
            fontFamily: "'Geist', ui-sans-serif, system-ui, sans-serif",
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: '-0.005em',
            color: 'var(--ink-50)',
            lineHeight: 1.25,
          }}
          contentEditable
          // Suppress React's warning: we intentionally manage this subtree
          // outside React (contentEditable writes directly to the DOM) and
          // only sync back on blur. The alternative — controlling it with
          // state — causes caret-jumping on every keystroke, which is the
          // well-known React contentEditable footgun.
          suppressContentEditableWarning
          onBlur={(e) =>
            updateNodeData(id, { label: e.currentTarget.textContent ?? data.label })
          }
        >
          {data.label}
        </div>
        {data.sublabel && (
          <div
            className="mt-1"
            style={{
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 10,
              fontWeight: 400,
              letterSpacing: '0.02em',
              color: 'var(--ink-400)',
              fontFeatureSettings: '"tnum", "zero"',
            }}
          >
            {data.sublabel}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

/**
 * IEC-style drawing for a chip node: the symbol centred in the node box,
 * conductor stubs from every CONNECTED handle (box edge midpoint) to the
 * symbol, and the designation to the right of the symbol — label above the
 * horizontal centre line, sublabel below it, so a wire entering from the
 * right runs between them instead of through the text. Diagrams mostly
 * flow top → bottom, which keeps the right-hand side free for text.
 *
 * Stubs are CSS boxes (not SVG lines) because their length depends on the
 * node's measured size, which `calc()` can express and SVG attributes can't.
 */
function IecOverlay({
  glyph: Glyph,
  connected,
  designation,
  label,
  sublabel,
}: {
  glyph: IecGlyph;
  connected: ReadonlySet<string>;
  designation?: string;
  label: string;
  sublabel?: string;
}) {
  const half = IEC_GLYPH_SIZE / 2;
  // React Flow ends an edge at the handle's OUTER edge, and the 10 px
  // handle is centred on the box edge, so the wire stops 5 px outside the
  // box. Stubs start there so wire and stub meet without a gap.
  const H = 5;
  const stub = `calc(50% - ${half - H}px)`;
  const W = 2; // matches the edge strokeWidth
  // Axial symbols (fuse, battery) lie along the wiring: horizontal when
  // the node is only wired from the sides.
  const horizontal =
    (connected.has('left') || connected.has('right')) &&
    !connected.has('top') &&
    !connected.has('bottom');
  const line: React.CSSProperties = { position: 'absolute', background: 'currentColor' };
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0, // the padding box — the frame React Flow positions handles in
        pointerEvents: 'none',
        color: 'var(--iec-ink)',
      }}
    >
      {connected.has('top') && (
        <div style={{ ...line, left: `calc(50% - ${W / 2}px)`, top: -H, width: W, height: stub }} />
      )}
      {connected.has('bottom') && (
        <div style={{ ...line, left: `calc(50% - ${W / 2}px)`, bottom: -H, width: W, height: stub }} />
      )}
      {connected.has('left') && (
        <div style={{ ...line, top: `calc(50% - ${W / 2}px)`, left: -H, height: W, width: stub }} />
      )}
      {connected.has('right') && (
        <div style={{ ...line, top: `calc(50% - ${W / 2}px)`, right: -H, height: W, width: stub }} />
      )}
      <div
        style={{
          position: 'absolute',
          left: `calc(50% - ${half}px)`,
          top: `calc(50% - ${half}px)`,
          width: IEC_GLYPH_SIZE,
          height: IEC_GLYPH_SIZE,
        }}
      >
        <Glyph horizontal={horizontal} />
      </div>
      <div
        style={{
          position: 'absolute',
          left: `calc(50% + ${half + 6}px)`,
          bottom: 'calc(50% + 3px)',
          whiteSpace: 'nowrap',
          fontFamily: "'Geist', ui-sans-serif, system-ui, sans-serif",
          fontSize: 11,
          fontWeight: 600,
          lineHeight: 1.2,
          color: 'var(--ink-50)',
        }}
      >
        {designation && <div>{designation}</div>}
        <div style={designation ? { fontWeight: 400 } : undefined}>{label}</div>
      </div>
      {sublabel && (
        <div
          style={{
            position: 'absolute',
            left: `calc(50% + ${half + 6}px)`,
            top: 'calc(50% + 3px)',
            whiteSpace: 'nowrap',
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 9.5,
            lineHeight: 1.2,
            color: 'var(--ink-300)',
          }}
        >
          {sublabel}
        </div>
      )}
    </div>
  );
}
