# AGENTS.md

Guide for AI coding agents working on this repo.

## What this project is

**Solar Planner** — a browser tool for sketching PV installations on satellite imagery. The user:

1. Navigates a Leaflet satellite map to their building
2. Locks the map (snapshots zoom/lat → computes meters-per-pixel)
3. Draws roof polygons by clicking vertices
4. Sets per-roof tilt and panel orientation (portrait/landscape)
5. Places individual panels on roofs — they snap to a grid aligned with the roof's long edge and stay inside the polygon
6. Creates strings, drags a lasso to assign panels; panels are auto-numbered to indicate wiring direction
7. Assigns strings to inverters
8. Switches to the **Block Diagram** view (sidebar toggle) to draw an electrical single-line diagram
9. The diagram bootstraps automatically from existing roof/inverter data; the user connects nodes and adds switches, fuses, batteries, FRE controller, grid output
10. Exports an A4 landscape PDF with two pages: roof plan + block diagram

Local-first editor backed by PocketBase for auth, team projects, and realtime sync.

## Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Build | Vite 5 | Default React-TS template config |
| UI | React 18 + TypeScript (strict) | Functional components, hooks only |
| Router | `react-router-dom` v7 | Declarative BrowserRouter; same API as v6 |
| Canvas | `react-konva` + `konva` | Object-level drag/click/hitbox on a single Stage |
| Map | `react-leaflet` + `leaflet` | Multi-provider: ESRI World Imagery, Bayern Orthophoto, Bayern ALKIS |
| State | `zustand` with `persist` + undo middleware | localStorage key: `solar-planner-project`; undo/redo via `undoMiddleware.ts` |
| i18n | `i18next` + `react-i18next` + `i18next-browser-languagedetector` | en/de; locale keys are type-checked against `en.ts` at compile time |
| Styling | Tailwind CSS + a little inline `<style>` | No component library |
| PDF | `@react-pdf/renderer` | React-component based; server-renders to PDF blob |
| Diagram canvas | `@xyflow/react` v12 | Node-edge graph for the electrical block diagram view; controlled nodes/edges via Zustand |
| Geocoding | Photon API | Open-source, no key; used for address autocomplete in `AddressAutocomplete.tsx` |
| Backend client | `pocketbase` JS SDK | Singleton in `src/backend/pb.ts`; auth persisted to localStorage |

## Backend

The server is a custom Go binary embedding PocketBase (`/server`), allowing custom HTTP routes and hooks.

- `main.go` — bootstraps `jsvm`, `migratecmd`, and custom route handlers.
- `handlers/patch.go` — `/api/sp/patch`: takes a JSON Patch + client `version`, applies atomically under a per-project lock, bumps `version`, writes to `patches` (triggering SSE fan-out). Returns new version or 409 with current server doc. Mirrors select doc fields onto `projects` row for cheap list queries.
- `handlers/datasheetImport.go` — `/api/sp/parse-datasheet`: auth + SSRF gate, then proxies to the `ocr-service` Python microservice. Returns streamed JSON array of product variants.
- `handlers/hooks.go` — auto-adds creating user as team admin on `teams` create; cron prunes old `patches` rows.
- `pb_migrations/` — JS migrations defining all collections and rules.

**PocketBase collections:**

| Collection | Purpose |
|---|---|
| `users` | Auth; `name` + `email` fields. |
| `teams` | Workspace; `name` + `created_by` FK. Owner auto-added as admin by hook. |
| `team_members` | Many-to-many users↔teams with `role: 'admin' | 'member'`. |
| `projects` | One row per project; `doc` column is the full opaque `Project` JSON; `revision` int; `name` mirrored column; `customer` optional FK; `panel_model` optional FK. |
| `patches` | Append-only log of JSON Patches; consumed by SSE for realtime sync. |
| `customers` | Team-scoped; contact records (name, address, phone, email, notes). |
| `panel_models` | Global catalog of PV modules (not team-scoped); `deleted` soft-delete flag. |
| `inverter_models` | Global catalog of inverters; `deleted` soft-delete flag; `mpptCount` + `stringsPerMppt` for MPPT grouping. |

