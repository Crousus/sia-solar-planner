// ────────────────────────────────────────────────────────────────────────────
// Sidebar — left-hand settings panel.
//
// Sections (top to bottom):
//   1. Project name + running totals (panel count, kWp)
//   2. Panel type editor (width, height, watts)
//   3. Inverters list (add / rename / delete)
//   4. Strings list (new / delete / assign inverter / activate for lasso)
//   5. Selected roof editor (name, tilt, orientation, areas, delete)
//      — only visible when a roof is currently selected
//
// Every control binds 1:1 to a store action. The sidebar has no local
// state of its own beyond ephemeral form input, which we delegate to
// native <input>s for simplicity.
//
// Styling: Tailwind + a small inline <style> block for reusable `.input` /
// `.btn-add` classes. Kept inline because a single sidebar file doesn't
// justify a separate CSS module.
// ────────────────────────────────────────────────────────────────────────────

import { useProjectStore } from '../store/projectStore';
import { polygonArea } from '../utils/geometry';

export default function Sidebar() {
  const project = useProjectStore((s) => s.project);
  const setProjectName = useProjectStore((s) => s.setProjectName);
  const updatePanelType = useProjectStore((s) => s.updatePanelType);

  const inverters = project.inverters;
  const strings = project.strings;
  const panels = project.panels;

  const addInverter = useProjectStore((s) => s.addInverter);
  const renameInverter = useProjectStore((s) => s.renameInverter);
  const deleteInverter = useProjectStore((s) => s.deleteInverter);

  const addString = useProjectStore((s) => s.addString);
  const deleteString = useProjectStore((s) => s.deleteString);
  const setStringInverter = useProjectStore((s) => s.setStringInverter);
  const activeStringId = useProjectStore((s) => s.activeStringId);
  const setActiveString = useProjectStore((s) => s.setActiveString);
  const setToolMode = useProjectStore((s) => s.setToolMode);

  const selectedRoofId = useProjectStore((s) => s.selectedRoofId);
  const updateRoof = useProjectStore((s) => s.updateRoof);
  const deleteRoof = useProjectStore((s) => s.deleteRoof);
  const selectedRoof = project.roofs.find((r) => r.id === selectedRoofId) || null;

  // Header totals — shown right under the project name so the user always
  // has a quick sense of scale while editing.
  const totalPanels = panels.length;
  const totalKwp = (totalPanels * project.panelType.wattPeak) / 1000;

  return (
    <aside className="w-72 shrink-0 h-full overflow-y-auto bg-neutral-900 text-neutral-100 border-r border-neutral-800 p-3 text-sm space-y-4">
      {/* ── Project ─────────────────────────────────────────────────── */}
      <Section title="Project">
        <Field label="Name">
          <input
            className="input"
            value={project.name}
            onChange={(e) => setProjectName(e.target.value)}
          />
        </Field>
        <div className="text-xs text-neutral-400 mt-1">
          {totalPanels} panels · {totalKwp.toFixed(2)} kWp
        </div>
      </Section>

      {/* ── Panel type ──────────────────────────────────────────────── */}
      {/* Single panel type per project — simpler than a library, matches
          most residential jobs where all panels are identical. */}
      <Section title="Panel Type">
        <Field label="Name">
          <input
            className="input"
            value={project.panelType.name}
            onChange={(e) => updatePanelType({ name: e.target.value })}
          />
        </Field>
        <Field label="Width (m)">
          <input
            type="number"
            step="0.001"
            className="input"
            value={project.panelType.widthM}
            onChange={(e) => updatePanelType({ widthM: parseFloat(e.target.value) || 0 })}
          />
        </Field>
        <Field label="Height (m)">
          <input
            type="number"
            step="0.001"
            className="input"
            value={project.panelType.heightM}
            onChange={(e) => updatePanelType({ heightM: parseFloat(e.target.value) || 0 })}
          />
        </Field>
        <Field label="Power (Wp)">
          <input
            type="number"
            className="input"
            value={project.panelType.wattPeak}
            onChange={(e) => updatePanelType({ wattPeak: parseInt(e.target.value) || 0 })}
          />
        </Field>
      </Section>

      {/* ── Inverters ───────────────────────────────────────────────── */}
      <Section title="Inverters">
        <button className="btn-add" onClick={addInverter}>+ Add Inverter</button>
        <div className="space-y-1 mt-2">
          {inverters.length === 0 && <p className="text-xs text-neutral-500">No inverters yet.</p>}
          {inverters.map((inv) => (
            <div key={inv.id} className="flex gap-1 items-center">
              <input
                className="input flex-1"
                value={inv.name}
                onChange={(e) => renameInverter(inv.id, e.target.value)}
              />
              <button
                className="text-red-400 hover:text-red-300 px-2"
                onClick={() => {
                  if (confirm(`Delete ${inv.name}?`)) deleteInverter(inv.id);
                }}
                title="Delete"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Strings ─────────────────────────────────────────────────── */}
      <Section title="Strings">
        <button className="btn-add" onClick={addString}>+ New String</button>
        <div className="space-y-1 mt-2">
          {strings.length === 0 && <p className="text-xs text-neutral-500">No strings yet.</p>}
          {strings.map((str) => {
            // Live panel count per string — derived, not stored.
            const count = panels.filter((p) => p.stringId === str.id).length;
            const isActive = str.id === activeStringId;
            return (
              <div
                key={str.id}
                className={`flex flex-col gap-1 p-2 rounded border ${isActive ? 'border-amber-400 bg-neutral-800' : 'border-neutral-700'}`}
              >
                <div className="flex items-center gap-2">
                  {/* Color swatch doubles as an "activate for assignment"
                      button — clicking it both highlights the string and
                      switches to assign-string mode. This is the main way
                      to "target" a string for subsequent lasso drags. */}
                  <button
                    className="w-4 h-4 rounded-sm border border-black/40 shrink-0"
                    style={{ background: str.color }}
                    onClick={() => {
                      setActiveString(str.id);
                      setToolMode('assign-string');
                    }}
                    title="Activate for assignment"
                  />
                  <span className="flex-1 text-xs">{str.label}</span>
                  <span className="text-xs text-neutral-400">{count}p</span>
                  <button
                    className="text-red-400 hover:text-red-300 px-1"
                    onClick={() => {
                      if (confirm(`Delete ${str.label}? Panels will become unassigned.`)) deleteString(str.id);
                    }}
                  >
                    ×
                  </button>
                </div>
                {/* Inverter assignment — empty option maps to null. */}
                <select
                  className="input text-xs"
                  value={str.inverterId || ''}
                  onChange={(e) => setStringInverter(str.id, e.target.value || null)}
                >
                  <option value="">— No inverter —</option>
                  {inverters.map((inv) => (
                    <option key={inv.id} value={inv.id}>
                      {inv.name}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      </Section>

      {/* ── Selected roof (conditional) ─────────────────────────────── */}
      {selectedRoof && (
        <Section title={`Selected: ${selectedRoof.name}`}>
          <Field label="Name">
            <input
              className="input"
              value={selectedRoof.name}
              onChange={(e) => updateRoof(selectedRoof.id, { name: e.target.value })}
            />
          </Field>
          <Field label={`Tilt: ${selectedRoof.tiltDeg}°`}>
            <input
              type="range"
              min={0}
              max={60}
              value={selectedRoof.tiltDeg}
              className="w-full"
              onChange={(e) => updateRoof(selectedRoof.id, { tiltDeg: parseInt(e.target.value) })}
            />
          </Field>
          <Field label="Orientation">
            {/* Portrait / landscape toggle — drives the geometry inside
                panelDisplaySize() (see utils/geometry.ts). */}
            <div className="flex gap-1">
              {(['portrait', 'landscape'] as const).map((o) => (
                <button
                  key={o}
                  className={`flex-1 px-2 py-1 text-xs rounded ${selectedRoof.panelOrientation === o ? 'bg-amber-500 text-black' : 'bg-neutral-800'}`}
                  onClick={() => updateRoof(selectedRoof.id, { panelOrientation: o })}
                >
                  {o}
                </button>
              ))}
            </div>
          </Field>
          <RoofAreaInfo roof={selectedRoof} mpp={project.mapState.metersPerPixel} />
          <button
            className="text-red-400 text-xs hover:text-red-300"
            onClick={() => {
              if (confirm(`Delete ${selectedRoof.name}?`)) deleteRoof(selectedRoof.id);
            }}
          >
            Delete roof
          </button>
        </Section>
      )}

      {/*
        Inline styles for reusable form controls. Keeping them local to the
        sidebar avoids coupling to tailwind.config or a shared CSS file —
        there's exactly one consumer.
      */}
      <style>{`
        .input {
          width: 100%;
          background: #262626;
          border: 1px solid #404040;
          border-radius: 4px;
          padding: 4px 6px;
          color: #f5f5f5;
          font-size: 12px;
        }
        .input:focus { outline: 1px solid #ffcb47; }
        .btn-add {
          width: 100%;
          background: #404040;
          border-radius: 4px;
          padding: 5px;
          font-size: 12px;
        }
        .btn-add:hover { background: #525252; }
      `}</style>
    </aside>
  );
}

/** Generic titled section wrapper with a subtle divider. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wide text-neutral-400 mb-2 border-b border-neutral-800 pb-1">
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

/** Labelled form field. Uses a block <label> so clicking the label focuses
    the child input (standard form accessibility). */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-neutral-400 mb-0.5">{label}</span>
      {children}
    </label>
  );
}

/**
 * Displays projected vs. actual roof area.
 *
 * Projected area = polygonArea(in px) × mpp² → m² as drawn on the
 * satellite view.
 *
 * Actual (on-slope) area = projected / cos(tilt). This is the real roof
 * surface the user would walk on, which is what matters for panel counting.
 */
function RoofAreaInfo({
  roof,
  mpp,
}: {
  roof: ReturnType<typeof useProjectStore.getState>['project']['roofs'][number];
  mpp: number;
}) {
  const projectedAreaPx = polygonArea(roof.polygon);
  const projectedAreaM2 = projectedAreaPx * mpp * mpp;
  const cosT = Math.cos((roof.tiltDeg * Math.PI) / 180);
  // Guard against cosT=0 (would only happen at 90° which our slider can't reach).
  const realAreaM2 = cosT > 0 ? projectedAreaM2 / cosT : projectedAreaM2;
  return (
    <div className="text-xs text-neutral-400 space-y-0.5">
      <div>Projected: {projectedAreaM2.toFixed(1)} m²</div>
      <div>Actual (sloped): {realAreaM2.toFixed(1)} m²</div>
    </div>
  );
}
