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
import type { DiagramMeta } from '../../types';

// Title-block columns rendered below the diagram canvas (like a drawing
// title block in a schematic). Keys must match DiagramMeta fields exactly —
// the TypeScript `keyof DiagramMeta` constraint enforces that at compile time.
// Labels come from the i18n bundle (diagram.meta.*) resolved at render time,
// so the column layout stays compile-time safe without baking translations
// into the module-level constant.
// `as const satisfies ...` narrows each labelKey to its literal value so
// the typed `t()` call accepts it; without the `as const` labelKey would
// widen to `string` and i18next's key type would reject the lookup.
const COLUMNS = [
  { key: 'client',      labelKey: 'diagram.meta.client' },
  { key: 'module',      labelKey: 'diagram.meta.module' },
  { key: 'systemSize',  labelKey: 'diagram.meta.systemSize' },
  { key: 'salesperson', labelKey: 'diagram.meta.salesperson' },
  { key: 'planner',     labelKey: 'diagram.meta.planner' },
  { key: 'company',     labelKey: 'diagram.meta.company' },
  { key: 'date',        labelKey: 'diagram.meta.date' },
] as const satisfies ReadonlyArray<{ key: keyof DiagramMeta; labelKey: string }>;

/**
 * Editable metadata table shown beneath the diagram. Single-row, all fields
 * free-text. Each keystroke patches the single changed field into the store,
 * so undo granularity is per-character (diagram actions don't enter the undo
 * stack anyway — see projectStore comment on diagram actions).
 *
 * `flex-shrink-0` ensures the table keeps its height when the parent uses a
 * flex column layout with the canvas stretching to fill remaining space.
 */
export default function DiagramMetaTable() {
  const { t } = useTranslation();
  const meta = useProjectStore(s => s.project.diagram?.meta ?? {});
  const updateDiagramMeta = useProjectStore(s => s.updateDiagramMeta);

  return (
    <table className="w-full border-collapse text-[11px] font-sans flex-shrink-0">
      <thead>
        <tr style={{ background: '#1e293b' }}>
          {COLUMNS.map(({ key, labelKey }) => (
            <th key={key} className="px-2 py-1.5 text-left font-semibold text-slate-100 border-r border-slate-600 last:border-r-0 whitespace-nowrap">
              {t(labelKey)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr className="bg-white">
          {COLUMNS.map(({ key }) => (
            <td key={key} className="border-r border-slate-200 last:border-r-0">
              <input
                className="w-full px-2 py-1 text-slate-800 bg-transparent outline-none focus:bg-slate-50"
                // `meta` may not contain this key yet (DiagramMeta fields are
                // all optional) — coerce to empty string so the input stays
                // controlled and React doesn't warn about switching modes.
                value={meta[key] ?? ''}
                onChange={e => updateDiagramMeta({ [key]: e.target.value })}
              />
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}
