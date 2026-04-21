# Backend Sync Design — PocketBase + JSON Patch

- **Date:** 2026-04-21
- **Status:** Draft (pending user review)
- **Supersedes:** localStorage-only persistence model documented in `AGENTS.md`

## Motivation

Solar Planner is currently a single-user browser tool with `localStorage` as
its only persistence layer. This design introduces a server backend to support:

1. **Authentication** — users have accounts.
2. **Project management** — users can have many projects organized by team.
3. **Multi-user collaboration** — members of the same team can edit the same
   project with changes reflected to other viewers within a few seconds.

The app retains a local-first feel: edits always apply to the local Zustand
store first and write to `localStorage` via the existing `persist` middleware;
sync to the server is asynchronous and best-effort. A short network outage
leaves the app usable; reconnect reconciles.

Conflict handling is deliberately minimal per the user's brief: when two
clients diverge, the losing side is presented a modal with "discard mine" or
"overwrite theirs." No operational-transform or CRDT merging.

## Scope decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Collaboration model | Teams — everyone in a team sees and edits every project in that team |
| Roles | Two roles: `admin` and `member`. Admins create/delete teams and manage membership. Both roles have full read/write on projects. |
| Invite mechanism | Admin enters email of existing user; user is added immediately. Unknown email → error ("ask them to sign up first"). No pending-invite table. |
| Auth methods | Email + password only. No SMTP/OAuth in v1. |
| Backend | PocketBase — single Go binary, embedded SQLite, built-in auth, SSE realtime. |
| Sync wire format | JSON Patch (RFC 6902) over HTTPS. |
| Concurrency control | Optimistic, based on a monotonic `revision` integer per project. |
| Satellite image | Stored inline in the project JSON doc (base64 PNG from `lockMap`). |
| Offline model | Online-first with offline grace. No anonymous/local-only projects; signing in is required to use the app beyond demo mode. |
| localStorage migration | On first sign-in, if local data exists and the user has no server projects, silently auto-import it as their first team project. |
| Project UX | Route `/` for team/project picker; `/p/:projectId` for the editor. Shareable URLs. |
| Sync push timing | Debounced: 2000 ms after the last local change. |
| Mid-gesture remote patches | Queued; applied on gesture end (pointerup). |
| Undo/redo | Local only. Undoing produces a normal outgoing patch; other users see add-then-remove as two patches. |

## Architecture

```
┌─────────────────────────────┐          ┌──────────────────────────────┐
│  Browser (existing SPA)     │          │  PocketBase (single Go bin)   │
│                             │          │                               │
│  ┌───────────────────────┐  │   HTTPS  │  ┌─────────────────────────┐ │
│  │ Zustand store         │  ├──REST───►│  │ /api/collections/...    │ │
│  │  - project (unchanged)│  │          │  │  teams, team_members,   │ │
│  │  - history stacks     │  │          │  │  users, projects        │ │
│  │  - NEW: syncState     │  │          │  └─────────────────────────┘ │
│  └─────────┬─────────────┘  │   SSE    │  ┌─────────────────────────┐ │
│            │                │◄─────────┤  │ Realtime subscriptions  │ │
│  ┌─────────▼─────────────┐  │          │  │ (patches collection)    │ │
│  │ syncClient.ts (NEW)   │  │          │  └─────────────────────────┘ │
│  │  - debounced diff     │  │          │  ┌─────────────────────────┐ │
│  │  - POST /patch        │  │   POST   │  │ Custom Go hook:         │ │
│  │  - SSE subscribe      │  ├─────────►│  │   /api/sp/patch         │ │
│  │  - gesture queue      │  │          │  │   - validate revision   │ │
│  │  - conflict modal     │  │          │  │   - apply patch         │ │
│  └───────────────────────┘  │          │  │   - broadcast patch     │ │
│                             │          │  └─────────────────────────┘ │
└─────────────────────────────┘          └──────────────────────────────┘
         │                                         │
         │ localStorage (offline cache)            │ SQLite file
         ▼                                         ▼
    existing `solar-planner-project`         pb_data/data.db
```

### Components

- **PocketBase** is the whole backend: authentication, authorization,
  database, realtime fanout, admin UI. One custom Go route is added.
- **`syncClient.ts`** is the single new client-side module that touches the
  network. It subscribes to the Zustand store, debounces changes, diffs,
  POSTs patches, subscribes to the realtime channel, and manages the
  gesture queue + conflict modal. The rest of the app is unaware of sync.
