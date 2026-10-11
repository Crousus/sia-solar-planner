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

import { useNavigate, useParams } from 'react-router-dom';
import { useProjectStore } from '../store/projectStore';
import { metersPerPixel } from '../utils/calibration';
// The export orchestrator lives behind a dynamic import: everything under
// src/pdf/ is meant to be reachable only via a lazy boundary (see
// composeStageImage.ts), so the editor chunk doesn't carry export code
// until the user hovers / clicks Export.
const loadPdfExport = () => import('../pdf/pdfExport');
const exportPdf: typeof import('../pdf/pdfExport').exportPdf = async (...args) =>
  (await loadPdfExport()).exportPdf(...args);
const prefetchPdfExport = () => {
  void loadPdfExport().then((m) => m.prefetchPdfExport());
};
import { KonvaExportFrame } from './KonvaOverlay';
import DiagramView from './DiagramView';
import type { DiagramSymbolStyle } from './diagram/symbolStyle';
import {
  serializeProject,
  deserializeProject,
  ProjectDeserializationError,
} from '../utils/projectSerializer';
import html2canvas from 'html2canvas';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolMode, DiagramNodeType, MapProvider } from '../types';
import SyncStatusIndicator from './SyncStatusIndicator';
import LanguageToggle from './LanguageToggle';
import { BrandMark } from './BrandMark';
import { getActiveProjectTeamId, getActiveProjectCreatorId } from './ProjectEditor';
import { pushToast } from '../store/toastStore';

interface Props {
  mapRef: React.MutableRefObject<L.Map | null>;
  /**
   * Pre-lock Leaflet preview rotation in degrees (clockwise). Owned by
   * App so the MapView can apply the CSS transform and the Toolbar can
   * forward the value into lockMap. Unused once `locked === true` — App
   * resets it on lock transitions.
   */
  preLockRotation: number;
  /**
   * Which editor is active. Drives which mid-bar cluster of controls is
   * shown — roof-plan gets Lock/basemap/tool-modes/backdrop; block-diagram
   * gets the node-insert palette. Common controls (undo/redo, save/load,
   * settings, language, export, reset) are identical on both views.
   */
  activeView: 'roof' | 'diagram';
}

// Diagram node-insert palette — previously lived in its own floating pill
// above the A4 sheet (DiagramToolbar). Inlined here so the main toolbar
// fully replaces the roof-plan cluster when the user switches views;
// keeping two header rows would mean "which controls do I use?" ambiguity.
//
// Only the node types that aren't auto-bootstrapped appear here. Solar
// generators and inverters are derived from project state by
// bootstrapDiagram, so exposing "add" buttons for them would create
// phantom nodes that don't map to any roof/inverter record.
const DIAGRAM_NODE_BUTTONS: ReadonlyArray<{
  type: DiagramNodeType;
  labelKey:
    | 'diagram.nodes.switch'
    | 'diagram.nodes.fuse'
    | 'diagram.nodes.battery'
    | 'diagram.nodes.fre'
    | 'diagram.nodes.gridOutput'
    | 'diagram.nodes.consumer';
  color: string;
}> = [
  { type: 'switch',     labelKey: 'diagram.nodes.switch',     color: '#64748b' },
  { type: 'fuse',       labelKey: 'diagram.nodes.fuse',       color: '#dc2626' },
  { type: 'battery',    labelKey: 'diagram.nodes.battery',    color: '#059669' },
  { type: 'fre',        labelKey: 'diagram.nodes.fre',        color: '#7c3aed' },
  { type: 'gridOutput', labelKey: 'diagram.nodes.gridOutput', color: '#0284c7' },
  { type: 'consumer',   labelKey: 'diagram.nodes.consumer',   color: '#e11d48' },
];

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