**How to run it locally:**

```bash
cd server && go build -o pocketbase . && ./pocketbase serve
```

Admin UI at `http://127.0.0.1:8090/_/`. Data lives in `server/pb_data/`.

**OCR sidecar (`/ocr-service`):** Python FastAPI microservice — only called by Go, never directly from the browser. Downloads PDF via `httpx`, extracts text with `pdfminer`, falls back to `pdf2image` + `tesseract` for image-only PDFs, then sends text to **Gemini Flash Lite** which returns a structured JSON array of product variants. Run via `docker-compose -f docker-compose.dev.yml up` or `cd ocr-service && uvicorn main:app --port 8001`. Override endpoint via `OCR_SERVICE_URL` env var.

**Client-side sync (`src/backend/`):**

- `pb.ts` — PocketBase SDK singleton + `currentUser`/`onAuthChange` wrappers.
- `types.ts` — hand-maintained TypeScript mirrors of all PB collection schemas.
- `diff.ts` — facade over `fast-json-patch`; exports `diffProjects`, `applyProjectPatch`, `Op`.
- `syncClient.ts` — per-project state machine: debounced outbound POSTs, SSE inbound, optimistic concurrency with 409 handling, gesture queue buffering inbound patches during pointer interactions, full-resync fallback. Per-tab `deviceId` in `sessionStorage` prevents echo of own patches.
- `photon.ts` — Photon geocoding API wrapper.
- `migrateLocalStorage.ts` — one-time boot migration for pre-auth localStorage data.

