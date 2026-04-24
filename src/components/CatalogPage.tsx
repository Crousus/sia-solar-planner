// ────────────────────────────────────────────────────────────────────────
// CatalogPage — /catalog
//
// Global (not team-scoped) CRUD page for the hardware catalog. Two tabs:
//   - Panels     — panel_models collection
//   - Inverters  — inverter_models collection
//
// Layout mirrors CustomersPage.tsx: header with "New entry" button, then
// either an inline edit form (editingId !== null) or the list. Kept in a
// single file rather than split per-tab because the two tabs share
// enough skeleton (tab switcher, empty state, delete confirm flow) that
// factoring it out would just create indirection without reducing lines.
//
// Delete policy (important!):
//   - Panel models: a PB relation on projects.panel_model means a hard
//     delete would orphan linked projects. Before deleting, we probe
//     for any reference; if any, switch to SOFT delete (flip
//     deleted=true) which hides the entry from pickers but keeps
//     existing links resolvable.
//   - Inverter models: no server-side FK (inverter.inverterModelId
//     lives inside the opaque doc JSON). Always hard delete. In-use
//     entries simply won't resolve in pickers, which is benign.
//
// Form design:
//   - All fields are always visible — no expand/collapse. The forms
//     have many fields but the user is focused on one entry at a time
//     and scrolling inside a form is acceptable for this "admin-ish" flow.
//   - datasheetUrl gets an inline <a target="_blank"> icon next to the
//     input so the user can verify the URL they're typing as they type.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { InverterModelRecord, PanelModelRecord } from '../backend/types';
import { useAuthUser } from './AppShell';
import { PageShell } from './PageShell';

// ── Datasheet import helpers ───────────────────────────────────────────────────
// These types mirror the JSON the ocr-service returns after LLM extraction.
// Fields are optional — the LLM omits ones it can't find.

interface PanelExtractResult {
  manufacturer?: string; model?: string;
  wattPeak?: number;
  voc?: number; isc?: number; vmpp?: number; impp?: number;
  efficiencyPct?: number; weightKg?: number;
  widthM?: number; heightM?: number;
  tempCoefficientPmax?: number;
}
interface InverterExtractResult {
  manufacturer?: string; model?: string;
  maxAcPowerW?: number; maxDcPowerW?: number;
  efficiencyPct?: number; maxInputVoltageV?: number;
  phases?: number; maxStrings?: number;
  mpptCount?: number; maxDcCurrentA?: number; stringsPerMppt?: number;
}

// Round to a fixed number of decimal places and strip trailing zeros so form
// inputs show "430" not "430.0000000000001".
function fmt(n: number, decimals = 4): string {
  return parseFloat(n.toFixed(decimals)).toString();
}

// Tab identifier kept local to this file — no other component cares
// about this enum.
type Tab = 'panels' | 'inverters';

// ── Form state shapes ──────────────────────────────────────────────
// Kept as plain strings even for numeric fields so the user can type
// intermediate values like "1." or "" without validation fighting the
// input mid-typing. We parse at submit-time via `numOrUndef`.

interface PanelFormState {
  manufacturer: string;
  model: string;
  widthM: string;
  heightM: string;
  wattPeak: string;
  efficiencyPct: string;
  weightKg: string;
  voc: string;
  isc: string;
  vmpp: string;
  impp: string;
  tempCoefficientPmax: string;
  warrantyYears: string;
  datasheetUrl: string;
}
function emptyPanelForm(): PanelFormState {
  return {
    manufacturer: '', model: '',
    widthM: '', heightM: '', wattPeak: '',
    efficiencyPct: '', weightKg: '', voc: '', isc: '',
    vmpp: '', impp: '', tempCoefficientPmax: '', warrantyYears: '',
    datasheetUrl: '',
  };
}
function panelRecordToForm(r: PanelModelRecord): PanelFormState {
  return {
    manufacturer: r.manufacturer ?? '',
    model: r.model ?? '',
    widthM: r.widthM?.toString() ?? '',
    heightM: r.heightM?.toString() ?? '',
    wattPeak: r.wattPeak?.toString() ?? '',
    efficiencyPct: r.efficiencyPct?.toString() ?? '',
    weightKg: r.weightKg?.toString() ?? '',
    voc: r.voc?.toString() ?? '',
    isc: r.isc?.toString() ?? '',
    vmpp: r.vmpp?.toString() ?? '',
    impp: r.impp?.toString() ?? '',
    tempCoefficientPmax: r.tempCoefficientPmax?.toString() ?? '',
    warrantyYears: r.warrantyYears?.toString() ?? '',
    datasheetUrl: r.datasheetUrl ?? '',
  };
}

