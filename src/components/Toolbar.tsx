// ────────────────────────────────────────────────────────────────────────────
// Toolbar — the top command bar.
//
// What lives here:
//   - Branded wordmark with a custom sunburst SVG logo (left)
//   - Lock / Unlock pill — the single most important action; styled as the
//     "primary" moment of the UI with an ambient amber glow when locked
//   - Basemap provider selector (only while unlocked)
//   - A segmented tool-mode switcher (draw/place/assign/delete) with
//     integrated kbd-shortcut hints
//   - Project-level actions on the right: backdrop toggle, export, save,
//     load, reset
//
// Notable wiring (unchanged from the prior version):
//   - `mapRef` is passed down from App so lockMap can read getCenter/getZoom.
//   - Tool buttons are disabled until the map is locked.
//   - Clicking "Assign String" with no active string auto-creates one.
//   - Save/Load use browser file APIs directly — no backend.
//
// Visual design notes:
//   All class-based styling leans on the primitives declared in index.css
//   (.btn-*, .segment*, .chip*, .surface, .kbd, etc.) so this file stays
//   mostly structural. The one exception is the Lock button, which needs
//   a custom ambient glow ring that's easier to express inline with style.
// ────────────────────────────────────────────────────────────────────────────

import { useProjectStore } from '../store/projectStore';
import { metersPerPixel } from '../utils/calibration';
import { exportPdf } from '../utils/pdfExport';
import {
  serializeProject,
  deserializeProject,
  ProjectDeserializationError,
} from '../utils/projectSerializer';
import html2canvas from 'html2canvas';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolMode } from '../types';
import SyncStatusIndicator from './SyncStatusIndicator';
import LanguageToggle from './LanguageToggle';
import { BrandMark } from './BrandMark';

interface Props {
  mapRef: React.MutableRefObject<L.Map | null>;
}

// Mode definitions. `glyph` is an inline SVG (instead of emoji) so the
// icon weight matches the typography and scales correctly on HiDPI. `key`
// is the keyboard shortcut handled in App.tsx.
//
// `labelKey` is typed as the narrow union of valid toolbar.* translation
// keys, so a typo here would be a compile-time error instead of a silent
// "[missing key]" at runtime.
type ToolbarModeKey =
  | 'toolbar.modeRoof'
  | 'toolbar.modePanels'
  | 'toolbar.modeString'
  | 'toolbar.modeDelete';
