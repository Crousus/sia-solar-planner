// ────────────────────────────────────────────────────────────────────────────
// Sidebar — the left-hand settings / inspector panel.
//
// Sections (top to bottom):
//   1. Stats hero — project name + live panel count + kWp, typeset in mono
//      because the numbers are the app's primary payload
//   2. Panel type editor (width, height, watts)
//   3. Inverters list (add / rename / delete / select)
//   4. Strings list (new / delete / assign inverter / activate for lasso)
//   5. Selected-roof editor — visible only when a roof is currently selected
//
// Design notes (vs. prior version):
//   - All form primitives come from index.css (.input, .section-title,
//     .field-label, .segmented/.segment, .slider, .chip, .btn-*) so this
//     file is mostly markup.
//   - Numeric readouts live in JetBrains Mono to sell "measurement" visually.
//   - Section titles use Bricolage Grotesque small-caps for a crafted header
//     feel; a hairline gradient fills the row after the title.
//   - The selected-roof card has a subtle amber top-border accent so it
//     reads as "currently selected" from a glance.
//
// Behavior is unchanged — every control still maps 1:1 to a store action.
// ────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../store/projectStore';
import { polygonArea, panelFitsOnRoof } from '../utils/geometry';
import type { PanelType } from '../types';
import PanelModelPicker from './PanelModelPicker';
import InverterModelPicker from './InverterModelPicker';

