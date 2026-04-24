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

// Switch node — DC isolator / disconnect switch. Slate-grey accent (neutral,
// since switches are passive routing elements — no warning colour like fuses).

import { useTranslation } from 'react-i18next';
import type { Node, NodeProps } from '@xyflow/react';
import type { DiagramNodeData } from '../../../types';
import BaseNode from './BaseNode';

// React Flow v12's `NodeProps<T>` takes the full Node type — wrap our data
// shape in `Node<...>` to satisfy the `Record<string, unknown>` constraint.
type SwitchNodeType = Node<DiagramNodeData, 'switch'>;

// Two contact points with a hinged lever — the schematic symbol for an open
// knife switch. Simple enough to read at 13x13 px.
const SwitchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
    {/* Left wire */}
    <line x1="2" y1="16" x2="8" y2="16" />
    {/* Hinged lever (angled up-right) */}
    <line x1="8" y1="16" x2="18" y2="6" />
    {/* Right wire + contact */}
    <line x1="16" y1="16" x2="22" y2="16" />
    {/* Contact dots */}
    <circle cx="8" cy="16" r="1.2" fill="white" />
    <circle cx="16" cy="16" r="1.2" fill="white" />
  </svg>
);

export default function SwitchNode({ id, data, selected }: NodeProps<SwitchNodeType>) {
  const { t } = useTranslation();
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      color="#64748b"
      typeLabel={t('diagram.nodes.switch')}
      icon={<SwitchIcon />}
    />
  );
}
