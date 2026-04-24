// Fuse node — DC fuse / overcurrent protection. Red accent signals
// "safety/protection device" at a glance, matching common electrical
// schematic colour conventions.

import type { Node, NodeProps } from '@xyflow/react';
import type { DiagramNodeData } from '../../../types';
import BaseNode from './BaseNode';

// React Flow v12's `NodeProps<T>` takes the full Node type — wrap our data
// shape in `Node<...>` to satisfy the `Record<string, unknown>` constraint.
type FuseNodeType = Node<DiagramNodeData, 'fuse'>;

// Rounded rectangle = fuse body, with wires entering/exiting on both sides.
// This is the IEC-60617 fuse symbol, simplified.
const FuseIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
    {/* Wire in */}
    <line x1="2" y1="12" x2="6" y2="12" />
    {/* Fuse body */}
    <rect x="6" y="8" width="12" height="8" rx="2" />
    {/* Wire out */}
    <line x1="18" y1="12" x2="22" y2="12" />
  </svg>
);

export default function FuseNode({ id, data, selected }: NodeProps<FuseNodeType>) {
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      color="#ef4444"
      typeLabel="Sicherung"
      icon={<FuseIcon />}
    />
  );
}