const MODES: {
  mode: ToolMode;
  labelKey: ToolbarModeKey;
  key: string;
  glyph: React.ReactNode;
}[] = [
  {
    mode: 'draw-roof',
    labelKey: 'toolbar.modeRoof',
    key: 'R',
    // Pen on a polygon corner — "draw outline"
    glyph: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M2 14L4 12M4 12L11 5L13 7L6 14H4V12Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M11 5L13 3L15 5L13 7" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    mode: 'place-panels',
    labelKey: 'toolbar.modePanels',
    key: 'P',
    // A stacked panel glyph
    glyph: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="3" width="12" height="10" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M2 8H14M8 3V13" stroke="currentColor" strokeWidth="1" opacity="0.7" />
      </svg>
    ),
  },
  {
    mode: 'assign-string',
    labelKey: 'toolbar.modeString',
    key: 'S',
    // Lightning bolt
    glyph: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M9 1L3 9H7L6 15L13 7H9L10 1H9Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" fill="currentColor" fillOpacity="0.2" />
      </svg>
    ),
  },
  {
    mode: 'delete',
    labelKey: 'toolbar.modeDelete',
    key: 'D',
    // Trash icon
    glyph: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M3 5H13M6 5V3H10V5M5 5L6 13H10L11 5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export default function Toolbar({ mapRef }: Props) {
  const { t } = useTranslation();
  const toolMode = useProjectStore((s) => s.toolMode);
  const setToolMode = useProjectStore((s) => s.setToolMode);
  const locked = useProjectStore((s) => s.project.mapState.locked);
  const mapProvider = useProjectStore((s) => s.project.mapState.mapProvider) || 'esri';
  const setMapProvider = useProjectStore((s) => s.setMapProvider);
  const lockMap = useProjectStore((s) => s.lockMap);
  const unlockMap = useProjectStore((s) => s.unlockMap);
  const project = useProjectStore((s) => s.project);
  const loadProject = useProjectStore((s) => s.loadProject);
  const resetProject = useProjectStore((s) => s.resetProject);
  const addString = useProjectStore((s) => s.addString);
  const showBackground = useProjectStore((s) => s.showBackground);
  const toggleBackground = useProjectStore((s) => s.toggleBackground);
  // Undo / redo wiring. `canUndo` / `canRedo` are real state fields (not
  // derived selectors) so these subscriptions re-render the buttons exactly
  // when the toolbar needs to flip between enabled and disabled — no custom
  // equality functions needed. See projectStore.ts for why they're stored
  // as booleans rather than computed from past/future lengths in selectors.
  const canUndo = useProjectStore((s) => s.canUndo);
  const canRedo = useProjectStore((s) => s.canRedo);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);

  // Platform-appropriate chord label for the Undo/Redo button titles.
  // `navigator.platform` is read once at module load; the result doesn't
  // change at runtime, so we don't bother memoizing — a single regex test
  // is cheaper than the useMemo bookkeeping and re-reading `navigator` on
  // every render is negligible. The `typeof navigator !== 'undefined'`
  // guard is defensive in case this module ever runs in a non-browser
  // environment (e.g. SSR), even though currently it never does.
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform);
  const undoLabel = isMac ? '⌘Z' : 'Ctrl+Z';
  const redoLabel = isMac ? '⇧⌘Z' : 'Ctrl+Shift+Z';

  // isLocking gates the Lock button during the async html2canvas capture
  // (~100-300ms). Without this, the button looks unresponsive and can be
  // double-fired — harmless but wasteful (two captures, second wins).
  const [isLocking, setIsLocking] = useState(false);

  /**
   * Lock/unlock handler.
   *
   * On lock: read center+zoom, compute mpp, rasterize the Leaflet container
   * via html2canvas, and commit to the store. Post-lock the map is unmounted
   * (see App.tsx); the Konva stage paints the captured PNG and owns pan/zoom.
   * This is the ADR-007 flow.
   *
   * Tile CORS can in theory fail html2canvas — ESRI is CORS-clean, but if
   * a future tile source breaks, we alert and bail rather than leaving the
   * user in a half-locked state.
   */
  const handleLock = async () => {
    if (locked) {
      unlockMap();
      return;
    }
    if (isLocking) return; // defensive; button is also disabled.

    const map = mapRef.current;
    if (!map) return;

    const c = map.getCenter();
    const z = map.getZoom();
    const mpp = metersPerPixel(z, c.lat);
    const mapEl = document.querySelector('.leaflet-container') as HTMLElement | null;
    if (!mapEl) {
      alert('Map container not found — cannot lock.');
      return;
    }
    setIsLocking(true);
    try {
      const canvas = await html2canvas(mapEl, {
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#1a1812',
        logging: false,
      });
      const dataUrl = canvas.toDataURL('image/png');
      lockMap({
        centerLat: c.lat,
        centerLng: c.lng,
        zoom: z,
        mpp,
        capturedImage: dataUrl,
        capturedWidth: mapEl.clientWidth,
        capturedHeight: mapEl.clientHeight,
      });
    } catch (err) {
      console.error('Failed to capture satellite view', err);
      alert('Failed to capture the satellite view — see console for details.');
    } finally {
      // Always clear the flag so a single error doesn't permanently brick
      // the Lock button until reload.
      setIsLocking(false);
    }
  };

  const handleExport = async () => {
    // The overlay element is looked up here — pdfExport no longer reaches
    // into the DOM itself. Same class selector as before; failing fast
    // with a user-facing error is fine because Export is only wired to
    // the toolbar button, which is hidden when the map isn't locked.
    const stageEl = document.querySelector('.konva-overlay') as HTMLElement | null;
    if (!stageEl) {
      alert(t('toolbar.exportFailed'));
      return;
    }
    const ok = await exportPdf(project, stageEl);
    if (!ok) alert(t('toolbar.exportFailedGeneral'));
  };

  /**
   * Save JSON: serialize the full persisted project and trigger a download.
   * Filename sanitized to filesystem-safe chars.
   *
   * The envelope shape (v2 `{ version, project, history }`) lives in
   * utils/projectSerializer.ts — this handler is just the DOM-glue that
   * pipes the result into a file download. Same for handleLoad below.
   */
  const handleSave = () => {
    const state = useProjectStore.getState();
    const payload = serializeProject({
      project: state.project,
      past: state.past,
      future: state.future,
    });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.project.name.replace(/[^a-z0-9-_]/gi, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /**
   * Load JSON: open a file picker, parse, hand off to store.loadProject.
   *
   * Version dispatch and data migration are handled by deserializeProject;
   * a ProjectDeserializationError means the file wasn't a recognizable
   * v1 or v2 shape (wrong file picked, corrupted export) — surface that
   * cleanly rather than the opaque cast error the previous inline logic
   * produced.
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
        const parsed = JSON.parse(text);
        const { project, history } = deserializeProject(parsed);
        loadProject(project, history);
      } catch (err) {
        if (err instanceof ProjectDeserializationError) {
          alert(t('toolbar.loadFailed', { message: err.message }));
        } else {
          alert(t('toolbar.loadFailedGeneral', { message: (err as Error).message }));
        }
      }
    };
    input.click();
  };

  const handleReset = () => {
    if (confirm(t('toolbar.resetConfirm'))) resetProject();
  };

  /**
   * Render one segment of the tool-mode switcher. Clicking the active mode
   * toggles back to idle (common toolbar idiom). Clicking "Assign String"
   * with no active string auto-creates one so the common flow is one
   * click instead of two.
   */
  const renderSegment = (m: typeof MODES[number]) => {
    const active = toolMode === m.mode;
    const disabled = !locked && m.mode !== 'idle';
    return (
      <button
        key={m.mode}
        disabled={disabled}
        data-active={active || undefined}
        className="segment"
        onClick={() => {
          if (m.mode === 'assign-string') {
            const state = useProjectStore.getState();
            if (!state.activeStringId || !state.project.strings.find((s) => s.id === state.activeStringId)) {
              addString(); // addString sets activeStringId + toolMode
              return;
            }
          }
          setToolMode(active ? 'idle' : m.mode);
        }}
        title={disabled ? t('toolbar.lockFirst') : `${t(m.labelKey)} — press ${m.key}`}
      >
        <span className="opacity-90">{m.glyph}</span>
        <span>{t(m.labelKey)}</span>
        {/* Keyboard shortcut hint. Hidden on active (no room) and on
            disabled (would read as another state). The `.kbd` style
            already handles dark-on-dark contrast via var(--sun-300). */}
        {!active && !disabled && (
          <span className="kbd" style={{ minWidth: 16, height: 15, fontSize: 9.5 }}>
            {m.key}
          </span>
        )}
      </button>
    );
  };

  return (
    // The header is a single hairline-bordered bar with a subtle neutral
    // gradient — the vertical gradient reinforces "layer stacking" rather
    // than a flat painted rectangle. Palette shifted to the new near-black
    // neutral scale so the bar reads as part of the Command Console chrome
    // instead of the prior warm-metal look.
    <header
      className="h-14 shrink-0 flex items-center gap-3 px-4 text-ink-100 relative"
      style={{
        background: 'linear-gradient(180deg, rgba(24,24,27,0.95) 0%, rgba(11,11,12,0.95) 100%)',
        borderBottom: '1px solid var(--hairline)',
        boxShadow: '0 1px 0 rgba(0,0,0,0.5), 0 12px 24px -18px rgba(0,0,0,0.6)',
      }}
    >
      {/* Wordmark — shared BrandMark glyph + "Solar" in the display face.
          The "/planner" trailing word rides in mono caps for technical
          feel. Color on /planner comes from ink-300 (not the scarlet
          accent) so the brand bar stays visually calm; scarlet is reserved
          for interactive signals below (primary CTA, active tool). */}
      <div className="flex items-center gap-2.5 mr-1">
        <BrandMark size={22} />
        <div className="flex items-baseline gap-1 select-none">
          <span
            className="font-display text-[15.5px] font-semibold tracking-tight"
            style={{ color: 'var(--ink-50)' }}
          >
            Solar
          </span>
          <span
            className="font-mono text-[11px] uppercase tracking-[0.12em]"
            style={{ color: 'var(--ink-300)' }}
          >
            /planner
          </span>
        </div>
      </div>

      <div className="divider-v" />

      {/* Lock button — the hero of the toolbar.
          When locked: filled amber with ambient glow (primary action achieved).
          When unlocked: ghost surface with a subtle "press me" pulse.
          When locking: spinner + "Capturing..." label. */}
      <button
        disabled={isLocking}
        onClick={handleLock}
        title={isLocking ? 'Capturing satellite view…' : locked ? 'Click to unlock' : 'Click to lock and start drawing'}
        className={`btn relative ${locked ? 'btn-primary' : 'btn-ghost'} ${isLocking ? 'opacity-70 cursor-wait' : ''}`}
        style={{
          padding: '7px 14px',
          fontSize: 12.5,
          // Ambient glow ring when locked — layered on top of the built-in
          // btn-primary shadow for a "confirmed / powered on" read.
          boxShadow: locked
            ? 'inset 0 1px 0 rgba(255,255,255,0.35), 0 0 0 1px var(--sun-600), 0 0 24px -4px var(--glow-sun)'
            : undefined,
        }}
      >
        {isLocking ? (
          <>
            <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
              <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
            <span>{t('toolbar.capturing')}</span>
          </>
        ) : locked ? (
          <>
            {/* Subtle pulsing dot — a pilot light indicating "armed/locked" */}
            <span
              className="animate-pulse-sun inline-block rounded-full"
              style={{
                width: 7,
                height: 7,
                background: 'var(--ink-950)',
                boxShadow: '0 0 6px rgba(10,8,4,0.8)',
              }}
            />
            <span>{t('toolbar.mapLocked')}</span>
          </>
        ) : (
          <>
            {/* Lock-open icon */}
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5 7V5a3 3 0 0 1 6 0v1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
            </svg>
            <span>{t('toolbar.lockMap')}</span>
          </>
        )}
      </button>

      {/* Basemap provider — only meaningful while navigating. Hiding it
          post-lock keeps the toolbar visually quieter once you're drawing. */}
      {!locked && (
        <select
          className="input"
          style={{ width: 'auto', padding: '6px 26px 6px 10px', fontSize: 12 }}
          value={mapProvider}
          onChange={(e) => setMapProvider(e.target.value as 'esri' | 'bayern' | 'bayern_alkis')}
          title="Satellite imagery provider"
        >
          <option value="esri">{t('toolbar.basemapEsri')}</option>
          <option value="bayern">{t('toolbar.basemapBayern')}</option>
          <option value="bayern_alkis">{t('toolbar.basemapBayernAlkis')}</option>
        </select>
      )}

      <div className="divider-v" />

      {/* Tool-mode segmented switcher. Grouped visually so the modes read
          as a single control (not four loose buttons), which matches how
          they function: exclusive selection. */}
      <div className="segmented">{MODES.map(renderSegment)}</div>

      <div className="flex-1" />

      {/* Right-side action group. Grouped by purpose (view, file, destructive)
          with hairline separators between. */}
      <div className="flex items-center gap-1">
        {/* Sync status — sits at the left of the right-hand cluster so
            the user's eye naturally lands on it when scanning for
            "is my work saved?". Placed before the action buttons (not
            after Reset) because it's informational, not an action, and
            logically belongs with other project-state context rather
            than trailing the destructive Reset button. */}
        <LanguageToggle />
        <SyncStatusIndicator />
        <div className="divider-v mx-1" />
        <button
          className={`btn btn-tool ${locked && showBackground ? 'text-sun-300' : ''}`}
          onClick={toggleBackground}
          disabled={!locked}
          title={!locked ? 'Lock the map first' : showBackground ? 'Hide satellite backdrop' : 'Show satellite backdrop'}
        >
          {/* Backdrop eye icon — the closed-eye state for hidden reads
              naturally as "off". */}
          {showBackground ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
              <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 2l12 12M6 6a2.8 2.8 0 0 0 4 4m-6-2s2-4 6-4c1 0 1.9.3 2.7.7M14 8s-.7 1.4-2.3 2.8"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          <span>{t('toolbar.backdrop')}</span>
        </button>

        <div className="divider-v mx-1" />

        <button className="btn btn-ghost" onClick={handleExport} title="Export A4 landscape PDF">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 2v8m0 0l-3-3m3 3l3-3M3 12v2h10v-2"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>{t('toolbar.export')}</span>
        </button>

        {/*
          Undo / Redo — sit here, between Export and Save, because they're
          project-level rather than drawing-level actions. Disabled state
          follows canUndo/canRedo mirrors; click handlers fire the store
          actions directly, which also maintain the mirrors on completion
          (see projectStore.undo / projectStore.redo).
        */}
        <button
          className="btn btn-tool"
          onClick={undo}
          disabled={!canUndo}
          title={`Undo (${undoLabel})`}
        >
          ↶ {t('toolbar.undo')}
        </button>
        <button
          className="btn btn-tool"
          onClick={redo}
          disabled={!canRedo}
          title={`Redo (${redoLabel})`}
        >
          ↷ {t('toolbar.redo')}
        </button>

        <button className="btn btn-tool" onClick={handleSave} title="Save project JSON">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path
              d="M3 3h7l3 3v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
            <path d="M5 3v3h5V3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
        </button>

        <button className="btn btn-tool" onClick={handleLoad} title="Load project JSON">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path
              d="M2 5h4l1.5 1.5H14v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <div className="divider-v mx-1" />

        <button className="btn btn-danger" onClick={handleReset} title="Reset entire project">
          {t('toolbar.reset')}
        </button>
      </div>
    </header>
  );
}
