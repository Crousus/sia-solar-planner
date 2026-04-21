// ────────────────────────────────────────────────────────────────────────────
// App shell — three-part layout:
//   [Toolbar]            ← top bar with mode buttons + lock + save/export
//   [Sidebar | Main]     ← left: settings/lists; right: map + Konva overlay
//
// This component also owns:
//   - The Leaflet `L.Map` ref (passed down so the Toolbar can call getCenter
//     to compute mpp at lock time)
//   - The canvas container ref (passed to KonvaOverlay so it can match size
//     via ResizeObserver)
//   - Global keyboard shortcuts (r/p/s/d/Esc) — registered here so they
//     work regardless of focus
// ────────────────────────────────────────────────────────────────────────────

import { useRef, useState, useEffect, useCallback } from 'react';
import MapView from './components/MapView';
import KonvaOverlay from './components/KonvaOverlay';
import Sidebar from './components/Sidebar';
import Toolbar from './components/Toolbar';
import { useProjectStore } from './store/projectStore';

export default function App() {
  // The Leaflet map instance. null until MapView calls onMapReady().
  // We hold it in a ref (not state) because consumers only need it on
  // click events, not every render — and we don't want to rerender when
  // the instance arrives after Leaflet initializes asynchronously.
  const mapRef = useRef<L.Map | null>(null);

  // Ref for the right-hand pane; KonvaOverlay watches its size to keep
  // the Stage perfectly overlaid on the Leaflet container.
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  // Dummy counter to force a re-render when the map instance arrives.
  // Needed because child components (Toolbar) can't use mapRef until it's
  // populated, and refs alone don't trigger renders.
  const [, forceRerender] = useState(0);

  const setToolMode = useProjectStore((s) => s.setToolMode);
  const locked = useProjectStore((s) => s.project.mapState.locked);
  const toolMode = useProjectStore((s) => s.toolMode);
  const splitCandidateRoofId = useProjectStore((s) => s.splitCandidateRoofId);

  const handleMapReady = useCallback((m: L.Map) => {
    mapRef.current = m;
    forceRerender((n) => n + 1);
  }, []);

  // Global keyboard shortcuts. Rules:
  //   - Only active when map is locked (modes are meaningless otherwise)
  //   - Ignored when an input/textarea has focus (don't trap typing)
  //   - Single-letter bindings per AGENTS.md convention
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      // Undo / redo shortcuts. Intentionally checked BEFORE the `!locked`
      // guard because edits to project name and panel type happen pre-lock
      // and those mutations still go through the record path — the user
      // expects ⌘Z to reach them too. The input/textarea guard above is
      // the real "don't steal typing keys" check; `locked` only gates
      // the single-letter mode keys below.
      //
      // Three chords supported:
      //   ⌘Z / Ctrl+Z        → undo (standard)
      //   ⇧⌘Z / Ctrl+Shift+Z → redo (Mac convention + modern Windows/Linux)
      //   Ctrl+Y             → redo (legacy Windows convention; some users
      //                        still reach for it reflexively — cheap to honor)
      // `preventDefault()` on each branch so the browser's native Back /
      // Find-next don't fire alongside our action.
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        useProjectStore.getState().undo();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        useProjectStore.getState().redo();
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        useProjectStore.getState().redo();
        return;
      }
      if (!locked) return;
      switch (e.key.toLowerCase()) {
        case 'r': setToolMode('draw-roof'); break;
        case 'p': setToolMode('place-panels'); break;
        case 's': setToolMode('assign-string'); break;
        case 'd': setToolMode('delete'); break;
        // Esc handled in KonvaOverlay so it can also clear in-progress drawing.
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked, setToolMode]);

  return (
    <div className="h-full w-full flex flex-col" style={{ background: 'var(--ink-950)' }}>
      <Toolbar mapRef={mapRef} />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        {/*
          `canvas-bg` paints a warm drafting-paper backdrop (sunflare
          gradient + amber grid + grain) beneath the Konva stage. It's
          normally covered by either the Leaflet map (unlocked) or the
          captured satellite image (locked), so the only time it's visible
          is when the user explicitly hides the background via the toolbar
          toggle — at which point this is what they see instead of a flat
          void. See index.css for the composition.
        */}
        <main ref={canvasContainerRef} className="flex-1 relative canvas-bg">
          {/*
            Leaflet is only mounted in the UNLOCKED state — the "navigate
            to your building" phase. Once locked, we tear it down entirely:
            the user's satellite backdrop has already been rasterized and
            handed to Konva (see Toolbar.handleLock + ADR-007). Keeping
            Leaflet mounted post-lock previously caused zoom desync
            between its CSS-animated tiles and our Stage scale — the
            cleanest fix is to just stop rendering it.

            mapRef goes stale on unmount, but that's fine: the next
            unlock remounts MapView, which calls onMapReady again and
            refreshes the ref before the next Lock Map press.
          */}
          {!locked && <MapView onMapReady={handleMapReady} />}
          <KonvaOverlay containerRef={canvasContainerRef} mapRef={mapRef} />
          {/*
            Hint banner — shown only before the map is locked. High z-index
            so it sits above the overlay; `pointer-events-none` so it
            doesn't block clicks on the map behind it.
          */}
          {!locked && (
            /*
              Hint banner — only shown pre-lock. Redesigned as a glass-morphic
              pill with a pulsing solar-dot "status light" on the left and a
              kbd-style emphasis for the Lock Map action. `surface` primitive
              provides the backdrop blur + hairline border; high z-index so
              it sits above the Konva overlay; pointer-events-none so clicks
              pass through to the map.
            */
            <div
              className="surface absolute top-4 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 z-[600] pointer-events-none flex items-center gap-2.5"
              style={{ fontSize: 12.5 }}
            >
              {/* Pulsing sunburst dot — the "system armed" pilot light */}
              <span className="relative flex items-center justify-center" style={{ width: 10, height: 10 }}>
                <span
                  className="absolute inset-0 rounded-full animate-pulse-sun"
                  style={{ background: 'var(--sun-400)', filter: 'blur(4px)' }}
                />
                <span
                  className="relative rounded-full"
                  style={{ width: 6, height: 6, background: 'var(--sun-300)' }}
                />
              </span>
              <span style={{ color: 'var(--ink-100)' }}>
                Navigate to your location, then
              </span>
              <span
                className="font-display font-semibold"
                style={{ color: 'var(--sun-300)', letterSpacing: '-0.01em' }}
              >
                Lock Map
              </span>
              <span style={{ color: 'var(--ink-300)' }}>to start drawing.</span>
            </div>
          )}
          {locked && toolMode === 'draw-roof' && splitCandidateRoofId && (
            /*
              Split-mode hint. Same visual treatment as the pre-lock
              hint but positioned the same way so the user sees
              instructions in a consistent place. Only rendered while
              the user is mid-cut — no clutter in normal drawing.
            */
            <div
              className="surface absolute top-4 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 z-[600] pointer-events-none flex items-center gap-2.5"
              style={{ fontSize: 12.5 }}
            >
              <span className="relative flex items-center justify-center" style={{ width: 10, height: 10 }}>
                <span
                  className="absolute inset-0 rounded-full animate-pulse-sun"
                  style={{ background: 'var(--sun-400)', filter: 'blur(4px)' }}
                />
                <span
                  className="relative rounded-full"
                  style={{ width: 6, height: 6, background: 'var(--sun-300)' }}
                />
              </span>
              <span style={{ color: 'var(--ink-100)' }}>
                Click another edge of this roof to
              </span>
              <span
                className="font-display font-semibold"
                style={{ color: 'var(--sun-300)', letterSpacing: '-0.01em' }}
              >
                split
              </span>
              <span style={{ color: 'var(--ink-300)' }}>
                it, or press Enter to commit a polyline cut.
              </span>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
