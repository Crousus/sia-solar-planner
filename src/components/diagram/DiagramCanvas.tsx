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
  ReactFlow, Background, Controls, MiniMap,
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
 * structurally compatible with ours but not identical (see Task 2 notes).
 */
export default function DiagramCanvas() {
  // `diagram` is optional on the project (only created on first open), so
  // fall back to empty arrays to avoid crashing before bootstrap runs.
  const nodes = useProjectStore(s => s.project.diagram?.nodes ?? []);
  const edges = useProjectStore(s => s.project.diagram?.edges ?? []);
  const setDiagramNodes = useProjectStore(s => s.setDiagramNodes);
  const setDiagramEdges = useProjectStore(s => s.setDiagramEdges);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setDiagramNodes(applyNodeChanges(changes, nodes) as DiagramNode[]),
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
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      // Both Delete and Backspace remove the selected node/edge — matches
      // typical diagram-editor UX on macOS (Backspace) and Windows (Delete).
      deleteKeyCode={['Delete', 'Backspace']}
      fitView
    >
      <Background gap={16} color="#cbd5e1" />
      <Controls />
      <MiniMap />
    </ReactFlow>
  );
}
