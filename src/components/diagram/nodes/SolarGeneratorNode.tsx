// Solar generator node — represents the aggregated roof(s) + panels block.
// Amber accent (sun iconography). Uses dark header text because amber is a
// light colour and white-on-amber fails contrast.

import type { Node, NodeProps } from '@xyflow/react';
import type { DiagramNodeData } from '../../../types';
import BaseNode from './BaseNode';

// React Flow v12's `NodeProps<T>` expects T to be the full Node type, not
// just the data payload. Wrap our data shape in `Node<...>` so the generic
// constraint (`NodeData extends Record<string, unknown>`) is satisfied.
type SolarGeneratorNodeType = Node<DiagramNodeData, 'solarGenerator'>;

// Inline SVG sun — self-contained so we don't pull an icon library just for
// seven nodes. Stroke colour matches the header textColor (#1e293b = slate-800)
// so the icon tracks the label.
const SunIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#1e293b" strokeWidth="2.5">
    <circle cx="12" cy="12" r="5" />
    <line x1="12" y1="1" x2="12" y2="3" />
    <line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" />
    <line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </svg>
);

export default function SolarGeneratorNode({ id, data, selected }: NodeProps<SolarGeneratorNodeType>) {
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      color="#f59e0b"
      textColor="#1e293b"
      typeLabel="Solargenerator"
      icon={<SunIcon />}
    />
  );
}
