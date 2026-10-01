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
9. The diagram bootstraps automatically from existing roof/inverter data; the user connects nodes and adds switches, fuses, batteries, FRE controller, grid output, consumers
10. Exports an A4 landscape PDF with two pages: roof plan + block diagram (always both, whichever view is active — ADR-018)

Online editor backed by PocketBase for auth, team projects, and realtime sync. The server is the source of truth: the project is held in memory only, never in localStorage (ADR-015).

## Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Build | Vite 8 (Rolldown) | Vendor chunk groups in `vite.config.ts`; Vitest 5 for tests |
| UI | React 18 + TypeScript (strict) | Functional components, hooks only |
| Router | `react-router-dom` v7 | Declarative BrowserRouter; same API as v6 |
| Canvas | `react-konva` + `konva` | Object-level drag/click/hitbox on a single Stage |
| Map | `react-leaflet` + `leaflet` | Multi-provider: ESRI World Imagery, Bayern Orthophoto, Bayern ALKIS |
| State | `zustand` + custom undo middleware | No `persist` (ADR-015); id-keyed delta undo/redo via `undoMiddleware.ts` |
| i18n | `i18next` + `react-i18next` + `i18next-browser-languagedetector` | en/de; locale keys are type-checked against `en.ts` at compile time |
| Styling | Tailwind CSS + a little inline `<style>` | No component library |
| PDF | `@react-pdf/renderer` (in `pdf-service/`) + `html-to-image` (client capture) | Client captures PNGs; `pdf-service` renders `SolarPlanDoc` in Node |
| Diagram canvas | `@xyflow/react` v12 | Node-edge graph for the block diagram; document nodes/edges in Zustand, view state (selection, measured, drag) local |
| Geocoding | Photon API | Open-source, no key; used for address autocomplete in `AddressAutocomplete.tsx` |
| Backend client | `pocketbase` JS SDK | Singleton in `src/backend/pb.ts`; auth token persisted to localStorage |
| Server | PocketBase v0.40 embedded in a Go binary | Requires Go 1.27+ (`server/go.mod`) |

## Backend

The server is a custom Go binary embedding PocketBase v0.40 (`/server`, Go 1.27+), allowing custom HTTP routes and hooks. Security model: ADR-017 and `server/README.md`.

