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
import type { InverterModelRecord } from '../../../backend/types';
import { useProjectStore } from '../../../store/projectStore';
import BaseNode from './BaseNode';

// React Flow v12's `NodeProps<T>` takes the full Node type — wrap our data
// shape in `Node<...>` so the `NodeData extends Record<string, unknown>`
// constraint is satisfied.
type InverterNodeType = Node<DiagramNodeData, 'inverter'>;

// Stylised "≈" / sine-wave pair, the classic electrical inverter glyph:
// top half = DC (straight segment), bottom half = AC (sine).
const InverterIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    {/* DC line (top) */}
    <line x1="4" y1="8" x2="20" y2="8" />
    {/* AC sine wave (bottom) */}
    <path d="M4 16 Q 8 12, 12 16 T 20 16" />
  </svg>
);

/**
 * AC output current from nameplate power + phase count.
 *
 * Catalog entries don't store AC current directly, but every European
 * datasheet quotes power + phases, so we can re-derive it:
 *   - 1-phase: 230 V, I = P / V
 *   - 3-phase: 400 V line-to-line, I = P / (√3 · V)
 * Phases default to 3 when unset (typical residential/commercial PV).
 * These are European grid standards; non-EU deployments would need a
 * locale-aware voltage constant here.
 */
function computeAcCurrentA(m: InverterModelRecord): number {
  const phases = m.phases ?? 3;
  const voltage = phases === 1 ? 230 : 400;
  const denom = phases === 1 ? voltage : voltage * Math.sqrt(3);
  return m.maxAcPowerW / denom;
}

export default function InverterNode({ id, data, selected }: NodeProps<InverterNodeType>) {
  const { t } = useTranslation();

  // Bootstrap emits node ids as `inv-${inverter.id}`. User-added inverter
  // nodes (via the toolbar) won't match that prefix — we fall back to the
  // generic "INVERTER" type label for those.
  const inverterId = id.startsWith('inv-') ? id.slice(4) : null;
  const inverter = useProjectStore((s) =>
    inverterId ? s.project.inverters.find((inv) => inv.id === inverterId) : undefined,
  );
  const model = useProjectStore((s) =>
    inverter?.inverterModelId ? s.inverterModelCache[inverter.inverterModelId] : undefined,
  );

  // Top slot reads inv.name (the sidebar-editable source of truth) so
  // renaming in the sidebar propagates here without an extra store round-
  // trip. Falls back to the i18n "Inverter" type label when the inverter
  // record isn't resolvable.
  const headerText = inverter?.name ?? t('diagram.nodes.inverter');

  // Body = derived from the linked catalog entry. Synthesized into `data`
  // so BaseNode's existing label/sublabel rendering picks it up. The body
  // label is contentEditable (per BaseNode); edits write to data.label
  // but get re-overridden on next render — acceptable since users rename
  // via the sidebar.
  const bodyData: DiagramNodeData = model
    ? {
        label: `${model.manufacturer} ${model.model}`,
        sublabel: `${computeAcCurrentA(model).toFixed(1)} A`,
      }
    : data;

  return (
    <BaseNode
      id={id}
      data={bodyData}
      selected={selected}
      color="#3b82f6"
      typeLabel={headerText}
      icon={<InverterIcon />}
    />
  );
}