- **`localStorage`** remains the offline cache; the existing `persist`
  middleware writes every change. On reconnect, the syncClient reconciles
  against the server.

### Why PocketBase over alternatives

Considered Supabase and a custom Node/Hono server.

- **Supabase** offers more raw capability (Postgres, RLS, horizontal
  scaling) but exceeds what a team tool needs. Managed pricing can bite;
  self-host is a Docker Compose zoo.
- **Custom** gives complete control but costs months for features
  PocketBase ships in a binary (auth, sessions, realtime, admin UI).
- **PocketBase** is the minimum viable backend for the stated goals.
  Operational surface is one binary + one SQLite file. Escape hatch if
  outgrown: dump SQLite → Postgres, reimplement two Go hooks on something
  else.

## Data model

Five PocketBase collections. Outer IDs are PocketBase's default 15-char
alphanumeric; in-project entity IDs (roof, panel, string, inverter) remain
the 8-char base36 `uid()` values produced by the existing store.

```
users                                   (PocketBase built-in auth collection)
├─ id              text (PK)
├─ email           email, unique
├─ password        hashed (managed)
└─ name            text

teams
├─ id              text (PK)
├─ name            text
├─ created_by      relation → users (admin at creation)
└─ created         datetime (auto)

team_members
├─ id              text (PK)
├─ team            relation → teams        ┐ composite unique
├─ user            relation → users        ┘ (team, user)
├─ role            select: "admin" | "member"
└─ joined          datetime (auto)

projects
├─ id              text (PK)
├─ team            relation → teams
├─ name            text (mirrors project.name for the list view)
├─ doc             json  (the full Project object from src/types/index.ts,
│                         INCLUDING capturedImage base64)
├─ revision        number (monotonic; bumps on every successful patch)
├─ created         datetime (auto)
└─ updated         datetime (auto)

patches                                  (broadcast-only; TTL-trimmed to ~1h)
├─ id              text (PK)
├─ project         relation → projects
├─ author          relation → users
├─ from_revision   number
├─ to_revision     number
├─ ops             json  (the RFC 6902 patch array)
└─ created         datetime (auto)
```

### Access rules (PocketBase expression syntax)

- **`teams`** — list/view: `@request.auth.id` is in `team_members.user` with
  matching `team`. Create: any signed-in user (a create hook inserts a
  `team_members` admin row automatically). Update/delete: admins only.
- **`team_members`** — list: members of the same team. Create/update/delete:
  admins of the target team only.
- **`projects`** — list/view: members of `projects.team`. Create: members of
  the target team. Update/delete via default endpoint: DISABLED
  (`@request.auth.id = ""`). All project mutations go through the custom
  `/api/sp/patch` route.
- **`patches`** — list/view: members of the project's team. Create: the
  custom hook only (not clients directly).

### Schema pragmatics

- `doc` is opaque JSON to the server except during patch application.
  `src/types/index.ts` remains the single source of truth for the project
  shape; there is no parallel server-side schema to keep in sync.
- `patches` exists primarily as a realtime fanout channel. PocketBase
  broadcasts record-create events to subscribers; clients apply `ops` and
  bump their `lastKnownRevision`. A cron hook trims `patches` older than
  ~1 hour — nobody needs history beyond the current session; `doc` at the
  current `revision` is always authoritative.
- `revision` starts at 0; bumps atomically with each successful patch apply.

## Sync protocol

### Outbound: local edit → server

```
User does something (e.g. moveGroup)
  │
  ▼
Zustand action mutates store.project               (unchanged)
  │
  ▼
syncClient subscriber fires                        (NEW)
  │
  ├─ If gesture active (see "Gesture queue") → stash snapshot, skip timer
  │
  ▼
Debounce timer (2000 ms after last change)
  │
  ▼
diff = jsonPatch.compare(lastSyncedDoc, currentDoc)
  │
  ▼
If diff.length === 0 → nothing to do
  │
  ▼
POST /api/sp/patch
  body: { projectId, fromRevision: lastKnownRevision, ops: diff }
  │
  ▼
Server (custom Go hook, transactional):
  1. row = SELECT doc, revision FROM projects WHERE id = projectId
  2. If row.revision != fromRevision:
       return 409 { currentRevision, currentDoc }
  3. newDoc = applyPatch(row.doc, ops)
  4. UPDATE projects SET doc = newDoc, revision = revision + 1
  5. INSERT patches (project, author, from_revision, to_revision, ops)
  6. Commit; PocketBase broadcasts the patches insert via SSE.
  7. Return 200 { newRevision }
  │
  ▼
Client on 200:
  lastKnownRevision = newRevision
  lastSyncedDoc = structured clone of currentDoc
```

