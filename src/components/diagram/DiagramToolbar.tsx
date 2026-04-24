import { useProjectStore } from '../../store/projectStore';
import type { DiagramNodeType } from '../../types';

// Toolbar buttons for manually adding diagram nodes. Only the node types that
// aren't auto-bootstrapped from the project (solar generators and inverters
// are inserted by `buildBootstrapDiagram`) are exposed here — everything else
// must be added by hand. Colors are chosen to match each node's visual theme
// in src/components/diagram/nodes/ so users can recognize them at a glance.
const NODE_BUTTONS: { type: DiagramNodeType; label: string; color: string }[] = [
  { type: 'switch',      label: 'Schalter',        color: '#64748b' },
  { type: 'fuse',        label: 'Sicherung',       color: '#ef4444' },
  { type: 'battery',     label: 'Batterie',        color: '#10b981' },
  { type: 'fre',         label: 'FRE',             color: '#8b5cf6' },
  { type: 'gridOutput',  label: 'Netzeinspeisung', color: '#0ea5e9' },
];

/**
 * A thin top bar rendered above the diagram canvas that lets users insert
 * new nodes with one click. New nodes are dropped at a semi-random offset
 * near the top-left so repeated additions don't stack perfectly on top of
 * each other (which would hide the duplicates visually).
 */
export default function DiagramToolbar() {
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
      <span className="text-slate-400 text-xs mr-1">+ Hinzufügen:</span>
      {NODE_BUTTONS.map(({ type, label, color }) => (
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
      ))}
    </div>
  );
}