interface InverterFormState {
  manufacturer: string;
  model: string;
  maxAcPowerW: string;
  maxDcPowerW: string;
  efficiencyPct: string;
  phases: string;
  maxStrings: string;
  maxInputVoltageV: string;
  mpptCount: string;
  maxDcCurrentA: string;
  stringsPerMppt: string;
  datasheetUrl: string;
}
function emptyInverterForm(): InverterFormState {
  return {
    manufacturer: '', model: '',
    maxAcPowerW: '', maxDcPowerW: '', efficiencyPct: '',
    phases: '', maxStrings: '', maxInputVoltageV: '',
    mpptCount: '', maxDcCurrentA: '', stringsPerMppt: '',
    datasheetUrl: '',
  };
}
function inverterRecordToForm(r: InverterModelRecord): InverterFormState {
  return {
    manufacturer: r.manufacturer ?? '',
    model: r.model ?? '',
    maxAcPowerW: r.maxAcPowerW?.toString() ?? '',
    maxDcPowerW: r.maxDcPowerW?.toString() ?? '',
    efficiencyPct: r.efficiencyPct?.toString() ?? '',
    phases: r.phases?.toString() ?? '',
    maxStrings: r.maxStrings?.toString() ?? '',
    maxInputVoltageV: r.maxInputVoltageV?.toString() ?? '',
    mpptCount: r.mpptCount?.toString() ?? '',
    maxDcCurrentA: r.maxDcCurrentA?.toString() ?? '',
    stringsPerMppt: r.stringsPerMppt?.toString() ?? '',
    datasheetUrl: r.datasheetUrl ?? '',
  };
}

/** Parse a numeric string → number | undefined (for optional fields).
 *  Empty / NaN → undefined so we can omit the key from the PB write
 *  rather than sending 0 (which would be a meaningful — and wrong —
 *  value for some fields). */
