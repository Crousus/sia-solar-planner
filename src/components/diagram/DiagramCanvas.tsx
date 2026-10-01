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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls,
  ConnectionMode, ConnectionLineType,
  addEdge,
  useNodesInitialized, useReactFlow,
  type NodeChange, type EdgeChange, type Connection, type Node, type Edge,
} from '@xyflow/react';
// React Flow's default stylesheet — must be imported exactly once somewhere
// in the app. We centralize it here so that any page mounting the diagram
// automatically pulls the styles; no other component needs to import it.
import '@xyflow/react/dist/style.css';
import { useProjectStore } from '../../store/projectStore';
import type { DiagramNode, DiagramEdge } from '../../types';
import SolarGeneratorNode from './nodes/SolarGeneratorNode';
import InverterNode from './nodes/InverterNode';
import SwitchNode from './nodes/SwitchNode';
import FuseNode from './nodes/FuseNode';
import BatteryNode from './nodes/BatteryNode';
import FreNode from './nodes/FreNode';
import GridOutputNode from './nodes/GridOutputNode';
import ConsumerNode from './nodes/ConsumerNode';
import EditableSmoothStepEdge from './edges/EditableSmoothStepEdge';
import {
  reduceNodeChanges,
  reduceEdgeChanges,
  stripEdgeTransient,
  EMPTY_NODE_EPHEMERAL,
  type NodeEphemeral,
} from './diagramChanges';

// Stable empty fallbacks for projects without a diagram yet. A selector
// returning a fresh `[]` on every call makes zustand see a "new" value on
// every store update (and React warn that getSnapshot isn't cached), which
// re-rendered the whole canvas for unrelated edits.
const EMPTY_NODES: DiagramNode[] = [];
const EMPTY_EDGES: DiagramEdge[] = [];

// Center-snap grid (flow px) — see snapCenter in diagramChanges.ts.
const CENTER_SNAP_GRID = 11;

// Map of node `type` strings to their React components. React Flow looks up
// each node's `type` field in this dictionary to decide which component to
// render. Keys here must match the `DiagramNodeType` union in src/types.
const nodeTypes = {
  solarGenerator: SolarGeneratorNode,
  inverter: InverterNode,
  switch: SwitchNode,
  fuse: FuseNode,
  battery: BatteryNode,
  fre: FreNode,
  gridOutput: GridOutputNode,
  consumer: ConsumerNode,
};

// Custom edge renderer registry. `editableSmoothStep` is our smoothstep
// variant with an in-place editable label (see EditableSmoothStepEdge.tsx).
// Made the default via `defaultEdgeOptions.type` below so every new edge
// the user draws picks up the label affordance automatically.
const edgeTypes = {
  editableSmoothStep: EditableSmoothStepEdge,
};

// Default edge styling — pure white on the dark editor canvas, swapped to
// pure black under [data-pdf-export] (see index.css). Monochrome by design:
// connections in a single-line diagram carry no per-wire semantic, so they
// read as crisp uniform conductors rather than competing with the colored
// node headers for attention. Applied uniformly so every connection draws
// the same weight without per-edge overrides.
// `smoothstep` gives orthogonal routing (horizontal + vertical segments)
// with rounded corners at each turn — the standard schematic/electrical
// look. Bezier edges (React Flow's default) produce "lasso" loops that
// read as cable slack rather than clean wiring. `borderRadius` controls
// the corner softness; 8px is a subtle round that still reads as angular.
const defaultEdgeOptions = {
  // Route through our custom editable variant so every new connection the
  // user draws can be labelled in place. The renderer itself uses
  // `getSmoothStepPath` internally, so the geometry matches pure smoothstep.
  type: 'editableSmoothStep',
  pathOptions: { borderRadius: 8 },
  style: {
    stroke: 'rgba(255, 255, 255, 0.6)',
    strokeWidth: 2,
  } as React.CSSProperties,
};

