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
// EditableSmoothStepEdge — a smoothstep edge with an in-place editable label.
//
// Why a custom edge:
//   React Flow's built-in `label` prop renders uneditable text. For a
//   schematic we want to annotate wires with cross-section / voltage /
//   string number, edited without leaving the canvas. This component
//   renders the same smoothstep path React Flow ships with, then overlays
//   an HTML label via `EdgeLabelRenderer` (a portal that positions HTML
//   in diagram coordinates so it zooms/pans with the canvas).
//
// Editing:
//   Single-click to select (stops pointer-event propagation so the edge
//   is actually selectable). Double-click enters edit mode: the label
//   becomes contentEditable and auto-focuses. Blur or Enter commits the
//   new value via `useReactFlow().setEdges` — we write back to `edge.label`
//   which is the same field React Flow's built-in rendering reads. This
//   keeps the store schema simple (one string, not a nested data object).
//
// contentEditable footgun — handled:
//   Controlling a contentEditable div with React state causes caret jumps
//   on every keystroke. We manage the DOM ourselves (initial text from
//   props; subsequent writes unseen by React) and only sync back on commit.
//   Same pattern BaseNode.tsx uses for the node label.
// ────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  getStraightPath,
  useReactFlow,
  type EdgeProps,
} from '@xyflow/react';

