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

// Fuse node — DC fuse / overcurrent protection. Red accent signals
// "safety/protection device" at a glance, matching common electrical
// schematic colour conventions.

import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      color="#ef4444"
      typeLabel={t('diagram.nodes.fuse')}
      icon={<FuseIcon />}
    />
  );
}