/**
 * The interactive React Flow canvas for the electrical block diagram.
 *
 * Reads nodes/edges from the project store and pushes DOCUMENT changes back
 * via dedicated diagram actions. React Flow's change arrays are routed by
 * `reduceNodeChanges` / `reduceEdgeChanges` (diagramChanges.ts): the store
 * stays the single source of truth for the document, while selection,
 * measured sizes and in-flight drag positions are per-viewer state held
 * locally and merged in for rendering — React Flow is still a controlled
 * component, it just isn't allowed to persist its runtime fields.
 *
 * The `as DiagramNode[] / as DiagramEdge[]` casts are required because
 * React Flow's helpers return its own `Node`/`Edge` internal types, which are
 * structurally compatible with ours but not identical.
 *
 * Visual treatment:
 *   - Background: transparent so the parent's atmospheric canvas-bg shows
 *     through — no discrete canvas rectangle, just the app surround. A
 *     subtle light dot grid is overlaid on top via React Flow's Background
 *     component, echoing the main canvas's dot pattern.
 *   - Controls: dark-chrome pill styled via the scoped selector below
 *     (.diagram-canvas .react-flow__controls), matching the main Toolbar.
 *   - MiniMap: removed. It added the most visual noise of any chrome and
 *     diagrams at this scale (a dozen nodes max) don't need navigation aid.
 */
/** One memoised render node + the inputs it was built from. */
interface RenderCacheEntry {
  src: DiagramNode;
  pos: { x: number; y: number } | undefined;
  m: { width: number; height: number } | undefined;
  sel: boolean;
  out: Node;
}

interface DiagramCanvasProps {
  /**
   * Offscreen PDF-export render (see pdf/pdfExport.tsx). Disables all
   * interaction and chrome, fits the view once nodes are measured, and
   * then calls `onReady` so the exporter knows the layout is final.
   */
  exportMode?: boolean;
  onReady?: () => void;
}