export default function EditableSmoothStepEdge({
  id,
  sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  label,
  data,
  markerEnd,
  style,
  selected,
}: EdgeProps) {
  // Persistent label offset in flow-space pixels. Read from edge.data so
  // it round-trips through the store. Fallback to 0/0 for edges that
  // predate the feature.
  const offset = (data as { labelOffset?: { x: number; y: number } } | undefined)
    ?.labelOffset ?? { x: 0, y: 0 };
  // When source and target handles are colinear on one axis, smoothstep's
  // forced offset-out-then-turn geometry still emits two rounded corners
  // that land on top of the straight segment — the curve has nowhere to
  // go, so the arc renders as a visible glitch overlapping the line. Our
  // center-snap grid makes this the common case for aligned nodes. Detect
  // collinearity (within 0.5 flow-px — tight enough that genuine offsets
  // still smoothstep, loose enough to tolerate floating-point residue
  // from the snap math) and draw a plain straight edge instead.
  const ALIGNED_EPS = 0.5;
  const isColinear =
    Math.abs(sourceX - targetX) < ALIGNED_EPS ||
    Math.abs(sourceY - targetY) < ALIGNED_EPS;
  const [edgePath, labelX, labelY] = isColinear
    ? getStraightPath({ sourceX, sourceY, targetX, targetY })
    : // The smoothstep helper returns the path `d` string plus the geometric
      // midpoint, which we use to anchor the label. `borderRadius` matches
      // the value configured in DiagramCanvas' `defaultEdgeOptions.pathOptions`
      // — duplicated here because EdgeProps doesn't surface pathOptions to
      // custom edge renderers.
      getSmoothStepPath({
        sourceX, sourceY, targetX, targetY,
        sourcePosition, targetPosition,
        borderRadius: 8,
        // Default offset is 20 flow-px — smoothstep travels that far out of
        // each handle before turning. When two handles are closer than
        // ~2×offset (e.g. a fuse sitting directly below a generator), the
        // line has no room for the forced detour and S-curves instead of
        // drawing a clean straight segment. Dropping to a small value lets
        // short runs render as plain verticals/horizontals.
        offset: 5,
      });

  const { setEdges, getViewport } = useReactFlow();
  const [editing, setEditing] = useState(false);
  const editorRef = useRef<HTMLDivElement | null>(null);

  // Drag-to-reposition state. We track the last pointer position in screen
  // coords and convert deltas to flow coords by dividing by the current
  // zoom. This keeps the drag feel 1:1 with the cursor regardless of zoom
  // level. `dragRef` holds the live offset during the drag so React doesn't
  // re-render on every pointermove — we only commit to the store on
  // pointerup.
  const dragRef = useRef<{
    startX: number;
    startY: number;
    baseOffset: { x: number; y: number };
  } | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);

  const onLabelPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only left button; ignore right-click etc. so context menus still work.
      if (e.button !== 0) return;
      // Don't start a drag when the user is editing text — they need normal
      // text-selection gestures on the contentEditable.
      if (editing) return;
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseOffset: { ...offset },
      };
      setDragOffset({ ...offset });
    },
    [editing, offset],
  );

  const onLabelPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const zoom = getViewport().zoom || 1;
      const dx = (e.clientX - drag.startX) / zoom;
      const dy = (e.clientY - drag.startY) / zoom;
      setDragOffset({
        x: drag.baseOffset.x + dx,
        y: drag.baseOffset.y + dy,
      });
    },
    [getViewport],
  );

  const onLabelPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      dragRef.current = null;
      const final = dragOffset;
      setDragOffset(null);
      if (!final) return;
      // Skip tiny jitters (<1 flow-px) so a click doesn't commit a noise
      // offset and defeat the selection path.
      const moved =
        Math.abs(final.x - drag.baseOffset.x) > 1 ||
        Math.abs(final.y - drag.baseOffset.y) > 1;
      if (!moved) return;
      setEdges((eds) =>
        eds.map((edge) => {
          if (edge.id !== id) return edge;
          const prevData = (edge.data ?? {}) as Record<string, unknown>;
          return { ...edge, data: { ...prevData, labelOffset: final } };
        }),
      );
    },
    [dragOffset, id, setEdges],
  );

  // The offset actually used for rendering — drag state wins over the
  // persisted value while a drag is in progress so the user sees immediate
  // feedback without committing every pointermove to the store.
  const liveOffset = dragOffset ?? offset;

  // Focus + select-all when entering edit mode so the user can just start
  // typing to replace the existing label. Runs once per edit-mode entry.
  useEffect(() => {
    if (!editing || !editorRef.current) return;
    const el = editorRef.current;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editing]);

  const commit = useCallback(
    (next: string) => {
      // Trim so pure-whitespace edits round-trip to "no label" rather than
      // a blank chip floating on the wire.
      const trimmed = next.trim();
      setEdges((eds) =>
        eds.map((e) =>
          e.id === id ? { ...e, label: trimmed.length > 0 ? trimmed : undefined } : e,
        ),
      );
      setEditing(false);
    },
    [id, setEdges],
  );

  const labelText = typeof label === 'string' ? label : '';

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        {/* Absolute-positioned HTML at the edge midpoint. `pointer-events:
            all` is required because EdgeLabelRenderer's wrapper disables
            pointer events by default (so labels don't block edge picking).
            `nodrag nopan` prevents React Flow from interpreting drags on
            the label as canvas pans. */}
        <div
          className="nodrag nopan"
          onPointerDown={onLabelPointerDown}
          onPointerMove={onLabelPointerMove}
          onPointerUp={onLabelPointerUp}
          onPointerCancel={onLabelPointerUp}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX + liveOffset.x}px, ${labelY + liveOffset.y}px)`,
            pointerEvents: 'all',
            // Visibility rule — keeps the canvas clean but keeps labels
            // discoverable:
            //   - always visible when the edge has a label
            //   - always visible while editing
            //   - visible (as a placeholder) when the edge is selected,
            //     so single-click-then-double-click reveals the affordance
            //   - hidden otherwise
            // Net effect: unlabelled edges read as pure wires; clicking
            // one prompts "double-click to label me".
            opacity: labelText || editing || selected ? 1 : 0,
            transition: 'opacity 140ms cubic-bezier(0.2, 0.8, 0.2, 1)',
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {editing ? (
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              onBlur={(e) => commit(e.currentTarget.textContent ?? '')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.currentTarget as HTMLDivElement).blur();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  // Reset displayed text and cancel — write the original back
                  // into the DOM so the commit-on-blur doesn't fire with a
                  // half-typed string.
                  (e.currentTarget as HTMLDivElement).textContent = labelText;
                  setEditing(false);
                }
              }}
              style={chipStyle(selected, true)}
            >
              {labelText}
            </div>
          ) : (
            <div style={chipStyle(selected, false)}>
              {labelText || <span style={{ opacity: 0.55 }}>double-click</span>}
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

// Chip visual — a small dark pill on the edge. `editable` swaps in a
// brighter ink color + subtle outline to read as an active input.
function chipStyle(selected: boolean | undefined, editable: boolean): React.CSSProperties {
  return {
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: '0.02em',
    color: editable ? 'var(--ink-50)' : 'var(--ink-100)',
    background: 'rgba(17, 17, 19, 0.9)',
    padding: '2px 6px',
    borderRadius: 4,
    border: `1px solid ${
      editable
        ? 'rgba(255,255,255,0.28)'
        : selected
          ? 'var(--sun-400)'
          : 'rgba(255,255,255,0.14)'
    }`,
    boxShadow: '0 2px 6px -2px rgba(0,0,0,0.6)',
    outline: 'none',
    // `grab` signals the chip is draggable when idle; `text` takes over
    // while editing so the caret affordance matches the actual interaction.
    cursor: editable ? 'text' : 'grab',
    userSelect: editable ? 'text' : 'none',
    whiteSpace: 'nowrap',
  };
}
