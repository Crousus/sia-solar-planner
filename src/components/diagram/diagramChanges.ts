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
// diagramChanges — splits React Flow's change stream into PERSISTENT edits
// (go to the Zustand store → localStorage → JSON patch → every collaborator)
// and EPHEMERAL view state (stays in DiagramCanvas's local React state).
//
// Why: DiagramCanvas used to pipe `applyNodeChanges(changes, nodes)` straight
// into `setDiagramNodes`. React Flow's change stream is chatty and carries
// per-viewer fields:
//   - `select`      → `selected: true` landed in project.diagram, so
//                     clicking a node in tab A selected it in tab B, and
//                     every click produced a server patch.
//   - `dimensions`  → `measured: {width, height}` was persisted & synced on
//                     every mount / font-load / re-measure.
//   - `position` (dragging) → one store write + sync patch per pointermove
//                     frame, and `dragging: true` was persisted mid-drag.
// The reducer below keeps all of those local and only reports a new
// persistent node array for real document edits: drag END (or a
// non-drag move such as keyboard nudges), add, remove, and replace
// (data edits via useReactFlow().updateNodeData / updateNode / setEdges).
//
// Pure functions only — no React — so the routing rules are unit-testable.
// ────────────────────────────────────────────────────────────────────────────

import { applyNodeChanges, applyEdgeChanges, type NodeChange, type EdgeChange } from '@xyflow/react';
import type { DiagramNode, DiagramEdge } from '../../types';

/** Keys React Flow writes onto node objects that describe THIS viewer's
 *  interaction state, not the document. Never persisted. */
const NODE_TRANSIENT_KEYS = ['selected', 'dragging', 'measured', 'resizing', 'internals', 'positionAbsolute'] as const;
/** Same for edges. */
const EDGE_TRANSIENT_KEYS = ['selected'] as const;

/** Return `node` without React-Flow-only runtime fields. Same reference when
 *  there is nothing to strip, so unchanged nodes keep their identity. */
export function stripNodeTransient<T extends object>(node: T): T {
  const rec = node as Record<string, unknown>;
  if (!NODE_TRANSIENT_KEYS.some((k) => k in rec)) return node;
  const out: Record<string, unknown> = { ...rec };
  for (const k of NODE_TRANSIENT_KEYS) delete out[k];
  return out as T;
}

/** Edge counterpart of stripNodeTransient. */
export function stripEdgeTransient<T extends object>(edge: T): T {
  const rec = edge as Record<string, unknown>;
  if (!EDGE_TRANSIENT_KEYS.some((k) => k in rec)) return edge;
  const out: Record<string, unknown> = { ...rec };
  for (const k of EDGE_TRANSIENT_KEYS) delete out[k];
  return out as T;
}

/** Per-viewer node state kept outside the store. Immutable snapshots so the
 *  component can hold it in useState and memo on identity. */
export interface NodeEphemeral {
  selected: ReadonlySet<string>;
  measured: ReadonlyMap<string, { width: number; height: number }>;
  /** Live positions of nodes mid-drag (already center-snapped). */
  dragging: ReadonlyMap<string, { x: number; y: number }>;
}

export const EMPTY_NODE_EPHEMERAL: NodeEphemeral = {
  selected: new Set(),
  measured: new Map(),
  dragging: new Map(),
};

/**
 * Snap a node's CENTER (not its top-left) to `grid`, using its measured
 * size. Nodes differ in size (an inverter card vs. a fuse chip), and React
 * Flow's built-in snapToGrid locks the top-left corner, so centres of
 * differently-sized nodes never line up. Unmeasured nodes (w = h = 0)
 * degrade to plain top-left snapping.
 */
export function snapCenter(
  position: { x: number; y: number },
  size: { width: number; height: number } | undefined,
  grid: number,
): { x: number; y: number } {
  if (!(grid > 0)) return position;
  const w = size?.width ?? 0;
  const h = size?.height ?? 0;
  const cx = Math.round((position.x + w / 2) / grid) * grid;
  const cy = Math.round((position.y + h / 2) / grid) * grid;
  return { x: cx - w / 2, y: cy - h / 2 };
}

/**
 * Route a batch of React Flow node changes.
 *
 * Returns the next ephemeral state (same object if untouched) and either a
 * new persistent node array to hand to `setDiagramNodes`, or `null` when
 * the batch contained no document edits (selection / measure / mid-drag
 * only) — the caller must NOT write to the store in that case.
 */