function numOrUndef(s: string): number | undefined {
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  const n = parseFloat(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

export default function CatalogPage() {
  const { t } = useTranslation();
  const user = useAuthUser();
  const navigate = useNavigate();

  const [tab, setTab] = useState<Tab>('panels');

  // Separate data + editing state per tab. We could unify into a single
  // editingId / form pair if we keyed everything by tab, but two
  // separate slices read more simply — tab switching naturally wipes
  // nothing because each tab owns its own state.
  const [panels, setPanels] = useState<PanelModelRecord[] | null>(null);
  const [inverters, setInverters] = useState<InverterModelRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editingPanelId, setEditingPanelId] = useState<'new' | string | null>(null);
  const [panelForm, setPanelForm] = useState<PanelFormState>(emptyPanelForm());
  const [editingInverterId, setEditingInverterId] = useState<'new' | string | null>(null);
  const [inverterForm, setInverterForm] = useState<InverterFormState>(emptyInverterForm());
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function signOut() {
    pb.authStore.clear();
    navigate('/login', { replace: true });
  }

  // Fetch both collections in parallel so the user can tab between them
  // without a second loading state. Deleted entries are filtered server-
  // side so the CRUD list never shows soft-deleted rows.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    Promise.all([
      pb.collection('panel_models').getFullList<PanelModelRecord>({
        filter: 'deleted=false',
        sort: 'manufacturer,model',
      }),
      pb.collection('inverter_models').getFullList<InverterModelRecord>({
        filter: 'deleted=false',
        sort: 'manufacturer,model',
      }),
    ])
      .then(([pans, invs]) => {
        if (cancelled) return;
        setPanels(pans);
        setInverters(invs);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? 'Failed to load catalog');
      });
    return () => { cancelled = true; };
  }, [user]);

  // ── Panel CRUD handlers ──────────────────────────────────────────
  function startCreatePanel() {
    setEditingPanelId('new');
    setPanelForm(emptyPanelForm());
    setFormError(null);
  }
  function startEditPanel(r: PanelModelRecord) {
    setEditingPanelId(r.id);
    setPanelForm(panelRecordToForm(r));
    setFormError(null);
  }
  function cancelPanelEdit() {
    setEditingPanelId(null);
    setFormError(null);
  }

  async function handleSavePanel(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    // Only the four hard-required fields block submission. The optional
    // fields can be blank.
    if (!panelForm.manufacturer.trim() || !panelForm.model.trim()) return;
    const widthM = numOrUndef(panelForm.widthM);
    const heightM = numOrUndef(panelForm.heightM);
    const wattPeak = numOrUndef(panelForm.wattPeak);
    if (widthM === undefined || heightM === undefined || wattPeak === undefined) {
      setFormError(t('catalog.errorRequiredNumbers'));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      // Build the payload. We conditionally include each optional field
      // only when present — empty strings would round-trip through PB
      // as '' and later confuse number fields on read.
      const payload = {
        manufacturer: panelForm.manufacturer.trim(),
        model: panelForm.model.trim(),
        widthM, heightM, wattPeak,
        deleted: false,
        ...(numOrUndef(panelForm.efficiencyPct) !== undefined ? { efficiencyPct: numOrUndef(panelForm.efficiencyPct) } : {}),
        ...(numOrUndef(panelForm.weightKg) !== undefined ? { weightKg: numOrUndef(panelForm.weightKg) } : {}),
        ...(numOrUndef(panelForm.voc) !== undefined ? { voc: numOrUndef(panelForm.voc) } : {}),
        ...(numOrUndef(panelForm.isc) !== undefined ? { isc: numOrUndef(panelForm.isc) } : {}),
        ...(numOrUndef(panelForm.vmpp) !== undefined ? { vmpp: numOrUndef(panelForm.vmpp) } : {}),
        ...(numOrUndef(panelForm.impp) !== undefined ? { impp: numOrUndef(panelForm.impp) } : {}),
        ...(numOrUndef(panelForm.tempCoefficientPmax) !== undefined ? { tempCoefficientPmax: numOrUndef(panelForm.tempCoefficientPmax) } : {}),
        ...(numOrUndef(panelForm.warrantyYears) !== undefined ? { warrantyYears: numOrUndef(panelForm.warrantyYears) } : {}),
        ...(panelForm.datasheetUrl.trim() ? { datasheetUrl: panelForm.datasheetUrl.trim() } : {}),
      };
      if (editingPanelId === 'new') {
        const rec = await pb.collection('panel_models').create<PanelModelRecord>(payload);
        setPanels((prev) => [...(prev ?? []), rec].sort(comparePanels));
      } else if (editingPanelId) {
        const rec = await pb.collection('panel_models').update<PanelModelRecord>(editingPanelId, payload);
        setPanels((prev) => (prev ?? []).map((p) => (p.id === rec.id ? rec : p)).sort(comparePanels));
      }
      setEditingPanelId(null);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeletePanel(id: string) {
    if (!confirm(t('catalog.deletePanelConfirm'))) return;
    try {
      // Check for references before deciding between hard vs soft delete.
      // getList(1, 1) asks for a single row just to read totalItems —
      // cheap and doesn't pull any doc data back.
      const refs = await pb.collection('projects').getList(1, 1, {
        filter: `panel_model="${id}"`,
      });
      if (refs.totalItems > 0) {
        // Soft delete — flip deleted=true so pickers hide it but
        // existing projects still resolve the expand.
        await pb.collection('panel_models').update(id, { deleted: true });
      } else {
        await pb.collection('panel_models').delete(id);
      }
      setPanels((prev) => (prev ?? []).filter((p) => p.id !== id));
      if (editingPanelId === id) setEditingPanelId(null);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Delete failed.');
    }
  }

  // ── Inverter CRUD handlers ───────────────────────────────────────
  function startCreateInverter() {
    setEditingInverterId('new');
    setInverterForm(emptyInverterForm());
    setFormError(null);
  }
  function startEditInverter(r: InverterModelRecord) {
    setEditingInverterId(r.id);
    setInverterForm(inverterRecordToForm(r));
    setFormError(null);
  }
  function cancelInverterEdit() {
    setEditingInverterId(null);
    setFormError(null);
  }

  async function handleSaveInverter(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!inverterForm.manufacturer.trim() || !inverterForm.model.trim()) return;
    const maxAcPowerW = numOrUndef(inverterForm.maxAcPowerW);
    if (maxAcPowerW === undefined) {
      setFormError(t('catalog.errorRequiredNumbers'));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const payload = {
        manufacturer: inverterForm.manufacturer.trim(),
        model: inverterForm.model.trim(),
        maxAcPowerW,
        deleted: false,
        ...(numOrUndef(inverterForm.maxDcPowerW) !== undefined ? { maxDcPowerW: numOrUndef(inverterForm.maxDcPowerW) } : {}),
        ...(numOrUndef(inverterForm.efficiencyPct) !== undefined ? { efficiencyPct: numOrUndef(inverterForm.efficiencyPct) } : {}),
        ...(numOrUndef(inverterForm.phases) !== undefined ? { phases: numOrUndef(inverterForm.phases) } : {}),
        ...(numOrUndef(inverterForm.maxStrings) !== undefined ? { maxStrings: numOrUndef(inverterForm.maxStrings) } : {}),
        ...(numOrUndef(inverterForm.maxInputVoltageV) !== undefined ? { maxInputVoltageV: numOrUndef(inverterForm.maxInputVoltageV) } : {}),
        ...(numOrUndef(inverterForm.mpptCount) !== undefined ? { mpptCount: numOrUndef(inverterForm.mpptCount) } : {}),
        ...(numOrUndef(inverterForm.maxDcCurrentA) !== undefined ? { maxDcCurrentA: numOrUndef(inverterForm.maxDcCurrentA) } : {}),
        ...(numOrUndef(inverterForm.stringsPerMppt) !== undefined ? { stringsPerMppt: numOrUndef(inverterForm.stringsPerMppt) } : {}),
        ...(inverterForm.datasheetUrl.trim() ? { datasheetUrl: inverterForm.datasheetUrl.trim() } : {}),
      };
      if (editingInverterId === 'new') {
        const rec = await pb.collection('inverter_models').create<InverterModelRecord>(payload);
        setInverters((prev) => [...(prev ?? []), rec].sort(compareInverters));
      } else if (editingInverterId) {
        const rec = await pb.collection('inverter_models').update<InverterModelRecord>(editingInverterId, payload);
        setInverters((prev) => (prev ?? []).map((i) => (i.id === rec.id ? rec : i)).sort(compareInverters));
      }
      setEditingInverterId(null);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteInverter(id: string) {
    // No FK to check for — inverter models are referenced only inside
    // opaque doc JSON. Always hard delete. The confirm copy mentions
    // that linked inverters will simply show "no model" after delete,
    // so the user isn't surprised by downstream UI behavior.
    if (!confirm(t('catalog.deleteInverterConfirm'))) return;
    try {
      await pb.collection('inverter_models').delete(id);
      setInverters((prev) => (prev ?? []).filter((i) => i.id !== id));
      if (editingInverterId === id) setEditingInverterId(null);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Delete failed.');
    }
  }

  const loading = panels === null || inverters === null;

  return (
    <PageShell
      label="FIG_05 · CATALOG"
      userEmail={user?.email}
      onSignOut={signOut}
      width="default"
    >
      {error && (
        <div
          role="alert"
          className="rounded-lg px-3 py-2 text-[12.5px] mb-4"
          style={{
            background: 'rgba(255, 99, 99, 0.08)',
            border: '1px solid rgba(255, 99, 99, 0.35)',
            color: 'var(--sun-200)',
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div>
          <div className="h-6 w-40 rounded bg-white/[0.04] mb-3 animate-pulse" />
          <div className="h-11 w-72 rounded bg-white/[0.04] mb-10 animate-pulse" />
        </div>
      ) : (
        <>
          <header className="mb-6">
            <div className="flex items-end justify-between gap-4">
              <div>
                <span className="tech-label" style={{ fontSize: 12 }}>{t('catalog.sectionTitle')}</span>
                <h1 className="mt-1 font-editorial text-[44px] leading-[1.05] tracking-tight text-ink-50">
                  {t('catalog.pageTitle')}
                </h1>
                <p className="mt-2 text-ink-300 text-[13.5px] max-w-sm">{t('catalog.pageDesc')}</p>
              </div>
              <button
                onClick={tab === 'panels' ? startCreatePanel : startCreateInverter}
                className="btn btn-primary shrink-0"
                style={{ padding: '11px 18px', fontSize: 14 }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <span>{t('catalog.newEntry')}</span>
              </button>
            </div>
          </header>

          {/* Tab switcher — plain buttons with data-active mirroring the
              existing segmented-control style used elsewhere. */}
          <div className="segmented mb-5" style={{ width: 'fit-content' }}>
            <button
              className="segment"
              data-active={tab === 'panels' || undefined}
              onClick={() => { setTab('panels'); setEditingInverterId(null); }}
            >
              {t('catalog.tabPanels')}
            </button>
            <button
              className="segment"
              data-active={tab === 'inverters' || undefined}
              onClick={() => { setTab('inverters'); setEditingPanelId(null); }}
            >
              {t('catalog.tabInverters')}
            </button>
          </div>

          {tab === 'panels' ? (
            <PanelsTab
              records={panels!}
              editingId={editingPanelId}
              form={panelForm}
              setForm={setPanelForm}
              onSave={handleSavePanel}
              onCancel={cancelPanelEdit}
              onStartEdit={startEditPanel}
              onDelete={handleDeletePanel}
              busy={busy}
              formError={formError}
            />
          ) : (
            <InvertersTab
              records={inverters!}
              editingId={editingInverterId}
              form={inverterForm}
              setForm={setInverterForm}
              onSave={handleSaveInverter}
              onCancel={cancelInverterEdit}
              onStartEdit={startEditInverter}
              onDelete={handleDeleteInverter}
              busy={busy}
              formError={formError}
            />
          )}
        </>
      )}
    </PageShell>
  );
}

// ── Sorting helpers ───────────────────────────────────────────────
// Both lists are sorted by manufacturer then model. Using localeCompare
// so German umlauts sort naturally (ä after a, etc.).
function comparePanels(a: PanelModelRecord, b: PanelModelRecord): number {
  return a.manufacturer.localeCompare(b.manufacturer) || a.model.localeCompare(b.model);
}
function compareInverters(a: InverterModelRecord, b: InverterModelRecord): number {
  return a.manufacturer.localeCompare(b.manufacturer) || a.model.localeCompare(b.model);
}

// ── Panels tab ────────────────────────────────────────────────────
interface PanelsTabProps {
  records: PanelModelRecord[];
  editingId: 'new' | string | null;
  form: PanelFormState;
  setForm: (updater: (f: PanelFormState) => PanelFormState) => void;
  onSave: (e: React.FormEvent) => void;
  onCancel: () => void;
  onStartEdit: (r: PanelModelRecord) => void;
  onDelete: (id: string) => void;
  busy: boolean;
  formError: string | null;
}

function PanelsTab(p: PanelsTabProps) {
  const { t } = useTranslation();
  const field = (key: keyof PanelFormState) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      p.setForm((f) => ({ ...f, [key]: e.target.value }));

  // Import state — kept separate from the form's busy/error so the Import
  // button doesn't interfere with the Save spinner.
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState(0);
  // Populated when the LLM finds multiple product variants; the user picks
  // one and the form fills. Cleared on entry edit switch or after picking.
  const [importVariants, setImportVariants] = useState<PanelExtractResult[] | null>(null);

  // Clear stale picker/message whenever a different catalog entry is opened.
  useEffect(() => {
    setImportVariants(null);
    setImportMsg(null);
    setImportProgress(0);
  }, [p.editingId]);

  function applyVariant(d: PanelExtractResult) {
    const patch: Partial<PanelFormState> = {};
    if (d.manufacturer        !== undefined) patch.manufacturer        = d.manufacturer;
    if (d.model               !== undefined) patch.model               = d.model;
    if (d.wattPeak            !== undefined) patch.wattPeak            = fmt(d.wattPeak, 0);
    if (d.voc                 !== undefined) patch.voc                 = fmt(d.voc, 2);
    if (d.isc                 !== undefined) patch.isc                 = fmt(d.isc, 2);
    if (d.vmpp                !== undefined) patch.vmpp                = fmt(d.vmpp, 2);
    if (d.impp                !== undefined) patch.impp                = fmt(d.impp, 2);
    if (d.efficiencyPct       !== undefined) patch.efficiencyPct       = fmt(d.efficiencyPct, 2);
    if (d.weightKg            !== undefined) patch.weightKg            = fmt(d.weightKg, 1);
    if (d.widthM              !== undefined) patch.widthM              = fmt(d.widthM, 3);
    if (d.heightM             !== undefined) patch.heightM             = fmt(d.heightM, 3);
    if (d.tempCoefficientPmax !== undefined) patch.tempCoefficientPmax = fmt(d.tempCoefficientPmax, 3);
    const count = Object.keys(patch).length;
    if (count > 0) p.setForm((f) => ({ ...f, ...patch }));
    setImportVariants(null);
    setImportMsg(t(count > 0 ? 'catalog.importOk' : 'catalog.importNone', { count }));
  }

  async function handleImport() {
    const url = p.form.datasheetUrl.trim();
    if (!url || importing) return;
    setImporting(true);
    setImportMsg(null);
    setImportVariants(null);
    setImportProgress(0);
    try {
      const res = await fetch('/api/sp/parse-datasheet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pb.authStore.token}`,
        },
        body: JSON.stringify({ url, type: 'panel' }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setImportMsg(t('catalog.importError', { message: (data as { error?: string; detail?: string }).error ?? (data as { detail?: string }).detail ?? 'request failed' }));
        return;
      }
      // Read the ndjson stream line by line and advance the progress bar.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: Record<string, unknown>;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.progress === 'downloaded') setImportProgress(33);
          else if (msg.progress === 'extracted') setImportProgress(66);
          else if (typeof msg.error === 'string') {
            setImportMsg(t('catalog.importError', { message: msg.error }));
            break outer;
          } else if (Array.isArray(msg.result)) {
            setImportProgress(100);
            const variants = msg.result as PanelExtractResult[];
            if (variants.length === 0) {
              setImportMsg(t('catalog.importNone', { count: 0 }));
            } else if (variants.length === 1) {
              applyVariant(variants[0]);
            } else {
              setImportVariants(variants);
            }
            break outer;
          }
        }
      }
    } catch {
      setImportMsg(t('catalog.importError', { message: 'network error' }));
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      {p.editingId !== null && (
        <form onSubmit={p.onSave} className="surface rounded-[14px] p-6 mb-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="field-label">{t('panelModel.manufacturer')}</span>
              <input className="input" value={p.form.manufacturer} onChange={field('manufacturer')} required autoFocus maxLength={100} />
            </label>
            <label className="block">
              <span className="field-label">{t('panelModel.model')}</span>
              <input className="input" value={p.form.model} onChange={field('model')} required maxLength={100} />
            </label>
            <label className="block">
              <span className="field-label">{t('panelModel.widthM')}</span>
              <input className="input input-mono" type="number" step="0.001" value={p.form.widthM} onChange={field('widthM')} required />
            </label>
            <label className="block">
              <span className="field-label">{t('panelModel.heightM')}</span>
              <input className="input input-mono" type="number" step="0.001" value={p.form.heightM} onChange={field('heightM')} required />
            </label>
            <label className="block">
              <span className="field-label">{t('panelModel.wattPeak')}</span>
              <input className="input input-mono" type="number" step="1" value={p.form.wattPeak} onChange={field('wattPeak')} required />
            </label>
            <label className="block">
              <span className="field-label">{t('panelModel.efficiencyPct')}</span>
              <input className="input input-mono" type="number" step="0.1" value={p.form.efficiencyPct} onChange={field('efficiencyPct')} />
            </label>
            <label className="block">
              <span className="field-label">{t('panelModel.weightKg')}</span>
              <input className="input input-mono" type="number" step="0.1" value={p.form.weightKg} onChange={field('weightKg')} />
            </label>
            <label className="block">
              <span className="field-label">{t('panelModel.voc')}</span>
              <input className="input input-mono" type="number" step="0.01" value={p.form.voc} onChange={field('voc')} />
            </label>
            <label className="block">
              <span className="field-label">{t('panelModel.isc')}</span>
              <input className="input input-mono" type="number" step="0.01" value={p.form.isc} onChange={field('isc')} />
            </label>
            <label className="block">
              <span className="field-label">{t('panelModel.vmpp')}</span>
              <input className="input input-mono" type="number" step="0.01" value={p.form.vmpp} onChange={field('vmpp')} />
            </label>
            <label className="block">
              <span className="field-label">{t('panelModel.impp')}</span>
              <input className="input input-mono" type="number" step="0.01" value={p.form.impp} onChange={field('impp')} />
            </label>
            <label className="block">
              <span className="field-label">{t('panelModel.tempCoefficientPmax')}</span>
              <input className="input input-mono" type="number" step="0.001" value={p.form.tempCoefficientPmax} onChange={field('tempCoefficientPmax')} />
            </label>
            <label className="block">
              <span className="field-label">{t('panelModel.warrantyYears')}</span>
              <input className="input input-mono" type="number" step="1" value={p.form.warrantyYears} onChange={field('warrantyYears')} />
            </label>
            <label className="col-span-2 block">
              <span className="field-label">{t('panelModel.datasheetUrl')}</span>
              <div className="flex gap-2 items-center">
                <input className="input flex-1" type="url" value={p.form.datasheetUrl} onChange={field('datasheetUrl')} placeholder="https://…" maxLength={500} />
                {/* Inline verify link — opens the URL in a new tab so
                    the user can confirm the datasheet is right. */}
                {p.form.datasheetUrl.trim() && (
                  <a
                    href={p.form.datasheetUrl.trim()}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-ghost"
                    style={{ padding: '8px 10px', fontSize: 13 }}
                    title={t('panelModel.openDatasheet')}
                  >
                    ↗
                  </a>
                )}
                {/* Import button: downloads the PDF, OCRs it, sends the
                    text to Gemini, and auto-fills the numeric fields. */}
                {p.form.datasheetUrl.trim() && (
                  <button
                    type="button"
                    onClick={handleImport}
                    disabled={importing || p.busy}
                    className="btn btn-ghost"
                    style={{ padding: '8px 12px', fontSize: 13, whiteSpace: 'nowrap' }}
                  >
                    {importing && (
                      <span
                        className="inline-block w-[11px] h-[11px] rounded-full border-2 border-current border-t-transparent animate-spin mr-1.5 align-[-1px]"
                        aria-hidden
                      />
                    )}
                    {importing ? t('catalog.importing') : t('catalog.importBtn')}
                  </button>
                )}
              </div>
              {/* Slim progress bar — only visible while an import is in
                  flight. Advances through three real server-side stages:
                  0 → 33 (PDF downloaded) → 66 (text extracted) → 100 (done). */}
              {(importing || importProgress > 0) && (
                <div className="mt-2 h-[3px] rounded-full overflow-hidden" style={{ background: 'var(--surface-1, rgba(255,255,255,0.08))' }}>
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${importProgress}%`,
                      background: 'var(--sun-300, #f59e0b)',
                      transition: importProgress === 0 ? 'none' : 'width 0.4s ease',
                    }}
                  />
                </div>
              )}
              {/* Variant picker: shown when the LLM found multiple power
                  classes on the same datasheet. Click one to fill the form. */}
              {importVariants && (
                <div className="mt-2">
                  <span className="block mb-1 text-[12px]" style={{ color: 'var(--ink-300)' }}>
                    {t('catalog.importPickVariant')}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {importVariants.map((v, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => applyVariant(v)}
                        className="btn btn-ghost"
                        style={{ padding: '4px 10px', fontSize: 12 }}
                      >
                        {v.model ?? ''}{v.model && v.wattPeak ? ' · ' : ''}{v.wattPeak != null ? `${v.wattPeak} Wp` : ''}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {importMsg && (
                <span
                  className="block mt-1 text-[12px]"
                  style={{ color: importMsg.startsWith(t('catalog.importError', { message: '' }).slice(0, 6)) ? 'var(--sun-200)' : 'var(--ink-300)' }}
                >
                  {importMsg}
                </span>
              )}
            </label>
          </div>
          {p.formError && (
            <div role="alert" className="rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'rgba(255,99,99,0.08)', border: '1px solid rgba(255,99,99,0.35)', color: 'var(--sun-200)' }}>
              {p.formError}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={p.busy} className="btn btn-primary" style={{ padding: '10px 14px', fontSize: 13 }}>
              {p.busy ? t('catalog.saving') : t('catalog.save')}
            </button>
            <button type="button" onClick={p.onCancel} className="btn btn-ghost" style={{ padding: '10px 14px', fontSize: 13 }}>
              {t('catalog.cancel')}
            </button>
          </div>
        </form>
      )}

      {p.records.length === 0 && p.editingId === null ? (
        <div className="surface rounded-2xl px-8 py-14 text-center">
          <span className="tech-label" style={{ fontSize: 12 }}>{t('catalog.sectionTitle')}</span>
          <h2 className="mt-3 font-editorial text-[34px] text-ink-50 leading-none">{t('catalog.emptyPanelsTitle')}</h2>
          <p className="mt-3 text-ink-300 text-[15px] max-w-sm mx-auto">{t('catalog.emptyPanelsBody')}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {p.records.map((r) => (
            <li key={r.id}>
              <div
                className="surface-row group relative flex items-center gap-4 rounded-xl p-4 border"
                style={{ borderColor: 'var(--hairline)' }}
              >
                <div className="flex-1 min-w-0">
                  <span className="block font-medium text-[15px] text-ink-100 truncate">
                    {r.manufacturer} {r.model}
                  </span>
                  <span className="block font-mono text-[12px] text-ink-400 truncate">
                    {`${r.wattPeak} Wp · ${r.widthM}×${r.heightM} m`}
                    {r.efficiencyPct ? ` · ${r.efficiencyPct}%` : ''}
                  </span>
                </div>
                {r.datasheetUrl && (
                  <a
                    href={r.datasheetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ink-300 hover:text-sun-300 shrink-0"
                    title={t('panelModel.openDatasheet')}
                    aria-label={t('panelModel.openDatasheet')}
                  >
                    ↗
                  </a>
                )}
                <div className="flex gap-2 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <button onClick={() => p.onStartEdit(r)} className="btn btn-ghost relative" style={{ padding: '6px 11px', fontSize: 13 }}>
                    {t('catalog.edit')}
                  </button>
                  <button onClick={() => p.onDelete(r.id)} className="btn btn-danger relative" style={{ padding: '6px 11px', fontSize: 13 }}>
                    {t('catalog.delete')}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ── Inverters tab ─────────────────────────────────────────────────
interface InvertersTabProps {
  records: InverterModelRecord[];
  editingId: 'new' | string | null;
  form: InverterFormState;
  setForm: (updater: (f: InverterFormState) => InverterFormState) => void;
  onSave: (e: React.FormEvent) => void;
  onCancel: () => void;
  onStartEdit: (r: InverterModelRecord) => void;
  onDelete: (id: string) => void;
  busy: boolean;
  formError: string | null;
}

function InvertersTab(p: InvertersTabProps) {
  const { t } = useTranslation();
  const field = (key: keyof InverterFormState) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      p.setForm((f) => ({ ...f, [key]: e.target.value }));

  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState(0);

  useEffect(() => {
    setImportMsg(null);
    setImportProgress(0);
  }, [p.editingId]);

  async function handleImport() {
    const url = p.form.datasheetUrl.trim();
    if (!url || importing) return;
    setImporting(true);
    setImportMsg(null);
    setImportProgress(0);
    try {
      const res = await fetch('/api/sp/parse-datasheet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pb.authStore.token}`,
        },
        body: JSON.stringify({ url, type: 'inverter' }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setImportMsg(t('catalog.importError', { message: (data as { error?: string; detail?: string }).error ?? (data as { detail?: string }).detail ?? 'request failed' }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: Record<string, unknown>;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.progress === 'downloaded') setImportProgress(33);
          else if (msg.progress === 'extracted') setImportProgress(66);
          else if (typeof msg.error === 'string') {
            setImportMsg(t('catalog.importError', { message: msg.error }));
            break outer;
          } else if (Array.isArray(msg.result)) {
            setImportProgress(100);
            // For inverters take the first variant — multi-model sheets are
            // uncommon and the user can adjust the fields manually.
            const d = (msg.result as InverterExtractResult[])[0];
            if (!d) { setImportMsg(t('catalog.importNone', { count: 0 })); break outer; }
            const patch: Partial<InverterFormState> = {};
            if (d.manufacturer     !== undefined) patch.manufacturer     = d.manufacturer;
            if (d.model            !== undefined) patch.model            = d.model;
            if (d.maxAcPowerW      !== undefined) patch.maxAcPowerW      = fmt(d.maxAcPowerW, 0);
            if (d.maxDcPowerW      !== undefined) patch.maxDcPowerW      = fmt(d.maxDcPowerW, 0);
            if (d.efficiencyPct    !== undefined) patch.efficiencyPct    = fmt(d.efficiencyPct, 2);
            if (d.maxInputVoltageV !== undefined) patch.maxInputVoltageV = fmt(d.maxInputVoltageV, 0);
            if (d.phases           !== undefined) patch.phases           = String(d.phases);
            if (d.maxStrings       !== undefined) patch.maxStrings       = String(d.maxStrings);
            if (d.mpptCount        !== undefined) patch.mpptCount        = String(d.mpptCount);
            if (d.maxDcCurrentA    !== undefined) patch.maxDcCurrentA    = fmt(d.maxDcCurrentA, 1);
            if (d.stringsPerMppt   !== undefined) patch.stringsPerMppt   = String(d.stringsPerMppt);
            const count = Object.keys(patch).length;
            if (count > 0) p.setForm((f) => ({ ...f, ...patch }));
            setImportMsg(t(count > 0 ? 'catalog.importOk' : 'catalog.importNone', { count }));
            break outer;
          }
        }
      }
    } catch {
      setImportMsg(t('catalog.importError', { message: 'network error' }));
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      {p.editingId !== null && (
        <form onSubmit={p.onSave} className="surface rounded-[14px] p-6 mb-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="field-label">{t('inverterModel.manufacturer')}</span>
              <input className="input" value={p.form.manufacturer} onChange={field('manufacturer')} required autoFocus maxLength={100} />
            </label>
            <label className="block">
              <span className="field-label">{t('inverterModel.model')}</span>
              <input className="input" value={p.form.model} onChange={field('model')} required maxLength={100} />
            </label>
            <label className="block">
              <span className="field-label">{t('inverterModel.maxAcPowerW')}</span>
              <input className="input input-mono" type="number" step="1" value={p.form.maxAcPowerW} onChange={field('maxAcPowerW')} required />
            </label>
            <label className="block">
              <span className="field-label">{t('inverterModel.maxDcPowerW')}</span>
              <input className="input input-mono" type="number" step="1" value={p.form.maxDcPowerW} onChange={field('maxDcPowerW')} />
            </label>
            <label className="block">
              <span className="field-label">{t('inverterModel.efficiencyPct')}</span>
              <input className="input input-mono" type="number" step="0.1" value={p.form.efficiencyPct} onChange={field('efficiencyPct')} />
            </label>
            <label className="block">
              <span className="field-label">{t('inverterModel.phases')}</span>
              <input className="input input-mono" type="number" step="1" value={p.form.phases} onChange={field('phases')} />
            </label>
            <label className="block">
              <span className="field-label">{t('inverterModel.maxStrings')}</span>
              <input className="input input-mono" type="number" step="1" value={p.form.maxStrings} onChange={field('maxStrings')} />
            </label>
            <label className="block">
              <span className="field-label">{t('inverterModel.maxInputVoltageV')}</span>
              <input className="input input-mono" type="number" step="1" value={p.form.maxInputVoltageV} onChange={field('maxInputVoltageV')} />
            </label>
            <label className="block">
              <span className="field-label">{t('inverterModel.mpptCount')}</span>
              <input className="input input-mono" type="number" step="1" value={p.form.mpptCount} onChange={field('mpptCount')} />
            </label>
            <label className="block">
              <span className="field-label">{t('inverterModel.stringsPerMppt')}</span>
              <input className="input input-mono" type="number" step="1" value={p.form.stringsPerMppt} onChange={field('stringsPerMppt')} />
            </label>
            <label className="col-span-2 block">
              <span className="field-label">{t('inverterModel.maxDcCurrentA')}</span>
              <input className="input input-mono" type="number" step="0.1" value={p.form.maxDcCurrentA} onChange={field('maxDcCurrentA')} />
            </label>
            <label className="col-span-2 block">
              <span className="field-label">{t('inverterModel.datasheetUrl')}</span>
              <div className="flex gap-2 items-center">
                <input className="input flex-1" type="url" value={p.form.datasheetUrl} onChange={field('datasheetUrl')} placeholder="https://…" maxLength={500} />
                {p.form.datasheetUrl.trim() && (
                  <a
                    href={p.form.datasheetUrl.trim()}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-ghost"
                    style={{ padding: '8px 10px', fontSize: 13 }}
                    title={t('inverterModel.openDatasheet')}
                  >
                    ↗
                  </a>
                )}
                {p.form.datasheetUrl.trim() && (
                  <button
                    type="button"
                    onClick={handleImport}
                    disabled={importing || p.busy}
                    className="btn btn-ghost"
                    style={{ padding: '8px 12px', fontSize: 13, whiteSpace: 'nowrap' }}
                  >
                    {importing && (
                      <span
                        className="inline-block w-[11px] h-[11px] rounded-full border-2 border-current border-t-transparent animate-spin mr-1.5 align-[-1px]"
                        aria-hidden
                      />
                    )}
                    {importing ? t('catalog.importing') : t('catalog.importBtn')}
                  </button>
                )}
              </div>
              {(importing || importProgress > 0) && (
                <div className="mt-2 h-[3px] rounded-full overflow-hidden" style={{ background: 'var(--surface-1, rgba(255,255,255,0.08))' }}>
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${importProgress}%`,
                      background: 'var(--sun-300, #f59e0b)',
                      transition: importProgress === 0 ? 'none' : 'width 0.4s ease',
                    }}
                  />
                </div>
              )}
              {importMsg && (
                <span
                  className="block mt-1 text-[12px]"
                  style={{ color: importMsg.startsWith(t('catalog.importError', { message: '' }).slice(0, 6)) ? 'var(--sun-200)' : 'var(--ink-300)' }}
                >
                  {importMsg}
                </span>
              )}
            </label>
          </div>
          {p.formError && (
            <div role="alert" className="rounded-lg px-3 py-2 text-[12.5px]" style={{ background: 'rgba(255,99,99,0.08)', border: '1px solid rgba(255,99,99,0.35)', color: 'var(--sun-200)' }}>
              {p.formError}
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={p.busy} className="btn btn-primary" style={{ padding: '10px 14px', fontSize: 13 }}>
              {p.busy ? t('catalog.saving') : t('catalog.save')}
            </button>
            <button type="button" onClick={p.onCancel} className="btn btn-ghost" style={{ padding: '10px 14px', fontSize: 13 }}>
              {t('catalog.cancel')}
            </button>
          </div>
        </form>
      )}

      {p.records.length === 0 && p.editingId === null ? (
        <div className="surface rounded-2xl px-8 py-14 text-center">
          <span className="tech-label" style={{ fontSize: 12 }}>{t('catalog.sectionTitle')}</span>
          <h2 className="mt-3 font-editorial text-[34px] text-ink-50 leading-none">{t('catalog.emptyInvertersTitle')}</h2>
          <p className="mt-3 text-ink-300 text-[15px] max-w-sm mx-auto">{t('catalog.emptyInvertersBody')}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {p.records.map((r) => (
            <li key={r.id}>
              <div
                className="surface-row group relative flex items-center gap-4 rounded-xl p-4 border"
                style={{ borderColor: 'var(--hairline)' }}
              >
                <div className="flex-1 min-w-0">
                  <span className="block font-medium text-[15px] text-ink-100 truncate">
                    {r.manufacturer} {r.model}
                  </span>
                  <span className="block font-mono text-[12px] text-ink-400 truncate">
                    {`${r.maxAcPowerW} W`}
                    {r.phases ? ` · ${r.phases}∅` : ''}
                    {r.mpptCount ? ` · ${r.mpptCount} MPPT` : ''}
                    {r.efficiencyPct ? ` · ${r.efficiencyPct}%` : ''}
                  </span>
                </div>
                {r.datasheetUrl && (
                  <a
                    href={r.datasheetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ink-300 hover:text-sun-300 shrink-0"
                    title={t('inverterModel.openDatasheet')}
                    aria-label={t('inverterModel.openDatasheet')}
                  >
                    ↗
                  </a>
                )}
                <div className="flex gap-2 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <button onClick={() => p.onStartEdit(r)} className="btn btn-ghost relative" style={{ padding: '6px 11px', fontSize: 13 }}>
                    {t('catalog.edit')}
                  </button>
                  <button onClick={() => p.onDelete(r.id)} className="btn btn-danger relative" style={{ padding: '6px 11px', fontSize: 13 }}>
                    {t('catalog.delete')}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
