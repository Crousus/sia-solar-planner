// Battery node — optional energy storage block. Emerald/green accent
// mirrors the common "stored energy" visual convention (and contrasts
// clearly with the amber solar source and blue inverter).

import { useTranslation } from 'react-i18next';
import type { Node, NodeProps } from '@xyflow/react';
import type { DiagramNodeData } from '../../../types';
import BaseNode from './BaseNode';

// React Flow v12's `NodeProps<T>` takes the full Node type — wrap our data
// shape in `Node<...>` to satisfy the `Record<string, unknown>` constraint.
type BatteryNodeType = Node<DiagramNodeData, 'battery'>;

// Battery silhouette with a filled charge bar — instantly readable as a
// battery even at icon size. The small terminal nub on the right makes
// the orientation unambiguous.
const BatteryIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
    {/* Battery body */}
    <rect x="2" y="7" width="17" height="10" rx="1.5" />
    {/* Terminal */}
    <line x1="21" y1="10" x2="21" y2="14" />
    {/* Charge-level bar (filled) */}
    <rect x="4" y="9" width="8" height="6" fill="white" stroke="none" />
  </svg>
);

export default function BatteryNode({ id, data, selected }: NodeProps<BatteryNodeType>) {
  const { t } = useTranslation();
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      color="#10b981"
      typeLabel={t('diagram.nodes.battery')}
      icon={<BatteryIcon />}
    />
  );
}
