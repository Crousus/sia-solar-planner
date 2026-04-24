import { useProjectStore } from '../../store/projectStore';
import type { DiagramMeta } from '../../types';

// Title-block columns rendered below the diagram canvas (like a drawing
// title block in a schematic). Keys must match DiagramMeta fields exactly —
// the TypeScript `keyof DiagramMeta` constraint enforces that at compile time.
const COLUMNS: { key: keyof DiagramMeta; label: string }[] = [
  { key: 'client',      label: 'Projekt für Kunde' },
  { key: 'module',      label: 'Modul' },
  { key: 'systemSize',  label: 'Anlagengröße' },
  { key: 'salesperson', label: 'Verkauf' },
  { key: 'planner',     label: 'Planung' },
  { key: 'company',     label: 'Firma' },
  { key: 'date',        label: 'Datum' },
];

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
  const meta = useProjectStore(s => s.project.diagram?.meta ?? {});
  const updateDiagramMeta = useProjectStore(s => s.updateDiagramMeta);

  return (
    <table className="w-full border-collapse text-[11px] font-sans flex-shrink-0">
      <thead>
        <tr style={{ background: '#1e293b' }}>
          {COLUMNS.map(({ label }) => (
            <th key={label} className="px-2 py-1.5 text-left font-semibold text-slate-100 border-r border-slate-600 last:border-r-0 whitespace-nowrap">
              {label}
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