- `main.go` — bootstraps `jsvm`, `migratecmd` (automigrate), then `handlers.Register(app, handlers.OptionsFromEnv())`.
- `handlers/register.go` — the ONE place routes, middleware and hooks are wired (Go tests call the same `Register`). `Options.RequireApproval` comes from `REQUIRE_APPROVAL=true`.
- `handlers/patch.go` — `POST /api/sp/patch` `{projectId, fromRevision, ops, deviceId}`: membership check (same 404 for "not found" and "not yours") before taking a refcounted per-project lock; applies the RFC 6902 patch atomically if `fromRevision` matches, bumps `revision`, writes a `patches` row (SSE fan-out). 409 with the current server doc on mismatch. Limits: 25 MB body, ≤ 20 000 ops, only `add`/`remove`/`replace`/`test`, copy-size limit, 20 MB result doc (413). Mirrors `doc.name` onto the `projects.name` column.
- `handlers/set_customer.go` — `POST /api/sp/set-customer` and `POST /api/sp/set-panel-model` (project row FKs; `projects.updateRule` is `null`, so row columns change only through custom routes).
- `handlers/team_invite.go` — `POST /api/sp/team-members` `{teamId, email, role?}`: team admins add an existing user by e-mail (users can't be listed client-side).
- `handlers/datasheetImport.go` — `POST /api/sp/parse-datasheet`: auth + SSRF gate (`handlers/ssrf.go`, DNS-resolving public-address check), then proxies to `ocr-service` and streams its NDJSON back.
- `handlers/approval.go` — approval gate: `approved` is superuser-only writable; with `REQUIRE_APPROVAL=true`, unapproved users get 403 on every token-issuing flow and existing tokens are treated as anonymous.
- `handlers/hooks.go` — creator becomes team admin on `teams` create; last-admin guard on `team_members` update/delete; `projects.created_by` and catalog `created_by` forced to the caller; catalog `DELETE` by a regular user becomes a soft delete; hourly cron prunes old `patches` rows.
- `handlers/*_test.go` — boot a real PocketBase test app with all migrations; cover API rules, approval, patch limits, SSRF, rate limiting.
- `pb_migrations/` — JS migrations defining all collections. The final API rules and rate limits are in `1712347100_security_hardening.js`; update rules pin `team`/`user`/`created_by`.

**PocketBase collections:**

| Collection | Purpose |
|---|---|
| `users` | Auth; `name`, `email`, `phone` (shown on PDF exports), `approved` (superuser-only writable). Viewable only by self + co-members; not listable. |
| `teams` | Workspace; `name`, `created_by`, `logo` (file), `company_name` (PDF branding). Owner auto-added as admin by hook. |
| `team_members` | Many-to-many users↔teams with `role: 'admin' | 'member'`. Visible to members of that team; admin-managed; the last admin can't be removed. |
| `projects` | One row per project; `doc` column is the full opaque `Project` JSON (≤ 20 MB); `revision` int; `name` mirrored column; `customer` / `panel_model` optional FKs; `created_by`. Row updates only via `/api/sp/*`. |
| `patches` | Append-only log of JSON Patches (`from_revision`, `to_revision`, `device_id`); consumed by SSE for realtime sync. Server-written only. |
| `customers` | Team-scoped; contact records (name, address, phone, email, notes). |
| `panel_models` | Global catalog of PV modules (not team-scoped); `created_by` (creator-only edit); `deleted` soft-delete flag. |
| `inverter_models` | Global catalog of inverters; `created_by` (creator-only edit); `deleted` soft-delete flag; `mpptCount` + `stringsPerMppt` for MPPT grouping. |

**How to run it locally:**

```bash
cd server && go build -o pocketbase . && ./pocketbase serve
```

Admin UI at `http://127.0.0.1:8090/_/` locally. In production nginx blocks `/_/`, `/api/_/` and `/api/collections/_superusers/` — use an SSH tunnel. Data lives in `server/pb_data/`.

**OCR sidecar (`/ocr-service`):** Python FastAPI microservice — only called by Go, never directly from the browser. Re-validates the URL (DNS resolve + IP pinning, manual redirects validated per hop), downloads with size/time caps (25 MB / 45 s), extracts text with `pdfminer`, falls back to `pdf2image` + `tesseract` for image-only PDFs (page-limited), then sends capped text to **Gemini Flash Lite** (Groq fallback on 503) which returns a structured JSON array of product variants. Concurrency 2, generic errors, non-root image. Run via `docker-compose -f docker-compose.dev.yml up` or `cd ocr-service && uvicorn main:app --port 8001`. Override endpoint via `OCR_SERVICE_URL` env var.

**PDF renderer (`/pdf-service`):** Node/Express service on port 3002 that renders `src/pdf/SolarPlanDoc.tsx` with `@react-pdf/renderer` (imported from `../src`). nginx (and the Vite dev proxy) route `/pdf/` straight to it — not through Go, because the image payload can exceed PocketBase's body limit. It verifies the caller's token via `users/auth-refresh` **before** parsing the body, accepts images only as `data:image/png|jpeg;base64` URIs (react-pdf's `<Image src>` would otherwise fetch URLs or read files), re-constructs the props from the validated payload, caps concurrent renders (default 2), and returns generic errors.

**Client-side sync (`src/backend/`):**

- `pb.ts` — PocketBase SDK singleton + `currentUser`/`onAuthChange` wrappers. `signOutUser()` is the only sign-out path (clears every `solar-planner-*` key, then the token); `installAuthUserGuard()` (mounted in `AppShell`) wipes app data when a different user signs in.
- `types.ts` — hand-maintained TypeScript mirrors of all PB collection schemas.
- `diff.ts` — facade over `fast-json-patch`: `diffProjects`, `applyProjectPatch`, `toJsonDoc`, `jsonEqual`, and `rebaseProject(base, theirs, mine)` — a three-way merge that merges id-keyed arrays by id and reports same-leaf conflicts.
- `syncClient.ts` — per-project state machine (ADR-016). The baseline is **server-confirmed state only**; unsent local work is rebased onto every new baseline (`rebaseProject`, then `repairReferences`). Subscribes to `patches` + `PB_CONNECT` before loading; buffers inbound patches by `from_revision`; one POST in flight (debounced 1 s) carrying `fromRevision`; 409 → rebase and re-send, or open the conflict modal on real same-field conflicts; reconnect/gap → GET + rebase, never `loadProject`; flush on `pagehide`/`visibilitychange` with `keepalive`; `stopped` guards on every await. Status: `synced | syncing | offline | conflict | error(load-failed | rejected)`. `deviceId` is per page load (module-level), so duplicated tabs don't drop each other's patches as echoes.
- `photon.ts` — Photon geocoding API wrapper.
- `migrateLocalStorage.ts` — one-time import of a pre-backend localStorage project (`LEGACY_PROJECT_STORAGE_KEY`), only after the user confirms.

**`applyRemotePatch` store action:** registered as `bypass` in `ACTION_POLICY` — remote patches and rebase results do NOT enter the undo stack and leave UI state untouched. Undo is local-only and applies id-keyed deltas to the current state, so Ctrl-Z in tab A can't revert tab B's work (ADR-015).

## Dev commands

```bash
npm install              # once
npm run dev              # http://localhost:5173 (needs the backend on :8090 for anything past /login)
npm run build            # tsc -b && vite build
npx tsc --noEmit         # typecheck only
npx vitest run           # unit tests (or `npm run test:run`; `npm test` = watch mode)
npm run test:integration # store/sync against a real PocketBase; build server/pocketbase first
```

Backend and sidecars:

```bash
cd server && go build -o pocketbase . && ./pocketbase serve   # Go 1.27+
cd server && go vet ./... && go test ./...                      # Go handler tests
cd pdf-service && npm ci && npm test && npm run typecheck       # payload validation (needs root npm install for types)
cd ocr-service && python -m pytest test_main.py                 # SSRF / limits tests
```

Full stack:

```bash
docker-compose -f docker-compose.dev.yml up   # dev (hot-reload; ports bound to 127.0.0.1)
docker-compose up                             # production-like build (nginx on :80, REQUIRE_APPROVAL=true)
```

There are no linters configured. Typecheck + `npm run build` + `npx vitest run` is the acceptance gate (plus `go test ./...` for server changes and the service tests for sidecar changes). CI (`.github/workflows/ci.yml`) runs one job per deployable on every push/PR: frontend (typecheck, unit tests, build, `npm audit --omit=dev`), pdf-service, ocr-service, server (vet, test, build, govulncheck) and the integration suite against a freshly built PocketBase.

## Architecture Decision Records (ADRs)

ADRs live in `adr/`, named `ADR-NNN-short-description.md`. Create one whenever you introduce a new system-wide pattern, change the data model significantly, or implement a complex requirement not self-evident from the code. Fields: **Status**, **Date**, **Requirement**, **Context**, **Decision**, **Consequences**. When a later ADR replaces part of an earlier one, update the earlier one's **Status** line (e.g. ADR-014 → ADR-015).

Most relevant to current architecture: ADR-015 (delta undo, no localStorage), ADR-016 (sync baseline + rebase), ADR-017 (API security model), ADR-018 (offscreen PDF export, local diagram view state).

## Project layout

```
src/
├── main.tsx                     # React root — renders <AppShell/>, imports i18n
├── App.tsx                      # Canvas editor shell; derives activeView ('roof' | 'diagram') from the URL
├── index.css                    # Tailwind directives + konva-overlay classes + [data-pdf-export] theme
├── i18n.ts                      # i18next init (LanguageDetector, en+de resources)
├── test-setup.ts                # vitest setup
│
├── types/index.ts               # ALL shared domain types:
│                                #   Point, Rect, PanelType, Roof, Panel, PvString,
│                                #   Inverter, MapState, ProjectMeta, ProjectAddress,
│                                #   Project, ToolMode, STRING_COLORS,
│                                #   MIN/MAX_ROOF_TILT_DEG, UndoableSlice, HistoryEntry,
│                                #   DiagramNodeType, DiagramNodeData, DiagramNode,
│                                #   DiagramEdge, DiagramMeta, Diagram
│
├── store/
│   ├── projectStore.ts          # Zustand store: in-memory project state + all mutations
│   │                            #   (no persistence; LEGACY_PROJECT_STORAGE_KEY for import only)
│   ├── undoMiddleware.ts        # Delta undo/redo: diffSlices, applyEntry, composeEntries,
│   │                            #   ACTION_POLICY, setCoalesceKey, cleanUiRefs
│   └── toastStore.ts            # Global ephemeral toast channel (pushToast / useToasts)
│
├── backend/
│   ├── pb.ts                    # PocketBase SDK singleton + auth wrappers, signOutUser
│   ├── types.ts                 # TypeScript mirrors of all PB collection schemas
│   ├── diff.ts                  # fast-json-patch facade + rebaseProject (three-way merge)
│   ├── syncClient.ts            # Per-project bidirectional sync state machine
│   ├── photon.ts                # Photon geocoding API wrapper (address autocomplete)
│   └── migrateLocalStorage.ts   # One-time, confirmed import of a legacy localStorage project
│
├── hooks/
│   ├── useDrawingController.ts  # Tool-mode interaction state machine
│   └── useViewport.ts           # Konva Stage transform: pan, zoom, rotation, ResizeObserver
│
├── utils/
│   ├── calibration.ts           # metersPerPixel(zoom, lat) — Web Mercator formula
│   ├── geometry.ts              # Polygon ops, snap, rotate, panelDisplaySize, SAT overlap
│   ├── drawingSnap.ts           # Angle + length snap for roof vertices (tolerances in screen px)
│   ├── polygonCut.ts            # splitPolygon + mergePolygons + boundary hit-test
│   ├── roofEditing.ts           # Edge-removal geometry (trim-to-intersection strategy)
│   ├── stringRouting.ts         # Visual wiring path: detour around off-string panels
│   ├── projectSerializer.ts     # migrateProject (defaults, tilt clamp, diagram strip) + JSON v3
│   ├── repairReferences.ts      # Whole-doc referential repair, run after every sync merge
│   ├── colors.ts                # Shared color utilities (string color assignment, etc.)
│   ├── errorClassify.ts         # Thrown value → user-facing category + technical detail
│   ├── dom.ts                   # isEditableTarget — shared "user is typing" check for shortcuts
│   └── safeUrl.ts               # safeHttpUrl — guard doc-supplied URLs before href/src
│
├── pdf/                         # Only reachable via dynamic import() (lazy export chunk)
│   ├── pdfExport.tsx            # Export orchestrator: captures, offscreen renders, POST /pdf/render
│   ├── PlanPageFrame.tsx        # HTML/CSS roof-plan page chrome, rendered offscreen + captured
│   ├── SolarPlanDoc.tsx         # @react-pdf/renderer document (page 1 roof plan, page 2 diagram);
│   │                            #   rendered by pdf-service, not in the browser
│   └── composeStageImage.ts     # captureStage (Konva toCanvas, html2canvas fallback),
│                                #   captureDiagramView (html-to-image), composeWithGrid
│
├── locales/
│   ├── en.ts                    # English strings (source of truth for type-checking)
│   └── de.ts                    # German strings
│
├── test/integration/            # pbHarness (boots server/pocketbase), storeHarness, seed,
│                                #   eventsource-polyfill — used by *.integration.test.ts
│
└── components/
    ├── AppShell.tsx             # BrowserRouter + <Routes> + useAuthUser + <Toaster/> + error toasts
    ├── AuthGuard.tsx            # Redirects unauthenticated users to /login
    ├── LoginPage.tsx            # Email/password sign-in + sign-up (pending-approval message)
    ├── PageShell.tsx            # Shared page chrome: nav header + breadcrumbs
    ├── BrandMark.tsx            # Logo mark (SVG)
    ├── LanguageToggle.tsx       # en/de switcher
    ├── Toaster.tsx              # Renders the toast stack from toastStore
    ├── AccountPage.tsx          # /account — own name + phone (PDF planner identity)
    │
    ├── TeamPicker.tsx           # / — lists teams the user belongs to
    ├── NewTeamPage.tsx          # /teams/new
    ├── TeamView.tsx             # /teams/:id — project list + new-project button
    ├── TeamMembers.tsx          # /teams/:id/members — invite (POST /api/sp/team-members) / remove
    ├── TeamBrandingPage.tsx     # /teams/:id/branding — logo + company name (admin-only edit)
    │
    ├── NewProjectPage.tsx       # /teams/:id/projects/new
    ├── ProjectEditor.tsx        # /p/:id (+ /diagram) — loads project, mounts <App/>, owns SyncClient
    ├── ProjectSettingsPage.tsx  # /p/:id/settings — name, client, address, notes
    ├── ProjectMetaForm.tsx      # Reusable metadata form (New + Settings pages)
    ├── ConflictModal.tsx        # Real same-field conflict: "discard mine" or "keep mine"
    ├── SyncStatusIndicator.tsx  # Live sync badge (synced / syncing / offline / conflict / error)
    │
    ├── CustomersPage.tsx        # /teams/:id/customers — CRUD for customer records
    ├── CustomerPicker.tsx       # Dropdown to link a customer to a project
    ├── AddressAutocomplete.tsx  # Photon-backed address search + structured field form
    │
    ├── CatalogPage.tsx          # /catalog — panel_models + inverter_models CRUD (creator-only
    │                            #   edit) + datasheet import
    ├── PanelModelPicker.tsx     # Dropdown/search for panel models (used in Sidebar)
    ├── InverterModelPicker.tsx  # Dropdown/search for inverter models (used in Sidebar)
    │
    ├── DiagramView.tsx          # Block diagram view: 1122×794 px A4 sheet ([data-diagram-view]);
    │                            #   bootstraps the diagram; exportMode + onReady for offscreen export
    ├── diagram/
    │   ├── DiagramCanvas.tsx    # <ReactFlow>; document nodes/edges from the store,
    │   │                        #   selection/measured/drag in local state
    │   ├── diagramChanges.ts    # Pure split of React Flow changes: persistent vs ephemeral
    │   ├── DiagramMetaTable.tsx # Editable title-block table; persists to diagram.meta
    │   ├── edges/
    │   │   └── EditableSmoothStepEdge.tsx  # Smoothstep edge with in-place editable label
    │   └── nodes/
    │       ├── BaseNode.tsx         # Shared rounded-rect shell: colored header, 4 handles,
    │       │                        #   contentEditable label via useReactFlow().updateNodeData()
    │       ├── SolarGeneratorNode.tsx   # amber #f59e0b
    │       ├── InverterNode.tsx         # blue #3b82f6
    │       ├── SwitchNode.tsx           # slate #64748b
    │       ├── FuseNode.tsx             # red #ef4444
    │       ├── BatteryNode.tsx          # emerald #10b981
    │       ├── FreNode.tsx              # violet #8b5cf6
    │       ├── GridOutputNode.tsx       # sky #0ea5e9
    │       └── ConsumerNode.tsx         # rose #e11d48 (house / on-site load)
    ├── Toolbar.tsx              # Top bar: lock, tool modes, add-diagram-node buttons, undo/redo,
    │                            #   PDF export, JSON save/load
    ├── Sidebar.tsx              # Panel type, inverters, strings, roof props; view toggle
    ├── MapView.tsx              # react-leaflet + MapLockSync + pre-lock rotation preview
    ├── CompassWidget.tsx        # North-arrow overlay; rotates with stage rotation
    ├── RotationDock.tsx         # Middle-mouse rotation control + reset button
    ├── KonvaOverlay.tsx         # <Stage> + useViewport + useDrawingController; KonvaExportFrame
    ├── RoofLayer.tsx            # Draws polygons; edge-click opens edge-removal confirm dialog
    ├── PanelLayer.tsx           # Placed panels + ghost preview; drag-to-move group
    └── StringLayer.tsx          # Wiring polylines via stringRouting.ts

pdf-service/                     # Node PDF renderer (server.ts, validate.test.ts) — see Backend
ocr-service/                     # FastAPI datasheet extractor (main.py, test_main.py)
server/                          # Go + PocketBase (main.go, handlers/, pb_migrations/, README.md)
adr/                             # Architecture Decision Records
```

Unit tests sit next to their module (`*.test.ts`); integration tests are `*.integration.test.ts` (run via `npm run test:integration`).

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
| `/teams/:teamId/branding` | `TeamBrandingPage` | Auth required; editing admin-only |
| `/p/:projectId` | `ProjectEditor` → `App` (roof view) | Auth required; ONE layout route with `index` + `diagram` children, so the editor stays mounted across view toggles |
| `/p/:projectId/diagram` | same mount (diagram view) | `App` picks the view from the pathname |
| `/p/:projectId/settings` | `ProjectSettingsPage` | Auth required |
| `/catalog` | `CatalogPage` | Auth required; global (not team-scoped) |
| `/account` | `AccountPage` | Auth required |

## Architecture

### State flow

Everything non-visual is in the single Zustand store (`useProjectStore`). Actions are store methods — **never mutate state directly**.

```
User input → Component event handler → store.someAction(args)
  → undoMiddleware intercepts set() → classifies by ACTION_POLICY:
      ├─ bypass → passes through
      └─ record → diffSlices(before, after) → id-keyed HistoryEntry onto `past`; clears `future`
  → Zustand sets state (in memory only — no localStorage)
  → subscribed components re-render
  → syncClient diffs store vs server-confirmed baseline → POSTs JSON Patch to /api/sp/patch
      ↑ SSE (patches collection)
      └─ remote change → rebase local work → store.applyRemotePatch (bypass, no undo entry)
```

Three kinds of state:
- **Document** (`project`): roofs, panels, strings, inverters, panelType, mapState, meta, diagram — synced to the server, never written to localStorage
- **Ephemeral** (`toolMode`, `selectedRoofId`, `activeStringId`, …): store-only, not synced; diagram selection/measured/drag live in `DiagramCanvas` local state
- **History** (`past`, `future`, `canUndo`, `canRedo`): delta undo/redo stacks; in-memory only

### Authentication and routing

`AppShell.tsx` hosts `BrowserRouter` and all routes, mounts `<Toaster/>`, routes uncaught errors to toasts, and installs `installAuthUserGuard()`. Protected routes are wrapped in `<AuthGuard>` (reads `pb.authStore.record`). `useAuthUser()` from `AppShell.tsx` is the canonical current-user hook — subscribes to `pb.authStore.onChange`. Sign out only via `signOutUser()`.

`ProjectEditor` (lazy-loaded) bridges router → editor: creates the `SyncClient` and calls `start({ load, onLoaded })` — one fetch feeds both `store.loadProject(doc)` and the sync baseline; a failed load (after retries) shows an error page. Its effect depends on `projectId` only, so toggling roof ↔ diagram doesn't remount it. On unmount: stop the client (final flush of a snapshot) **then** `store.resetProject()`. `App.tsx` is server-agnostic and never imports from `backend/`.

### Undo/Redo

`undoMiddleware.ts` wraps Zustand's `set()` and classifies via `ACTION_POLICY`:

- **`record`** — builds `UndoableSlice` (name, panelType, roofs, panels, strings, inverters — NOT mapState/meta/diagram) before and after the mutation and pushes the id-keyed delta (`HistoryEntry`: add/remove/field-level update per entity) onto `past`; clears `future`. No-op diffs aren't pushed. Rapid-fire calls with same `actionName` + `key` within 500 ms compose into one history step (coalescing via `setCoalesceKey`).
- **`bypass`** — passes through (UI state, mapState, diagram, remote patches, etc.).
- **`clear-history`** — called on `resetProject`.
- **`load-history`** — called on `loadProject`.

Undo applies the inverse delta to the **current** state (ADR-015): a field is reverted only if it still holds the step's value, an entity a collaborator deleted is not resurrected, then a targeted referential repair + `renumberStrings` runs. So undo only ever affects the local user's own edits. `mapState` is excluded by design — undoing a panel edit must not resurrect a previous captured map image.

### Panel groups

`groupId` is stored on every `Panel` (not a separate entity). Active group tracked in `activePanelGroupId`. Groups govern shared orientation (`updateGroupOrientation`), whole-group moves (`moveGroup`), and undo coalescing for multi-panel placements. Valid group IDs are derived by scanning `project.panels`.

### Roof split and merge

- **Split** (`splitRoof`): polyline whose endpoints lie on an existing roof's boundary. `splitPolygon()` in `polygonCut.ts` produces two polygons; store migrates panels.
- **Merge** (`mergeRoofs`): two roofs sharing an edge. `mergePolygons()` finds the shared edge and produces a single polygon.
- **Edge removal**: right-click edge in `delete` mode → `computeEdgeRemoval()` in `roofEditing.ts` extends neighbour edges to meet (trim-to-intersection strategy).

### Map and viewport

`MapState` is a discriminated union on `locked`:
- `locked: false` → Leaflet active; no drawing possible.
- `locked: true` → Leaflet torn down; tile view rasterised to `capturedImage` (base64 PNG) via `html2canvas` (in `Toolbar.tsx`); all canvas coords in that pixel frame.

**Map providers:** `'esri'` (default), `'bayern'` (Bavarian Orthophoto), `'bayern_alkis'` (cadastral overlay). Stored on `mapState`.

**Rotation:** pre-lock (CSS-transformed Leaflet preview) or post-lock (middle-mouse / `RotationDock`). `initialRotationDeg` on locked `MapState` is persisted; live post-lock rotation is session-local.

`useViewport.ts` owns Stage transform state as **refs** (not React state) to avoid 60 Hz re-renders.

### String wiring (visual routing)

`stringRouting.ts` detours wiring lines around non-member panels on the same roof. For each segment between consecutive string panels: check nearby non-members; if found, detour perpendicular to the segment direction. Try both sides and pick the one minimising crossings ("best-effort cross-free routing").

### Block diagram

`activeView: 'roof' | 'diagram'` in `App.tsx` is derived from the URL (`/p/:id` vs `/p/:id/diagram`) and toggles between Konva/map and `DiagramView`. Node/edge state lives in `project.diagram` as plain `DiagramNode[]` / `DiagramEdge[]` matching React Flow's native shapes. All diagram store actions are `bypass` (no undo stack).

**View state is local (ADR-018):** `diagramChanges.ts` routes React Flow changes — selection, `measured` dimensions and in-progress drag positions stay in `DiagramCanvas` local state; only drag end, add, remove and data edits reach the store. `setDiagramNodes`/`setDiagramEdges` and `migrateProject` strip transient keys (`selected`, `dragging`, `measured`, …) as a safety net.

**Node types:** Eight custom nodes wrapping `BaseNode.tsx` (`solarGenerator`, `inverter`, `switch`, `fuse`, `battery`, `fre`, `gridOutput`, `consumer`); edges use `EditableSmoothStepEdge`. React Flow v12 pattern: `NodeProps<Node<DiagramNodeData, 'solarGenerator'>>` — NOT the v11 form. "Add node" buttons live in `Toolbar.tsx` (diagram view).

**Bootstrap:** `bootstrapDiagram()` is idempotent — exits if `project.diagram` exists. Creates one `solarGenerator` per Roof and one `inverter` per Inverter; no edges auto-created.

### PDF export

`exportPdf` in `src/pdf/pdfExport.tsx` (loaded by `Toolbar.tsx` via dynamic `import()`) always produces both pages when both have content (ADR-018):

1. Per page, use the mounted element if it's on screen (keeps the user's pan/zoom); otherwise render it offscreen via `withOffscreenRoot`: `KonvaExportFrame` (roof plan; needs a locked map) or `<DiagramView exportMode onReady>` (needs ≥ 1 node). The temporary root waits for `onReady` (6 s timeout) and is always torn down in `finally`.
2. Capture: Konva via `captureStage` (`stage.toCanvas`, html2canvas fallback) + `composeWithGrid`; `PlanPageFrame` and the diagram sheet via `captureDiagramView` (`html-to-image`, plus text runs for selectable PDF text).
3. POST the payload (PNG/JPEG data URIs + strings + branding) to `/pdf/render`; `pdf-service` renders `SolarPlanDoc.tsx` and returns the PDF.

### i18n

`t()` is the only way to produce user-visible strings. The resource type is augmented from `en.ts` — missing keys are compile errors.

### Coordinate system

Canvas coords are Leaflet container pixels at the moment of map lock. `mapState.metersPerPixel` (mpp) is the calibration. The Konva Stage is a full-size overlay (`pointer-events: none` when unlocked, `auto` when a tool is active).

### Tilt projection (the tricky math)

The satellite view is the **horizontal projection** of a sloped roof. `panelDisplaySize(panelType, orientation, tiltDeg, mpp)` in `utils/geometry.ts` is the single source of truth (tilt clamped to `[MIN_ROOF_TILT_DEG, MAX_ROOF_TILT_DEG]` = `[0, 60]`):

```
portrait:
  displayW = panelType.widthM  / mpp
  displayH = panelType.heightM * cos(tilt) / mpp

landscape:
  displayW = panelType.heightM / mpp
  displayH = panelType.widthM  * cos(tilt) / mpp
```

**If you change the tilt model, change it here and only here.** `updateRoof` re-lays out a roof's panels when its tilt changes and returns `{ unfitPanelIds }` — panels that no longer fit — for the caller to confirm/delete.

### Panel grid snapping

`snapPanelToGrid()` in `utils/geometry.ts`:

1. Compute roof's primary angle (`roofPrimaryAngle`: longest run of near-collinear edges → atan2)
2. Rotate cursor into roof-local frame (origin = centroid)
3. Snap to nearest `displayW × displayH` multiple
4. Rotate back to canvas frame
5. Reject if any corner is outside polygon
6. Reject if the panel's rotated rectangle overlaps an existing panel's (`rectanglesOverlap`, SAT; edge-touching neighbours allowed)

Returns `null` on rejection → caller draws a red ghost.

### String numbering

`renumberStrings()` (bottom of `projectStore.ts`) is called **after any mutation that touches `panel.stringId`**. It preserves the order the user added panels (NOT a geometric sort): panels that already have an `indexInString` keep their relative order, newcomers are appended in `insertionOrder` (e.g. paint order), and the result is compacted to 1..N. See `assignPanelsToString` for the pattern. `repairReferences` applies the same policy after sync merges.

### Tool modes

`ToolMode`: `'idle' | 'draw-roof' | 'place-panels' | 'assign-string' | 'delete'`. Toolbar sets mode (shortcuts `r`/`p`/`s`/`d` in `App.tsx`, roof view only); `KonvaOverlay` gates handlers on `toolMode`; `Escape` resets to `idle`. Every global key handler must ignore typing via `isEditableTarget` (`utils/dom.ts`) — diagram labels are `contentEditable`. `place-panels` ghost/click lives in `PanelLayer.tsx`; `delete` in `RoofLayer.tsx`/`PanelLayer.tsx`.

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
3. If it references another entity by id, extend `repairReferences` (`src/utils/repairReferences.ts`) and the undo repair in `applyEntry` (`undoMiddleware.ts`).
4. Exception: if also surfaced as a `projects` ROW column, mirror it in `server/handlers/patch.go` (or a `/api/sp/*` route — `projects.updateRule` is `null`).

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

Add React components using `<View>`, `<Text>`, `<Image>` from `@react-pdf/renderer` to `src/pdf/SolarPlanDoc.tsx`. A4 landscape = 841.89 × 595.28 pt. `SolarPlanDoc` runs in `pdf-service`, so any new prop must also be added to the payload validator in `pdf-service/server.ts` (and `validate.test.ts`) — never pass request data through unvalidated. Don't put layout into `src/pdf/pdfExport.tsx`; that's the browser-side capture/payload orchestrator.

### New user-visible string
1. Add key in `src/locales/en.ts`
2. Add German translation in `src/locales/de.ts`
3. Use `const { t } = useTranslation()` and call `t('your.key')`

### New PocketBase collection
1. Create JS migration in `server/pb_migrations/` (`<unix_timestamp>_<description>.js`) with explicit API rules — scope by team membership and pin tenant relations on update (see `1712347100_security_hardening.js`, ADR-017)
2. Add a rules test in `server/handlers/rules_test.go`
3. Add TypeScript mirror interface in `src/backend/types.ts`
4. Rebuild: `go build -o pocketbase .` in `server/`

### New custom API route
1. Implement the handler in `server/handlers/`; check auth + team membership yourself and return the same 404 for "not found" and "forbidden"
2. Register it in `registerRoutes` in `server/handlers/register.go` (consider an nginx / PocketBase rate limit)
3. Add a Go test

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
- Render doc-supplied URLs only through `safeHttpUrl` (`utils/safeUrl.ts`) — any team member can write arbitrary values into `doc`
- Surface errors via `pushToast` (`store/toastStore.ts`), using `utils/errorClassify.ts` for user-facing messages

## Known limits / non-goals

- **No multi-select of panels** — only whole-group moves via `moveGroup`
- **No rotation of panel grid independent of the roof** — always aligns to longest edge
- **No non-map-mode calibration** — drawing requires a locked map
- **Map tile capture can fail silently** (CORS); `composeStageImage.ts` handles the fallback
- **Concurrent reorderings of the same entity array** — the collaborator's order wins (ADR-016)
- Konva Stage has a static background `<Layer>` and one interactive `<Layer>` for roofs/strings/panels; split further if perf becomes an issue
- **Undo/redo does not restore mapState** — by design
- **Inverter catalog links are soft-FK only** — inside opaque `doc` JSON; UI must tolerate dangling refs
- **No offline capability** — requires live PocketBase connection; sync layer handles transient disconnects only. A reload while offline shows nothing (no local copy)
- **Invites only for registered users** — no e-mail invite flow

## Pitfalls that have already bitten

- `leaflet` optional `tap` property isn't typed on `L.Map` — cast via `unknown` (see `MapView.tsx`)
- Don't put transient/per-viewer state inside `project` — everything in `project` is diffed and synced to every collaborator (this is how React Flow's `selected`/`measured` once leaked across tabs)
- Call `renumberStrings()` whenever you touch `panel.stringId` — silent off-by-one is the failure mode
- Konva shape clicks bubble to Stage — set `e.cancelBubble = true` in shape handlers when needed
- **Every new store action must be in `ActionName` + `ACTION_POLICY`** — a missing entry is a compile error (`Record<ActionName, Policy>`); a dynamically built, unregistered name would fall back to `bypass` with a dev warning
- **`useViewport.ts` uses refs, not state** — `isDraggingView()` is a getter, not a boolean; not a valid React dependency
- The Enter-key commit path in `useDrawingController.ts` uses `useProjectStore.getState()` for fresh state — follow this pattern for any new key handlers that need current store state
- `setCoalesceKey` must be called **immediately before** its matching `set()` — a stale key from a prior action can leak
- Soft-deleted `panel_models` rows: filter from pickers but don't hard-delete if projects reference them
- `go build ./...` does **not** update `./pocketbase` — always `go build -o pocketbase .` in `server/`
- **React Flow v12 node prop types:** use `NodeProps<Node<DiagramNodeData, 'solarGenerator'>>`, NOT the v11 form. `DiagramNodeData` must satisfy `Record<string, unknown>` — add `[key: string]: unknown`
- **Never assign the sync baseline from the store** — only from server-confirmed state (fetch, in-order inbound patch, POST 200, 409/resync doc). Index-addressed JSON-Patch diffs against a wrong baseline hit the wrong array elements (ADR-016)
- **Remote/merged state goes through `applyRemotePatch`, never `loadProject`** — `loadProject` resets undo history and UI state
- Offscreen export renders (`KonvaExportFrame`, `DiagramView exportMode`) must call `onReady`; otherwise export waits for the 6 s timeout
- Outbound/datasheet URLs: never replace the resolving SSRF check with string matching (`handlers/ssrf.go`, `ocr-service`)
- Don't publish port 8090 in production — PocketBase rate limits key on nginx's `X-Real-IP`, which becomes spoofable

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
10. `src/pdf/pdfExport.tsx` + `src/pdf/SolarPlanDoc.tsx` — export flow and layout
11. `src/backend/syncClient.ts` + `src/backend/diff.ts` — bidirectional sync and rebase
12. `server/handlers/register.go` + `server/README.md` — server wiring and security model
13. `adr/ADR-015` … `ADR-018` — undo/persistence, sync, security, export decisions
