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

import { useCallback } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls,
  ConnectionMode, ConnectionLineType,
  applyNodeChanges, applyEdgeChanges,
  addEdge,
  type NodeChange, type EdgeChange, type Connection,
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
import EditableSmoothStepEdge from './edges/EditableSmoothStepEdge';

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
};

// Custom edge renderer registry. `editableSmoothStep` is our smoothstep
// variant with an in-place editable label (see EditableSmoothStepEdge.tsx).
// Made the default via `defaultEdgeOptions.type` below so every new edge
// the user draws picks up the label affordance automatically.
const edgeTypes = {
  editableSmoothStep: EditableSmoothStepEdge,
};

// Default edge styling — a soft ink-200 hairline on the dark canvas. On a
// dark background a pure-dark stroke vanishes, so edges are tuned bright
// enough to read as deliberate lines but not loud enough to fight nodes.
// Applied uniformly so every connection draws the same weight without
// per-edge overrides.
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
    stroke: 'rgba(197, 197, 204, 0.75)', // ~var(--ink-200) with a touch of alpha
    strokeWidth: 2,
  } as React.CSSProperties,
};

/**
 * The interactive React Flow canvas for the electrical block diagram.
 *
 * Reads nodes/edges from the project store and pushes changes back via
 * dedicated diagram actions. We translate React Flow's change arrays into
 * full node/edge arrays using `applyNodeChanges` / `applyEdgeChanges` so the
 * store remains the single source of truth — React Flow is effectively a
 * controlled component here.
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
export default function DiagramCanvas() {
  // `diagram` is optional on the project (only created on first open), so
  // fall back to empty arrays to avoid crashing before bootstrap runs.
  const nodes = useProjectStore(s => s.project.diagram?.nodes ?? []);
  const edges = useProjectStore(s => s.project.diagram?.edges ?? []);
  const setDiagramNodes = useProjectStore(s => s.setDiagramNodes);
  const setDiagramEdges = useProjectStore(s => s.setDiagramEdges);

  // Center-snap grid. Nodes aren't all the same size (inverters with model
  // + current are taller than a bare fuse chip), and React Flow's native
  // `snapToGrid` locks the top-left corner — which means centers only
  // align when widths/heights match. We intercept position changes and
  // translate: snap the node's CENTER to the grid, then convert back to
  // a top-left position using the measured size. Result: no matter the
  // size difference, two nodes placed next to each other can line up
  // center-to-center on the same grid row/column.
  const CENTER_SNAP_GRID = 11;
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const snapped = changes.map((c) => {
        if (c.type !== 'position' || !c.position) return c;
        // React Flow augments each node in its internal store with
        // `measured` (computed size after layout) and sometimes `.width`
        // /`.height`. Our `DiagramNode` type is the persisted schema and
        // doesn't include those runtime-only fields, so cast through a
        // local shape to read them without polluting the stored type.
        type MeasuredNode = DiagramNode & {
          measured?: { width?: number; height?: number };
          width?: number;
          height?: number;
        };
        const node = nodes.find((n) => n.id === c.id) as MeasuredNode | undefined;
        const w = node?.measured?.width ?? node?.width ?? 0;
        const h = node?.measured?.height ?? node?.height ?? 0;
        const centerX = c.position.x + w / 2;
        const centerY = c.position.y + h / 2;
        const snapCenterX = Math.round(centerX / CENTER_SNAP_GRID) * CENTER_SNAP_GRID;
        const snapCenterY = Math.round(centerY / CENTER_SNAP_GRID) * CENTER_SNAP_GRID;
        return {
          ...c,
          position: { x: snapCenterX - w / 2, y: snapCenterY - h / 2 },
        };
      });
      setDiagramNodes(applyNodeChanges(snapped, nodes) as DiagramNode[]);
    },
    [nodes, setDiagramNodes],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setDiagramEdges(applyEdgeChanges(changes, edges) as DiagramEdge[]),
    [edges, setDiagramEdges],
  );
  const onConnect = useCallback(
    (connection: Connection) => setDiagramEdges(addEdge(connection, edges) as DiagramEdge[]),
    [edges, setDiagramEdges],
  );

  return (
    // The wrapper div carries a stable class name so the scoped CSS below
    // can override React Flow's default control / attribution colors
    // without leaking into other React Flow instances elsewhere in the app.
    <div
      className="diagram-canvas"
      style={{ width: '100%', height: '100%', background: 'transparent' }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
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
        deleteKeyCode={['Delete', 'Backspace']}
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
        <Controls showInteractive={false} />
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
          stroke: rgba(197, 197, 204, 0.75);
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
      `}</style>
    </div>
  );
}
