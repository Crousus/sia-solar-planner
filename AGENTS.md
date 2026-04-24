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
8. Switches to the **Block Diagram** view (sidebar toggle) to draw an electrical single-line diagram
9. The diagram bootstraps automatically from existing roof/inverter data; the user connects nodes and adds switches, fuses, batteries, FRE controller, grid output
10. Exports an A4 landscape PDF with two pages: roof plan + block diagram

Local-first editor backed by PocketBase for auth, team projects, and realtime sync. See `docs/superpowers/specs/2026-04-21-backend-sync-design.md` for the design rationale and `docs/superpowers/plans/2026-04-21-backend-sync.md` for the implementation plan.

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
| PDF | `@react-pdf/renderer` | React-component based; server-renders to PDF blob; replaced jspdf+html2canvas |
| Diagram canvas | `@xyflow/react` v12 | Node-edge graph for the electrical block diagram view; controlled nodes/edges via Zustand |
| Geocoding | Photon API | Open-source, no key; used for address autocomplete in `AddressAutocomplete.tsx` |
| Backend client | `pocketbase` JS SDK | Singleton in `src/backend/pb.ts`; auth persisted to localStorage |

## Backend

The app is local-first but authoritative state lives server-side once a user signs in. The server is a custom Go binary that embeds PocketBase — we embed rather than use the stock `pocketbase` binary so we can ship custom HTTP routes and hooks that PocketBase doesn't support out of the box.

**Where the server lives:** `/server`.

- `main.go` — bootstrap. Wires up `jsvm` (for hook scripts) and `migratecmd` (for JS-based schema migrations) so schema changes stay in version control instead of living only in the admin UI. Also registers the custom route handlers.
- `handlers/patch.go` — the custom `/api/sp/patch` route. Takes a JSON Patch + the client's last known `version`, applies it atomically under a per-project lock, bumps `version`, writes a row into the `patches` collection (which triggers SSE fan-out to other tabs), and returns either the new version or a 409 with the current server doc for conflict UI. Also mirrors a handful of doc fields (e.g. `name`) onto the `projects` row so list queries stay cheap.
- `handlers/datasheetImport.go` — the `/api/sp/parse-datasheet` route. Auth + SSRF gate (only authenticated users; only public http/https URLs with a known host). Proxies validated requests to the `ocr-service` Python microservice which handles the actual PDF download, text extraction, and LLM parsing. Returns a streamed JSON array of product variants (one per spec variant found in the datasheet). Auth and SSRF live in Go; OCR lives in Python — see "OCR sidecar" below.
- `handlers/hooks.go` — two things. (a) On `teams` create, the creating user is auto-added as admin so the owner always has access. (b) A cron that prunes old rows from `patches` (the SSE log grows forever otherwise; we only need recent history for late-joining subscribers).
- `pb_migrations/` — JS migrations that define ALL collections plus their rules. Current schema covers: `users`, `teams`, `team_members`, `projects`, `patches`, `customers`, `panel_models`, `inverter_models`.

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

**OCR sidecar (`/ocr-service`):**

A separate Python FastAPI microservice that owns datasheet parsing. It is NOT reached directly from the browser — the Go backend is the only caller. Architecture:

1. Download PDF via `httpx` (25 MB cap).
2. Extract text with `pdfminer` (free, works for digitally-authored PDFs).
3. OCR fallback via `pdf2image` + `tesseract` when text is < 80 alnum chars (catches manufacturers like JA Solar/Longi that render fonts without Unicode maps).
4. Send extracted text to **Gemini Flash Lite** which normalises OCR artefacts, handles multi-variant tables, and returns a structured JSON array — one dict per product variant.

Run locally with `docker-compose -f docker-compose.dev.yml up` or start it directly: `cd ocr-service && uvicorn main:app --port 8001`. Override the endpoint via `OCR_SERVICE_URL` env var on the Go backend.

**Client-side sync lives in `src/backend/`:**

