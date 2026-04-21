# AGENTS.md

Guide for AI coding agents working on this repo.

## What this project is

**Solar Planner** — a single-user browser tool for sketching PV installations on satellite imagery. The user:

1. Navigates a Leaflet satellite map to their building
2. Locks the map (snapshots zoom/lat → computes meters-per-pixel)
3. Draws roof polygons by clicking vertices
4. Sets per-roof tilt and panel orientation (portrait/landscape)
5. Places individual panels on roofs — they snap to a grid aligned with the roof's long edge and stay inside the polygon
6. Creates strings, drags a lasso to assign panels; panels are auto-numbered to indicate wiring direction
7. Assigns strings to inverters
8. Exports an A4 landscape PDF with the plan + string-to-inverter table

No backend. Everything lives in `localStorage`; JSON export/import handles portability.

## Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Build | Vite 5 | Default React-TS template config |
| UI | React 18 + TypeScript (strict) | Functional components, hooks only |
| Canvas | `react-konva` + `konva` | Object-level drag/click/hitbox on a single Stage |
| Map | `react-leaflet` + `leaflet` | ESRI World Imagery tiles, no API key |
| State | `zustand` with `persist` | localStorage key: `solar-planner-project` |
| Styling | Tailwind CSS + a little inline `<style>` | No component library |
| PDF | `jspdf` + `html2canvas` | Client-side; tile CORS may prevent capturing the map layer — code falls back to canvas only |

## Dev commands

```bash
npm install      # once
npm run dev      # http://localhost:5173
npm run build    # tsc -b && vite build (used as CI-style check)
npx tsc --noEmit # typecheck only
```

There are no tests or linters configured. Typecheck + `npm run build` is the acceptance gate.

## Architecture Decision Records (ADRs)

We use ADRs to document significant architectural decisions, requirements, and their rationale. This ensures that the reasoning behind the project's evolution is preserved for future contributors (AI or human).

- **Location:** All ADRs live in the `adr/` directory.
- **Naming:** Files are named `ADR-NNN-short-description.md` (e.g., `ADR-001-zoom-synchronization.md`).
- **When to create one:** Whenever you introduce a new system-wide pattern, change the data model significantly, or implement a complex requirement that isn't fully explained by the code itself.
- **Template:**
  ```markdown
  # ADR-NNN: [Short Description]

  - **Status:** [Proposed | Accepted | Superseded]
  - **Date:** [YYYY-MM-DD]
  - **Requirement:** [What user need or technical constraint is being addressed?]

  ## Context
  [What is the problem? Why is it a problem? What are the existing constraints?]

  ## Decision
  [What was chosen? How does it solve the problem?]

  ## Consequences
  [What are the trade-offs? What new constraints or opportunities does this create?]
  ```

## Project layout

```
src/
├── main.tsx                   # React root + Leaflet CSS import
├── App.tsx                    # Layout shell, keyboard shortcuts, hint banner
├── index.css                  # Tailwind directives + konva-overlay classes
├── types/index.ts             # ALL shared types + STRING_COLORS palette
├── store/projectStore.ts      # Zustand store + persistence + renumberStrings
├── utils/
│   ├── calibration.ts         # metersPerPixel(zoom, lat) — Web Mercator
│   ├── geometry.ts            # polygon ops, snap, rotate, displaySize
│   └── pdfExport.ts           # composite canvas + jsPDF layout
└── components/
    ├── Toolbar.tsx            # Top bar: lock, modes, export, save/load
    ├── Sidebar.tsx            # Panel type, inverters, strings, roof props
    ├── MapView.tsx            # react-leaflet + MapLockSync
    ├── KonvaOverlay.tsx       # Stage + pointer/lasso state machine
    ├── RoofLayer.tsx          # Draws polygons (committed + in-progress)
    ├── PanelLayer.tsx         # Placed panels + ghost preview
    └── StringLasso.tsx        # Dumb renderer for lasso rect
```

## Architecture

### State flow

Everything non-visual is in the single Zustand store (`useProjectStore`). Components subscribe to slices with selectors (`useProjectStore((s) => s.project.panels)`). Actions are exposed as store methods — **never mutate state directly**; always go through a setter so `persist` fires.

```
User input
  │
  ▼
Component event handler
  │
  ▼
store.someAction(args)         ← all mutation lives here
  │
  ▼
Zustand sets state; persist middleware writes to localStorage
  │
  ▼
Subscribed components re-render
```

Two kinds of state:
- **Persistent** (`project`): roofs, panels, strings, inverters, panelType, mapState
- **Ephemeral** (`toolMode`, `selectedRoofId`, `activeStringId`): not persisted (see `partialize` in the store)

### Coordinate system

**Critical**: canvas coordinates are Leaflet container pixels at the moment the map was locked. Everything (roof vertices, panel centers, lasso rects) is stored in that pixel space.

- `mapState.metersPerPixel` (mpp) is the calibration — set once by `lockMap` using `metersPerPixel(zoom, lat)` from `utils/calibration.ts`
- To convert pixels → meters: multiply by `mpp`
- The Konva Stage is a full-size overlay positioned over the Leaflet container, with `pointer-events: none` when map unlocked and `pointer-events: auto` when a tool mode is active (see `.konva-overlay-active` / `-passive` in `index.css`)

### Tilt projection (the tricky math)

The satellite view is the **horizontal projection** of a sloped roof. Panels mounted on the slope appear compressed along the slope direction. In this project the convention is:

- The roof's "long axis" (longest edge) is taken as **horizontal** (no compression)
- The **perpendicular** axis is the slope direction → compressed by `cos(tiltDeg)`