export default function DiagramCanvas({ exportMode = false, onReady }: DiagramCanvasProps = {}) {
  // `diagram` is optional on the project (only created on first open), so
  // fall back to stable empty arrays to avoid crashing before bootstrap runs.
  const storeNodes = useProjectStore(s => s.project.diagram?.nodes ?? EMPTY_NODES);
  const storeEdges = useProjectStore(s => s.project.diagram?.edges ?? EMPTY_EDGES);
  const setDiagramNodes = useProjectStore(s => s.setDiagramNodes);
  const setDiagramEdges = useProjectStore(s => s.setDiagramEdges);

  // ── Per-viewer interaction state (NOT persisted, NOT synced) ─────────
  // Selection, measured size and in-flight drag positions live here, in
  // local React state. Only document edits reach the store — see
  // diagramChanges.ts for the full routing table and why.
  const [nodeEph, setNodeEph] = useState<NodeEphemeral>(EMPTY_NODE_EPHEMERAL);
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(() => new Set());

  // Refs mirror the latest values so the change handlers stay referentially
  // stable (React Flow re-subscribes on handler identity changes) and never
  // reduce against a stale closure when several change batches arrive
  // between renders (e.g. dimensions + select on the same frame).
  const nodeEphRef = useRef(nodeEph);
  nodeEphRef.current = nodeEph;
  const selectedEdgesRef = useRef(selectedEdges);
  selectedEdgesRef.current = selectedEdges;

  // ── Render nodes = store nodes ⊕ local ephemeral fields ──────────────
  // Cached per node id so a node whose inputs didn't change keeps its
  // object identity — React Flow skips re-adopting it, which keeps a drag
  // of one node from re-processing every other node each frame.
  const renderCacheRef = useRef(new Map<string, RenderCacheEntry>());
  const renderNodes = useMemo(() => {
    const cache = renderCacheRef.current;
    const next = new Map<string, RenderCacheEntry>();
    const out = storeNodes.map((n) => {
      const pos = nodeEph.dragging.get(n.id);
      const m = nodeEph.measured.get(n.id);
      const sel = nodeEph.selected.has(n.id);
      const hit = cache.get(n.id);
      if (hit && hit.src === n && hit.pos === pos && hit.m === m && hit.sel === sel) {
        next.set(n.id, hit);
        return hit.out;
      }
      // `measured` is set explicitly (possibly undefined) so a stale value
      // persisted by an older client never overrides this viewer's own
      // measurement; React Flow re-measures unmeasured nodes on mount.
      const node: Node = {
        ...(n as unknown as Node),
        position: pos ?? n.position,
        selected: sel,
        dragging: pos !== undefined,
        measured: m,
      };
      next.set(n.id, { src: n, pos, m, sel, out: node });
      return node;
    });
    renderCacheRef.current = next;
    return out;
  }, [storeNodes, nodeEph]);

  const renderEdges = useMemo(
    () =>
      storeEdges.map((e) => {
        const sel = selectedEdges.has(e.id);
        // Leave unselected edges untouched (same identity) unless an older
        // client persisted `selected` onto them.
        if (!sel && !('selected' in e)) return e as unknown as Edge;
        return { ...(e as unknown as Edge), selected: sel };
      }),
    [storeEdges, selectedEdges],
  );

  // Latest store arrays for the handlers (same stale-closure rationale).
  const storeNodesRef = useRef(storeNodes);
  storeNodesRef.current = storeNodes;
  const storeEdgesRef = useRef(storeEdges);
  storeEdgesRef.current = storeEdges;

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const { eph, nodes } = reduceNodeChanges(
        storeNodesRef.current,
        nodeEphRef.current,
        changes,
        CENTER_SNAP_GRID,
      );
      if (eph !== nodeEphRef.current) {
        nodeEphRef.current = eph;
        setNodeEph(eph);
      }
      // Only real document edits (drag end, add/remove, data replace) hit
      // the store → localStorage → sync. Selection/measure/mid-drag don't.
      if (nodes) {
        storeNodesRef.current = nodes;
        setDiagramNodes(nodes);
      }
    },
    [setDiagramNodes],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const { selected, edges } = reduceEdgeChanges(
        storeEdgesRef.current,
        selectedEdgesRef.current,
        changes,
      );
      if (selected !== selectedEdgesRef.current) {
        selectedEdgesRef.current = selected;
        setSelectedEdges(selected);
      }
      if (edges) {
        storeEdgesRef.current = edges;
        setDiagramEdges(edges);
      }
    },
    [setDiagramEdges],
  );
  const onConnect = useCallback(
    (connection: Connection) => {
      const next = (addEdge(connection, storeEdgesRef.current as unknown as Edge[]) as unknown as DiagramEdge[])
        .map((e) => stripEdgeTransient(e));
      storeEdgesRef.current = next;
      setDiagramEdges(next);
    },
    [setDiagramEdges],
  );

  // Prune local state for nodes/edges that disappeared (remote delete,
  // undo-free reset). Not required for correctness — render ignores
  // unknown ids — but keeps the sets from growing across a long session.
  useEffect(() => {
    const ids = new Set(storeNodes.map((n) => n.id));
    const eph = nodeEphRef.current;
    const stale =
      [...eph.selected].some((id) => !ids.has(id)) ||
      [...eph.measured.keys()].some((id) => !ids.has(id)) ||
      [...eph.dragging.keys()].some((id) => !ids.has(id));
    if (!stale) return;
    const next: NodeEphemeral = {
      selected: new Set([...eph.selected].filter((id) => ids.has(id))),
      measured: new Map([...eph.measured].filter(([id]) => ids.has(id))),
      dragging: new Map([...eph.dragging].filter(([id]) => ids.has(id))),
    };
    nodeEphRef.current = next;
    setNodeEph(next);
  }, [storeNodes]);
  useEffect(() => {
    const ids = new Set(storeEdges.map((e) => e.id));
    const sel = selectedEdgesRef.current;
    if (![...sel].some((id) => !ids.has(id))) return;
    const next = new Set([...sel].filter((id) => ids.has(id)));
    selectedEdgesRef.current = next;
    setSelectedEdges(next);
  }, [storeEdges]);

  return (
    // The wrapper div carries a stable class name so the scoped CSS below
    // can override React Flow's default control / attribution colors
    // without leaking into other React Flow instances elsewhere in the app.
    <div
      className="diagram-canvas"
      style={{ width: '100%', height: '100%', background: 'transparent' }}
    >
      <ReactFlow
        nodes={renderNodes}
        edges={renderEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        // BaseNode declares every handle as `type="source"` so the user can
        // drag FROM any side of any node. React Flow's default strict mode
        // would then refuse the drop because the landing handle is also a
        // source — no target exists to connect to. Loose mode allows any
        // handle→any handle and preserves the "drag from anywhere" intent.
        // Grid snap is implemented in `onNodesChange` (center-snap instead
        // of corner-snap) so nodes of different sizes can still align by
        // center. See the CENTER_SNAP_GRID comment above.
        connectionMode={ConnectionMode.Loose}
        // Preview line while dragging a new connection — match the committed
        // edge shape so the drop doesn't visually snap between two path styles.
        connectionLineType={ConnectionLineType.SmoothStep}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        // Both Delete and Backspace remove the selected node/edge — matches
        // typical diagram-editor UX on macOS (Backspace) and Windows (Delete).
        deleteKeyCode={exportMode ? null : ['Delete', 'Backspace']}
        // Export renders are a static snapshot: no dragging, connecting,
        // selecting or viewport gestures on the hidden offscreen copy.
        {...(exportMode
          ? {
              nodesDraggable: false,
              nodesConnectable: false,
              elementsSelectable: false,
              panOnDrag: false,
              zoomOnScroll: false,
              zoomOnPinch: false,
              zoomOnDoubleClick: false,
            }
          : {})}
        fitView
        // Give fitView a small inset so nodes don't touch the canvas edges,
        // which would otherwise collide with the title block.
        fitViewOptions={{ padding: 0.15 }}
        proOptions={{ hideAttribution: true }}
      >
        {/* Dot grid — a faint white tracery at low alpha, matching the
            density of the roof-plan canvas-bg dots so the two views share
            one engineering-paper voice on the dark surround. */}
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.1}
          color="rgba(255,255,255,0.1)"
          bgColor="transparent"
        />
        {!exportMode && <Controls showInteractive={false} />}
        {exportMode && onReady && (
          <ExportReadySignal nodeCount={renderNodes.length} onReady={onReady} />
        )}
      </ReactFlow>

      {/*
        Scoped overrides for React Flow chrome. Kept inline rather than in
        index.css because these are specific to this component's tree and
        we want them to load alongside the canvas (not polluting the global
        stylesheet if the diagram is never opened). The class prefix
        `.diagram-canvas` scopes everything to this subtree only.
      */}
      <style>{`
        /* Controls — dark chrome pill matching the main Toolbar and the
           diagram insert palette. Hairline border, soft drop shadow so
           the pill still lifts off the transparent canvas. */
        .diagram-canvas .react-flow__controls {
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.03),
            0 1px 0 rgba(0,0,0,0.5),
            0 10px 24px -14px rgba(0,0,0,0.7);
          border: 1px solid var(--hairline);
          border-radius: 8px;
          overflow: hidden;
          background: rgba(17, 17, 19, 0.82);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }
        .diagram-canvas .react-flow__controls button {
          background: transparent;
          border-bottom: 1px solid var(--hairline);
          color: var(--ink-200);
          width: 28px;
          height: 26px;
          transition:
            background-color 140ms cubic-bezier(0.2, 0.8, 0.2, 1),
            color 140ms cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        .diagram-canvas .react-flow__controls button:last-child {
          border-bottom: none;
        }
        .diagram-canvas .react-flow__controls button:hover {
          background: rgba(255, 255, 255, 0.04);
          color: var(--ink-50);
        }
        .diagram-canvas .react-flow__controls button path,
        .diagram-canvas .react-flow__controls button svg {
          fill: currentColor;
        }
        /* Edge selection: give selected connections a brighter accent in
           the app's electric blue, so edge picking reads the same as node
           selection (which uses its own accent ring). */
        .diagram-canvas .react-flow__edge.selected .react-flow__edge-path,
        .diagram-canvas .react-flow__edge:focus .react-flow__edge-path {
          stroke: var(--sun-400);
          stroke-width: 2;
        }
        /* Connection line (mid-drag) matches the default edge tone so the
           preview doesn't flash a different weight before committing. */
        .diagram-canvas .react-flow__connection-path {
          stroke: rgba(255, 255, 255, 0.6);
          stroke-width: 1.25;
          stroke-dasharray: 4 3;
        }
        /* Connection handles are hidden by default so idle nodes read as
           clean chips without four dangling pins. Revealed on hover of
           the containing React Flow node wrapper, and kept visible while
           the node is selected (so keyboard-selected nodes still expose
           their connection points). Transition is short enough to feel
           instant but long enough to avoid popping. */
        .diagram-canvas .react-flow__node .diagram-node .react-flow__handle {
          opacity: 0;
          transition: opacity 120ms cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        .diagram-canvas .react-flow__node:hover .diagram-node .react-flow__handle,
        .diagram-canvas .react-flow__node.selected .diagram-node .react-flow__handle,
        .diagram-canvas .react-flow__node .diagram-node .react-flow__handle[data-connected="true"] {
          opacity: 1;
        }
        /* Per-node action buttons (currently only SwitchNode's rotate
           control). Same hover-reveal pattern as the connection handles
           so idle nodes stay visually clean — the button is only there
           to be discovered. pointer-events:none while hidden stops the
           invisible button from absorbing clicks meant for the canvas
           behind it. */
        .diagram-canvas .react-flow__node .diagram-node .diagram-rotate-btn {
          opacity: 0;
          pointer-events: none;
          transition: opacity 120ms cubic-bezier(0.2, 0.8, 0.2, 1),
                      transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        .diagram-canvas .react-flow__node:hover .diagram-node .diagram-rotate-btn,
        .diagram-canvas .react-flow__node.selected .diagram-node .diagram-rotate-btn {
          opacity: 1;
          pointer-events: auto;
        }
        .diagram-canvas .react-flow__node .diagram-node .diagram-rotate-btn:hover {
          background: rgba(30, 30, 33, 0.95);
          color: var(--ink-50);
        }
        .diagram-canvas .react-flow__node .diagram-node .diagram-rotate-btn:active {
          transform: scale(0.92);
        }
      `}</style>
    </div>
  );
}

/**
 * Fires `onReady` once the offscreen export canvas has a final layout:
 * every node measured by React Flow, the viewport fitted to them, and two
 * frames painted so the DOM the capture walks reflects the fitted
 * transform. Must render INSIDE <ReactFlow> to reach its context.
 *
 * An empty diagram is ready immediately (useNodesInitialized stays false
 * when there are no nodes, which would otherwise hang the export until
 * the exporter's timeout).
 */
function ExportReadySignal({ nodeCount, onReady }: { nodeCount: number; onReady: () => void }) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    if (nodeCount > 0 && !initialized) return;
    firedRef.current = true;
    const fitted = nodeCount > 0 ? fitView({ padding: 0.15 }) : Promise.resolve(true);
    void Promise.resolve(fitted).then(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => onReady()));
    });
  }, [initialized, nodeCount, fitView, onReady]);
  return null;
}
