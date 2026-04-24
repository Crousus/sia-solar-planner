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

// Grid-output node — the utility grid connection point (Netzeinspeisung).
// Sky-blue accent — distinct from the inverter's brand-blue, evoking the
// "public utility / shared grid" feel.

import { useTranslation } from 'react-i18next';
import type { Node, NodeProps } from '@xyflow/react';
import type { DiagramNodeData } from '../../../types';
import BaseNode from './BaseNode';

// React Flow v12's `NodeProps<T>` takes the full Node type — wrap our data
// shape in `Node<...>` to satisfy the `Record<string, unknown>` constraint.
type GridOutputNodeType = Node<DiagramNodeData, 'gridOutput'>;

// Transmission-tower silhouette — the universal shorthand for "the grid".
// Chosen over a simpler plug icon because it unambiguously means "utility
// feed-in" rather than "generic electrical outlet".
const GridIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    {/* Tower legs */}
    <line x1="6" y1="22" x2="10" y2="4" />
    <line x1="18" y1="22" x2="14" y2="4" />
    {/* Tower top */}
    <line x1="10" y1="4" x2="14" y2="4" />
    {/* Cross braces */}
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="9" y1="9" x2="15" y2="9" />
  </svg>
);

export default function GridOutputNode({ id, data, selected }: NodeProps<GridOutputNodeType>) {
  const { t } = useTranslation();
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      color="#0ea5e9"
      typeLabel={t('diagram.nodes.gridOutput')}
      icon={<GridIcon />}
    />
  );
}