### Inbound: server patch → local

```
SSE subscription to collection "patches", filter: project = projectId
  │
  ▼
Patch arrives: { from_revision, to_revision, author, ops }
  │
  ├─ If author === me → ignore (already applied locally)
  │
  ├─ If from_revision !== lastKnownRevision →
  │     Gap detected. Trigger full resync:
  │       GET /api/collections/projects/records/:projectId
  │       loadProject(record.doc); lastKnownRevision = record.revision
  │
  ▼
Apply ops via a new store action applyRemotePatch(ops):
  - Registered as ACTION_POLICY: "bypass" so it does NOT push to undo stack
  - Updates store.project AND lastSyncedDoc in the same transaction
  - lastKnownRevision = to_revision
  │
  ▼
Subscribed components re-render normally via existing selectors
```

### Conflict: 409 response

```
POST /api/sp/patch returns 409 { currentRevision, currentDoc }
  │
  ▼
Pause outbound sync. Show modal:
  "Your changes conflict with someone else's edits to this project.
   [Discard mine]   [Overwrite theirs]   [X]"
  │
  ├─ [Discard mine]:
  │     store.loadProject(currentDoc)       (existing action)
  │     lastSyncedDoc = currentDoc
  │     lastKnownRevision = currentRevision
  │     Resume sync.
  │
  ├─ [Overwrite theirs]:
  │     rebasedOps = jsonPatch.compare(currentDoc, localDoc)
  │     POST /api/sp/patch with fromRevision: currentRevision, ops: rebasedOps
  │     (Can 409 again if a third party edited in the interim — loop. Bounded
  │      in practice by the 2 s debounce on all clients.)
  │
  └─ [X] / dismiss:
        Default to "Discard mine" behavior. We MUST reconcile because the
        client's revision is stale; leaving stale state around guarantees
        the next edit will 409.
```

### Gesture queue

KonvaOverlay tracks pointer state for drag/lasso gestures. Integration points:

```
On pointerdown  → syncClient.beginGesture()
  - gestureActive = true
  - Suspend debounce timer (no POSTs during drag)
  - Buffer incoming SSE patches into gestureInboundQueue

On pointerup    → syncClient.endGesture()
  - Snapshot aliceDiff = jsonPatch.compare(lastSyncedDoc, project) — this
    captures Alice's gesture-produced changes while `project` still holds
    them (before we apply buffered remote ops).
  - Apply buffered inbound patches in received order via applyRemotePatch.
    This bumps lastKnownRevision and lastSyncedDoc, and propagates Bob's
    changes into Alice's store. Fields Alice also touched will be
    overwritten locally by Bob's values at this step.
  - Re-apply aliceDiff to project to reassert Alice's values on any
    fields they both touched. After this step, project = (Bob's state)
    with Alice's gesture changes on top (LWW where last to POST wins).
  - Compute diff vs lastSyncedDoc (which should now equal aliceDiff on
    non-contested fields, and Alice's values on contested fields) and POST.
  - If any buffered patch has from_revision mismatch → discard buffer,
    trigger full resync, abandon aliceDiff (rare; means Alice's client
    drifted out of sync mid-gesture — she re-does the gesture).
  - On 409 from the POST → conflict modal; Alice's completed gesture is
    "mine."

On Escape       → treated as pointerup (gesture cancelled)
```

### Subtleties

- **Self-patch filter.** When client A POSTs, the server broadcasts the
  patch to ALL subscribers including A. A filters by `author === me` to
  avoid re-applying its own op.
- **Full-resync fallback.** Any unexpected state — missed patch, stale
  revision, malformed ops — triggers
  `GET /api/collections/projects/records/:id` + `loadProject(record.doc)`.
  The server `doc` at the current `revision` is always source of truth.
  This replaces all "reconstruct from partial patch history" logic.
- **Captured image in patches.** If the user re-locks the map, the patch
  includes a `replace` op on `mapState.capturedImage` carrying a
  multi-megabyte base64 string. This is expected and infrequent; HTTPS
  compression helps; we do not split the image into a separate upload in
  v1 (decision recorded under scope decisions).

## Auth, routing, UI

### Routes (React Router v6, new dependency)

```
/                       — unauth: login page
                          auth + no team: "create your first team"
                          auth + teams: team picker + project list
/login                  — email+password form; "Sign up" toggle
/teams/new              — create team form (name)
/teams/:teamId          — project list for that team, "New Project",
                          "Manage members" (admins only)
/teams/:teamId/members  — member list, invite-by-email field (admins only)
/p/:projectId           — the existing editor (MapView + KonvaOverlay etc.)
```

