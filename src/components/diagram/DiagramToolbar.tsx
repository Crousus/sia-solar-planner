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

import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../store/projectStore';
import type { DiagramNodeType } from '../../types';

// Toolbar buttons for manually adding diagram nodes. Only the node types that
// aren't auto-bootstrapped from the project (solar generators and inverters
// are inserted by `buildBootstrapDiagram`) are exposed here — everything else
// must be added by hand. Colors are chosen to match each node's visual theme
// in src/components/diagram/nodes/ so users can recognize them at a glance.
//
// The label for each button lives in the i18n bundle (diagram.nodes.*) so the
// same translated string is reused as the typeLabel in each node's header
// band — a single source of truth for "what this node type is called".
//
// `as const` narrows each labelKey to its exact literal so the typed `t()`
// augmentation accepts the lookup without a cast — losing `as const` here
// widens labelKey to `string` and trips i18next's resource-key check.
const NODE_BUTTONS = [
  { type: 'switch',      labelKey: 'diagram.nodes.switch',       color: '#64748b' },
  { type: 'fuse',        labelKey: 'diagram.nodes.fuse',         color: '#ef4444' },
  { type: 'battery',     labelKey: 'diagram.nodes.battery',      color: '#10b981' },
  { type: 'fre',         labelKey: 'diagram.nodes.fre',          color: '#8b5cf6' },
  { type: 'gridOutput',  labelKey: 'diagram.nodes.gridOutput',   color: '#0ea5e9' },
] as const satisfies ReadonlyArray<{ type: DiagramNodeType; labelKey: string; color: string }>;

/**
 * A thin top bar rendered above the diagram canvas that lets users insert
 * new nodes with one click. New nodes are dropped at a semi-random offset
 * near the top-left so repeated additions don't stack perfectly on top of
 * each other (which would hide the duplicates visually).
 */
export default function DiagramToolbar() {
  const { t } = useTranslation();
  const addDiagramNode = useProjectStore(s => s.addDiagramNode);

  const handleAdd = (type: DiagramNodeType, label: string) => {
    addDiagramNode({
      // 8-char base36 id — cheap, collision-unlikely enough for a single
      // diagram, and avoids pulling in a UUID dependency for a UI-only id.
      id: Math.random().toString(36).slice(2, 10),
      type,
      // Randomize within a small rectangle so successive adds don't overlap.
      position: { x: 200 + Math.random() * 200, y: 200 + Math.random() * 100 },
      data: { label },
    });
  };

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border-b border-slate-700">
      <span className="text-slate-400 text-xs mr-1">{t('diagram.toolbar.addLabel')}</span>
      {NODE_BUTTONS.map(({ type, labelKey, color }) => {
        // Resolve the label once per render so it can be passed both as the
        // button's visible text AND as the initial `data.label` on the new
        // node. Keeping the two in lockstep means the node's editable label
        // defaults to its type name, which is what users expect.
        const label = t(labelKey);
        return (
          <button
            key={type}
            onClick={() => handleAdd(type, label)}
            className="text-[11px] px-2.5 py-1 rounded-md font-medium text-white hover:opacity-90 transition-opacity"
            // Inline style because Tailwind can't generate arbitrary hex
            // backgrounds from a runtime value — each button needs its own hue.
            style={{ background: color }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
