// Inverter node — DC→AC converter block. Blue accent.

import type { Node, NodeProps } from '@xyflow/react';
import type { DiagramNodeData } from '../../../types';
import BaseNode from './BaseNode';

// React Flow v12's `NodeProps<T>` takes the full Node type — wrap our data
// shape in `Node<...>` so the `NodeData extends Record<string, unknown>`
// constraint is satisfied.
type InverterNodeType = Node<DiagramNodeData, 'inverter'>;

// Stylised "≈" / sine-wave pair, the classic electrical inverter glyph:
// top half = DC (straight segment), bottom half = AC (sine).
const InverterIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
    {/* DC line (top) */}
    <line x1="4" y1="8" x2="20" y2="8" />
    {/* AC sine wave (bottom) */}
    <path d="M4 16 Q 8 12, 12 16 T 20 16" />
  </svg>
);

export default function InverterNode({ id, data, selected }: NodeProps<InverterNodeType>) {
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      color="#3b82f6"
      typeLabel="Wechselrichter"
      icon={<InverterIcon />}
    />
  );
}