**`applyRemotePatch` store action:** registered as `bypass` in `ACTION_POLICY` — remote patches do NOT enter the undo stack (undo is local-only; remote-undoable edits would let Ctrl-Z in tab A clobber tab B's work).

## Dev commands

```bash
npm install      # once
npm run dev      # http://localhost:5173 (frontend only; backend not required)
npm run build    # tsc -b && vite build (used as CI-style check)
npx tsc --noEmit # typecheck only
npx vitest run   # run unit tests (diff.ts, syncClient, undoMiddleware, stringRouting, polygonCut)
```

Full stack:

```bash
docker-compose -f docker-compose.dev.yml up   # dev (hot-reload)
docker-compose up                             # production-like build
```

There are no linters configured. Typecheck + `npm run build` + `npx vitest run` is the acceptance gate.

## Architecture Decision Records (ADRs)

ADRs live in `adr/`, named `ADR-NNN-short-description.md`. Create one whenever you introduce a new system-wide pattern, change the data model significantly, or implement a complex requirement not self-evident from the code. Fields: **Status**, **Date**, **Requirement**, **Context**, **Decision**, **Consequences**.

## Project layout

```
src/
├── main.tsx                     # React root — renders <AppShell/>, imports i18n
├── App.tsx                      # Canvas editor shell; owns `activeView` ('roof' | 'diagram')
├── index.css                    # Tailwind directives + konva-overlay classes
├── i18n.ts                      # i18next init (LanguageDetector, en+de resources)
│
├── types/index.ts               # ALL shared domain types:
│                                #   Point, Rect, PanelType, Roof, Panel, PvString,
│                                #   Inverter, MapState, ProjectMeta, ProjectAddress,
│                                #   Project, ToolMode, STRING_COLORS,
│                                #   DiagramNodeType, DiagramNodeData, DiagramNode,
│                                #   DiagramEdge, DiagramMeta, Diagram
│
├── store/
│   ├── projectStore.ts          # Zustand store: project state + all mutations + persistence
│   └── undoMiddleware.ts        # Undo/redo: buildSlice, applyUndo/Redo, ACTION_POLICY,
│                                #   setCoalesceKey, cleanUiRefs
│
├── backend/
│   ├── pb.ts                    # PocketBase SDK singleton + auth wrappers
│   ├── types.ts                 # TypeScript mirrors of all PB collection schemas
│   ├── diff.ts                  # fast-json-patch facade: diffProjects, applyProjectPatch
│   ├── syncClient.ts            # Per-project bidirectional sync state machine
│   ├── photon.ts                # Photon geocoding API wrapper (address autocomplete)
│   └── migrateLocalStorage.ts  # One-time boot migration for pre-auth localStorage data
│
├── hooks/
│   ├── useDrawingController.ts  # Tool-mode interaction state machine
│   └── useViewport.ts           # Konva Stage transform: pan, zoom, rotation, ResizeObserver
│
├── utils/
│   ├── calibration.ts           # metersPerPixel(zoom, lat) — Web Mercator formula
│   ├── geometry.ts              # Polygon ops, snap, rotate, panelDisplaySize, tilt projection
│   ├── drawingSnap.ts           # Angle + length snap for roof vertices (45° grid + edge-snap)
│   ├── polygonCut.ts            # splitPolygon + mergePolygons + boundary hit-test
│   ├── roofEditing.ts           # Edge-removal geometry (trim-to-intersection strategy)
│   ├── stringRouting.ts         # Visual wiring path: detour around off-string panels
│   ├── projectSerializer.ts     # migrateProject: back-fills defaults for pre-migration saves
│   ├── colors.ts                # Shared color utilities (string color assignment, etc.)
│   └── pdfExport.tsx            # Legacy export shim (transitional; main PDF is SolarPlanDoc)
│
├── pdf/
│   ├── SolarPlanDoc.tsx         # @react-pdf/renderer document: page 1 = roof plan,
│   │                            #   page 2 = block diagram (A4 landscape PNG)
│   └── composeStageImage.ts     # Rasterises Konva Stage (page 1) + html2canvas capture (page 2)
│
├── locales/
│   ├── en.ts                    # English strings (source of truth for type-checking)
│   └── de.ts                    # German strings
│
└── components/
    ├── AppShell.tsx             # BrowserRouter + <Routes> + useAuthUser hook
    ├── AuthGuard.tsx            # Redirects unauthenticated users to /login
    ├── LoginPage.tsx            # Email/password sign-in form
    ├── PageShell.tsx            # Shared page chrome: nav header + breadcrumbs
    ├── BrandMark.tsx            # Logo mark (SVG)
    ├── LanguageToggle.tsx       # en/de switcher
    │
    ├── TeamPicker.tsx           # / — lists teams the user belongs to
    ├── NewTeamPage.tsx          # /teams/new
    ├── TeamView.tsx             # /teams/:id — project list + new-project button
    ├── TeamMembers.tsx          # /teams/:id/members — invite / remove members
    │
    ├── NewProjectPage.tsx       # /teams/:id/projects/new
    ├── ProjectEditor.tsx        # /p/:id — fetches project, mounts <App/>, owns SyncClient
    ├── ProjectSettingsPage.tsx  # /p/:id/settings — name, client, address, notes
    ├── ProjectMetaForm.tsx      # Reusable metadata form (New + Settings pages)
    ├── ConflictModal.tsx        # 409 conflict UI — show diff, pick "mine" or "theirs"
    ├── SyncStatusIndicator.tsx  # Live sync badge (synced / syncing / conflict / offline)
    │
    ├── CustomersPage.tsx        # /teams/:id/customers — CRUD for customer records
    ├── CustomerPicker.tsx       # Dropdown to link a customer to a project
    ├── AddressAutocomplete.tsx  # Photon-backed address search + structured field form
    │
    ├── CatalogPage.tsx          # /catalog — panel_models + inverter_models CRUD + datasheet import
    ├── PanelModelPicker.tsx     # Dropdown/search for panel models (used in Sidebar)
    ├── InverterModelPicker.tsx  # Dropdown/search for inverter models (used in Sidebar)
    │
    ├── DiagramView.tsx          # Block diagram view: 1122×794 px A4 container
    │                            #   (data-diagram-view for html2canvas), triggers bootstrapDiagram()
    ├── diagram/
    │   ├── DiagramCanvas.tsx    # <ReactFlow> controlled canvas; wires store nodes/edges
    │   ├── DiagramToolbar.tsx   # "Add node" buttons for manually-added node types
    │   ├── DiagramMetaTable.tsx # 7-column editable table; persists to diagram.meta
    │   └── nodes/
    │       ├── BaseNode.tsx         # Shared rounded-rect shell: colored header, 4 handles,
    │       │                        #   contentEditable label via useReactFlow().updateNodeData()
    │       ├── SolarGeneratorNode.tsx   # amber #f59e0b
    │       ├── InverterNode.tsx         # blue #3b82f6
    │       ├── SwitchNode.tsx           # slate #64748b
    │       ├── FuseNode.tsx             # red #ef4444
    │       ├── BatteryNode.tsx          # emerald #10b981
    │       ├── FreNode.tsx              # violet #8b5cf6
    │       └── GridOutputNode.tsx       # sky #0ea5e9
    ├── Toolbar.tsx              # Top bar: lock, tool modes, undo/redo, export, save/load
    ├── Sidebar.tsx              # Panel type, inverters, strings, roof props; view toggle
    ├── MapView.tsx              # react-leaflet + MapLockSync + pre-lock rotation preview
    ├── CompassWidget.tsx        # North-arrow overlay; rotates with stage rotation
    ├── RotationDock.tsx         # Middle-mouse rotation control + reset button
    ├── KonvaOverlay.tsx         # <Stage> + composes useViewport + useDrawingController
    ├── RoofLayer.tsx            # Draws polygons; edge-click opens edge-removal confirm dialog
    ├── PanelLayer.tsx           # Placed panels + ghost preview; drag-to-move group
    ├── StringLayer.tsx          # Wiring polylines via stringRouting.ts
    └── StringLasso.tsx          # Lasso rect renderer (deprecated paint mode remnant)
```

**Routing table:**

| Path | Component | Notes |
|---|---|---|
| `/login` | `LoginPage` | Public |
| `/` | `TeamPicker` | Auth required |
| `/teams/new` | `NewTeamPage` | Auth required |
| `/teams/:teamId` | `TeamView` | Auth required |
| `/teams/:teamId/members` | `TeamMembers` | Auth required |
| `/teams/:teamId/projects/new` | `NewProjectPage` | Auth required |
| `/teams/:teamId/customers` | `CustomersPage` | Auth required |
| `/p/:projectId` | `ProjectEditor` → `App` | Auth required |
| `/p/:projectId/settings` | `ProjectSettingsPage` | Auth required |
| `/catalog` | `CatalogPage` | Auth required; global (not team-scoped) |

## Architecture

### State flow

Everything non-visual is in the single Zustand store (`useProjectStore`). Actions are store methods — **never mutate state directly**.

```
User input → Component event handler → store.someAction(args)
  → undoMiddleware intercepts set() → classifies by ACTION_POLICY:
      ├─ bypass → passes through
      └─ record → snapshots UndoableSlice; pushes `before` onto `past`; clears `future`
  → Zustand sets state; persist writes to localStorage
  → subscribed components re-render
  → syncClient detects diff → POSTs JSON Patch to /api/sp/patch
      ↑ SSE (patches collection)
      └─ remote change → store.applyRemotePatch (bypass, no undo entry)
```

Three kinds of state:
- **Persistent** (`project`): roofs, panels, strings, inverters, panelType, mapState, meta, diagram
- **Ephemeral** (`toolMode`, `selectedRoofId`, `activeStringId`, …): not persisted
- **History** (`past`, `future`, `canUndo`, `canRedo`): undo/redo stacks; in-memory only

### Authentication and routing

`AppShell.tsx` hosts `BrowserRouter` and all routes. Protected routes are wrapped in `<AuthGuard>` (reads `pb.authStore.record`). `useAuthUser()` from `AppShell.tsx` is the canonical current-user hook — subscribes to `pb.authStore.onChange`.

`ProjectEditor` bridges router → editor: fetches project, calls `store.loadProject(doc)`, starts `SyncClient`. On unmount: `store.resetProject()` + stop client. `App.tsx` is server-agnostic and never imports from `backend/`.

### Undo/Redo

`undoMiddleware.ts` wraps Zustand's `set()` and classifies via `ACTION_POLICY`:

- **`record`** — snapshots `UndoableSlice` (name, panelType, roofs, panels, strings, inverters — NOT mapState) before mutation; pushes onto `past`; clears `future`. Rapid-fire calls with same `actionName` + `key` within 500 ms collapse into one history step (coalescing via `setCoalesceKey`).
- **`bypass`** — passes through (UI state, mapState, remote patches, etc.).
- **`clear-history`** — called on `resetProject`.
- **`load-history`** — called on `loadProject`.

`mapState` is excluded from undo snapshots by design — undoing a panel edit must not resurrect a previous captured map image.

### Panel groups

`groupId` is stored on every `Panel` (not a separate entity). Active group tracked in `activePanelGroupId`. Groups govern shared orientation (`updateGroupOrientation`), whole-group moves (`moveGroup`), and undo coalescing for multi-panel placements. Valid group IDs are derived by scanning `project.panels`.

### Roof split and merge

- **Split** (`splitRoof`): polyline whose endpoints lie on an existing roof's boundary. `splitPolygon()` in `polygonCut.ts` produces two polygons; store migrates panels.
- **Merge** (`mergeRoofs`): two roofs sharing an edge. `mergePolygons()` finds the shared edge and produces a single polygon.
- **Edge removal**: right-click edge in `delete` mode → `computeEdgeRemoval()` in `roofEditing.ts` extends neighbour edges to meet (trim-to-intersection strategy).

### Map and viewport

`MapState` is a discriminated union on `locked`:
- `locked: false` → Leaflet active; no drawing possible.
- `locked: true` → Leaflet torn down; tile view rasterised to `capturedImage` (base64 PNG) via `html2canvas`; all canvas coords in that pixel frame.

**Map providers:** `'esri'` (default), `'bayern'` (Bavarian Orthophoto), `'bayern_alkis'` (cadastral overlay). Stored on `mapState`.

**Rotation:** pre-lock (CSS-transformed Leaflet preview) or post-lock (middle-mouse / `RotationDock`). `initialRotationDeg` on locked `MapState` is persisted; live post-lock rotation is session-local.

`useViewport.ts` owns Stage transform state as **refs** (not React state) to avoid 60 Hz re-renders.

### String wiring (visual routing)

`stringRouting.ts` detours wiring lines around non-member panels on the same roof. For each segment between consecutive string panels: check nearby non-members; if found, detour perpendicular to the segment direction. Try both sides and pick the one minimising crossings ("best-effort cross-free routing").

### Block diagram

`activeView: 'roof' | 'diagram'` in `App.tsx` toggles between Konva/map and `DiagramView`. Node/edge state lives in `project.diagram` as plain `DiagramNode[]` / `DiagramEdge[]` matching React Flow's native shapes. All diagram store actions are `bypass` (no undo stack).

**Node types:** Seven custom nodes wrapping `BaseNode.tsx`. React Flow v12 pattern: `NodeProps<Node<DiagramNodeData, 'solarGenerator'>>` — NOT the v11 form.

**Bootstrap:** `bootstrapDiagram()` is idempotent — exits if `project.diagram` exists. Creates one `solarGenerator` per Roof and one `inverter` per Inverter; no edges auto-created.

**PDF capture:** `DiagramView` renders in `<div data-diagram-view>` at 1122 × 794 px. `captureDiagramView()` passes it to `html2canvas`; PNG goes to `SolarPlanDoc.tsx` as page 2. If the element isn't mounted at export time, the second page is silently skipped.

### i18n

`t()` is the only way to produce user-visible strings. The resource type is augmented from `en.ts` — missing keys are compile errors.

### Coordinate system

Canvas coords are Leaflet container pixels at the moment of map lock. `mapState.metersPerPixel` (mpp) is the calibration. The Konva Stage is a full-size overlay (`pointer-events: none` when unlocked, `auto` when a tool is active).

### Tilt projection (the tricky math)

The satellite view is the **horizontal projection** of a sloped roof. `panelDisplaySize(panelType, roof, mpp)` in `utils/geometry.ts` is the single source of truth:

```
portrait:
  displayW = panelType.widthM  / mpp
  displayH = panelType.heightM * cos(tilt) / mpp

landscape:
  displayW = panelType.heightM / mpp
  displayH = panelType.widthM  * cos(tilt) / mpp
```

**If you change the tilt model, change it here and only here.**

### Panel grid snapping

`snapPanelToGrid()` in `utils/geometry.ts`:

1. Compute roof's primary angle (longest edge → atan2)
2. Rotate cursor into roof-local frame (origin = centroid)
3. Snap to nearest `displayW × displayH` multiple
4. Rotate back to canvas frame
5. Reject if any corner is outside polygon
6. Reject if within `0.7 × min(cellW, cellH)` of an existing panel center

Returns `null` on rejection → caller draws a red ghost.

### String numbering

`renumberStrings()` (bottom of `projectStore.ts`) is called **after any mutation that touches `panel.stringId`**. Sorts panels by `(descending cy, ascending cx)` and rewrites `indexInString`. See `assignPanelsToString` for the pattern.

### Tool modes

`ToolMode`: `'idle' | 'draw-roof' | 'place-panels' | 'assign-string' | 'delete'`. Toolbar sets mode; `KonvaOverlay` gates handlers on `toolMode`; `Escape` resets to `idle`. `place-panels` ghost/click lives in `PanelLayer.tsx`; `delete` in `RoofLayer.tsx`/`PanelLayer.tsx`.

### Event bubbling

Konva events bubble shape → Stage. Set `e.cancelBubble = true` in shape handlers to prevent Stage handler from firing.

## Adding a feature — quick recipes

### New persisted field on a Roof
1. Add field to `Roof` interface in `types/index.ts`
2. Add a default in `addRoof()` in `store/projectStore.ts`
3. If mutable, add a setter or use `updateRoof(id, changes)`
4. Update `migrateProject` in `src/utils/projectSerializer.ts`
5. Render control in `Sidebar.tsx` under the selected-roof section

### New persisted field on a doc-embedded entity (Roof, Panel, String, …)

No server-side schema change needed — `doc` is opaque JSON.

1. Update the TypeScript type in `src/types/index.ts`.
2. Update `migrateProject` in `src/utils/projectSerializer.ts`.
3. Exception: if also surfaced as a `projects` ROW column, mirror it in `server/handlers/patch.go`.

### New store action
1. Add name literal to `ActionName` in `undoMiddleware.ts`
2. Add `Policy` entry to `ACTION_POLICY` (compile error if missing)
3. Implement in `projectStore.ts`
4. If undoable and entity-specific, call `setCoalesceKey(set, 'actionName', entityId)` immediately before `set()`

### New tool mode
1. Add literal to `ToolMode` union in `types/index.ts`
2. Add button in `Toolbar.tsx` + keyboard shortcut in `App.tsx`
3. Gate rendering/handlers in `useDrawingController.ts` or `useViewport.ts`
4. Add reset branch in `useDrawingController.ts` keydown handler (Escape)

### New PDF section

Add React components using `<View>`, `<Text>`, `<Image>` from `@react-pdf/renderer` to `src/pdf/SolarPlanDoc.tsx`. A4 landscape = 841.89 × 595.28 pt. Do NOT add to `utils/pdfExport.tsx`.

### New user-visible string
1. Add key in `src/locales/en.ts`
2. Add German translation in `src/locales/de.ts`
3. Use `const { t } = useTranslation()` and call `t('your.key')`

### New PocketBase collection
1. Create JS migration in `server/pb_migrations/` (`<unix_timestamp>_<description>.js`)
2. Add TypeScript mirror interface in `src/backend/types.ts`
3. Rebuild: `go build -o pocketbase .` in `server/`

## Conventions

- **TypeScript strict** — no implicit any
- Named exports for utilities, default exports for components
- No side effects outside effects/event handlers
- Selectors return the smallest needed slice
- No imports from `store/projectStore` in `utils/*` — utilities are pure
- No imports from `backend/*` in `App.tsx` or canvas components — `ProjectEditor` is the server boundary
- IDs are short random strings (`uid()` in the store); no UUID library
- **Comments:** generous inline comments with WHY context (design reasoning, not just what)
- `src/components` → PascalCase; `utils/` → camelCase
- Every new store action **must** appear in `ActionName` AND `ACTION_POLICY` (compile error if missing)
- User-visible strings go in `locales/en.ts` + `locales/de.ts` — never hardcode English text in JSX

## Known limits / non-goals

- **No multi-select of panels** — only whole-group moves via `moveGroup`
- **No rotation of panel grid independent of the roof** — always aligns to longest edge
- **No non-map-mode calibration** — drawing requires a locked map
- **Map tile PDF capture can fail silently** (CORS); `composeStageImage.ts` handles the fallback
- Konva Stage is a single layer; split into static/dynamic `<Layer>`s if perf becomes an issue
- **Undo/redo does not restore mapState** — by design
- **Inverter catalog links are soft-FK only** — inside opaque `doc` JSON; UI must tolerate dangling refs
- **No offline capability** — requires live PocketBase connection; sync layer handles transient disconnects only

## Pitfalls that have already bitten

- `leaflet` optional `tap` property isn't typed on `L.Map` — cast via `unknown` (see `MapView.tsx`)
- Don't put transient state inside `project` — `persist` writes on every state change
- Call `renumberStrings()` whenever you touch `panel.stringId` — silent off-by-one is the failure mode
- Konva shape clicks bubble to Stage — set `e.cancelBubble = true` in shape handlers when needed
- **Every new store action must be in `ACTION_POLICY`** — missing entry silently defaults to `bypass`
- **`useViewport.ts` uses refs, not state** — `isDraggingView()` is a getter, not a boolean; not a valid React dependency
- The Enter-key commit path in `useDrawingController.ts` uses `useProjectStore.getState()` for fresh state — follow this pattern for any new key handlers that need current store state
- `setCoalesceKey` must be called **immediately before** its matching `set()` — a stale key from a prior action can leak
- Soft-deleted `panel_models` rows: filter from pickers but don't hard-delete if projects reference them
- `go build ./...` does **not** update `./pocketbase` — always `go build -o pocketbase .` in `server/`
- **React Flow v12 node prop types:** use `NodeProps<Node<DiagramNodeData, 'solarGenerator'>>`, NOT the v11 form. `DiagramNodeData` must satisfy `Record<string, unknown>` — add `[key: string]: unknown`
- **Diagram PDF page only appears when `DiagramView` is mounted** — exporting from roof plan view skips page 2 (intentional)

## Where to start reading

1. `src/types/index.ts` — full domain data model
2. `src/store/projectStore.ts` — every state transition
3. `src/store/undoMiddleware.ts` — undo/redo and ACTION_POLICY
4. `src/utils/geometry.ts` — spatial math (tilt projection, grid snapping)
5. `src/components/AppShell.tsx` — routing + auth session
6. `src/components/ProjectEditor.tsx` — server↔editor bridge
7. `src/components/KonvaOverlay.tsx` — Stage host
8. `src/hooks/useDrawingController.ts` — tool-mode interaction state machine
9. `src/components/Toolbar.tsx` + `Sidebar.tsx` — user-facing controls
10. `src/pdf/SolarPlanDoc.tsx` — export layout
11. `src/backend/syncClient.ts` — bidirectional sync state machine
