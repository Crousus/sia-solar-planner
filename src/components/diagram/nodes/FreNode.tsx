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

// FRE node — Frequency Relay / ESS controller. Violet accent distinguishes
// it from the blue inverter (which it often sits next to in the diagram)
// while still feeling "electronic/control" rather than "power/protection".

import { useTranslation } from 'react-i18next';
import type { Node, NodeProps } from '@xyflow/react';
import type { DiagramNodeData } from '../../../types';
import BaseNode from './BaseNode';

// React Flow v12's `NodeProps<T>` takes the full Node type — wrap our data
// shape in `Node<...>` to satisfy the `Record<string, unknown>` constraint.
type FreNodeType = Node<DiagramNodeData, 'fre'>;

// Stylised controller / chip iconography: a rectangular body with "pins"
// protruding on two sides, suggesting a control module. Abstract enough
// to represent any FRE/ESS box without prescribing a specific vendor.
const FreIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
    {/* Chip body */}
    <rect x="6" y="6" width="12" height="12" rx="1" />
    {/* Pins — left side */}
    <line x1="2" y1="10" x2="6" y2="10" />
    <line x1="2" y1="14" x2="6" y2="14" />
    {/* Pins — right side */}
    <line x1="18" y1="10" x2="22" y2="10" />
    <line x1="18" y1="14" x2="22" y2="14" />
  </svg>
);

export default function FreNode({ id, data, selected }: NodeProps<FreNodeType>) {
  const { t } = useTranslation();
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      color="#8b5cf6"
      typeLabel={t('diagram.nodes.fre')}
      icon={<FreIcon />}
    />
  );
}