The current `App.tsx` becomes the inner editor rendered at `/p/:projectId`.
A new `AppShell.tsx` wraps the router and handles the auth state.

### Auth flow (PocketBase JS SDK)

- `pb.authStore.isValid` drives a redirect guard: unauthenticated users on
  `/p/:id` bounce to `/login?return=/p/:id`.
- `pb.authStore` persists to `localStorage` under PocketBase's own key and
  survives refresh. We do not re-implement session storage.
- On successful login/signup, first-sign-in migration runs:
  1. If `localStorage.solar-planner-project` contains any roofs/panels/
     strings AND the user has no projects in any team:
     - If the user has no team → create a default team `"{userName}'s Team"`.
     - Create a project from the local doc. Navigate to `/p/:newId`.
  2. Otherwise navigate to `/`.

### Project lifecycle

- **Create:** `POST /api/collections/projects` with
  `{ team, name: "Untitled Project", doc: initialProject, revision: 0 }`.
  Navigate to `/p/:newId` and immediately establish SSE subscription.
- **Open:** `GET /api/collections/projects/records/:id`,
  `loadProject(record.doc)`, `lastKnownRevision = record.revision`,
  subscribe to `patches` filtered by `project = :id`.
- **Leave** (unmount of `/p/:id`): unsubscribe from SSE, flush any pending
  debounced patch, clear `syncClient` state, call `resetProject()`.
- **Delete:** admin-only button in the project list;
  `DELETE /api/collections/projects/records/:id`; server cascades `patches`.

### Editor UI additions

Three additions inside `/p/:projectId`, all in the top bar:

1. **Breadcrumb:** `Team Name / Project Name` (team name links to
   `/teams/:id`; project name hosts the existing rename field).
2. **Sync status indicator** (top-right):
   - `green "Synced"` — idle, `lastSyncedDoc === currentDoc`, revision current
   - `blue "Syncing…"` — debounce timer active or POST in flight
   - `amber "Offline — changes saved locally"` — last network call failed;
     localStorage still writes; retries on reconnect
   - `red "Conflict"` — 409 modal is up (blocks editing until resolved)
3. **Presence (stretch, possibly M5):** "2 others editing" pill; not in
   v1 scope.

### What does NOT change

- The editor interior — `KonvaOverlay`, `MapView`, `RoofLayer`,
  `PanelLayer`, `Toolbar`, `Sidebar`, all of `utils/`, and the core of
  `store/projectStore.ts` — stays pixel-identical. The only store change
  is a new `applyRemotePatch(ops)` action registered as `bypass` in
  `ACTION_POLICY`.
- JSON import/export via the existing `projectSerializer` remains. It
  becomes the "emergency backup" path and the way to move a project
  between teams.
- Undo/redo behaves exactly as today — local only.

## Error handling

| Scenario | Client behavior |
|---|---|
| Network down during POST | Exponential backoff (1s, 2s, 4s, cap 30s). Status → amber "Offline". localStorage still saves via `persist`. |
| Network down during SSE | PocketBase SDK auto-reconnects. On reconnect: full-resync fallback. |
| 409 conflict | Modal per conflict flow above. Sync paused until resolved. |
| 401 (session expired) | Redirect to `/login?return=...`. Local edits preserved in localStorage. |
| 403 (kicked from team mid-session) | Message + redirect to `/`. Local copy stays readable but cannot sync. |
| 404 (project deleted) | Same as 403. |
| Server 5xx | Retry with backoff, treated as network-down for the status indicator. |
| Malformed remote patch (apply throws) | Log to console, trigger full resync. |
| Duplicate SSE event | `from_revision` check in inbound flow is idempotent-safe. |

## Testing strategy

Project has Vitest configured already (no tests land yet for store logic;
this work introduces the first substantial test suite).

### Unit tests (Vitest, jsdom)

- `syncClient.diff` produces correct RFC 6902 ops for representative
  store mutations (add roof, move group, delete inverter, lock map with
  captured image).
- Patch round-trip: `applyPatch(doc, diff(doc, doc2)) ≡ doc2` for a
  range of fixture projects.
- Gesture queue: inbound patches during an active gesture are held in
  order, applied on end; patches with gap revision trigger full resync.
- Conflict rebase: "overwrite theirs" produces the expected patch against
  the refreshed server doc.

### Integration tests (Vitest, PocketBase subprocess)