export function reduceNodeChanges(
  storeNodes: DiagramNode[],
  eph: NodeEphemeral,
  changes: NodeChange[],
  snapGrid: number,
): { eph: NodeEphemeral; nodes: DiagramNode[] | null } {
  let selected: Set<string> | null = null;
  let measured: Map<string, { width: number; height: number }> | null = null;
  let dragging: Map<string, { x: number; y: number }> | null = null;
  const sel = () => (selected ??= new Set(eph.selected));
  const meas = () => (measured ??= new Map(eph.measured));
  const drag = () => (dragging ??= new Map(eph.dragging));
  const currentSelected = (): ReadonlySet<string> => selected ?? eph.selected;
  const currentMeasured = () => measured ?? eph.measured;
  const currentDragging = () => dragging ?? eph.dragging;

  const persistent: NodeChange[] = [];
  const storeById = new Map(storeNodes.map((n) => [n.id, n]));

  for (const c of changes) {
    switch (c.type) {
      case 'select':
        if (c.selected) sel().add(c.id);
        else sel().delete(c.id);
        break;
      case 'dimensions':
        if (c.dimensions) {
          const prev = currentMeasured().get(c.id);
          if (!prev || prev.width !== c.dimensions.width || prev.height !== c.dimensions.height) {
            meas().set(c.id, { width: c.dimensions.width, height: c.dimensions.height });
          }
        }
        break;
      case 'position': {
        const raw = c.position ?? currentDragging().get(c.id);
        const snapped = raw ? snapCenter(raw, currentMeasured().get(c.id), snapGrid) : undefined;
        if (c.dragging) {
          // Mid-drag: local only. React Flow renders from our merged nodes,
          // so the node still follows the cursor at 60 Hz.
          if (snapped) drag().set(c.id, snapped);
        } else {
          // Drag end (dragging === false) or a non-drag move (keyboard
          // nudge, programmatic). Commit once.
          if (currentDragging().has(c.id)) drag().delete(c.id);
          const stored = storeById.get(c.id);
          if (snapped && stored && (stored.position.x !== snapped.x || stored.position.y !== snapped.y)) {
            persistent.push({ type: 'position', id: c.id, position: snapped });
          }
        }
        break;
      }
      case 'remove':
        if (currentSelected().has(c.id)) sel().delete(c.id);
        if (currentMeasured().has(c.id)) meas().delete(c.id);
        if (currentDragging().has(c.id)) drag().delete(c.id);
        persistent.push(c);
        break;
      case 'add':
        persistent.push({ ...c, item: stripNodeTransient(c.item) });
        break;
      case 'replace':
        // updateNodeData / updateNode hand us the full node as React Flow
        // sees it — i.e. our merged render node, including `selected` and
        // `measured`. Strip before it reaches the document.
        persistent.push({ ...c, item: stripNodeTransient(c.item) });
        break;
    }
  }

  const nextEph: NodeEphemeral =
    selected || measured || dragging
      ? {
          selected: selected ?? eph.selected,
          measured: measured ?? eph.measured,
          dragging: dragging ?? eph.dragging,
        }
      : eph;

  if (persistent.length === 0) return { eph: nextEph, nodes: null };
  const applied = applyNodeChanges(persistent, storeNodes as never) as unknown as DiagramNode[];
  // applyNodeChanges returns untouched nodes by reference; only strip the
  // ones it rebuilt so unchanged nodes keep identity (cheap React Flow diff).
  const original = new Set<DiagramNode>(storeNodes);
  return {
    eph: nextEph,
    nodes: applied.map((n) => (original.has(n) ? n : stripNodeTransient(n))),
  };
}

/**
 * Edge counterpart. Selection stays local (returned as the next selected
 * set); add / remove / replace (label edits, label-offset drags via
 * setEdges) become a new persistent array.
 */
export function reduceEdgeChanges(
  storeEdges: DiagramEdge[],
  selectedEdges: ReadonlySet<string>,
  changes: EdgeChange[],
): { selected: ReadonlySet<string>; edges: DiagramEdge[] | null } {
  let selected: Set<string> | null = null;
  const sel = () => (selected ??= new Set(selectedEdges));
  const currentSelected = (): ReadonlySet<string> => selected ?? selectedEdges;
  const persistent: EdgeChange[] = [];
  for (const c of changes) {
    switch (c.type) {
      case 'select':
        if (c.selected) sel().add(c.id);
        else sel().delete(c.id);
        break;
      case 'remove':
        if (currentSelected().has(c.id)) sel().delete(c.id);
        persistent.push(c);
        break;
      case 'add':
      case 'replace':
        persistent.push({ ...c, item: stripEdgeTransient(c.item) });
        break;
    }
  }
  const nextSelected = currentSelected();
  if (persistent.length === 0) return { selected: nextSelected, edges: null };
  const applied = applyEdgeChanges(persistent, storeEdges as never) as unknown as DiagramEdge[];
  const original = new Set<DiagramEdge>(storeEdges);
  return {
    selected: nextSelected,
    edges: applied.map((e) => (original.has(e) ? e : stripEdgeTransient(e))),
  };
}
