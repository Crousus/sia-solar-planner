// ────────────────────────────────────────────────────────────────────────────
// Toolbar — top bar with lock/unlock, tool mode buttons, and project-level
// actions (export PDF, save/load JSON, reset).
//
// Notable wiring:
//   - `mapRef` is passed down from App so the lock button can call
//     getCenter() / getZoom() at the moment of lock to compute mpp.
//   - Mode buttons are disabled until the map is locked (modes are
//     meaningless without a calibrated viewport).
//   - The "Assign String" button has extra logic: if there's no currently
//     active string, clicking it creates a new one (matches the common
//     case and avoids a dead click).
//   - Save/Load use the browser's file APIs directly — no backend.
// ────────────────────────────────────────────────────────────────────────────

import { useProjectStore } from '../store/projectStore';
import { metersPerPixel } from '../utils/calibration';
import { exportPdf } from '../utils/pdfExport';
import type { ToolMode, Project } from '../types';

interface Props {
  mapRef: React.MutableRefObject<L.Map | null>;
}

// Modes rendered as buttons. `key` is the keyboard shortcut handled in
// App.tsx (shown in tooltips could be nice; not doing it to keep code tight).
const MODES: { mode: ToolMode; label: string; key: string }[] = [
  { mode: 'draw-roof', label: '✏ Draw Roof', key: 'r' },
  { mode: 'place-panels', label: '☐ Place Panels', key: 'p' },
  { mode: 'assign-string', label: '⚡ Assign String', key: 's' },
  { mode: 'delete', label: '🗑 Delete', key: 'd' },
];

export default function Toolbar({ mapRef }: Props) {
  const toolMode = useProjectStore((s) => s.toolMode);
  const setToolMode = useProjectStore((s) => s.setToolMode);
  const locked = useProjectStore((s) => s.project.mapState.locked);
  const lockMap = useProjectStore((s) => s.lockMap);
  const unlockMap = useProjectStore((s) => s.unlockMap);
  const project = useProjectStore((s) => s.project);
  const loadProject = useProjectStore((s) => s.loadProject);
  const resetProject = useProjectStore((s) => s.resetProject);
  const addString = useProjectStore((s) => s.addString);

  /**
   * Lock/unlock handler. On lock, capture the CURRENT map center + zoom
   * and bake them into the persisted mapState along with mpp. Unlocking
   * doesn't reproject existing drawings — it just lets the user pan again
   * (usefulness: re-orient, then re-lock).
   */
  const handleLock = () => {
    const map = mapRef.current;
    if (!map) return;
    if (locked) {
      unlockMap();
    } else {
      const c = map.getCenter();
      const z = map.getZoom();
      const mpp = metersPerPixel(z, c.lat);
      lockMap(c.lat, c.lng, z, mpp);
    }
  };

  const handleExport = async () => {
    const ok = await exportPdf(project);
    if (!ok) alert('Export failed — see console for details.');
  };

  /**
   * Save JSON: serialize the entire project (same shape as the
   * localStorage payload) and trigger a download via a temporary <a>.
   * Filename is sanitized to filesystem-safe chars.
   */
  const handleSave = () => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name.replace(/[^a-z0-9-_]/gi, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /**
   * Load JSON: open a file picker, parse, and hand off to store.loadProject.
   * No schema validation beyond JSON.parse — if the file was made by this
   * app the shape will match; if not, the user sees their error.
   */
  const handleLoad = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as Project;
        loadProject(parsed);
      } catch (err) {
        alert('Failed to load project: ' + (err as Error).message);
      }
    };
    input.click();
  };

  const handleReset = () => {
    if (confirm('Reset entire project? This cannot be undone.')) resetProject();
  };

  /**
   * Render one mode button. Clicking an active mode toggles back to idle
   * (a common toolbar idiom). Clicking "Assign String" when no active
   * string exists creates one — saves the user a separate click on
   * "+ New String" in the sidebar for the common flow.
   */
  const modeBtn = (mode: ToolMode, label: string) => {
    const active = toolMode === mode;
    const disabled = !locked && mode !== 'idle';
    return (
      <button
        key={mode}
        disabled={disabled}
        className={`px-3 py-1.5 rounded text-sm border ${
          active
            ? 'bg-amber-500 text-black border-amber-500'
            : 'bg-neutral-800 text-neutral-100 border-neutral-700 hover:bg-neutral-700'
        } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
        onClick={() => {
          if (mode === 'assign-string') {
            const state = useProjectStore.getState();
            if (!state.activeStringId || !state.project.strings.find((s) => s.id === state.activeStringId)) {
              addString(); // addString sets activeStringId + toolMode itself
              return;
            }
          }
          setToolMode(active ? 'idle' : mode);
        }}
        title={disabled ? 'Lock map first' : ''}
      >
        {label}
      </button>
    );
  };

  return (
    <header className="h-12 shrink-0 flex items-center gap-2 px-3 bg-neutral-900 border-b border-neutral-800 text-neutral-100">
      <div className="font-bold text-amber-400 mr-3">☀ Solar Planner</div>
      <button
        className={`px-3 py-1.5 rounded text-sm border ${
          locked
            ? 'bg-emerald-600 border-emerald-600'
            : 'bg-neutral-800 border-neutral-700 hover:bg-neutral-700'
        }`}
        onClick={handleLock}
      >
        {locked ? '🔒 Map Locked' : '🔓 Lock Map'}
      </button>
      <div className="w-px h-6 bg-neutral-700 mx-1" />
      {MODES.map((m) => modeBtn(m.mode, m.label))}
      <div className="flex-1" />
      <button className="btn-tool" onClick={handleExport}>📄 Export PDF</button>
      <button className="btn-tool" onClick={handleSave}>💾 Save JSON</button>
      <button className="btn-tool" onClick={handleLoad}>📂 Load JSON</button>
      <button className="btn-tool text-red-400" onClick={handleReset}>Reset</button>
      <style>{`
        .btn-tool {
          padding: 6px 10px;
          font-size: 13px;
          border-radius: 4px;
          background: #262626;
          border: 1px solid #404040;
        }
        .btn-tool:hover { background: #404040; }
      `}</style>
    </header>
  );
}