export default function Sidebar() {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const setProjectName = useProjectStore((s) => s.setProjectName);
  const updatePanelType = useProjectStore((s) => s.updatePanelType);
  const deletePanels = useProjectStore((s) => s.deletePanels);

  const inverters = project.inverters;
  const strings = project.strings;
  const panels = project.panels;

  const addInverter = useProjectStore((s) => s.addInverter);
  const renameInverter = useProjectStore((s) => s.renameInverter);
  const deleteInverter = useProjectStore((s) => s.deleteInverter);
  const selectedInverterId = useProjectStore((s) => s.selectedInverterId);
  const setSelectedInverter = useProjectStore((s) => s.setSelectedInverter);

  const addString = useProjectStore((s) => s.addString);
  const deleteString = useProjectStore((s) => s.deleteString);
  const updateString = useProjectStore((s) => s.updateString);
  const setStringInverter = useProjectStore((s) => s.setStringInverter);
  const activeStringId = useProjectStore((s) => s.activeStringId);
  const setActiveString = useProjectStore((s) => s.setActiveString);
  const setToolMode = useProjectStore((s) => s.setToolMode);

  // ── Catalog context ────────────────────────────────────────────────
  // Wired up by ProjectEditor on mount. We read them here so the panel-
  // type and inverter-row sections can render catalog-aware UI.
  const activePanelModelId = useProjectStore((s) => s.activePanelModelId);
  const setPanelModelFromCatalog = useProjectStore((s) => s.setPanelModelFromCatalog);
  const inverterModelCache = useProjectStore((s) => s.inverterModelCache);
  const linkInverterModel = useProjectStore((s) => s.linkInverterModel);
  // Inline-picker toggles. Kept as local state (rather than in the
  // store) because they're pure presentation — the store shouldn't know
  // whether a dropdown is open. `null` means "closed"; string id means
  // "open for that inverter". The panel-model toggle is a plain boolean
  // since there's only one panel picker at a time.
  const [panelPickerOpen, setPanelPickerOpen] = useState(false);
  const [inverterPickerOpenFor, setInverterPickerOpenFor] = useState<string | null>(null);

  const selectedRoofId = useProjectStore((s) => s.selectedRoofId);
  const updateRoof = useProjectStore((s) => s.updateRoof);
  const deleteRoof = useProjectStore((s) => s.deleteRoof);
  const updateGroupOrientation = useProjectStore((s) => s.updateGroupOrientation);
  const activePanelGroupId = useProjectStore((s) => s.activePanelGroupId);
  const selectedRoof = project.roofs.find((r) => r.id === selectedRoofId) || null;

  // If the user has an active panel group on the selected roof, the
  // orientation toggle targets THAT group. Otherwise it updates the roof's
  // default for newly-created groups. Matches the prior implementation.
  const activeGroupPanelsOnRoof = selectedRoof && activePanelGroupId
    ? project.panels.filter((p) => p.groupId === activePanelGroupId && p.roofId === selectedRoof.id)
    : [];
  const orientationTargetsGroup = activeGroupPanelsOnRoof.length > 0;
  // Panel.orientation is required on live panels (migrateProject backfills
  // legacy saves at the persistence boundary), so no roof-default fallback
  // needed for the group-targeting case.
  const currentOrientation = orientationTargetsGroup
    ? activeGroupPanelsOnRoof[0].orientation
    : (selectedRoof?.panelOrientation ?? 'portrait');

  // Hero stats. Derived, not stored — recomputed on every render is trivial.
  const totalPanels = panels.length;
  const totalKwp = (totalPanels * project.panelType.wattPeak) / 1000;
  const totalStrings = strings.length;
  const totalInverters = inverters.length;

  /**
   * Guard panel-type dimension edits.
   *
   * Changing widthM/heightM resizes every placed panel's rendered rectangle
   * around its stored center. Panels that used to fit may now overflow or
   * overlap. Before committing, compute which panels would become invalid
   * under the proposed dimensions; if any, confirm with the user and delete.
   *
   * Why prompt rather than auto-snap? Re-snapping would silently move panels
   * the user deliberately placed — worse than losing them. Confirm-then-delete
   * keeps surprises to zero.
   *
   * Text-field edits: onChange can fire with intermediate values like "1."
   * (partway through typing 1.5), which parseFloat turns into NaN or 0.
   * We skip validation for non-finite / zero dims and just commit — the user
   * is mid-type and we'll re-check on the next keystroke.
   */
  const tryUpdatePanelType = (changes: Partial<PanelType>) => {
    const dimChange = changes.widthM !== undefined || changes.heightM !== undefined;
    if (!dimChange) {
      updatePanelType(changes);
      return;
    }
    const hypothetical = { ...project.panelType, ...changes };
    const w = hypothetical.widthM;
    const h = hypothetical.heightM;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      updatePanelType(changes);
      return;
    }
    const mpp = project.mapState.metersPerPixel;
    // Group siblings once per roof so we don't filter project.panels
    // quadratically inside the inner loop.
    const siblingsByRoof = new Map<string, typeof project.panels>();
    for (const p of project.panels) {
      const arr = siblingsByRoof.get(p.roofId) ?? [];
      arr.push(p);
      siblingsByRoof.set(p.roofId, arr);
    }
    const invalidIds: string[] = [];
    for (const p of project.panels) {
      const roof = project.roofs.find((r) => r.id === p.roofId);
      if (!roof) continue;
      const siblings = siblingsByRoof.get(p.roofId) ?? [];
      const orientation = p.orientation;
      if (!panelFitsOnRoof(p, roof, hypothetical, orientation, mpp, siblings)) {
        invalidIds.push(p.id);
      }
    }
    if (invalidIds.length === 0) {
      updatePanelType(changes);
      return;
    }
    const ok = confirm(t('sidebar.panelResizeConfirm', { count: invalidIds.length, w: w.toFixed(3), h: h.toFixed(3) }));
    if (!ok) return;
    // Order matters: delete invalid panels *before* resizing so the
    // deletions renumber strings under the old dimensions, then the
    // resize commits against a clean set.
    deletePanels(invalidIds);
    updatePanelType(changes);
  };

  return (
    <aside
      className="w-80 shrink-0 h-full overflow-y-auto text-ink-100 text-sm"
      style={{
        background: 'linear-gradient(180deg, var(--ink-900) 0%, var(--ink-950) 100%)',
        borderRight: '1px solid var(--hairline-strong)',
      }}
    >
      {/* ── Hero: project name + headline stats ─────────────────────── */}
      {/*
          The hero sits outside the normal Section grid because it IS the
          sidebar's headline. Subtle solar-amber top gradient above it ties
          it to the toolbar visually (both glow faintly amber).
      */}
      <div
        className="px-4 pt-4 pb-5 relative"
        style={{
          borderBottom: '1px solid var(--hairline)',
          backgroundImage:
            'radial-gradient(ellipse 80% 60% at 50% -20%, rgba(245,181,68,0.12), transparent 70%)',
        }}
      >
        <label className="block">
          <span className="field-label">{t('sidebar.project')}</span>
          <input
            className="input font-display"
            style={{
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: '-0.01em',
              padding: '7px 9px',
            }}
            value={project.name}
            onChange={(e) => setProjectName(e.target.value)}
            spellCheck={false}
          />
        </label>

        {/* Mono-typeset stats row. Big numbers + tiny labels — industrial
            instrument feel. The kWp value is emphasized (brighter + larger)
            because it's the one number most users actually quote. */}
        <div className="grid grid-cols-2 gap-2 mt-3">
          <StatCard
            label={t('sidebar.statPanels')}
            value={totalPanels.toString()}
            emphasis={false}
          />
          <StatCard
            label={t('sidebar.statKwp')}
            value={totalKwp.toFixed(2)}
            emphasis
          />
        </div>
        <div className="flex items-center gap-2 mt-3 text-[10.5px] font-mono text-ink-400">
          <span>
            <span className="text-ink-200">{totalStrings}</span> {t('sidebar.stringUnit', { count: totalStrings })}
          </span>
          <span className="opacity-50">·</span>
          <span>
            <span className="text-ink-200">{totalInverters}</span> {t('sidebar.inverterUnit', { count: totalInverters })}
          </span>
          <span className="opacity-50">·</span>
          <span>
            mpp&nbsp;
            <span className="text-ink-200">{project.mapState.metersPerPixel.toFixed(3)}</span>
          </span>
        </div>
      </div>

      {/* ── Body ─────────────────────────────────────────────────────── */}
      <div className="px-4 py-4 space-y-6">

        {/* ── Panel type ──────────────────────────────────────────── */}
        {/*
           Two display modes driven by `activePanelModelId`:
            (a) Catalog-linked (id present): show a read-only summary
                card with manufacturer/model/Wp + a Change button that
                reveals an inline picker. Datasheet link surfaces as "↗"
                when present. Editing the underlying dimensions here
                would desynchronize from the catalog on next load
                (live reference overwrites them), so we don't offer
                inline edit — the user has to either change the
                catalog entry itself from /catalog or pick a different
                model.
            (b) Legacy (no link): keep the original manual inputs so
                pre-catalog projects continue to work. A small "Link to
                catalog" affordance lets the user opt into catalog
                tracking at any point — picking triggers
                setPanelModelFromCatalog which both patches panel_model
                on PB and updates doc.panelType.
        */}
        <section>
          <h3 className="section-title">
            <span>{t('sidebar.panelType')}</span>
          </h3>
          {activePanelModelId ? (
            <div
              className="rounded-lg p-3 space-y-2"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid var(--hairline)',
              }}
            >
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-ink-100 truncate">{project.panelType.name}</div>
                  <div className="font-mono text-[11px] text-ink-400">
                    {`${project.panelType.wattPeak} Wp · ${project.panelType.widthM}×${project.panelType.heightM} m`}
                    {project.panelType.efficiencyPct ? ` · ${project.panelType.efficiencyPct}%` : ''}
                  </div>
                </div>
                {project.panelType.datasheetUrl && (
                  <a
                    href={project.panelType.datasheetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ink-300 hover:text-sun-300 shrink-0"
                    title={t('panelModel.openDatasheet')}
                    aria-label={t('panelModel.openDatasheet')}
                  >
                    ↗
                  </a>
                )}
              </div>
              <button
                className="btn btn-ghost w-full justify-center"
                onClick={() => setPanelPickerOpen((v) => !v)}
                style={{ padding: '6px 8px', fontSize: 12 }}
              >
                {panelPickerOpen ? t('panelModel.closePicker') : t('panelModel.change')}
              </button>
              {panelPickerOpen && (
                <PanelModelPicker
                  value={activePanelModelId}
                  onChange={(_id, record) => {
                    // Fire-and-forget: the async PATCH is handled inside
                    // the store action. If it fails, the local doc is
                    // already updated — the FK will reconcile on next
                    // load via expand. We could surface errors here but
                    // haven't wired an error slot in the sidebar yet.
                    void setPanelModelFromCatalog(record);
                    setPanelPickerOpen(false);
                  }}
                />
              )}
            </div>
          ) : (
            <div className="space-y-2.5">
              <Field label={t('sidebar.model')}>
                <input
                  className="input"
                  value={project.panelType.name}
                  onChange={(e) => updatePanelType({ name: e.target.value })}
                />
              </Field>
              {/* Dimensions on a single row — paired conceptually. */}
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('sidebar.widthM')}>
                  <input
                    type="number"
                    step="0.001"
                    className="input input-mono"
                    value={project.panelType.widthM}
                    onChange={(e) => updatePanelType({ widthM: parseFloat(e.target.value) || 0 })}
                    onBlur={(e) => tryUpdatePanelType({ widthM: parseFloat(e.target.value) || 0 })}
                  />
                </Field>
                <Field label={t('sidebar.heightM')}>
                  <input
                    type="number"
                    step="0.001"
                    className="input input-mono"
                    value={project.panelType.heightM}
                    onChange={(e) => updatePanelType({ heightM: parseFloat(e.target.value) || 0 })}
                    onBlur={(e) => tryUpdatePanelType({ heightM: parseFloat(e.target.value) || 0 })}
                  />
                </Field>
              </div>
              <Field label={t('sidebar.ratedPower')}>
                <input
                  type="number"
                  className="input input-mono"
                  value={project.panelType.wattPeak}
                  onChange={(e) => updatePanelType({ wattPeak: parseInt(e.target.value) || 0 })}
                />
              </Field>
              {/* Affordance to opt-in to catalog tracking. Intentionally
                  tertiary (ghost button, smaller) so it doesn't pull
                  focus from the ordinary manual-edit flow for legacy
                  projects. */}
              <button
                className="btn btn-ghost w-full justify-center"
                onClick={() => setPanelPickerOpen((v) => !v)}
                style={{ padding: '6px 8px', fontSize: 11, opacity: 0.75 }}
              >
                {panelPickerOpen ? t('panelModel.closePicker') : t('panelModel.linkToCatalog')}
              </button>
              {panelPickerOpen && (
                <PanelModelPicker
                  value={null}
                  onChange={(_id, record) => {
                    void setPanelModelFromCatalog(record);
                    setPanelPickerOpen(false);
                  }}
                />
              )}
            </div>
          )}
        </section>

        {/* ── Inverters ───────────────────────────────────────────── */}
        <section>
          <h3 className="section-title">
            <span>{t('sidebar.inverters')}</span>
          </h3>
          <button className="btn btn-ghost w-full justify-center" onClick={addInverter}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>{t('sidebar.addInverter')}</span>
          </button>
          <div className="space-y-1 mt-2">
            {inverters.length === 0 && (
              <p className="text-[11px] text-ink-400 italic px-1 pt-0.5">{t('sidebar.noInverters')}</p>
            )}
            {inverters.map((inv) => {
              const isSelected = inv.id === selectedInverterId;
              // Resolve the linked catalog model (if any) for display.
              // Two possible states:
              //   - inv.inverterModelId set AND cache hit → show mfr/model
              //   - inv.inverterModelId set but cache miss → treat as
              //     unlinked-for-display (the underlying id is still
              //     stored and will re-resolve when the catalog record
              //     loads, but the sidebar can't show metadata for
              //     something it doesn't have cached)
              const linkedModel = inv.inverterModelId
                ? inverterModelCache[inv.inverterModelId]
                : undefined;
              const pickerOpen = inverterPickerOpenFor === inv.id;
              return (
                <div
                  key={inv.id}
                  className="rounded-md cursor-pointer transition-colors"
                  style={{
                    background: isSelected ? 'rgba(245,181,68,0.08)' : 'transparent',
                    border: `1px solid ${isSelected ? 'rgba(245,181,68,0.25)' : 'transparent'}`,
                  }}
                  onClick={() => setSelectedInverter(isSelected ? null : inv.id)}
                >
                  <div className="flex gap-2 items-center p-1.5">
                    {/* Custom radio indicator — same as before. */}
                    <div
                      className="w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0 transition-all"
                      style={{
                        border: `1.5px solid ${isSelected ? 'var(--sun-400)' : 'var(--ink-500)'}`,
                        background: isSelected ? 'rgba(245,181,68,0.1)' : 'transparent',
                      }}
                    >
                      {isSelected && (
                        <div
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ background: 'var(--sun-400)', boxShadow: '0 0 6px var(--glow-sun)' }}
                        />
                      )}
                    </div>
                    <input
                      className="input flex-1"
                      style={{ padding: '3px 6px', fontSize: 12 }}
                      value={inv.name}
                      onChange={(e) => {
                        e.stopPropagation();
                        renameInverter(inv.id, e.target.value);
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <button
                      className="btn btn-danger px-1.5"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(t('sidebar.deleteInverterConfirm', { name: inv.name }))) deleteInverter(inv.id);
                      }}
                      title="Delete inverter"
                    >
                      ×
                    </button>
                  </div>
                  {/* Second line — catalog model info + change affordance.
                      Stops propagation on all clicks so interacting with
                      the picker doesn't toggle the inverter's selected
                      state (which the outer row click handles). */}
                  <div
                    className="px-1.5 pb-1.5 flex items-center gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {linkedModel ? (
                      <>
                        <span className="font-mono text-[10.5px] text-ink-400 truncate flex-1">
                          {`${linkedModel.manufacturer} ${linkedModel.model}`}
                        </span>
                        <button
                          className="btn btn-ghost"
                          style={{ padding: '2px 6px', fontSize: 10 }}
                          onClick={() => setInverterPickerOpenFor(pickerOpen ? null : inv.id)}
                        >
                          {pickerOpen ? t('inverterModel.closePicker') : t('inverterModel.change')}
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn btn-ghost flex-1 justify-center"
                        style={{ padding: '2px 6px', fontSize: 10, opacity: 0.75 }}
                        onClick={() => setInverterPickerOpenFor(pickerOpen ? null : inv.id)}
                      >
                        {pickerOpen ? t('inverterModel.closePicker') : t('inverterModel.linkModel')}
                      </button>
                    )}
                  </div>
                  {pickerOpen && (
                    <div
                      className="px-1.5 pb-1.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <InverterModelPicker
                        value={inv.inverterModelId ?? null}
                        onChange={(id, record) => {
                          linkInverterModel(inv.id, id, record);
                          setInverterPickerOpenFor(null);
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* ── Strings ─────────────────────────────────────────────── */}
        <section>
          <h3 className="section-title">
            <span>{t('sidebar.strings')}</span>
          </h3>
          <button className="btn btn-ghost w-full justify-center" onClick={addString}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>{t('sidebar.newString')}</span>
          </button>
          <div className="space-y-2 mt-2">
            {strings.length === 0 && (
              <p className="text-[11px] text-ink-400 italic px-1 pt-0.5">{t('sidebar.noStrings')}</p>
            )}
            {strings.map((str) => {
              // Live panel count per string — derived, not stored.
              const count = panels.filter((p) => p.stringId === str.id).length;
              const isActive = str.id === activeStringId;
              return (
                <div
                  key={str.id}
                  className="rounded-lg p-2.5 transition-all"
                  style={{
                    background: isActive
                      ? 'linear-gradient(180deg, rgba(36,33,26,0.95) 0%, rgba(18,16,9,0.8) 100%)'
                      : 'rgba(18,16,9,0.35)',
                    // Border color reflects the string color when active, so the
                    // card reads as a visible "link" to its wire-color on the canvas.
                    border: isActive
                      ? `1px solid ${str.color}55`
                      : '1px solid var(--hairline)',
                    boxShadow: isActive
                      ? `inset 0 1px 0 rgba(255,255,255,0.04), 0 0 16px -6px ${str.color}66`
                      : 'inset 0 1px 0 rgba(255,255,255,0.03)',
                  }}
                >
                  <div className="flex items-center gap-2">
                    {/* Color swatch — clicking opens the native color
                        picker. The swatch itself gets a subtle ring when
                        the string is active. */}
                    <div className="relative w-5 h-5 shrink-0 group">
                      <input
                        type="color"
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                        value={str.color}
                        onChange={(e) => updateString(str.id, { color: e.target.value })}
                        title="Change color"
                      />
                      <div
                        className="w-full h-full rounded"
                        style={{
                          background: str.color,
                          border: '1px solid rgba(0,0,0,0.5)',
                          boxShadow: `0 0 0 1px rgba(255,255,255,0.06), ${
                            isActive ? `0 0 10px ${str.color}99` : 'none'
                          }`,
                          transition: 'box-shadow 160ms ease',
                        }}
                      />
                    </div>
                    <button
                      className="flex-1 text-left text-[12.5px] font-medium truncate transition-colors hover:text-sun-300"
                      onClick={() => {
                        setActiveString(str.id);
                        setToolMode('assign-string');
                      }}
                      title="Activate for lasso assignment"
                      style={{ color: isActive ? 'var(--ink-50)' : 'var(--ink-200)' }}
                    >
                      {str.label}
                    </button>
                    {/* Panel count chip. Mono for numeric alignment across
                        cards of varying name lengths. */}
                    <span className="chip font-mono" style={{ fontSize: 10.5 }}>
                      {count}
                      <span className="opacity-60">p</span>
                    </span>
                    <button
                      className="btn btn-danger px-1.5"
                      onClick={() => {
                        if (confirm(t('sidebar.deleteStringConfirm', { label: str.label }))) {
                          deleteString(str.id);
                        }
                      }}
                      title="Delete string"
                    >
                      ×
                    </button>
                  </div>
                  {/* Inverter assignment — empty option maps to null. */}
                  <select
                    className="input mt-2"
                    style={{ fontSize: 11 }}
                    value={str.inverterId || ''}
                    onChange={(e) => setStringInverter(str.id, e.target.value || null)}
                  >
                    <option value="">{t('sidebar.noInverterOption')}</option>
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
        </section>

        {/* ── Selected roof (conditional) ─────────────────────────── */}
        {selectedRoof && (
          <section>
            <h3 className="section-title">
              <span>{t('sidebar.roof')}</span>
              <span
                className="chip chip-amber font-mono"
                style={{ fontSize: 10, textTransform: 'none', letterSpacing: 0 }}
              >
                {t('sidebar.selected')}
              </span>
            </h3>
            <div
              className="rounded-lg p-3 space-y-3"
              style={{
                // A thin amber top edge — "focus line" indicating this is
                // the currently-highlighted object on the canvas.
                borderTop: '2px solid var(--sun-400)',
                background: 'linear-gradient(180deg, rgba(36,33,26,0.9) 0%, rgba(18,16,9,0.7) 100%)',
                border: '1px solid var(--hairline)',
                borderTopColor: 'var(--sun-400)',
                boxShadow: '0 8px 24px -14px rgba(0,0,0,0.8)',
              }}
            >
              <Field label={t('sidebar.name')}>
                <input
                  className="input"
                  value={selectedRoof.name}
                  onChange={(e) => updateRoof(selectedRoof.id, { name: e.target.value })}
                />
              </Field>
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <span className="field-label" style={{ marginBottom: 0 }}>{t('sidebar.tilt')}</span>
                  <span className="font-mono text-[13px]" style={{ color: 'var(--sun-300)' }}>
                    {selectedRoof.tiltDeg}°
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={60}
                  value={selectedRoof.tiltDeg}
                  className="slider"
                  // CSS var `--val` drives the filled portion of the track.
                  // Range is 0-60, so normalize to a percentage.
                  style={{ ['--val' as string]: `${(selectedRoof.tiltDeg / 60) * 100}%` }}
                  onChange={(e) => updateRoof(selectedRoof.id, { tiltDeg: parseInt(e.target.value) })}
                />
                {/* Tick row — gives the slider a measuring-tape quality
                    without needing real ticks (which would fight the
                    filled-track gradient). */}
                <div className="flex justify-between text-[9.5px] font-mono text-ink-400 mt-1 px-0.5">
                  <span>0°</span>
                  <span>15°</span>
                  <span>30°</span>
                  <span>45°</span>
                  <span>60°</span>
                </div>
              </div>

              <Field
                label={
                  orientationTargetsGroup
                    ? t('sidebar.orientationGroup')
                    : t('sidebar.orientationRoof')
                }
              >
                {/* Portrait / landscape segmented toggle. Scope depends on
                    whether a panel group is active on this roof — group-
                    scoped flips the existing group's panels in place; roof-
                    default scope applies to newly-created groups. Behavior
                    unchanged from prior impl; just a visual upgrade. */}
                <div className="segmented" style={{ width: '100%' }}>
                  {(['portrait', 'landscape'] as const).map((o) => (
                    <button
                      key={o}
                      data-active={currentOrientation === o || undefined}
                      className="segment flex-1 justify-center"
                      onClick={() => {
                        if (orientationTargetsGroup && activePanelGroupId) {
                          updateGroupOrientation(activePanelGroupId, o);
                        } else {
                          updateRoof(selectedRoof.id, { panelOrientation: o });
                        }
                      }}
                    >
                      {/* Tiny orientation glyph so the toggle isn't purely
                          text — vertical rect = portrait, horizontal = landscape */}
                      {o === 'portrait' ? (
                        <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
                          <rect x="1" y="1" width="8" height="10" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
                        </svg>
                      ) : (
                        <svg width="12" height="10" viewBox="0 0 12 10" fill="none">
                          <rect x="1" y="1" width="10" height="8" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
                        </svg>
                      )}
                      <span>{o === 'portrait' ? t('sidebar.orientationPortrait') : t('sidebar.orientationLandscape')}</span>
                    </button>
                  ))}
                </div>
              </Field>

              <RoofAreaInfo roof={selectedRoof} mpp={project.mapState.metersPerPixel} />

              <button
                className="btn btn-danger w-full justify-center"
                style={{ marginTop: 4 }}
                onClick={() => {
                  if (confirm(t('sidebar.deleteRoofConfirm', { name: selectedRoof.name }))) deleteRoof(selectedRoof.id);
                }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M3 5H13M6 5V3H10V5M5 5L6 13H10L11 5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                </svg>
                <span>{t('sidebar.deleteRoof')}</span>
              </button>
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}

/**
 * Hero stat card. Big mono numeric + tiny small-caps label. The emphasis
 * flag paints the card with a subtle amber glow — used for the headline
 * figure (kWp) so the eye goes there first.
 */
function StatCard({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis: boolean;
}) {
  return (
    <div
      className="surface rounded-lg px-3 py-2"
      style={{
        background: emphasis
          ? 'linear-gradient(180deg, rgba(245,181,68,0.1) 0%, rgba(50,46,37,0.7) 100%)'
          : undefined,
        borderColor: emphasis ? 'rgba(245,181,68,0.25)' : undefined,
      }}
    >
      <div
        className="font-mono leading-none"
        style={{
          fontSize: emphasis ? 22 : 18,
          fontWeight: 500,
          letterSpacing: '-0.02em',
          color: emphasis ? 'var(--sun-300)' : 'var(--ink-100)',
          // Subtle amber glow on the emphasized number
          textShadow: emphasis ? '0 0 16px rgba(245,181,68,0.35)' : undefined,
        }}
      >
        {value}
      </div>
      <div
        className="mt-1 font-mono uppercase"
        style={{
          fontSize: 9.5,
          letterSpacing: '0.14em',
          color: 'var(--ink-400)',
        }}
      >
        {label}
      </div>
    </div>
  );
}

/** Labeled form field. Block <label> so clicking the label focuses the child. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

/**
 * Projected vs. actual roof area.
 *
 * Projected = polygonArea(px) × mpp²  → m² as drawn on the satellite view.
 * Actual (on-slope) = projected / cos(tilt). This is the real walkable surface
 * the installer works with, which is what matters for panel counting.
 */
function RoofAreaInfo({
  roof,
  mpp,
}: {
  roof: ReturnType<typeof useProjectStore.getState>['project']['roofs'][number];
  mpp: number;
}) {
  const { t } = useTranslation();
  const projectedAreaPx = polygonArea(roof.polygon);
  const projectedAreaM2 = projectedAreaPx * mpp * mpp;
  const cosT = Math.cos((roof.tiltDeg * Math.PI) / 180);
  // Guard cosT=0 — only reachable at 90° which the slider can't produce,
  // but a defensive fallback costs nothing.
  const realAreaM2 = cosT > 0 ? projectedAreaM2 / cosT : projectedAreaM2;
  return (
    <div
      className="rounded-md px-3 py-2 space-y-1 font-mono"
      style={{
        background: 'rgba(10,8,4,0.4)',
        border: '1px solid var(--hairline)',
        fontSize: 11,
      }}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-ink-400 text-[10px] uppercase tracking-wider">{t('sidebar.projected')}</span>
        <span className="text-ink-100">
          {projectedAreaM2.toFixed(1)}<span className="text-ink-400 text-[10px] ml-0.5">m²</span>
        </span>
      </div>
      <div className="flex items-baseline justify-between">
        <span className="text-ink-400 text-[10px] uppercase tracking-wider">{t('sidebar.sloped')}</span>
        <span className="text-sun-300">
          {realAreaM2.toFixed(1)}<span className="text-ink-400 text-[10px] ml-0.5">m²</span>
        </span>
      </div>
    </div>
  );
}