`panelDisplaySize(panelType, roof, mpp)` in `utils/geometry.ts` is the single source of truth:

```
portrait:
  displayW = panelType.widthM  / mpp        // short side, along roof long axis
  displayH = panelType.heightM * cos(tilt) / mpp   // long side, up the slope

landscape:
  displayW = panelType.heightM / mpp
  displayH = panelType.widthM  * cos(tilt) / mpp
```

**If you change the tilt model, change it here and only here** — every component reads from this function.

### Panel grid snapping

`snapPanelToGrid()` in `utils/geometry.ts`:

1. Compute the roof's primary angle (longest edge → atan2)
2. Rotate cursor into the roof-local frame (origin = polygon centroid)
3. Snap to nearest multiple of `displayW × displayH` (the cell size)
4. Rotate back to canvas frame
5. Reject if any of the panel's 4 corners is outside the polygon
6. Reject if within `0.7 × min(cellW, cellH)` of any existing panel center on that roof

Returns `null` on rejection → caller draws a red ghost.

### String numbering

`renumberStrings()` (bottom of `store/projectStore.ts`) is called **after any mutation that affects a string's membership** (assign, unassign, delete panel, delete roof). It sorts panels within a string by `(descending cy, ascending cx)` = bottom-to-top, left-to-right — i.e. the standard solar-string snake starting at the lower-left — and rewrites `indexInString`.

Any new mutation that touches `panel.stringId` must call `renumberStrings` on the affected string ids. See `assignPanelsToString` for the pattern.

### Tool modes

`ToolMode` is a tagged string union: `'idle' | 'draw-roof' | 'place-panels' | 'assign-string' | 'delete'`.

- The Toolbar sets mode via `setToolMode`
- `KonvaOverlay` gates its pointer handlers on `toolMode`
- Mode buttons are disabled when the map isn't locked
- `Escape` key resets to `idle` and clears in-progress drawing/lasso

Each mode's event handling lives in `KonvaOverlay.tsx` except:
- `place-panels`'s ghost rendering and click-to-place handler are in `PanelLayer.tsx` (because the ghost needs access to the selected roof + panel type)
- `delete` is handled by individual shape `onClick`/`onContextMenu` in `RoofLayer.tsx` and `PanelLayer.tsx`

### Event bubbling gotcha

Konva events bubble from shape → Stage. Shape handlers set `e.cancelBubble = true` when they want to stop the Stage handler from firing (e.g. clicking a roof to select it shouldn't add a roof-draw vertex). Check existing code in `RoofLayer.tsx` and `PanelLayer.tsx` before adding new shape clicks.

## Adding a feature — quick recipes

### New persisted field on a Roof
1. Add field to `Roof` interface in `types/index.ts`
2. Add a default in `addRoof()` in `store/projectStore.ts`
3. If mutable, add a setter or use `updateRoof(id, changes)`
4. Render control in `Sidebar.tsx` under the selected-roof section

### New tool mode
1. Add the literal to the `ToolMode` union
2. Add a button in `Toolbar.tsx` (`MODES` array + handler, and a keyboard shortcut in `App.tsx`)
3. Gate rendering/handlers in `KonvaOverlay.tsx` (or the relevant layer)
4. Make sure `Escape` resets it (already handled if you follow the pattern)

### New PDF section
PDF layout is hand-coded mm arithmetic in `utils/pdfExport.ts`. The left pane is the composited canvas image; the right pane is the string table + totals. Add rows by incrementing `cursorY`. Page is `297 × 210 mm`, margins `8 mm`.

## Conventions

- **TypeScript strict** is on; no implicit any
- Prefer **named exports** for utilities, **default** for components
- Keep components pure — **no side effects outside effects/event handlers**
- Selectors should return the smallest slice needed (don't destructure the whole project)
- Don't import from `store/projectStore` into `utils/*` — utilities are pure
- Ids are short random strings (`uid()` in the store); no UUID library
- Comments: only when the WHY isn't obvious. Don't restate the code
- New files under `src/components` use PascalCase; utilities use camelCase

## Known limits / non-goals

- **No Undo/Redo** — deferred
- **No multi-select of panels** — one at a time
- **No rotation of the panel grid independent of the roof** — panels always align to the roof's longest edge
- **No non-map mode calibration** — drawing only works after locking a map
- **Map tile PDF capture can fail silently** (CORS); falls back to canvas-only plan. The console warns
- The Konva Stage is a single layer for simplicity; if perf ever becomes an issue, split static (roofs) and dynamic (ghost/lasso) onto separate `<Layer>`s

## Pitfalls that have already bitten

- `leaflet` optional `tap` property isn't typed on `L.Map` — cast via `unknown` (see `MapView.tsx`)
- The Zustand `persist` middleware writes the full `project` on every state change; don't put transient state inside `project` or you'll write every mousemove
- Don't forget to call `renumberStrings()` when you touch `panel.stringId` — silent off-by-one numbering is the failure mode
- Konva shape clicks bubble to the Stage by default — set `e.cancelBubble = true` in shape handlers when needed

## Where to start reading

If you're new to the codebase, read in this order:

1. `src/types/index.ts` — the full data model in ~60 lines
2. `src/store/projectStore.ts` — every state transition
3. `src/utils/geometry.ts` — the spatial math
4. `src/components/KonvaOverlay.tsx` — the interaction state machine
5. `src/components/Toolbar.tsx` + `Sidebar.tsx` — user-facing controls
6. `src/utils/pdfExport.ts` — export layout
