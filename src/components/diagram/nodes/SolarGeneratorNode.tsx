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

// Solar generator node — represents the aggregated roof(s) + panels block.
// Amber accent (sun iconography). Uses dark header text because amber is a
// light colour and white-on-amber fails contrast.

import { useTranslation } from 'react-i18next';
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
  // Localised type label for the header band. Resolved at render so changing
  // language live updates the node without re-mounting React Flow.
  const { t } = useTranslation();
  return (
    <BaseNode
      id={id}
      data={data}
      selected={selected}
      color="#f59e0b"
      textColor="#1e293b"
      typeLabel={t('diagram.nodes.solarGenerator')}
      icon={<SunIcon />}
    />
  );
}
