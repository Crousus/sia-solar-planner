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
// GridOutput) renders the same card: a rounded white body with a coloured
// header band (type icon + type label) and a contentEditable "label" + an
// optional sublabel. The only per-type variation is the accent colour, the
// type-label text, and the icon — those come in as props. Keeping one
// component means one place to fix spacing / shadows / handle positioning.
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
//   This works ONLY inside a `<ReactFlowProvider>`; that provider is mounted
//   by `DiagramCanvas` in a later task.
// ────────────────────────────────────────────────────────────────────────────

import { Handle, Position, useReactFlow } from '@xyflow/react';
import type { DiagramNodeData } from '../../../types';

interface BaseNodeProps {
  id: string;
  data: DiagramNodeData;
  selected?: boolean;
  /** Header background colour — the node's identity colour (amber, blue, …). */
  color: string;
  /** Text/icon colour in the header. Defaults to white; override for light headers. */
  textColor?: string;
  /** Type label shown in the header band (e.g., "Solargenerator"). */
  typeLabel: string;
  /** SVG icon rendered in the header — the type-specific iconography. */
  icon: React.ReactNode;
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
  textColor = 'white',
  typeLabel,
  icon,
}: BaseNodeProps) {
  const { updateNodeData } = useReactFlow();

  return (
    <div
      className={`rounded-xl bg-white shadow-md min-w-[140px] border-2 transition-shadow ${
        selected ? 'shadow-lg' : ''
      }`}
      style={{ borderColor: color }}
    >
      {HANDLES.map(({ pos, id: hid }) => (
        <Handle
          key={hid}
          type="source"
          position={pos}
          id={hid}
          // Tailwind `!` = important, needed to override React Flow's default
          // handle styles which ship as inline styles in the library CSS.
          className="!w-3 !h-3 !rounded-full !border-2 !border-white"
          style={{ background: color }}
        />
      ))}

      {/* Header band — colour-coded by node type, with icon + type label. */}
      <div
        className="rounded-t-[9px] px-2.5 py-1.5 flex items-center gap-1.5"
        style={{ background: color }}
      >
        <span style={{ color: textColor }} className="flex-shrink-0">
          {icon}
        </span>
        <span className="text-[11px] font-bold" style={{ color: textColor }}>
          {typeLabel}
        </span>
      </div>

      {/* Body — user-editable label + optional sublabel (specs/counts/etc.). */}
      <div className="px-2.5 py-2 text-xs text-slate-800">
        <div
          className="font-semibold outline-none cursor-text"
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
          <div className="text-slate-500 mt-0.5 text-[10px]">{data.sublabel}</div>
        )}
      </div>
    </div>
  );
}