- A `beforeAll` spawns PocketBase against a temp SQLite file; a
  `afterAll` tears it down. The JS SDK connects over loopback.
- Two-client scenarios: client A's edit surfaces on client B within a
  bounded window (target: < 3 s given the 2 s debounce).
- Conflict scenario: both clients edit the same roof; second POST gets
  409; "overwrite theirs" succeeds on retry.
- Offline reconnect: disable A's POST endpoint, make five edits, re-enable,
  verify a single merged patch is sent (the debounce collapses them).

### E2E (optional)

Playwright flow (login, create team, invite member, collaborate) is
deferred unless integration coverage proves insufficient.

## Rollout (milestones)

Each milestone is independently mergeable and leaves the app working.

### M1 — Backend skeleton (no app changes)

- `/server` subdirectory: Go module, PocketBase embedded binary, schema
  migrations (`pb_migrations/`), the `/api/sp/patch` custom route, the
  create-team-admin hook, and the 1-hour patch TTL cron.
- Manual testing via the PocketBase admin UI + `curl`.
- README section: `./pocketbase serve` on localhost for dev.

### M2 — Auth shell (no sync yet)

- Add React Router.
- `AppShell` with route guard.
- `/login`, `/teams/:id`, `/p/:projectId`.
- Team CRUD, invite-by-email, list members.
- Project CRUD: create, list, delete.
- Opening `/p/:id` does a one-shot GET and renders the editor. Edits
  save only to localStorage. No sync yet.

### M3 — Sync client

- `syncClient.ts`: debounced diff, POST, SSE subscribe.
- `applyRemotePatch(ops)` store action, registered as `bypass`.
- Gesture queue.
- Conflict modal.
- Sync status indicator.
- Two-browser-tab smoke test.

### M4 — Migration path

- First-sign-in auto-import of `localStorage` project.
- JSON export/import still works alongside sync.
- Update `AGENTS.md`: the localStorage-as-primary era is over.

### M5 — Polish (stretch)

- Presence indicator (separate `presence` collection, 30 s TTL rows).
- SMTP config for password resets (until then, admin resets manually).
- Admin UI refinements.

## Deferred decisions (surfaced at plan time)

- JSON Patch library: `fast-json-patch` vs `rfc6902`. Both small, both
  acceptable. Pick at plan time based on bundle size + API ergonomics.
- PocketBase schema migration format: JS-based migrations (`pb_migrations/`)
  vs raw JSON collection exports.
- Whether integration tests use a PocketBase subprocess or embed the Go
  binary directly.
- Presence collection schema if M5 is pursued.

## Non-goals (explicit)

- Real CRDT / multi-day offline operation.
- Fine-grained permissions (per-project roles, view-only).
- End-to-end encryption of project data.
- Mobile app — still browser only.
- Version history / "restore to yesterday" — v1 keeps only the current
  `doc` and a 1-hour `patches` buffer.
- Schema decomposition of the project JSON — `doc` stays opaque JSON.

## Open risks

- **Large captured images in patches.** A re-lock can send a multi-MB
  patch. Acceptable in v1; if it bites, we can split the image to
  separate file storage in a follow-up without schema changes (add a new
  `capturedImageFile` field to `mapState`, prefer it over `capturedImage`
  when present).
- **SQLite vertical-scaling ceiling.** Fine for team-sized usage;
  migrating to Postgres is straightforward when needed.
- **Operational burden of self-hosting.** One binary on a VPS is simple,
  but backups, TLS, and updates remain the user's responsibility. A
  managed PocketBase host (like PocketHost) is an option if the user
  doesn't want to self-host.
- **Array-index semantics of RFC 6902.** JSON Patch addresses array
  elements by integer index. If two clients both insert into
  `project.roofs` near-simultaneously, the second patch may land at an
  unintended index. Mitigation: in our data model, `roofs`, `panels`,
  `strings`, and `inverters` are append-only with occasional random-index
  deletes — true reorders aren't a user action. Residual risk is low.
  If it bites in practice, we can switch to keyed diffs (address by `id`,
  not index) via a small wrapper around the JSON Patch lib without
  changing the server.
- **Re-assertion step in gesture queue.** The endGesture flow re-applies
  `aliceDiff` on top of Bob's buffered ops. If Bob's ops restructure an
  array that Alice's diff references by index (e.g., Bob deletes a roof
  with a lower index), re-application can land on the wrong element or
  fail outright. Same mitigation as above — in practice, simultaneous
  delete-plus-drag is rare; failure mode is a visible glitch the user can
  correct with undo or a re-drag.
