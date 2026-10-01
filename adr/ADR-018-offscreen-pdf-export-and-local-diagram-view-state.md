# ADR-018: Offscreen PDF Export and Local-Only Diagram View State

- **Status:** Accepted
- **Date:** 2026-10-01
- **Requirement:** "Export PDF" must always produce both pages (roof plan + block diagram), whichever view is on screen. Per-viewer interaction state in the block diagram (selection, measured sizes, in-progress drags) must never reach the shared project document.

## Context

1. **One-page PDFs.** `App.tsx` renders either the roof canvas or `DiagramView`, never both. The exporter captured "whatever is mounted": exporting from the roof view silently skipped the diagram page, and exporting from the diagram view had no roof plan. AGENTS.md even documented this as intentional, but users expected both pages every time.
2. **Switching views to capture was rejected.** Briefly navigating to the other view would remount (and reset) the view the user is looking at, flash it on screen, and race router navigation and the sync client.
3. **React Flow's change stream is chatty and per-viewer.** `DiagramCanvas` piped `applyNodeChanges(changes, nodes)` straight into `setDiagramNodes`. So `selected: true` from a click landed in `project.diagram` (clicking a node in tab A selected it in tab B and produced a server patch); `measured` was synced on every mount and font load; and every pointer-move frame of a drag was a store write plus a JSON patch, with `dragging: true` persisted mid-drag.

## Decision

1. **Render the missing page offscreen.** `Toolbar.tsx` hands `exportPdf` (`src/pdf/pdfExport.tsx`; formerly `src/utils/pdfExport.tsx`), per page, either the mounted element (preferred, so the user's current pan/zoom is kept) or an `OffscreenRender` recipe:
   - Roof plan: `KonvaExportFrame` (exported from `KonvaOverlay.tsx`), a self-contained Stage sized to the locked capture with a fresh viewport. Only offered when the map is locked.
   - Block diagram: `<DiagramView exportMode onReady>`. `exportMode` skips the bootstrap effect and makes the canvas a static snapshot. Only offered when the diagram has nodes.
2. **`withOffscreenRoot`** mounts the recipe in a temporary React root inside a `position: fixed`, off-viewport, `inert` + `aria-hidden` container (laid out at full size, unlike `display: none`, so ResizeObserver and `getBoundingClientRect` work). It waits for `onReady` (Konva: background decoded; React Flow: nodes measured and `fitView` done) or a 6 s timeout, captures, and always unmounts in a `finally`, so a failed capture can't leak a hidden React tree.
3. **Capture and render split.** The diagram sheet and the HTML/CSS roof-page frame (`src/pdf/PlanPageFrame.tsx`) are captured with `html-to-image` (`captureDiagramView` in `src/pdf/composeStageImage.ts`) together with their text runs. The Konva stage is captured from the scene graph via Konva's `stage.toCanvas`, with `html2canvas` as fallback (`captureStage`). The payload is POSTed to `/pdf/render`, where `pdf-service` renders `src/pdf/SolarPlanDoc.tsx` with `@react-pdf/renderer` in Node.
4. **Diagram view state is local React state.** `src/components/diagram/diagramChanges.ts` (pure, unit-tested) splits React Flow changes into ephemeral and persistent ones. Selection, measured dimensions (`measured`) and in-progress drag positions stay in `DiagramCanvas`'s local state. Only real document edits — drag end (or non-drag moves such as keyboard nudges), add, remove, replace/data edits — reach the store.
5. **Strip transient fields at every boundary.** `stripNodeTransient` / `stripEdgeTransient` remove `selected`, `dragging`, `measured`, `resizing`, `internals`, `positionAbsolute` (edges: `selected`). The store's `setDiagramNodes` / `setDiagramEdges` strip again, and `migrateProject` strips them from loaded documents, so legacy docs that already carry them are cleaned on load.

## Consequences

- **Pros:** Every export has both pages when both have content, independent of the active view. Clicking or dragging in the diagram no longer produces a patch per frame or leaks selection to collaborators. The ephemeral/persistent routing is testable without React.
- **Cons:** An export from the diagram view frames the roof plan at the full locked capture area, not at the user's last roof-view pan/zoom (that viewport is session-local and gone once the view unmounts). The offscreen render briefly mounts a second Konva Stage or React Flow instance, which costs memory on large projects. A render that never signals ready is captured anyway after the timeout and may be incomplete.
- **Supersedes** the AGENTS.md note "Diagram PDF page only appears when `DiagramView` is mounted".