- `pb.ts` — PocketBase SDK singleton plus thin wrappers (`currentUser`, `onAuthChange`). Centralising the singleton means other modules never construct their own client and auth state has exactly one source of truth.
- `types.ts` — TypeScript mirrors of every PocketBase collection schema (`UserRecord`, `TeamRecord`, `ProjectRecord`, `PanelModelRecord`, `InverterModelRecord`, `CustomerRecord`, `PatchRecord`). Hand-maintained (not generated) because the collections are stable and small.
- `diff.ts` — facade over `fast-json-patch`. Exports `diffProjects`, `applyProjectPatch`, and the `Op` type. Keeping the JSON Patch library behind our own API means we can swap implementations (or add normalization) without touching callers.
- `syncClient.ts` — per-project state machine, one instance per mounted `ProjectEditor`. Responsibilities: debounced outbound POSTs to `/api/sp/patch`, SSE inbound via `pb.collection('patches').subscribe`, optimistic concurrency with 409 handling, a gesture queue that buffers inbound patches during active pointer interactions (so a remote edit can't yank a roof out from under the user mid-drag), and a full-resync fallback when things get wedged. Per-tab `deviceId` stored in `sessionStorage` is written onto each `patches` row; SSE subscribers drop their own echoes by matching `device_id`.
- `photon.ts` — thin wrapper over the Photon geocoding API for address autocomplete.
- `migrateLocalStorage.ts` — one-time migration helper; runs on app boot to normalise localStorage data from pre-auth-era single-project format.

**`applyRemotePatch` store action:** registered as `bypass` in `ACTION_POLICY` in `undoMiddleware.ts`. Remote-originated patches do NOT enter the undo stack — per spec Q11, undo is a local-only concept. If remote edits were undoable, Ctrl-Z in tab A could clobber tab B's work. The `syncClient` calls this action when an SSE patch arrives.

## Dev commands

```bash
npm install      # once
npm run dev      # http://localhost:5173 (frontend only; backend not required)
npm run build    # tsc -b && vite build (used as CI-style check)
npx tsc --noEmit # typecheck only
npx vitest run   # run unit tests (diff.ts, syncClient, undoMiddleware, stringRouting, polygonCut)
```

Start the full stack (frontend + backend + OCR sidecar):

```bash
# Dev (hot-reload frontend, OCR logs to console):
docker-compose -f docker-compose.dev.yml up

# Production-like build:
docker-compose up
```

Or run each service independently:

```bash
# Go backend (port 8090):
cd server && go build -o pocketbase . && ./pocketbase serve

# OCR sidecar (port 8001) — requires Python + tesseract:
cd ocr-service && pip install -r requirements.txt && uvicorn main:app --port 8001

# Frontend (port 5173):
npm run dev
```

There are no linters configured. Typecheck (`npx tsc --noEmit`) + `npm run build` + `npx vitest run` is the acceptance gate.

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
├── main.tsx                     # React root — renders <AppShell/>, imports i18n
├── App.tsx                      # The canvas editor shell (keyboard shortcuts, hint banner)
│                                #   rendered by ProjectEditor at /p/:id; owns the
│                                #   `activeView` ('roof' | 'diagram') local state and
│                                #   conditionally renders MapView/KonvaOverlay vs DiagramView
├── index.css                    # Tailwind directives + konva-overlay classes
├── i18n.ts                      # i18next init (LanguageDetector, en+de resources)
│
├── types/index.ts               # ALL shared domain types:
│                                #   Point, Rect, PanelType, Roof, Panel, PvString,
│                                #   Inverter, MapState (discriminated union), ProjectMeta,
│                                #   ProjectAddress, Project, ToolMode, STRING_COLORS,
│                                #   DiagramNodeType, DiagramNodeData, DiagramNode,
│                                #   DiagramEdge, DiagramMeta, Diagram
│
├── store/
│   ├── projectStore.ts          # Zustand store: project state + all mutations +
│   │                            #   undo/redo + persistence (localStorage)
│   └── undoMiddleware.ts        # Undo/redo middleware: buildSlice, applyUndo/Redo,
│                                #   ACTION_POLICY, setCoalesceKey, cleanUiRefs
│
├── backend/
│   ├── pb.ts                    # PocketBase SDK singleton + useAuthUser-friendly wrappers
│   ├── types.ts                 # TypeScript mirrors of all PB collection schemas
│   ├── diff.ts                  # fast-json-patch facade: diffProjects, applyProjectPatch
│   ├── syncClient.ts            # Per-project bidirectional sync state machine
│   ├── photon.ts                # Photon geocoding API wrapper (address autocomplete)
│   └── migrateLocalStorage.ts  # One-time boot migration for pre-auth localStorage data
│
├── hooks/
│   ├── useDrawingController.ts  # Tool-mode interaction state machine (extracted from KonvaOverlay)
│   │                            #   owns: drawingPoints, cursor, paint-drag, Escape/Enter/Shift keys
│   └── useViewport.ts           # Konva Stage transform: pan (space+drag / RMB), zoom (wheel),
│                                #   rotation (middle-mouse drag), ResizeObserver
│
├── utils/
│   ├── calibration.ts           # metersPerPixel(zoom, lat) — Web Mercator formula
│   ├── geometry.ts              # Polygon ops, snap, rotate, panelDisplaySize, tilt projection
│   ├── drawingSnap.ts           # Angle + length snap for roof vertices (45° grid + edge-snap)
│   ├── polygonCut.ts            # splitPolygon (polyline cut) + mergePolygons + boundary hit-test
│   ├── roofEditing.ts           # Edge-removal geometry (trim-to-intersection strategy)
│   ├── stringRouting.ts         # Visual wiring path: detour around off-string panels,
│   │                            #   cross-minimising perpendicular side selection
│   ├── projectSerializer.ts     # migrateProject: back-fills defaults for pre-migration saves
│   ├── colors.ts                # Shared color utilities (string color assignment, etc.)
│   └── pdfExport.tsx            # Legacy export shim (transitional; main PDF is SolarPlanDoc)
│
├── pdf/
│   ├── SolarPlanDoc.tsx         # @react-pdf/renderer document: page 1 = left rail (meta/stats) +
│   │                            #   right pane (plan image) + full-width strings table;
│   │                            #   page 2 = block diagram (A4 landscape PNG via html2canvas)
│   └── composeStageImage.ts     # Rasterises the Konva Stage to a PNG dataURL (page 1) and
│                                #   captures the diagram view via html2canvas (page 2)
│
├── locales/
│   ├── en.ts                    # English translation strings (source of truth for type-checking)
│   └── de.ts                    # German translation strings
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
    ├── NewProjectPage.tsx       # /teams/:id/projects/new — captures meta before PB create
    ├── ProjectEditor.tsx        # /p/:id — fetches project, mounts <App/>, owns SyncClient
    ├── ProjectSettingsPage.tsx  # /p/:id/settings — name, client, address, notes
    ├── ProjectMetaForm.tsx      # Reusable metadata form used by New + Settings pages
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
    ├── DiagramView.tsx          # Top-level block diagram view: A4 container (1122×794 px,
│                                #   data-diagram-view attr for html2canvas capture),
│                                #   mounts DiagramCanvas + DiagramToolbar + DiagramMetaTable,
│                                #   triggers bootstrapDiagram() on first open
    ├── diagram/
│   ├── DiagramCanvas.tsx        # <ReactFlow> controlled canvas; wires store nodes/edges;
│   │                            #   applyNodeChanges, applyEdgeChanges, addEdge;
│   │                            #   deleteKeyCode=['Delete','Backspace']
│   ├── DiagramToolbar.tsx       # "Add node" buttons for manually-added node types
│   ├── DiagramMetaTable.tsx     # 7-column editable table (#1e293b header); persists to diagram.meta
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
    ├── Sidebar.tsx              # Panel type, inverters (with catalog link), strings, roof props;
│                                #   hosts the Roof Plan / Block Diagram toggle above PROJEKT
    ├── MapView.tsx              # react-leaflet + MapLockSync + pre-lock rotation preview
    ├── CompassWidget.tsx        # North-arrow overlay; rotates with stage rotation
    ├── RotationDock.tsx         # Middle-mouse rotation control + reset button
    ├── KonvaOverlay.tsx         # <Stage> + composes useViewport + useDrawingController
    ├── RoofLayer.tsx            # Draws polygons (committed, in-progress, split preview);
    │                            #   edge-click opens edge-removal confirm dialog
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

Everything non-visual is in the single Zustand store (`useProjectStore`). Components subscribe to slices with selectors (`useProjectStore((s) => s.project.panels)`). Actions are exposed as store methods — **never mutate state directly**; always go through a setter so `persist` fires.

```
User input
  │
  ▼
Component event handler
  │
  ▼
store.someAction(args)             ← all mutation lives here
  │
  ▼
undoMiddleware intercepts set()    ← classifies by ACTION_POLICY:
  ├─ bypass → passes through       record, bypass, clear-history, load-history
  └─ record → snapshots before/after; pushes `before` onto `past`; clears `future`
  │
  ▼
Zustand sets state; persist middleware writes to localStorage
  │
  ▼
Subscribed components re-render
  │
  ▼
syncClient detects diff            ← debounced, runs after each store mutation
  └─ POSTs JSON Patch to /api/sp/patch → server updates `projects.revision`
       ↑ SSE (patches collection)
       └─ remote collaborator change → store.applyRemotePatch (bypass, no undo entry)
```

Three kinds of state:
- **Persistent** (`project`): roofs, panels, strings, inverters, panelType, mapState, meta, diagram
- **Ephemeral** (`toolMode`, `selectedRoofId`, `activeStringId`, …): not persisted (see `partialize` in the store)
- **History** (`past`, `future`, `canUndo`, `canRedo`): undo/redo stacks; NOT persisted (in-memory only)

### Authentication and routing

`AppShell.tsx` is the top-level React component. It hosts a `BrowserRouter` and declares all routes. Protected routes are wrapped in `<AuthGuard>` which reads `pb.authStore.record`; unauthenticated users are redirected to `/login`.

`useAuthUser()` exported from `AppShell.tsx` is the canonical way to read the current user in any component. It subscribes to `pb.authStore.onChange` so re-renders happen on login/logout without a Context.

`ProjectEditor` is the bridge between the router and the canvas editor (`App.tsx`). On mount it fetches the project record, calls `store.loadProject(doc)`, and starts a `SyncClient`. On unmount it calls `store.resetProject()` and stops the client. `App.tsx` itself is server-agnostic and never imports from `backend/`.

### Undo/Redo

Undo/redo is implemented by `store/undoMiddleware.ts`. It wraps Zustand's `set()` and classifies every call via `ACTION_POLICY`:

- **`record`** — snapshots the `UndoableSlice` (name, panelType, roofs, panels, strings, inverters — NOT mapState) before the mutation and pushes it onto `past`. Clears `future`. Subject to coalescing: rapid-fire calls with the same `actionName` + `key` (set via `setCoalesceKey`) within a 500 ms window collapse into a single history step.
- **`bypass`** — passes through unchanged (UI state, mapState, remote patches, etc.).
- **`clear-history`** — called on `resetProject`; empties both stacks.
- **`load-history`** — called on `loadProject`; replaces stacks from the loaded doc.

`mapState` is excluded from undo snapshots by design — undoing a panel edit must not resurrect a previous captured map image or flip the lock state.

`canUndo` / `canRedo` are flat booleans on the store (not derived) so toolbar buttons subscribe cheaply without re-running selectors.

### Panel groups

Panels are placed in **groups** — a logical grouping of panels placed together in one operation. `groupId` is stored on every `Panel` (not a separate entity). The active group for new panels is tracked in `activePanelGroupId` on the store.

Groups are relevant for:
- **Orientation** — all panels in a group share an orientation, changed atomically via `updateGroupOrientation(groupId, orientation)`.
- **Move** — `moveGroup(groupId, dx, dy)` shifts all panels in a group together.
- **Undo coalescing** — `addPanel` coalesces by `groupId` so multi-panel placements are a single undo step.

"Panel group" is NOT a first-class data model entity — valid group IDs are derived by scanning `project.panels` for unique `groupId` values.

### Roof split and merge

- **Split** (`splitRoof`): the user draws a polyline in `draw-roof` mode whose endpoints both lie on an existing roof's boundary. `splitPolygon()` in `polygonCut.ts` produces two new polygons; the store replaces the original roof and migrates any panels that fell inside each half.
- **Merge** (`mergeRoofs`): two roofs that share an edge can be merged. `mergePolygons()` in `polygonCut.ts` finds the shared edge and produces a single polygon.
- **Edge removal**: right-clicking an edge in `delete` mode opens a confirmation dialog. `computeEdgeRemoval()` in `roofEditing.ts` computes the new polygon using the trim-to-intersection strategy (extends the two neighbour edges until they meet, removing the clicked edge and its endpoints).

### Map and viewport

`MapState` is a **discriminated union** keyed on `locked`:
- `locked: false` → Leaflet is active; user can pan/zoom; no drawing possible.
- `locked: true` → Leaflet is torn down. At lock time the tile view is rasterised via `html2canvas` into a `capturedImage` (base64 PNG), which Konva displays as a static background. All canvas coordinates are in the pixel frame of that captured image.

**Map providers** (`mapProvider` on `MapState`): `'esri'` (default, global ESRI World Imagery), `'bayern'` (Bavarian Orthophoto), `'bayern_alkis'` (Bavarian cadastral parcels overlay). Stored on `mapState` so the same provider is restored on re-open.

**Rotation**: the user can rotate the stage before locking (pre-lock rotation, CSS-transformed Leaflet preview) or after locking (middle-mouse drag or `RotationDock`). `initialRotationDeg` on the locked `MapState` captures the at-lock rotation and is restored on re-open. Live post-lock rotation is session-local and is NOT persisted.

`useViewport.ts` owns all Stage transform state (position, scale, rotation) as refs (not React state) to avoid 60 Hz re-renders during pan/zoom. `useDrawingController.ts` owns all tool-mode interaction state and reads viewport state via the `isDraggingView()` callback.

### String wiring (visual routing)

`stringRouting.ts` computes the rendered polyline for each PV string. Straight center-to-center lines are misleading when a string skips a non-member panel — readers can't tell if the panel is part of the string or being bypassed. The algorithm:

1. For each segment between two consecutive string panels, check every OTHER (non-member) panel on the same roof for "near the line" proximity.
2. If a non-member panel is found on the segment, detour the line perpendicular to the segment direction, clearing the panel's bounding box.
3. Try both perpendicular sides and pick the one that minimises crossings with already-committed sub-segments ("best-effort cross-free routing").

### Block diagram

The **Block Diagram** view is a second canvas inside the same project editor, toggled by a Roof Plan / Block Diagram button pair in the sidebar. `App.tsx` holds `activeView: 'roof' | 'diagram'` as local state; setting it to `'diagram'` unmounts the Konva/map layer and mounts `DiagramView`.

**React Flow integration**: `@xyflow/react` v12 is used for the canvas. Node state and edge state are stored in `project.diagram` (Zustand) as plain `DiagramNode[]` / `DiagramEdge[]` that match React Flow's native shapes exactly — no transformation layer. The store exposes `setDiagramNodes`, `setDiagramEdges`, `addDiagramNode`, `updateDiagramMeta`, `bootstrapDiagram`; all registered as `bypass` in `ACTION_POLICY` (diagram actions do not enter the undo stack).

**Node types**: Seven custom node types, each a thin wrapper around `BaseNode.tsx`. React Flow v12 requires the pattern `NodeProps<Node<DiagramNodeData, 'solarGenerator'>>` — NOT the v11 `NodeProps<DiagramNodeData>`. Every node file defines a local type alias before the component to stay compile-clean.

**Bootstrap**: `bootstrapDiagram()` is idempotent — it exits immediately if `project.diagram` already exists. On first open it creates one `solarGenerator` node per Roof (top third of canvas) and one `inverter` node per Inverter (middle third). No edges are created automatically. `DiagramView` calls `useEffect(() => { bootstrapDiagram(); }, [bootstrapDiagram])` so bootstrap runs once per mount when needed.

**PDF capture**: `DiagramView` renders inside a `<div data-diagram-view>` fixed at 1122 × 794 px (A4 landscape at 96 dpi). `captureDiagramView(el)` in `composeStageImage.ts` passes that element to `html2canvas`; the resulting PNG is passed as `diagramImage` to `SolarPlanDoc.tsx` which emits it as a second `<Page>`. The selector `document.querySelector('[data-diagram-view]')` in `pdfExport.tsx` resolves only when the diagram view is mounted — PDF exports triggered from the roof plan view capture `undefined` and skip the second page.

### i18n

`i18n.ts` initialises i18next with `LanguageDetector` (reads browser language) and two locale bundles (`en.ts`, `de.ts`). The resource type is augmented from `en.ts` so `t('login.signIn')` is type-checked at compile time — missing or misspelled keys are compile errors, not blank strings at runtime.

Use `useTranslation()` from `react-i18next` inside components. The `t()` function is the only way to produce user-visible strings — never hardcode English text in JSX.

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
4. Update `migrateProject` in `src/utils/projectSerializer.ts` so existing saves pick up a default for the new field
5. Render control in `Sidebar.tsx` under the selected-roof section

### New persisted field on a doc-embedded collection (Roof, Panel, String, …)

No server-side schema change needed — the `doc` column on `projects` is opaque JSON, so any field you add to `Project` / `Roof` / etc. flows through the existing diff + patch machinery unchanged.

1. Update the TypeScript type in `src/types/index.ts` (or wherever the domain type lives).
2. Update `migrateProject` in `src/utils/projectSerializer.ts` so localStorage drafts from before the change pick up a default for the new field.
3. Exception: if your field is also surfaced as a column on the `projects` ROW (like `name`), add a mirror branch in `server/handlers/patch.go`'s post-apply logic — row columns are kept in sync with the doc JSON by that code, not automatically.

### New store action
1. Add the action name literal to `ActionName` in `undoMiddleware.ts`
2. Add the corresponding `Policy` entry to `ACTION_POLICY` in `undoMiddleware.ts` (compile error if missing)
3. Implement the action in `projectStore.ts`
4. If the action should be undoable and operates on a specific entity (roof/string/etc.), call `setCoalesceKey(set, 'actionName', entityId)` immediately before the `set()` call

### New tool mode
1. Add the literal to the `ToolMode` union in `types/index.ts`
2. Add a button in `Toolbar.tsx` (`MODES` array + handler, and a keyboard shortcut in `App.tsx`)
3. Gate rendering/handlers in `useDrawingController.ts` (drawing intent) or `useViewport.ts` (viewport intent)
4. Make sure `Escape` resets it (handled in `useDrawingController.ts` keydown handler — add a reset branch there)

### New PDF section
The PDF is a `@react-pdf/renderer` document in `src/pdf/SolarPlanDoc.tsx`. The document already has two pages:

1. **Roof plan page** (A4 landscape): left rail (meta/stats) + right pane (captured Konva Stage PNG) + full-width strings table.
2. **Block diagram page** (A4 landscape): a single `<Image>` that fills the page with the html2canvas capture of `[data-diagram-view]`.

Add new sections as React components using `<View>`, `<Text>`, `<Image>` from `@react-pdf/renderer`. The document is A4 landscape (841.89 × 595.28 pt). Do NOT add sections to the legacy `utils/pdfExport.tsx`.

### New user-visible string
1. Add the key under the correct namespace in `src/locales/en.ts`
2. Add the corresponding German translation in `src/locales/de.ts`
3. Use `const { t } = useTranslation()` in the component and call `t('your.key')`

The TypeScript augmentation in `i18n.ts` means a missing key in `en.ts` is a compile error in code that references it via `t()`.

### New PocketBase collection
1. Create a new JS migration file in `server/pb_migrations/` — name it `<unix_timestamp>_<description>.js`
2. Add a `TypeScript` mirror interface in `src/backend/types.ts`
3. Add a `go build -o pocketbase .` run (see memory: always rebuild after any Go change)

## Conventions

- **TypeScript strict** is on; no implicit any
- Prefer **named exports** for utilities, **default** for components
- Keep components pure — **no side effects outside effects/event handlers**
- Selectors should return the smallest slice needed (don't destructure the whole project)
- Don't import from `store/projectStore` into `utils/*` — utilities are pure
- Don't import from `backend/*` into `App.tsx` or canvas components (`KonvaOverlay`, `RoofLayer`, `PanelLayer`, etc.) — `App.tsx` must stay server-agnostic; the `ProjectEditor` is the server boundary
- Ids are short random strings (`uid()` in the store); no UUID library
- **Comments:** this project uses generous inline comments with design reasoning — add WHY context, not just WHAT. See memory: `feedback_inline_comments.md`
- New files under `src/components` use PascalCase; utilities use camelCase
- Every new store action **must** appear in `ActionName` union AND `ACTION_POLICY` in `undoMiddleware.ts` (compile error if missing)
- User-visible strings go in `locales/en.ts` + `locales/de.ts` — never hardcode English text in JSX

## Known limits / non-goals

- **No multi-select of panels** — only whole-group moves (drag `moveGroup`); no arbitrary multi-select
- **No rotation of the panel grid independent of the roof** — panels always align to the roof's longest edge
- **No non-map mode calibration** — drawing only works after locking a map
- **Map tile PDF capture can fail silently** (CORS when compositing the stage); `composeStageImage.ts` handles the fallback
- The Konva Stage is a single layer for simplicity; if perf ever becomes an issue, split static (roofs) and dynamic (ghost/lasso) onto separate `<Layer>`s
- **Undo/redo does not restore mapState** (captured image, lock flag) — by design; see undoMiddleware.ts and ADR
- **Inverter catalog links are soft-FK only** — `Inverter.inverterModelId` lives inside the opaque `doc` JSON with no server-side FK. A deleted catalog entry becomes a dangling reference; UI must tolerate a cache miss and fall back to the user-editable `name`
- **No offline capability** — the app requires a live PocketBase connection to open/create projects; the sync layer handles transient disconnects but is not designed for full offline-first use

## Pitfalls that have already bitten

- `leaflet` optional `tap` property isn't typed on `L.Map` — cast via `unknown` (see `MapView.tsx`)
- The Zustand `persist` middleware writes the full `project` on every state change; don't put transient state inside `project` or you'll write every mousemove
- Don't forget to call `renumberStrings()` when you touch `panel.stringId` — silent off-by-one numbering is the failure mode
- Konva shape clicks bubble to the Stage by default — set `e.cancelBubble = true` in shape handlers when needed
- **Every new store action must be registered in `ACTION_POLICY`** (`undoMiddleware.ts`). A missing entry causes a dev-mode `console.warn` and defaults to `bypass` — meaning the action won't be undoable even if you intended `record`
- **`useViewport.ts` uses refs, not state**, for pan/rotate drag tracking. `isDraggingView()` is a getter function, not a boolean — don't use it as a React dependency because it's always the same function reference
- The Enter-key commit path in `useDrawingController.ts` reads store state via `useProjectStore.getState()` (not the closure-captured selector values) — if you add more keys that need fresh store state, use `getState()` too
- `setCoalesceKey` must be called **immediately before** its matching `set()` call. A stale pending key from a prior (different) action can leak into the next record-path set if the pair gets separated by an intervening `bypass` call
- Panel soft-delete / catalog `deleted` flag: soft-deleted `panel_models` rows are filtered out of picker dropdowns but a project already linked to a soft-deleted model will still show that model via the `expand.panel_model` path. Don't hard-delete a catalog entry if projects reference it — use the soft-delete flag
- `go build ./...` does **not** update the `./pocketbase` binary — always `go build -o pocketbase .` in `server/` (see memory)
- **React Flow v12 node prop types changed**: use `NodeProps<Node<DiagramNodeData, 'solarGenerator'>>`, NOT `NodeProps<DiagramNodeData>`. Also `DiagramNodeData` (and any custom node data type) must satisfy `Record<string, unknown>` — add `[key: string]: unknown` to the interface. See `src/components/diagram/nodes/` for the canonical pattern
- **Diagram PDF page only appears when `DiagramView` is mounted**: `pdfExport.tsx` queries `document.querySelector('[data-diagram-view]')` at export time. If the user exports while on the roof plan view, the diagram element isn't in the DOM and the second page is silently skipped — this is intentional (we can't capture a view that hasn't rendered)

## Where to start reading

If you're new to the codebase, read in this order:

1. `src/types/index.ts` — the full domain data model
2. `src/store/projectStore.ts` — every state transition
3. `src/store/undoMiddleware.ts` — undo/redo middleware and ACTION_POLICY
4. `src/utils/geometry.ts` — the spatial math (tilt projection, grid snapping)
5. `src/components/AppShell.tsx` — routing + auth session
6. `src/components/ProjectEditor.tsx` — server↔editor bridge
7. `src/components/KonvaOverlay.tsx` — Stage host; delegates to useViewport + useDrawingController
8. `src/hooks/useDrawingController.ts` — tool-mode interaction state machine
9. `src/components/Toolbar.tsx` + `Sidebar.tsx` — user-facing controls
10. `src/pdf/SolarPlanDoc.tsx` — export layout
11. `src/backend/syncClient.ts` — bidirectional sync state machine