export default function Toolbar({ mapRef, preLockRotation, activeView }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const addDiagramNode = useProjectStore((s) => s.addDiagramNode);
  // The editor is always mounted under /p/:projectId, so projectId is
  // defined here. Read via the router rather than the store because
  // the store's `project` blob doesn't carry the record id.
  const { projectId } = useParams<{ projectId: string }>();
  const toolMode = useProjectStore((s) => s.toolMode);
  const setToolMode = useProjectStore((s) => s.setToolMode);
  const locked = useProjectStore((s) => s.project.mapState.locked);
  const mapProvider = useProjectStore((s) => s.project.mapState.mapProvider) || 'esri';
  const setMapProvider = useProjectStore((s) => s.setMapProvider);
  const lockMap = useProjectStore((s) => s.lockMap);
  const unlockMap = useProjectStore((s) => s.unlockMap);
  // NB: no whole-`project` selector here — the toolbar only needs the
  // project at export/save time and reads it via getState() then.
  // Subscribing to `s.project` re-rendered the toolbar on every doc
  // change (each diagram drag frame, every keystroke in a field).
  const loadProject = useProjectStore((s) => s.loadProject);
  const resetProject = useProjectStore((s) => s.resetProject);
  const addString = useProjectStore((s) => s.addString);
  const showBackground = useProjectStore((s) => s.showBackground);
  const toggleBackground = useProjectStore((s) => s.toggleBackground);
  const snapToImageEdges = useProjectStore((s) => s.snapToImageEdges);
  const toggleImageEdgeSnap = useProjectStore((s) => s.toggleImageEdgeSnap);
  const imageEdgeStatus = useProjectStore((s) => s.imageEdgeStatus);
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

  const handleBackToProjects = () => {
    const teamId = getActiveProjectTeamId();
    // Navigate to the team's project list if we know the team; fall back to
    // the TeamPicker root so the user always ends up somewhere sensible.
    navigate(teamId ? `/teams/${teamId}` : '/');
  };

  // isLocking gates the Lock button during the async html2canvas capture
  // (~100-300ms). Without this, the button looks unresponsive and can be
  // double-fired — harmless but wasteful (two captures, second wins).
  const [isLocking, setIsLocking] = useState(false);

  // Export menu: the user picks the block-diagram symbol style per export
  // (app design vs. IEC 60617 standard symbols, ADR-020). Closed by an
  // outside click or Escape.
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!exportMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!exportMenuRef.current?.contains(e.target as Node)) setExportMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExportMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [exportMenuOpen]);

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
    // Target the MapView shell (the axis-aligned parent of the rotating
    // wrapper) rather than `.leaflet-container`. The shell is main-sized
    // with `overflow: hidden`; the rotated wrapper inside overflows it
    // and gets clipped at the visible viewport. Capturing the shell
    // therefore produces exactly what the user sees in preview — tilted
    // tiles baked into a main-sized rectangle — so the locked background
    // matches the preview 1:1, with no "flip to axis-aligned" frame and
    // no need for a separate stage-rotation seed.
    //
    // Fallback to `.leaflet-container` if the shell can't be found for
    // any reason; on the off chance MapView's structure changes the
    // capture still produces something rather than aborting the lock.
    const shellEl = document.querySelector('[data-map-shell]') as HTMLElement | null;
    const captureEl =
      shellEl ?? (document.querySelector('.leaflet-container') as HTMLElement | null);
    if (!captureEl) {
      // Surfaced via toast rather than alert() so the user can keep
      // interacting with the rest of the UI (e.g. switch basemap and
      // try again) without dismissing a modal first.
      pushToast('error', t('errors.mapContainerMissing'));
      return;
    }
    setIsLocking(true);
    const cropW = captureEl.clientWidth;
    const cropH = captureEl.clientHeight;
    try {
      const canvas = await html2canvas(captureEl, {
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#1a1812',
        logging: false,
        // Exclude the Leaflet control overlay (zoom +/−) — it's interactive
        // chrome that shouldn't appear in the locked background image.
        ignoreElements: (el) => el.classList.contains('leaflet-control-container'),
      });
      const dataUrl = canvas.toDataURL('image/png');
      lockMap({
        centerLat: c.lat,
        centerLng: c.lng,
        zoom: z,
        mpp,
        capturedImage: dataUrl,
        capturedWidth: cropW,
        capturedHeight: cropH,
        // Rotation is baked into the captured image (we targeted the
        // axis-aligned shell which contains the rotating wrapper), so
        // don't seed the stage with an additional rotation on top —
        // that would double-rotate.
        initialRotationDeg: undefined,
      });
    } catch (err) {
      // Keep the console.error for devs; the toast carries the user-
      // facing summary plus the underlying message as detail.
      console.error('Failed to capture satellite view', err);
      pushToast('error', t('errors.mapCaptureFailed'), {
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Always clear the flag so a single error doesn't permanently brick
      // the Lock button until reload.
      setIsLocking(false);
    }
  };

  const handleExport = async (symbolStyle: DiagramSymbolStyle) => {
    setExportMenuOpen(false);
    // The PDF always gets BOTH pages (roof plan + block diagram) when the
    // project has material for them, regardless of which view is active.
    // App mounts only one view at a time, so for the other page we hand
    // exportPdf an offscreen-render recipe (see pdf/pdfExport.tsx). The
    // mounted view is still captured from the live DOM, which keeps the
    // user's current pan/zoom for that page.
    const store = useProjectStore.getState();

    // Block diagram: if it was never opened, bootstrap it now (one solar
    // generator per roof, one inverter per inverter — the same thing
    // opening the diagram view does) so the export has a page 2. Skipped
    // when there is nothing to bootstrap from, so an early export of an
    // empty project doesn't freeze an empty diagram into the doc.
    if (!store.project.diagram && (store.project.roofs.length > 0 || store.project.inverters.length > 0)) {
      store.bootstrapDiagram();
    }
    // Read fresh state AFTER the bootstrap (and at export time rather than
    // via a render-time selector, so the toolbar doesn't subscribe to the
    // whole project just for this click).
    const { project, inverterModelCache } = useProjectStore.getState();

    // Mounted sources. `.konva-overlay` only counts on the roof view.
    const stageEl =
      activeView === 'roof' ? (document.querySelector('.konva-overlay') as HTMLElement | null) : null;
    // The on-screen diagram is always drawn in the app style, so for the
    // IEC style the page is rendered offscreen instead (fitted to the
    // nodes rather than the user's current pan/zoom).
    const diagramEl =
      symbolStyle === 'app'
        ? (document.querySelector('[data-diagram-view]') as HTMLElement | null)
        : null;

    // Offscreen recipes for whichever page isn't mounted.
    const ms = project.mapState;
    const roofOffscreen =
      !stageEl && ms.locked && ms.capturedWidth > 0 && ms.capturedHeight > 0
        ? {
            width: ms.capturedWidth,
            height: ms.capturedHeight,
            render: (onReady: () => void) => (
              <KonvaExportFrame width={ms.capturedWidth} height={ms.capturedHeight} onReady={onReady} />
            ),
          }
        : undefined;
    const diagramOffscreen =
      !diagramEl && (project.diagram?.nodes.length ?? 0) > 0
        ? {
            // DiagramView wraps the 1122×794 sheet in padded scroll chrome;
            // give it room so nothing reflows. Only the sheet is captured.
            width: 1200,
            height: 900,
            render: (onReady: () => void) => (
              <DiagramView exportMode onReady={onReady} symbolStyle={symbolStyle} />
            ),
          }
        : undefined;

    if (!stageEl && !diagramEl && !roofOffscreen && !diagramOffscreen) {
      pushToast('error', t('toolbar.exportFailed'));
      return;
    }
    // Branding + planner context, read at export time so any tab that
    // just switched teams/projects sees fresh values rather than a stale
    // closure capture. `teamId` drives the logo + company_name lookup;
    // `creatorId` drives the planner name + phone lookup. Either may be
    // null (legacy project without created_by, or exceptional mount
    // without a team binding) — exportPdf tolerates both.
    const brandingCtx = {
      teamId: getActiveProjectTeamId(),
      creatorId: getActiveProjectCreatorId(),
    };
    const ok = await exportPdf(
      project,
      { stageEl, diagramEl, roofOffscreen, diagramOffscreen },
      inverterModelCache,
      brandingCtx,
    );
    if (!ok) pushToast('error', t('toolbar.exportFailedGeneral'));
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
          pushToast('error', t('toolbar.loadFailed', { message: err.message }));
        } else {
          pushToast('error', t('toolbar.loadFailedGeneral', {
            message: (err as Error).message,
          }));
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
        title={disabled ? t('toolbar.lockFirst') : t('toolbar.modeTitle', { label: t(m.labelKey), key: m.key })}
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
      {/* Wordmark — clickable home button back to the team's project list.
          Uses the `group` pattern so the back-chevron fades in on hover
          without extra React state. The subtle fill on hover signals
          interactivity while keeping the bar visually calm at rest. */}
      <button
        className="group flex items-center gap-2 mr-1 px-2 py-1.5 -mx-2 -my-1.5 rounded-lg transition-colors select-none"
        style={{ cursor: 'pointer', background: 'transparent' }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
        }}
        onClick={handleBackToProjects}
        title={t('toolbar.backToProjects')}
      >
        {/* Left chevron — invisible at rest, slides in and becomes visible
            on hover to hint that this is a navigation control. */}
        <svg
          width="11"
          height="11"
          viewBox="0 0 11 11"
          fill="none"
          className="shrink-0 -mr-0.5 transition-all duration-150 opacity-0 group-hover:opacity-50"
          style={{ color: 'var(--ink-300)' }}
          aria-hidden="true"
        >
          <path d="M7 2L4 5.5L7 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <BrandMark size={22} />
        <div className="flex items-baseline gap-1">
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
      </button>

      <div className="divider-v" />

      {/* View-specific middle cluster. Roof plan shows Lock/basemap/
          tool-modes/backdrop; block diagram shows the node-insert palette.
          Switching hides the entire "wrong" cluster so the user never
          sees controls that don't act on the currently visible canvas. */}
      {activeView === 'roof' && (
      <>
      {/* Lock button — the hero of the toolbar.
          When locked: filled amber with ambient glow (primary action achieved).
          When unlocked: ghost surface with a subtle "press me" pulse.
          When locking: spinner + "Capturing..." label. */}
      <button
        disabled={isLocking}
        onClick={handleLock}
        title={isLocking ? t('toolbar.capturingSatellite') : locked ? t('toolbar.clickToUnlock') : t('toolbar.clickToLock')}
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
          onChange={(e) => setMapProvider(e.target.value as MapProvider)}
          title={t('toolbar.basemapProvider')}
        >
          <option value="esri">{t('toolbar.basemapEsri')}</option>
          <option value="bayern">{t('toolbar.basemapBayern')}</option>
          <option value="swisstopo">{t('toolbar.basemapSwisstopo')}</option>
        </select>
      )}

      <div className="divider-v" />

      {/* Tool-mode segmented switcher. Grouped visually so the modes read
          as a single control (not four loose buttons), which matches how
          they function: exclusive selection. */}
      <div className="segmented">{MODES.map(renderSegment)}</div>
      </>
      )}

      {activeView === 'diagram' && (
        // Diagram node-insert palette. Same pattern the previous floating
        // DiagramToolbar used — a prefix tech-label plus one color-dotted
        // chip per node type — but styled as bare inline elements so it
        // reads as part of the toolbar rather than a nested widget.
        <div className="flex items-center gap-1.5">
          <span
            className="uppercase select-none"
            style={{
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: '0.16em',
              color: 'var(--ink-400)',
              paddingRight: 4,
            }}
          >
            {t('diagram.toolbar.addLabel')}
          </span>
          {DIAGRAM_NODE_BUTTONS.map(({ type, labelKey, color }) => {
            const label = t(labelKey);
            return (
              <button
                key={type}
                onClick={() =>
                  addDiagramNode({
                    // 8-char base36 id — cheap, collision-unlikely enough
                    // for a single diagram; avoids pulling in a UUID dep
                    // for a UI-only identifier.
                    id: Math.random().toString(36).slice(2, 10),
                    type,
                    // Randomize within a small rectangle so successive
                    // adds don't overlap perfectly and hide each other.
                    position: {
                      x: 200 + Math.random() * 200,
                      y: 200 + Math.random() * 100,
                    },
                    // Empty body label — every node renders the type as a
                    // small uppercase caption already (e.g. "SWITCH"), so
                    // pre-filling the editable body with the same word
                    // would print the type twice. Leaving it blank turns
                    // the body into an obvious "click here to name this"
                    // affordance instead.
                    data: { label: '' },
                  })
                }
                className="btn btn-ghost"
                style={{ padding: '6px 10px 6px 8px', fontSize: 11.5 }}
                title={t('toolbar.addNode', { label })}
              >
                {/* 7px identity dot — the type's accent hue as a tiny
                    round pilot light, matching the node's header color
                    in the canvas so the palette reads like a legend. */}
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    background: color,
                    boxShadow: `0 0 0 1px rgba(255,255,255,0.06), 0 0 6px -1px ${color}`,
                    flexShrink: 0,
                  }}
                />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      )}

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
        {/* Project settings — gear icon, navigates to /p/:id/settings
            where the user can edit the name / client / address / notes
            captured on bootstrap. Placed here (next to the language
            toggle and sync indicator) because it belongs with the
            "project-level configuration" cluster, not the drawing tools
            on the left. Disabled if projectId isn't available for any
            reason (should never happen in practice — the editor route
            always has the param). */}
        <button
          className="btn btn-tool"
          onClick={() => projectId && navigate(`/p/${projectId}/settings`)}
          disabled={!projectId}
          title={t('team.settings')}
          aria-label={t('team.settings')}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            {/* Inline gear / cog. 8-tooth, centered ring. Sized to
                match the surrounding 13-14px tool icons. */}
            <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.3" />
            <path
              d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <SyncStatusIndicator />
        <div className="divider-v mx-1" />
        {activeView === 'roof' && (
        <button
          className={`btn btn-tool ${locked && showBackground ? 'text-sun-300' : ''}`}
          onClick={toggleBackground}
          disabled={!locked}
          title={!locked ? t('toolbar.lockFirst') : showBackground ? t('toolbar.hideBackdrop') : t('toolbar.showBackdrop')}
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
        )}
        {activeView === 'roof' && (
        <button
          className={`btn btn-tool ${locked && snapToImageEdges ? 'text-sun-300' : ''}`}
          onClick={toggleImageEdgeSnap}
          disabled={!locked}
          aria-pressed={locked && snapToImageEdges}
          title={
            !locked
              ? t('toolbar.lockFirst')
              : !snapToImageEdges
                ? t('toolbar.imageEdgesOff')
                : imageEdgeStatus === 'computing'
                  ? t('toolbar.imageEdgesComputing')
                  : imageEdgeStatus === 'error'
                    ? t('toolbar.imageEdgesError')
                    : t('toolbar.imageEdgesOn')
          }
        >
          {/* Roof-corner icon: two edges meeting, with a snap dot. Pulses
              while detection runs (a second or less after locking). */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            className={locked && snapToImageEdges && imageEdgeStatus === 'computing' ? 'animate-pulse' : ''}
          >
            <path d="M2 13.5 8 3l6 10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2.2 1.6" />
            <circle cx="8" cy="3.2" r="1.7" fill="currentColor" />
          </svg>
          <span>{t('toolbar.imageEdges')}</span>
        </button>
        )}

        <div className="divider-v mx-1" />

        <div className="relative" ref={exportMenuRef}>
        <button
          className="btn btn-ghost"
          onClick={() => setExportMenuOpen((o) => !o)}
          // Warm the lazy export chunk on intent (hover or keyboard focus)
          // so the @react-pdf/renderer bundle is already in cache by the
          // time the user actually clicks. Idempotent — no harm if the
          // user hovers, leaves, hovers again.
          onMouseEnter={prefetchPdfExport}
          onFocus={prefetchPdfExport}
          title={t('toolbar.exportTitle')}
          aria-haspopup="menu"
          aria-expanded={exportMenuOpen}
        >
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
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {exportMenuOpen && (
          <div
            role="menu"
            className="surface absolute right-0 top-full mt-2 p-1 rounded-lg flex flex-col gap-0.5"
            // Above Leaflet's panes/controls (z 400–1000) on the map below.
            style={{ zIndex: 2000, width: 280 }}
          >
            {([
              ['app', 'toolbar.exportAppStyle', 'toolbar.exportAppStyleHint'],
              ['iec', 'toolbar.exportIec', 'toolbar.exportIecHint'],
            ] as const).map(([style, label, hint]) => (
              <button
                key={style}
                role="menuitem"
                className="surface-row rounded-md text-left px-3 py-2"
                onClick={() => void handleExport(style)}
              >
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-50)' }}>{t(label)}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-300)', marginTop: 2 }}>{t(hint)}</div>
              </button>
            ))}
          </div>
        )}
        </div>

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
          title={t('toolbar.undoTitle', { shortcut: undoLabel })}
        >
          ↶ {t('toolbar.undo')}
        </button>
        <button
          className="btn btn-tool"
          onClick={redo}
          disabled={!canRedo}
          title={t('toolbar.redoTitle', { shortcut: redoLabel })}
        >
          ↷ {t('toolbar.redo')}
        </button>

        <button className="btn btn-tool" onClick={handleSave} title={t('toolbar.saveJson')}>
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

        <button className="btn btn-tool" onClick={handleLoad} title={t('toolbar.loadJson')}>
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

        <button className="btn btn-danger" onClick={handleReset} title={t('toolbar.resetTitle')}>
          {t('toolbar.reset')}
        </button>
      </div>
    </header>
  );
}
