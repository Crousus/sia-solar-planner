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

import { useRef, useState, useEffect } from 'react';
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

  const handleMapReady = (m: L.Map) => {
    mapRef.current = m;
    forceRerender((n) => n + 1);
  };

  // Global keyboard shortcuts. Rules:
  //   - Only active when map is locked (modes are meaningless otherwise)
  //   - Ignored when an input/textarea has focus (don't trap typing)
  //   - Single-letter bindings per AGENTS.md convention
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
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
    <div className="h-full w-full flex flex-col bg-neutral-950">
      <Toolbar mapRef={mapRef} />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        <main ref={canvasContainerRef} className="flex-1 relative">
          <MapView onMapReady={handleMapReady} />
          <KonvaOverlay containerRef={canvasContainerRef} />
          {/*
            Hint banner — shown only before the map is locked. High z-index
            so it sits above the overlay; `pointer-events-none` so it
            doesn't block clicks on the map behind it.
          */}
          {!locked && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-black/70 text-amber-300 text-sm px-3 py-1.5 rounded shadow z-[600] pointer-events-none">
              Navigate to your location, then <strong>Lock Map</strong> to start drawing.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
