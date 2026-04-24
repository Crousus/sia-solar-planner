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

// Inverter node — DC→AC converter block. Blue accent.

import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      color="#3b82f6"
      typeLabel={t('diagram.nodes.inverter')}
      icon={<InverterIcon />}
    />
  );
}
