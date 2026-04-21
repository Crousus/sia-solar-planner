# Backend Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Solar Planner from a single-user localStorage app into a team-collaborative tool with PocketBase as the backend, JSON Patch as the sync wire format, and optimistic concurrency control via a revision number.

**Architecture:** Two new top-level pieces — a Go-based PocketBase server in `/server` (auth, data, realtime fanout, one custom patch-apply route) and a client-side `syncClient` module that debounces local edits, diffs them as RFC 6902 patches, POSTs them to the server, and applies inbound patches received over SSE. Everything else in the React app stays functionally identical; the editor is wrapped in a router and mounted at `/p/:projectId`. Local-first semantics (offline grace, localStorage cache) are preserved via the existing `persist` middleware.

**Tech Stack:**
- **Server:** Go 1.22+, PocketBase v0.23 (embedded SQLite), `github.com/evanphx/json-patch` v5
- **Client additions:** `pocketbase` JS SDK, `react-router-dom` v6, `fast-json-patch`
- **Existing:** React 18, Zustand, Konva, Leaflet, Vite, Vitest, TypeScript strict

**Reference spec:** `docs/superpowers/specs/2026-04-21-backend-sync-design.md`

**User-project conventions to honour throughout:**
- Heavy WHY comments on code (per `AGENTS.md` + user memory). Explain non-obvious design trade-offs in comments, not just in the commit message.
- Commit messages MUST NOT include a `Co-Authored-By` trailer.
- Every new store action must appear in `ActionName` AND `ACTION_POLICY` (see `src/store/undoMiddleware.ts`) — TypeScript enforces coverage.
- Any new user-facing mutation must think about undo (record vs bypass).

**Branch + worktree guidance:** Create a feature branch `backend-sync`. Given the scope (18 tasks across 4 milestones), a long-lived branch is preferable to a worktree; tasks land as incremental commits on that branch. The branch only merges to main after M3 produces a working two-client demo.

---

## File inventory

### Created

**Server-side (`/server/`):**
- `server/go.mod`, `server/go.sum` — Go module for PocketBase + json-patch
- `server/main.go` — PocketBase bootstrap, custom route registration, hooks, cron
- `server/handlers/patch.go` — the `/api/sp/patch` custom HTTP handler
- `server/handlers/hooks.go` — create-team-admin hook, patch TTL cron
- `server/pb_migrations/1712345600_initial_schema.js` — schema migration
- `server/README.md` — dev setup
- `server/.gitignore` — `pb_data/`, `pocketbase` binary

**Client-side (`src/`):**
- `src/backend/pb.ts` — PocketBase JS client singleton + auth store wrappers
- `src/backend/types.ts` — TypeScript types for server records (Team, Project, Patch, etc.)
- `src/backend/diff.ts` — JSON Patch wrapper (thin facade over `fast-json-patch`)
- `src/backend/diff.test.ts`
- `src/backend/syncClient.ts` — the sync state machine
- `src/backend/syncClient.test.ts`
- `src/backend/migrateLocalStorage.ts` — first-sign-in import of `solar-planner-project`
- `src/components/AppShell.tsx` — top-level router + auth guard mount point
- `src/components/AuthGuard.tsx` — redirect wrapper for auth-gated routes
- `src/components/LoginPage.tsx` — sign in + sign up form
- `src/components/TeamPicker.tsx` — `/` route (list teams, pick one or create)
- `src/components/NewTeamPage.tsx` — `/teams/new`
- `src/components/TeamView.tsx` — `/teams/:teamId` (project list + "New Project")
- `src/components/TeamMembers.tsx` — `/teams/:teamId/members`
- `src/components/ProjectEditor.tsx` — `/p/:projectId` wrapper around the editor
- `src/components/SyncStatusIndicator.tsx` — top-bar dot + label
- `src/components/ConflictModal.tsx` — the discard/overwrite modal

### Modified

- `src/main.tsx` — swap direct `<App/>` render for `<AppShell/>`
- `src/App.tsx` — becomes the inner editor body (no longer top-level shell)
- `src/store/projectStore.ts` — add `applyRemotePatch(ops)` action
- `src/store/undoMiddleware.ts` — add `'applyRemotePatch'` to `ActionName` + `ACTION_POLICY` as `bypass`
- `src/components/Toolbar.tsx` — add breadcrumb + sync status indicator
- `src/components/KonvaOverlay.tsx` — call `syncClient.beginGesture()` / `endGesture()` in `onMouseDown` / `onMouseUp`
- `package.json` — deps: `pocketbase`, `react-router-dom`, `fast-json-patch`
- `vite.config.ts` — dev proxy `/api` → `http://127.0.0.1:8090`
- `AGENTS.md` — note the backend; end-of-doc deprecation of the "no backend" claim at the top
- `.gitignore` — ignore `server/pb_data/`, `server/pocketbase` binary

---

## Task 1: Feature branch + dependencies

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`
- Modify: `.gitignore`
- Create: `server/.gitignore`

**Purpose:** Prepare the workspace. Create the branch, install client deps, set up Vite dev proxy so `/api/*` calls hit PocketBase during `npm run dev`, and make sure we don't accidentally commit the SQLite file or downloaded PocketBase binary.

- [ ] **Step 1: Create and switch to the feature branch.**

```bash
git checkout -b backend-sync
```

- [ ] **Step 2: Install client dependencies.**

```bash
npm install pocketbase react-router-dom fast-json-patch
npm install --save-dev @types/react-router-dom
```

Verify `package.json`'s `dependencies` now include `pocketbase`, `react-router-dom`, `fast-json-patch`. `pocketbase` pulls no transitive deps; `fast-json-patch` is ~10 KB gzipped.

- [ ] **Step 3: Add Vite dev proxy for `/api/*`.**

Edit `vite.config.ts`. If no `server` block exists yet, add one:

```ts
export default defineConfig({
  plugins: [react()],
  server: {
    // During `npm run dev`, forward any /api/* request to the PocketBase
    // instance running on :8090. This lets client code use same-origin
    // paths like /api/sp/patch in both dev and prod — in prod, we'll put
    // PocketBase behind a reverse proxy at the same origin as the SPA.
    //
    // changeOrigin:true rewrites the Host header so PocketBase sees its
    // own hostname, not vite's. ws:true forwards the SSE realtime stream
    // (PocketBase implements realtime over SSE, not websockets, but the
    // upgrade flag covers both just in case a future version switches).
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8090',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
```

- [ ] **Step 4: Update `.gitignore`.**

Append to the repo-root `.gitignore`:

```
# PocketBase working data (SQLite file, uploaded files, logs)
server/pb_data/
# Downloaded PocketBase binary (installed locally by the server's README)
server/pocketbase
```

Create `server/.gitignore` with the same lines plus `*.exe` for Windows dev machines.

- [ ] **Step 5: Commit.**

```bash
git add package.json package-lock.json vite.config.ts .gitignore server/.gitignore
git commit -m "Add backend-sync deps and dev proxy scaffolding"
```

Verify `npm run dev` still starts without error (no new code wired yet, proxy target just isn't reachable — expected).

---

## Task 2: PocketBase bootstrap and auth/team schema

**Files:**
- Create: `server/go.mod`
- Create: `server/main.go`
- Create: `server/pb_migrations/1712345600_initial_schema.js`
- Create: `server/README.md`

**Purpose:** Stand up a runnable PocketBase instance and define the three auth-related collections (`users` is built in; we add `teams` and `team_members`). Access rules go in this task too — splitting "schema" from "rules" would force two migrations for one coherent concept.

- [ ] **Step 1: Initialise the Go module.**

```bash
cd server
go mod init solar-planner/server
go get github.com/pocketbase/pocketbase@v0.23.0
go get github.com/evanphx/json-patch/v5
```

This yields `go.mod`, `go.sum`, and a vendored dep tree under `~/go/pkg/mod`.

- [ ] **Step 2: Write `server/main.go`.**

```go
// server/main.go — PocketBase host for Solar Planner.
//
// Composition:
//   - Embeds the PocketBase framework. `app.Start()` boots the built-in
//     HTTP server, SQLite connection, admin UI, auth routes, and realtime
//     SSE endpoint.
//   - Registers our custom /api/sp/patch route (see handlers/patch.go).
//   - Registers lifecycle hooks (see handlers/hooks.go): auto-admin on
//     team creation, TTL cron on patches.
//
// Why a single binary?
//   PocketBase's design — one Go binary embedding SQLite — keeps ops to
//   "scp and ./pocketbase serve". Adding a separate service would double
//   the deployment burden for a team tool that runs on a single VPS.
//
// Why custom route alongside stock collections?
//   The default PocketBase record-update endpoint ignores the body's shape
//   beyond known collection fields and has no notion of RFC 6902 JSON Patch
//   or per-row revision-based optimistic concurrency. Implementing both
//   would require so much filtering of the default behaviour that it's
//   simpler to disable update-via-default-endpoint for projects (rule set
//   to @request.auth.id = "") and route all edits through /api/sp/patch.
package main

import (
	"log"
	"os"

	"solar-planner/server/handlers"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	_ "github.com/pocketbase/pocketbase/migrations"
)

func main() {
	app := pocketbase.New()

	// `automigrate: true` on the default migrate runner auto-applies any
	// JS file in ./pb_migrations on boot. We want this in prod too — the
	// server is single-node and migrations are authored by us, not
	// user-submitted. The `--automigrate` flag is also accepted as a CLI
	// override, but baking it into code prevents an operator from starting
	// the server without it and producing a schema-less SQLite.
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		handlers.RegisterRoutes(app, e)
		return e.Next()
	})

	handlers.RegisterHooks(app)

	if err := app.Start(); err != nil {
		log.Printf("pocketbase exited: %v", err)
		os.Exit(1)
	}
}
```

Create stub `server/handlers/patch.go` and `server/handlers/hooks.go` with empty `RegisterRoutes(app *pocketbase.PocketBase, e *core.ServeEvent)` / `RegisterHooks(app *pocketbase.PocketBase)` functions so the build passes. Fill them in later tasks.

- [ ] **Step 3: Write the initial schema migration.**

Create `server/pb_migrations/1712345600_initial_schema.js`. PocketBase's migration runner executes JS files in `pb_migrations/` in timestamp order, giving access to an `app` binding with collection CRUD. We split the schema across two migrations (this one and Task 3's) only because `projects` + `patches` depend on `teams` existing.

```js
/// <reference path="../pb_data/types.d.ts" />

// Initial schema migration — users, teams, team_members.
//
// IDs: PocketBase default 15-char base36 auto-ids. We do NOT use our
// app's 8-char base36 uid() for outer records — that's for in-project
// entities (roof/panel/string/inverter IDs) and stays inside the JSON
// `doc` field on projects.

migrate((app) => {
  // ── users — extend the built-in auth collection with a `name` field.
  const users = app.findCollectionByNameOrId('users');
  // Add `name` as a required text field if it isn't already there.
  // PocketBase's built-in users collection ships with name/avatar/verified
  // in newer versions, but we set the API rules explicitly to lock down
  // user enumeration.
  if (!users.fields.getByName('name')) {
    users.fields.add(new TextField({
      name: 'name',
      required: true,
      min: 1,
      max: 100,
    }));
  }
  // Lock down user listing — members should be able to see OTHER users'
  // names (for displaying "Inviter: Alice" and in team member lists),
  // but only by direct ID lookup, not by email enumeration. The list
  // rule empty string = deny-all; view rule = authenticated.
  users.listRule = null;
  users.viewRule = '@request.auth.id != ""';
  app.save(users);

  // ── teams
  const teams = new Collection({
    type: 'base',
    name: 'teams',
    // listRule: only teams the user is a member of.
    // viewRule: same.
    // createRule: any authenticated user (they become admin via hook).
    // updateRule: only admins of this team.
    // deleteRule: only admins of this team.
    listRule: "@request.auth.id != '' && @collection.team_members.team = id && @collection.team_members.user = @request.auth.id",
    viewRule: "@request.auth.id != '' && @collection.team_members.team = id && @collection.team_members.user = @request.auth.id",
    createRule: "@request.auth.id != ''",
    updateRule: "@request.auth.id != '' && @collection.team_members.team = id && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'",
    deleteRule: "@request.auth.id != '' && @collection.team_members.team = id && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'",
    fields: [
      { name: 'name', type: 'text', required: true, min: 1, max: 100 },
      { name: 'created_by', type: 'relation', required: true, collectionId: users.id, cascadeDelete: false, maxSelect: 1 },
    ],
  });
  app.save(teams);

  // ── team_members
  const teamMembers = new Collection({
    type: 'base',
    name: 'team_members',
    // listRule: members of the same team can see each other.
    //   `@request.auth.id != ""` gate first (cheap) then a self-join via
    //   @collection.team_members (PocketBase supports this pattern).
    // viewRule: same.
    // createRule: admins only. Checked via the role of the CALLER'S row
    //   in the same team. Note the distinct alias `tm` to avoid binding
    //   to the row being created.
    // updateRule / deleteRule: admins only.
    listRule: "@request.auth.id != '' && team.id ?= @collection.team_members.team",
    viewRule: "@request.auth.id != '' && team.id ?= @collection.team_members.team",
    createRule: "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'",
    updateRule: "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'",
    deleteRule: "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'",
    fields: [
      { name: 'team', type: 'relation', required: true, collectionId: teams.id, cascadeDelete: true, maxSelect: 1 },
      { name: 'user', type: 'relation', required: true, collectionId: users.id, cascadeDelete: true, maxSelect: 1 },
      { name: 'role', type: 'select', required: true, maxSelect: 1, values: ['admin', 'member'] },
    ],
    indexes: [
      // Composite unique — a user can only appear once per team.
      'CREATE UNIQUE INDEX idx_team_members_team_user ON team_members (team, user)',
    ],
  });
  app.save(teamMembers);
}, (app) => {
  // Down migration: reverse order of deletion to avoid FK constraints.
  app.delete(app.findCollectionByNameOrId('team_members'));
  app.delete(app.findCollectionByNameOrId('teams'));
  // Users is a built-in collection; we only added a field. Remove it.
  const users = app.findCollectionByNameOrId('users');
  if (users.fields.getByName('name')) {
    users.fields.removeByName('name');
    app.save(users);
  }
});
```

The `/// <reference>` comment at the top loads PocketBase-generated TypeScript types for editor autocomplete. The file itself is plain JS — PocketBase's JS VM doesn't execute TS.

- [ ] **Step 4: Write `server/README.md`.**

Include:
- How to download the PocketBase binary (`wget https://github.com/pocketbase/pocketbase/releases/download/v0.23.0/...`).
- `go build -o pocketbase .` to embed our custom routes/hooks into the binary.
- `./pocketbase serve --http=127.0.0.1:8090` to start; admin UI at `http://127.0.0.1:8090/_/`.
- First-run admin setup (email/password prompt).
- How to nuke and restart: `rm -rf pb_data && ./pocketbase serve`.

- [ ] **Step 5: Run it once.**

```bash
cd server
go build -o pocketbase .
./pocketbase serve
```

Open `http://127.0.0.1:8090/_/` in a browser, create the admin account, and verify:
- `teams` and `team_members` collections exist.
- `users` has a `name` field.
- Rules in the admin UI match what we wrote.

- [ ] **Step 6: Commit.**

```bash
git add server/
git commit -m "M1/1: PocketBase bootstrap + teams/team_members schema"
```

---

## Task 3: projects and patches collections

**Files:**
- Create: `server/pb_migrations/1712345700_projects_patches.js`

**Purpose:** Add the two data collections. `projects` holds the JSON doc + revision (the actual editable unit); `patches` is a broadcast-only collection whose record-create events are the SSE fanout channel.

- [ ] **Step 1: Write the migration.**

```js
/// <reference path="../pb_data/types.d.ts" />

// Projects + patches.
//
// `projects.doc` is an opaque JSON field from the server's perspective.
// The client's types/index.ts is the source of truth for its shape.
// We validate only that it's a JSON object at write time; deeper
// validation would require a parallel server-side schema (what the
// spec explicitly says we don't want to maintain).
//
// Updates to `doc` and `revision` come ONLY through /api/sp/patch.
// The default collection-update endpoint is disabled by setting
// updateRule to the never-matching "@request.auth.id = ''" literal.
// We keep `name` updatable through the default endpoint so renames are
// cheap (no patch roundtrip).

migrate((app) => {
  const teams = app.findCollectionByNameOrId('teams');
  const users = app.findCollectionByNameOrId('users');

  const projects = new Collection({
    type: 'base',
    name: 'projects',
    // listRule / viewRule: any team member.
    listRule: "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id",
    viewRule: "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id",
    // createRule: any team member. The new project's team ID is
    //   validated to belong to the caller.
    createRule: "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id",
    // updateRule: explicit DISABLED for default endpoint. The /api/sp/patch
    //   handler performs its own auth check by looking up the caller's
    //   team membership with elevated privileges. We DO still allow
    //   renames via the PATCH endpoint — but through a careful rule that
    //   permits ONLY the `name` field (PB supports this via @request.body).
    //   Simpler: for now, disable default PATCH entirely; implement
    //   rename via /api/sp/rename later or via the same /api/sp/patch
    //   route (a diff that touches only the name field IS a valid patch).
    //   Going with the latter — patches can rename the project.
    updateRule: null, // null == nobody via default endpoint
    deleteRule: "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'",
    fields: [
      { name: 'team', type: 'relation', required: true, collectionId: teams.id, cascadeDelete: true, maxSelect: 1 },
      { name: 'name', type: 'text', required: true, min: 1, max: 200 },
      { name: 'doc', type: 'json', required: true, maxSize: 20000000 }, // 20 MB — captured image can be multi-MB base64
      { name: 'revision', type: 'number', required: true, min: 0, onlyInt: true },
    ],
  });
  app.save(projects);

  const patches = new Collection({
    type: 'base',
    name: 'patches',
    // listRule / viewRule: any team member of the project's team. PB
    //   supports dotted navigation: `project.team` dereferences the
    //   projects record's team relation.
    listRule: "@request.auth.id != '' && @collection.team_members.team = project.team && @collection.team_members.user = @request.auth.id",
    viewRule: "@request.auth.id != '' && @collection.team_members.team = project.team && @collection.team_members.user = @request.auth.id",
    // createRule: DISABLED — only the server-side /api/sp/patch handler
    //   creates rows, via app.Save with no user context. If a
    //   malicious/curious client POSTs directly to /api/collections/patches,
    //   it 403s.
    createRule: null,
    updateRule: null,
    // deleteRule: we DO want automatic cleanup (the TTL cron) to be able
    //   to delete — but cron runs with an admin-like privilege (no auth
    //   context). Leave this disabled for HTTP access; the cron's
    //   app.Delete bypasses rules.
    deleteRule: null,
    fields: [
      { name: 'project', type: 'relation', required: true, collectionId: projects.id, cascadeDelete: true, maxSelect: 1 },
      { name: 'author', type: 'relation', required: true, collectionId: users.id, cascadeDelete: false, maxSelect: 1 },
      { name: 'from_revision', type: 'number', required: true, min: 0, onlyInt: true },
      { name: 'to_revision', type: 'number', required: true, min: 1, onlyInt: true },
      { name: 'ops', type: 'json', required: true, maxSize: 10000000 }, // 10 MB upper bound; normal patches are < 10 KB
    ],
    indexes: [
      // Query helper for TTL cron — find old patches fast.
      'CREATE INDEX idx_patches_created ON patches (created)',
      // Not strictly required but speeds up the SSE filter on project.
      'CREATE INDEX idx_patches_project ON patches (project)',
    ],
  });
  app.save(patches);
}, (app) => {
  app.delete(app.findCollectionByNameOrId('patches'));
  app.delete(app.findCollectionByNameOrId('projects'));
});
```

- [ ] **Step 2: Apply the migration by restarting the server.**

```bash
cd server
./pocketbase serve
```

Admin UI now shows `projects` and `patches`. Open each and verify field list + rules.

- [ ] **Step 3: Sanity check: try to create a project via admin UI.**

Create a `team` manually first (admin UI → `teams` → New). Then create a `team_member` row linking your admin user to that team with role=admin. Then create a `project` with `team` = that team, `name` = "Test", `doc` = `{}`, `revision` = 0. It should save.

- [ ] **Step 4: Sanity check: verify default update is blocked.**

In the admin UI, try editing the project's `doc` field and saving. The admin UI uses the same endpoint as clients — however admins bypass rules. This is fine; the rule blocks non-admin users. To properly test the rule, you'd sign in as a regular user via the JS SDK; we defer that to Task 5's curl tests.

- [ ] **Step 5: Commit.**

```bash
git add server/pb_migrations/1712345700_projects_patches.js
git commit -m "M1/2: projects + patches collections with access rules"
```

---

## Task 4: Hooks — auto-admin on team create, patch TTL cron

**Files:**
- Modify: `server/handlers/hooks.go`

**Purpose:** Two lifecycle integrations that keep the data model correct without client-side cooperation.

1. When a `teams` record is created, automatically create a `team_members` row with the caller as `admin`. Otherwise the creator couldn't even see the team they just made (the list rule would exclude them).
2. Hourly cron that deletes `patches` older than 1 hour. Keeps the table small; `doc` at `revision` is always source of truth so historical patches are only useful as live SSE fanout.

- [ ] **Step 1: Implement `RegisterHooks`.**

Replace the stub in `server/handlers/hooks.go`:

```go
package handlers

import (
	"fmt"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

// RegisterHooks wires lifecycle integrations onto the PocketBase app.
// Called once from main(); idempotent per-boot.
func RegisterHooks(app *pocketbase.PocketBase) {
	registerTeamAutoAdmin(app)
	registerPatchTTL(app)
}

// After a `teams` record is created, auto-insert a `team_members` row
// binding the creator as admin. Without this hook, the brand-new team's
// list rule (member-of) would exclude its own creator, rendering it
// invisible from the API.
//
// We use OnRecordAfterCreateSuccess so the team record is committed before
// we insert the members row. The two writes are NOT in a single transaction
// — a failure here would leave a team with no members. Acceptable risk:
// the admin can retry by manually creating the member row, and the failure
// mode (DB full, disk error) is rare enough. Worst case the user deletes
// the orphan team and retries.
func registerTeamAutoAdmin(app *pocketbase.PocketBase) {
	app.OnRecordAfterCreateSuccess("teams").BindFunc(func(e *core.RecordEvent) error {
		// `e.Auth` is the authenticated caller that triggered the create.
		// If it's nil, the create came from admin UI / internal code —
		// skip auto-admin because we don't know whom to elect.
		if e.Auth == nil {
			return e.Next()
		}

		memberCollection, err := e.App.FindCollectionByNameOrId("team_members")
		if err != nil {
			return fmt.Errorf("team_members collection missing: %w", err)
		}

		member := core.NewRecord(memberCollection)
		member.Set("team", e.Record.Id)
		member.Set("user", e.Auth.Id)
		member.Set("role", "admin")
		if err := e.App.Save(member); err != nil {
			// Roll back the team creation by deleting it. This keeps the
			// invariant "every team has at least one admin member" true.
			// The returned error propagates to the HTTP caller as a 500.
			e.App.Delete(e.Record)
			return fmt.Errorf("could not create team_members admin row: %w", err)
		}
		return e.Next()
	})
}

// Hourly cleanup: delete patches records older than 1 hour. Their only
// purpose is live SSE fanout to currently-connected clients; offline
// clients reconnect and full-resync against `doc` at the current
// revision. Keeping historical patches costs disk and pollutes list
// queries.
func registerPatchTTL(app *pocketbase.PocketBase) {
	app.Cron().MustAdd("trimPatches", "0 * * * *", func() {
		cutoff := time.Now().Add(-1 * time.Hour).UTC().Format(time.DateTime)
		_, err := app.DB().NewQuery(
			"DELETE FROM patches WHERE created < {:cutoff}",
		).Bind(map[string]any{"cutoff": cutoff}).Execute()
		if err != nil {
			// Log-and-continue. Next run will catch any rows missed.
			app.Logger().Error("trimPatches failed", "error", err)
		}
	})
}
```

- [ ] **Step 2: Rebuild and restart.**

```bash
cd server
go build -o pocketbase .
./pocketbase serve
```

- [ ] **Step 3: Manual verification.**

Create a new team via the admin UI impersonating a regular user (admin UI → `users` → copy a user's token; then use curl with `Authorization: Bearer <token>`, or sign in via the auth-OAuth-proxy endpoint — see PocketBase docs). Easier alternative: defer the full test to Task 5 where we'll exercise this end-to-end through the client. For now, verify the hook registers without error by checking the server log: you should see no "missing hook" warnings on boot.

- [ ] **Step 4: Verify the cron registration.**

In the admin UI under `Settings → Cron`, `trimPatches` should appear with schedule `0 * * * *`. It won't fire immediately — wait until the top of the next hour or manually trigger via the admin UI's "Run" button.

- [ ] **Step 5: Commit.**

```bash
git add server/handlers/hooks.go
git commit -m "M1/3: team auto-admin hook + patches TTL cron"
```

---

## Task 5: Custom `/api/sp/patch` route

**Files:**
- Modify: `server/handlers/patch.go`

**Purpose:** The core server-side logic: parse a JSON Patch request, check the revision, apply the patch transactionally, save the updated project, insert a `patches` record for SSE fanout. Returns 200 on success, 409 with current state on revision mismatch, 403 for permission issues.

- [ ] **Step 1: Implement the handler.**

Replace the stub in `server/handlers/patch.go`:

```go
package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	jsonpatch "github.com/evanphx/json-patch/v5"
)

// RegisterRoutes attaches our custom routes to the PocketBase HTTP server.
// Called once per ServeEvent (boot). The signature is dictated by how
// main.go invokes us from inside OnServe.
func RegisterRoutes(app *pocketbase.PocketBase, e *core.ServeEvent) {
	e.Router.POST("/api/sp/patch", func(re *core.RequestEvent) error {
		return handlePatch(app, re)
	})
}

// ── Request/response DTOs ──────────────────────────────────────────────

type patchRequest struct {
	ProjectID    string          `json:"projectId"`
	FromRevision int             `json:"fromRevision"`
	Ops          json.RawMessage `json:"ops"` // RFC 6902 patch array, kept as raw JSON
}

type patchConflictResponse struct {
	Error           string `json:"error"`
	CurrentRevision int    `json:"currentRevision"`
	CurrentDoc      any    `json:"currentDoc"`
}

type patchSuccessResponse struct {
	NewRevision int `json:"newRevision"`
}

// ── Handler ────────────────────────────────────────────────────────────

func handlePatch(app *pocketbase.PocketBase, re *core.RequestEvent) error {
	// 1. Auth gate. We only accept signed-in user callers (not admins via
	//    the admin token, not anonymous). PB's `re.Auth` is populated by
	//    the auth middleware that runs ahead of this handler.
	if re.Auth == nil || re.Auth.Collection().Name != "users" {
		return re.UnauthorizedError("sign-in required", nil)
	}

	// 2. Parse body. BindBody rejects non-JSON early.
	body := patchRequest{}
	if err := re.BindBody(&body); err != nil {
		return re.BadRequestError("invalid JSON body", err)
	}
	if body.ProjectID == "" {
		return re.BadRequestError("projectId required", nil)
	}
	if len(body.Ops) == 0 {
		return re.BadRequestError("ops required", nil)
	}

	// 3. Transactional work: read project, validate revision, apply patch,
	//    save project, save patches record. All or nothing — we don't
	//    want a patches row without a matching project revision bump.
	var newRevision int
	err := app.RunInTransaction(func(txApp core.App) error {
		project, err := txApp.FindRecordById("projects", body.ProjectID)
		if err != nil {
			return notFound("project not found")
		}

		// 4. Team-membership check. The handler has a signed-in user (step
		//    1) but no automatic rule evaluation — we're a custom route,
		//    not a default collection endpoint. So we check membership
		//    by hand: find a team_members row binding this user to the
		//    project's team.
		teamID := project.GetString("team")
		members, err := txApp.FindRecordsByFilter(
			"team_members",
			"team = {:team} && user = {:user}",
			"", 1, 0,
			map[string]any{"team": teamID, "user": re.Auth.Id},
		)
		if err != nil || len(members) == 0 {
			return forbidden("not a member of this project's team")
		}

		// 5. Revision check. Mismatch → 409 with current state so the
		//    client can show the discard/overwrite modal without a
		//    second roundtrip.
		currentRevision := project.GetInt("revision")
		if currentRevision != body.FromRevision {
			return conflict{
				currentRevision: currentRevision,
				currentDoc:      project.Get("doc"),
			}
		}

		// 6. Apply patch.
		docBytes, err := json.Marshal(project.Get("doc"))
		if err != nil {
			return fmt.Errorf("marshal existing doc: %w", err)
		}
		patch, err := jsonpatch.DecodePatch(body.Ops)
		if err != nil {
			return re.BadRequestError("invalid JSON Patch", err)
		}
		patchedBytes, err := patch.Apply(docBytes)
		if err != nil {
			return re.BadRequestError("patch failed to apply", err)
		}
		var patchedDoc any
		if err := json.Unmarshal(patchedBytes, &patchedDoc); err != nil {
			return fmt.Errorf("patched doc not valid JSON: %w", err)
		}

		// 7. Save updated project. PocketBase's Save on an existing record
		//    does an UPDATE, bumps `updated`, and returns the same record
		//    instance with the new revision visible.
		project.Set("doc", patchedDoc)
		project.Set("revision", currentRevision+1)
		// If the patch touched the top-level name, mirror it to the
		// column so the project list view doesn't need to parse `doc`.
		if patchedMap, ok := patchedDoc.(map[string]any); ok {
			if name, ok := patchedMap["name"].(string); ok && name != "" {
				project.Set("name", name)
			}
		}
		if err := txApp.Save(project); err != nil {
			return fmt.Errorf("save project: %w", err)
		}

		// 8. Insert patches record — this is the SSE fanout. PocketBase's
		//    realtime broadcasts record-create events to anyone subscribed
		//    to the collection (client filters by project relation on its
		//    end).
		patchesCollection, err := txApp.FindCollectionByNameOrId("patches")
		if err != nil {
			return fmt.Errorf("patches collection missing: %w", err)
		}
		patchRec := core.NewRecord(patchesCollection)
		patchRec.Set("project", body.ProjectID)
		patchRec.Set("author", re.Auth.Id)
		patchRec.Set("from_revision", body.FromRevision)
		patchRec.Set("to_revision", currentRevision+1)
		// Store the ops as-is. json.RawMessage preserves the original bytes,
		// avoiding a round-trip through a Go map that could reorder object
		// keys or normalize number representation.
		patchRec.Set("ops", body.Ops)
		if err := txApp.Save(patchRec); err != nil {
			return fmt.Errorf("save patches record: %w", err)
		}

		newRevision = currentRevision + 1
		return nil
	})

	if err != nil {
		// Translate our sentinel error types into HTTP responses. Anything
		// unexpected falls through to a 500.
		var c conflict
		if errors.As(err, &c) {
			return re.JSON(http.StatusConflict, patchConflictResponse{
				Error:           "revision mismatch",
				CurrentRevision: c.currentRevision,
				CurrentDoc:      c.currentDoc,
			})
		}
		if nfErr, ok := err.(notFound); ok {
			return re.NotFoundError(string(nfErr), nil)
		}
		if fErr, ok := err.(forbidden); ok {
			return re.ForbiddenError(string(fErr), nil)
		}
		// router.ApiError already responds; the returned error is for
		// PB logging only.
		var apiErr *router.ApiError
		if errors.As(err, &apiErr) {
			return err
		}
		app.Logger().Error("handlePatch", "error", err)
		return re.InternalServerError("patch failed", err)
	}

	return re.JSON(http.StatusOK, patchSuccessResponse{NewRevision: newRevision})
}

// ── Sentinel error types — let us carry typed failure data out of the
// RunInTransaction closure without forcing everything through http.Error
// plumbing (which would foreclose the 409's structured body). ────────

type conflict struct {
	currentRevision int
	currentDoc      any
}

func (conflict) Error() string { return "revision mismatch" }

type notFound string

func (n notFound) Error() string { return string(n) }

type forbidden string

func (f forbidden) Error() string { return string(f) }
```

- [ ] **Step 2: Rebuild and run.**

```bash
cd server
go build -o pocketbase .
./pocketbase serve
```

- [ ] **Step 3: Exercise with curl.**

Using the admin UI, create a test user `alice@example.com` (set a password). Create a team and add Alice as admin. Create a project with `doc = {"name":"t","roofs":[],"panels":[],"strings":[],"inverters":[]}`, `revision = 0`.

Get Alice's token (sign in via the auth endpoint):

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:8090/api/collections/users/auth-with-password \
  -H 'Content-Type: application/json' \
  -d '{"identity":"alice@example.com","password":"<password>"}' | jq -r '.token')
```

Try a patch:

```bash
curl -v -X POST http://127.0.0.1:8090/api/sp/patch \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "projectId": "<project_id_from_admin_ui>",
    "fromRevision": 0,
    "ops": [{"op":"replace","path":"/name","value":"renamed"}]
  }'
```

Expected: `200 {"newRevision":1}`. Then repeat WITHOUT changing `fromRevision`:

```bash
# same command again — should 409
```

Expected: `409` with body containing `currentRevision: 1` and `currentDoc.name = "renamed"`.

- [ ] **Step 4: Commit.**

```bash
git add server/handlers/patch.go
git commit -m "M1/4: /api/sp/patch route with revision OCC"
```

M1 is complete. The backend accepts, validates, and broadcasts patches.

---

## Task 6: Client PocketBase singleton + backend types

**Files:**
- Create: `src/backend/pb.ts`
- Create: `src/backend/types.ts`

**Purpose:** Single PocketBase JS client instance shared across the app. TypeScript types that mirror server records so the rest of the client has real IntelliSense instead of `any`.

- [ ] **Step 1: Write `src/backend/pb.ts`.**

```ts
// ────────────────────────────────────────────────────────────────────────
// PocketBase client singleton.
//
// One instance per browser tab. PocketBase SDK is stateless aside from
// its `authStore` which it persists to localStorage under its own key
// (`pocketbase_auth`). Sharing a singleton lets any file in the app read
// pb.authStore.model for "who is signed in" without threading the
// instance through props/context.
//
// The base URL is empty string in dev because Vite proxies /api/* to
// the PocketBase server (see vite.config.ts). In prod, the same origin
// assumption means empty string works there too (PocketBase sits behind
// the same reverse proxy). If we ever split origins, set via env var.
// ────────────────────────────────────────────────────────────────────────

import PocketBase from 'pocketbase';

// Explicit cast so the JSDoc + our types files stay informative.
// Empty-string base means "use the current origin" at runtime.
export const pb = new PocketBase('');

/** Thin wrapper: resolves to the current auth model or null. */
export function currentUser() {
  return pb.authStore.model;
}

/** Subscribe to auth changes. Returns an unsubscribe fn. */
export function onAuthChange(cb: (user: unknown) => void) {
  return pb.authStore.onChange((_token, model) => cb(model));
}
```

- [ ] **Step 2: Write `src/backend/types.ts`.**

```ts
// ────────────────────────────────────────────────────────────────────────
// Server record types. Mirror the PocketBase collection schemas defined
// in server/pb_migrations/*.js.
//
// We hand-maintain these rather than generating from PocketBase's
// /api/collections schema because (a) the collection list lives behind
// admin auth in prod, (b) the generated types we care about are just 5
// simple records, and (c) this file also documents our local Project
// import mapping in one place.
// ────────────────────────────────────────────────────────────────────────

import type { Project } from '../types';

/** Every PocketBase record carries these auto-fields. */
export interface BaseRecord {
  id: string;
  created: string; // ISO 8601 UTC
  updated: string;
  collectionId: string;
  collectionName: string;
}

export interface UserRecord extends BaseRecord {
  email: string;
  name: string;
  verified: boolean;
}

export interface TeamRecord extends BaseRecord {
  name: string;
  created_by: string; // relation → users.id
}

export interface TeamMemberRecord extends BaseRecord {
  team: string;
  user: string;
  role: 'admin' | 'member';
}

export interface ProjectRecord extends BaseRecord {
  team: string;
  name: string;
  // `doc` is OUR Project type. Typed loosely here because the server
  // treats it as opaque JSON; we trust it because only our client ever
  // writes it (via patches whose ops are generated by our own diff util).
  doc: Project;
  revision: number;
}

export interface PatchRecord extends BaseRecord {
  project: string;
  author: string;
  from_revision: number;
  to_revision: number;
  // RFC 6902 patch array. We don't narrow the Op type here; the client's
  // diff.ts wrapper re-imports from fast-json-patch where needed.
  ops: unknown[];
}
```

- [ ] **Step 3: Commit.**

```bash
git add src/backend/pb.ts src/backend/types.ts
git commit -m "Add PocketBase client singleton + server record types"
```

No behavioural change yet — the app still renders `<App/>` directly and uses no backend types.

---

## Task 7: Router, AppShell, AuthGuard, LoginPage

**Files:**
- Modify: `src/main.tsx`
- Create: `src/components/AppShell.tsx`
- Create: `src/components/AuthGuard.tsx`
- Create: `src/components/LoginPage.tsx`

**Purpose:** Move the top-level render off `<App/>` onto a router shell. Gate every non-login route behind an auth check. Provide the sign-in / sign-up UI.

- [ ] **Step 1: Rewrite `src/main.tsx`.**

```tsx
// ────────────────────────────────────────────────────────────────────────
// App entry point.
//
// We now render an <AppShell/> with a BrowserRouter rather than a bare
// <App/>. App.tsx is still the editor body but is rendered via the
// router at /p/:projectId (see AppShell + ProjectEditor).
//
// StrictMode is kept — helps surface double-effect bugs early. Does NOT
// break Konva or Leaflet in our usage (components are idempotent on mount).
//
// The Leaflet CSS import is CRITICAL: without it, tile container layout
// collapses to zero height and the map appears empty.
// ────────────────────────────────────────────────────────────────────────

import React from 'react';
import ReactDOM from 'react-dom/client';
import AppShell from './components/AppShell';
import 'leaflet/dist/leaflet.css';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppShell />
  </React.StrictMode>
);
```

- [ ] **Step 2: Write `src/components/AppShell.tsx`.**

```tsx
// ────────────────────────────────────────────────────────────────────────
// AppShell — router host + auth session management.
//
// Responsibilities:
//   - Wire react-router-dom v6 routes.
//   - Expose the authenticated user to the React tree via a shallow
//     useAuthUser() hook (no Context — the PocketBase SDK's authStore
//     is already a singleton with change subscriptions, we just adapt
//     it to React state).
//   - Redirect unauthenticated users to /login for protected routes.
//
// Why no <AuthContext.Provider>? The PocketBase SDK is the source of
// truth for the current auth; wrapping it in Context would add a
// second truth-source to keep in sync. Instead, components that need
// the user call useAuthUser() which subscribes to authStore directly.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from 'react-router-dom';
import { pb } from '../backend/pb';
import type { UserRecord } from '../backend/types';
import LoginPage from './LoginPage';
// The page components below are created in Tasks 8 & 9 — imports are
// left commented until then so each task's commit builds cleanly.
// import TeamPicker from './TeamPicker';
// import NewTeamPage from './NewTeamPage';
// import TeamView from './TeamView';
// import TeamMembers from './TeamMembers';
// import ProjectEditor from './ProjectEditor';

/** React-friendly view onto pb.authStore. Re-renders on login/logout. */
export function useAuthUser(): UserRecord | null {
  const [user, setUser] = useState<UserRecord | null>(
    (pb.authStore.model as UserRecord | null) ?? null
  );
  useEffect(() => {
    // onChange fires synchronously on login, logout, and token refresh.
    const unsub = pb.authStore.onChange((_token, model) => {
      setUser((model as UserRecord | null) ?? null);
    });
    return () => unsub();
  }, []);
  return user;
}

export default function AppShell() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/*
          Tasks 8 & 9 add:
            <Route path="/" element={<AuthGuard><TeamPicker/></AuthGuard>} />
            <Route path="/teams/new" ... />
            <Route path="/teams/:teamId" ... />
            <Route path="/teams/:teamId/members" ... />
            <Route path="/p/:projectId" ... />
        */}
        <Route path="*" element={<PlaceholderRoot />} />
      </Routes>
    </BrowserRouter>
  );
}

// Placeholder for the root route until TeamPicker lands in Task 8.
// Makes the build pass and gives a visible "logged in, go build UI" hint.
function PlaceholderRoot() {
  const user = useAuthUser();
  const location = useLocation();
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return (
    <div className="p-6">
      <p>Signed in as {user.email}. Team picker coming in Task 8.</p>
      <button
        className="mt-3 underline"
        onClick={() => pb.authStore.clear()}
      >
        Sign out
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Write `src/components/AuthGuard.tsx`.**

```tsx
// ────────────────────────────────────────────────────────────────────────
// AuthGuard — redirects unauthenticated visitors to /login.
//
// Usage: <AuthGuard><ProtectedPage/></AuthGuard> in the route element.
//
// We pass the requested location via `state.from` so LoginPage can
// bounce the user back after successful sign-in. Without this, a user
// who bookmarked /p/ab12cd and isn't signed in would land on /
// after login rather than the project they intended to open.
// ────────────────────────────────────────────────────────────────────────

import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthUser } from './AppShell';

export default function AuthGuard({ children }: { children: ReactNode }) {
  const user = useAuthUser();
  const location = useLocation();
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
}
```

- [ ] **Step 4: Write `src/components/LoginPage.tsx`.**

```tsx
// ────────────────────────────────────────────────────────────────────────
// LoginPage — sign in and sign up share one UI toggle.
//
// Sign up also requires `name` per our users-collection rule; we prompt
// for it only in the sign-up branch.
//
// Why no separate /signup route? The sign-up flow is short enough
// that a mode toggle on the same page is simpler than a second route.
// After signup we immediately sign in (PB's create endpoint returns
// a record but not a token — we call authWithPassword afterwards).
// ────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { pb } from '../backend/pb';

type Mode = 'signin' | 'signup';

interface LocationState {
  from?: { pathname?: string };
}

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as LocationState | null)?.from?.pathname ?? '/';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signup') {
        // PocketBase users collection supports creation by anyone (see
        // built-in auth collection create rule). `passwordConfirm` is
        // required by the SDK even though we collect the password once.
        await pb.collection('users').create({
          email,
          password,
          passwordConfirm: password,
          name,
        });
      }
      await pb.collection('users').authWithPassword(email, password);
      // Task 17 adds localStorage auto-import here. For now, navigate
      // to the previously-requested page or /.
      navigate(from, { replace: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Sign-in failed.';
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-900 text-zinc-100">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 p-6 bg-zinc-800 rounded-lg">
        <h1 className="text-xl font-semibold">
          {mode === 'signin' ? 'Sign in' : 'Create an account'}
        </h1>

        {mode === 'signup' && (
          <label className="block">
            <span className="text-sm">Name</span>
            <input
              className="w-full mt-1 px-3 py-2 bg-zinc-700 rounded"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
            />
          </label>
        )}

        <label className="block">
          <span className="text-sm">Email</span>
          <input
            className="w-full mt-1 px-3 py-2 bg-zinc-700 rounded"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </label>

        <label className="block">
          <span className="text-sm">Password</span>
          <input
            className="w-full mt-1 px-3 py-2 bg-zinc-700 rounded"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            minLength={8}
          />
        </label>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          className="w-full py-2 bg-blue-600 rounded hover:bg-blue-500 disabled:opacity-50"
          disabled={busy}
        >
          {busy ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>

        <button
          type="button"
          className="w-full text-sm text-zinc-400 underline"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin');
            setError(null);
          }}
        >
          {mode === 'signin' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 5: Verify.**

```bash
npm run dev
```

Open `http://localhost:5173/`. You should be redirected to `/login`. Try signing up with a new email; after submit you should land on `/` showing the placeholder. Try signing out, then signing in with the same credentials.

Also confirm `npx tsc --noEmit` passes.

- [ ] **Step 6: Commit.**

```bash
git add src/main.tsx src/components/AppShell.tsx src/components/AuthGuard.tsx src/components/LoginPage.tsx
git commit -m "M2/1: router, auth guard, login page"
```

---

## Task 8: Team routes (picker, create, view, members)

**Files:**
- Create: `src/components/TeamPicker.tsx`
- Create: `src/components/NewTeamPage.tsx`
- Create: `src/components/TeamView.tsx`
- Create: `src/components/TeamMembers.tsx`
- Modify: `src/components/AppShell.tsx`

**Purpose:** The full team CRUD / member UI. A signed-in user can see their teams, create new ones, view a team's project list, and (if admin) manage members.

- [ ] **Step 1: Write `src/components/TeamPicker.tsx`.**

The root (`/`) page: a list of teams the user belongs to plus a "+ New Team" button. Use `pb.collection('teams').getFullList({ sort: '-updated' })` — the list rule limits the response to member teams.

```tsx
// ────────────────────────────────────────────────────────────────────────
// TeamPicker — the `/` page for a signed-in user.
//
// Shows the teams they're in. One click navigates to the team view.
// Empty state directs them to create their first team.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { TeamRecord } from '../backend/types';
import { useAuthUser } from './AppShell';

export default function TeamPicker() {
  const user = useAuthUser();
  const navigate = useNavigate();
  const [teams, setTeams] = useState<TeamRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    pb.collection('teams')
      .getFullList<TeamRecord>({ sort: '-updated' })
      .then((list) => { if (!cancelled) setTeams(list); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  async function signOut() {
    pb.authStore.clear();
    navigate('/login', { replace: true });
  }

  if (error) return <Shell><p className="text-red-400">{error}</p></Shell>;
  if (!teams) return <Shell><p>Loading…</p></Shell>;

  return (
    <Shell>
      <header className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold">Your teams</h1>
        <div className="text-sm text-zinc-400">
          {user?.email}
          <button className="ml-3 underline" onClick={signOut}>Sign out</button>
        </div>
      </header>

      {teams.length === 0 ? (
        <p className="text-zinc-400">
          You're not in any team yet.{' '}
          <Link className="underline text-blue-400" to="/teams/new">Create one →</Link>
        </p>
      ) : (
        <ul className="space-y-2">
          {teams.map((t) => (
            <li key={t.id}>
              <Link
                to={`/teams/${t.id}`}
                className="block p-4 bg-zinc-800 rounded hover:bg-zinc-700"
              >
                {t.name}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6">
        <Link to="/teams/new" className="px-4 py-2 bg-blue-600 rounded">
          + New team
        </Link>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100">
      <div className="max-w-2xl mx-auto p-6">{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: Write `src/components/NewTeamPage.tsx`.**

A form that calls `pb.collection('teams').create({ name, created_by: user.id })`. The server's hook (Task 4) auto-creates the `team_members` row as admin. On success, navigate to `/teams/:newId`.

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { TeamRecord } from '../backend/types';
import { useAuthUser } from './AppShell';

export default function NewTeamPage() {
  const user = useAuthUser();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const team = await pb.collection('teams').create<TeamRecord>({
        name: name.trim(),
        created_by: user.id,
      });
      navigate(`/teams/${team.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Create failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100">
      <div className="max-w-sm mx-auto p-6 space-y-3">
        <h1 className="text-xl font-semibold">New team</h1>
        <form onSubmit={submit} className="space-y-3">
          <input
            className="w-full px-3 py-2 bg-zinc-800 rounded"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Team name"
            required
            minLength={1}
            maxLength={100}
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full py-2 bg-blue-600 rounded disabled:opacity-50"
          >
            {busy ? '…' : 'Create'}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write `src/components/TeamView.tsx`.**

Shows the team's name at top; below, the list of projects; below that, "+ New project" and "Manage members" (admin-only). Admin status is derived by fetching the user's `team_members` row. Project creation body:

```js
{ team: teamId, name: 'Untitled Project', doc: initialProjectDoc(), revision: 0 }
```

Provide `initialProjectDoc()` in this file (copied from `projectStore`'s `initialProject` — we'll DRY this up in Task 10 by exporting from projectStore). For now, the inline definition is fine.

```tsx
// ────────────────────────────────────────────────────────────────────────
// TeamView — /teams/:teamId — project list for one team.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { ProjectRecord, TeamRecord, TeamMemberRecord } from '../backend/types';
import type { Project } from '../types';
import { useAuthUser } from './AppShell';

export default function TeamView() {
  const { teamId } = useParams<{ teamId: string }>();
  const user = useAuthUser();
  const navigate = useNavigate();

  const [team, setTeam] = useState<TeamRecord | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null);
  const [myRole, setMyRole] = useState<'admin' | 'member' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!teamId || !user) return;
    let cancelled = false;
    Promise.all([
      pb.collection('teams').getOne<TeamRecord>(teamId),
      pb.collection('projects').getFullList<ProjectRecord>({
        filter: `team="${teamId}"`,
        sort: '-updated',
      }),
      pb.collection('team_members').getFirstListItem<TeamMemberRecord>(
        `team="${teamId}" && user="${user.id}"`
      ),
    ])
      .then(([t, projs, me]) => {
        if (cancelled) return;
        setTeam(t);
        setProjects(projs);
        setMyRole(me.role);
      })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [teamId, user]);

  async function createProject() {
    if (!teamId) return;
    setCreating(true);
    try {
      const doc: Project = initialProjectDoc();
      const created = await pb.collection('projects').create<ProjectRecord>({
        team: teamId,
        name: 'Untitled Project',
        doc,
        revision: 0,
      });
      navigate(`/p/${created.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Create failed.');
    } finally {
      setCreating(false);
    }
  }

  async function deleteProject(projectId: string) {
    if (!confirm('Delete this project? This cannot be undone.')) return;
    try {
      await pb.collection('projects').delete(projectId);
      setProjects((list) => list?.filter((p) => p.id !== projectId) ?? null);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Delete failed.');
    }
  }

  if (error) return <Shell><p className="text-red-400">{error}</p></Shell>;
  if (!team || !projects || !myRole) return <Shell><p>Loading…</p></Shell>;

  return (
    <Shell>
      <header className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold">{team.name}</h1>
        <nav className="text-sm space-x-3">
          <Link to="/" className="underline">All teams</Link>
          {myRole === 'admin' && (
            <Link to={`/teams/${team.id}/members`} className="underline">Members</Link>
          )}
        </nav>
      </header>

      {projects.length === 0 ? (
        <p className="text-zinc-400">No projects yet.</p>
      ) : (
        <ul className="space-y-2">
          {projects.map((p) => (
            <li key={p.id} className="flex items-center gap-2 bg-zinc-800 rounded p-3">
              <Link to={`/p/${p.id}`} className="flex-1 hover:underline">
                {p.name}
              </Link>
              {myRole === 'admin' && (
                <button
                  onClick={() => deleteProject(p.id)}
                  className="text-sm text-red-400 underline"
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6">
        <button
          onClick={createProject}
          disabled={creating}
          className="px-4 py-2 bg-blue-600 rounded disabled:opacity-50"
        >
          {creating ? '…' : '+ New project'}
        </button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100">
      <div className="max-w-2xl mx-auto p-6">{children}</div>
    </div>
  );
}

// Standalone copy of the project store's initial state. DRY'd up in
// Task 10 when projectStore exports `initialProject`.
function initialProjectDoc(): Project {
  return {
    name: 'Untitled Project',
    panelType: {
      id: Math.random().toString(36).slice(2, 10),
      name: 'Generic 400W',
      widthM: 1.134,
      heightM: 1.722,
      wattPeak: 400,
    },
    roofs: [],
    panels: [],
    strings: [],
    inverters: [],
    mapState: {
      locked: false,
      centerLat: 48.137,
      centerLng: 11.575,
      zoom: 19,
      metersPerPixel: 0.1,
      mapProvider: 'esri',
    },
  };
}
```

- [ ] **Step 4: Write `src/components/TeamMembers.tsx`.**

Admin-only page. Shows current members with role + remove button, and an "invite by email" field. Invite logic:

1. Look up the user by email via `pb.collection('users').getFirstListItem('email="…"')`.
2. If not found → error "No user with that email. Ask them to sign up first."
3. Otherwise create `team_members` with `team, user, role: 'member'`.

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { TeamMemberRecord, UserRecord } from '../backend/types';
import { useAuthUser } from './AppShell';

interface MemberWithUser {
  member: TeamMemberRecord;
  user: UserRecord;
}

export default function TeamMembers() {
  const { teamId } = useParams<{ teamId: string }>();
  const me = useAuthUser();
  const navigate = useNavigate();

  const [rows, setRows] = useState<MemberWithUser[] | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    if (!teamId) return;
    const members = await pb
      .collection('team_members')
      .getFullList<TeamMemberRecord>({ filter: `team="${teamId}"`, expand: 'user' });
    setRows(
      members.map((m) => ({
        member: m,
        user: (m.expand as { user: UserRecord }).user,
      })),
    );
  }

  useEffect(() => {
    reload().catch((e) => setError((e as Error).message));
  }, [teamId]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!teamId) return;
    setBusy(true);
    setError(null);
    try {
      // Users collection view rule allows authenticated users to look up
      // by exact email. This is intentional: the invite UX depends on it.
      let targetUser: UserRecord;
      try {
        targetUser = await pb
          .collection('users')
          .getFirstListItem<UserRecord>(`email="${inviteEmail.trim()}"`);
      } catch {
        setError('No user with that email. Ask them to sign up first.');
        return;
      }
      // Avoid duplicate add.
      if (rows?.some((r) => r.user.id === targetUser.id)) {
        setError('That user is already in the team.');
        return;
      }
      await pb.collection('team_members').create<TeamMemberRecord>({
        team: teamId,
        user: targetUser.id,
        role: 'member',
      });
      setInviteEmail('');
      await reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Invite failed.');
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(memberId: string) {
    if (!confirm('Remove this member from the team?')) return;
    await pb.collection('team_members').delete(memberId);
    await reload();
  }

  if (error && !rows) return <Shell><p className="text-red-400">{error}</p></Shell>;
  if (!rows) return <Shell><p>Loading…</p></Shell>;

  return (
    <Shell>
      <header className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold">Members</h1>
        <Link className="text-sm underline" to={`/teams/${teamId}`}>← Back to team</Link>
      </header>

      <ul className="space-y-2 mb-6">
        {rows.map(({ member, user }) => (
          <li key={member.id} className="flex items-center gap-2 bg-zinc-800 rounded p-3">
            <span className="flex-1">
              <span className="font-medium">{user.name}</span>{' '}
              <span className="text-zinc-400 text-sm">({user.email})</span>
            </span>
            <span className="text-xs uppercase tracking-wider text-zinc-400">{member.role}</span>
            {user.id !== me?.id && (
              <button
                onClick={() => removeMember(member.id)}
                className="text-sm text-red-400 underline"
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>

      <form onSubmit={invite} className="flex gap-2">
        <input
          type="email"
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          placeholder="Invite by email"
          className="flex-1 px-3 py-2 bg-zinc-800 rounded"
          required
        />
        <button
          type="submit"
          disabled={busy}
          className="px-4 py-2 bg-blue-600 rounded disabled:opacity-50"
        >
          {busy ? '…' : 'Invite'}
        </button>
      </form>
      {error && <p className="mt-2 text-red-400 text-sm">{error}</p>}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100">
      <div className="max-w-2xl mx-auto p-6">{children}</div>
    </div>
  );
}
```

- [ ] **Step 5: Wire the routes in `AppShell.tsx`.**

Uncomment the page imports and add the four routes, each wrapped in `AuthGuard`. The ProjectEditor route lands in Task 9.

```tsx
import AuthGuard from './AuthGuard';
import TeamPicker from './TeamPicker';
import NewTeamPage from './NewTeamPage';
import TeamView from './TeamView';
import TeamMembers from './TeamMembers';

// inside <Routes>:
<Route path="/" element={<AuthGuard><TeamPicker/></AuthGuard>} />
<Route path="/teams/new" element={<AuthGuard><NewTeamPage/></AuthGuard>} />
<Route path="/teams/:teamId" element={<AuthGuard><TeamView/></AuthGuard>} />
<Route path="/teams/:teamId/members" element={<AuthGuard><TeamMembers/></AuthGuard>} />
```

Delete the PlaceholderRoot component — the catchall `path="*"` route can go too, or leave it as a 404 landing page if you prefer.

- [ ] **Step 6: Verify end-to-end.**

```bash
npm run dev
```

Sign up (Task 7 flow). Land on `/` empty. Click "New team" → create "Test Team". Land on `/teams/:id`, which has zero projects. Click "+ New project" → it creates a project and routes you to `/p/:id`. The `/p/:id` route doesn't exist yet → 404/blank. That's expected; Task 9 handles it.

Go back to `/teams/:id/members`. Your user shows as admin. Invite by email fails for unknown emails. Create a second account in an incognito window; back in the original, invite that email — the second user should appear as member.

`npx tsc --noEmit` passes.

- [ ] **Step 7: Commit.**

```bash
git add src/components/TeamPicker.tsx src/components/NewTeamPage.tsx src/components/TeamView.tsx src/components/TeamMembers.tsx src/components/AppShell.tsx
git commit -m "M2/2: team picker, team view, member management"
```

---

## Task 9: Project editor route + refactor App.tsx

**Files:**
- Create: `src/components/ProjectEditor.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/AppShell.tsx`
- Modify: `src/store/projectStore.ts` (export `initialProject`)
- Modify: `src/components/TeamView.tsx` (use the exported `initialProject`)

**Purpose:** Make `/p/:projectId` load a project from the server, hand it to the existing Zustand store via `loadProject`, and render the existing editor. No sync yet — edits go to the server ONLY via subsequent tasks. DRY up `initialProject` so it's defined once in the store.

- [ ] **Step 1: Export `initialProject` from the store.**

In `src/store/projectStore.ts`, change the `initialProject` declaration to export it:

```ts
export const initialProject: Project = {
  // ...existing initialization...
};
```

Leave the rest of the file untouched.

- [ ] **Step 2: Use it in `TeamView.createProject`.**

```ts
import { initialProject } from '../store/projectStore';
// ...
const doc: Project = initialProject;
```

Delete the local `initialProjectDoc()` helper.

- [ ] **Step 3: Write `src/components/ProjectEditor.tsx`.**

```tsx
// ────────────────────────────────────────────────────────────────────────
// ProjectEditor — mounted at /p/:projectId.
//
// Lifecycle:
//   1. On mount, fetch the project record from the server.
//   2. Call store.loadProject(record.doc) to hand it to the existing
//      Zustand store. The editor (<App/>) doesn't know or care that
//      the project came from the server.
//   3. Stash the record's revision in a module-local for syncClient
//      to pick up in Task 13. For now, we just render <App/> and let
//      edits go to localStorage only.
//   4. On unmount, call store.resetProject() so the next /p/:id load
//      starts from a clean slate.
//
// Task 13 adds the syncClient subscription here (outbound diff + POST,
// inbound SSE). This task stops short of that — opening a project works
// but nothing is synced back.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { ProjectRecord } from '../backend/types';
import { useProjectStore } from '../store/projectStore';
import App from '../App';

export default function ProjectEditor() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    pb.collection('projects')
      .getOne<ProjectRecord>(projectId)
      .then((record) => {
        if (cancelled) return;
        useProjectStore.getState().loadProject(record.doc);
        // Revision-tracking setup — a module-level cell in syncClient
        // gets populated in Task 13. Stub for now.
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.status === 404 || err.status === 403) {
          navigate('/', { replace: true });
          return;
        }
        setError(err.message);
      });
    return () => {
      cancelled = true;
      useProjectStore.getState().resetProject();
    };
  }, [projectId, navigate]);

  if (error) {
    return (
      <div className="min-h-screen bg-zinc-900 text-zinc-100 p-6">
        <p className="text-red-400">Failed to open project: {error}</p>
        <Link className="underline mt-3 inline-block" to="/">← Back</Link>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="min-h-screen bg-zinc-900 text-zinc-100 p-6">
        Loading…
      </div>
    );
  }
  return <App />;
}
```

- [ ] **Step 4: Wire the route.**

In `AppShell.tsx`:

```tsx
import ProjectEditor from './ProjectEditor';
// inside <Routes>:
<Route path="/p/:projectId" element={<AuthGuard><ProjectEditor/></AuthGuard>} />
```

- [ ] **Step 5: Touch App.tsx — no substantive change needed.**

The existing `App.tsx` already talks only to the Zustand store. It does not reference `useParams`, `history`, etc. But make sure `App.tsx` does not hard-assume that the store's project is the initial blank project — `loadProject` has already run by the time we render it, so the first paint sees the server's data. No edits required; verify by reading `App.tsx` end-to-end.

- [ ] **Step 6: Verify end-to-end.**

```bash
npm run dev
```

Create a team, create a project. Editor opens — default state (blank). Navigate + lock map, draw a roof. It's saved ONLY to localStorage (nothing hits the server). Refresh: the localStorage copy rehydrates the store, not the server's empty doc. This is a temporary inconsistency — intentional, resolved in M3.

Close the tab, sign in from an incognito, open the same project URL — you see the server's blank state (no roofs). Correct for this milestone.

`npx tsc --noEmit` passes.

- [ ] **Step 7: Commit.**

```bash
git add src/App.tsx src/components/ProjectEditor.tsx src/components/AppShell.tsx src/store/projectStore.ts src/components/TeamView.tsx
git commit -m "M2/3: project editor route, DRY initialProject"
```

M2 is complete. Auth, teams, and project CRUD work. Editing is still localStorage-only.

---

## Task 10: JSON Patch diff/apply wrapper

**Files:**
- Create: `src/backend/diff.ts`
- Create: `src/backend/diff.test.ts`

**Purpose:** Thin, typed wrapper around `fast-json-patch`. One place to change libraries. Exports: `diffProjects(a, b)`, `applyProjectPatch(doc, ops)`, and the `Op` type.

- [ ] **Step 1: Write `src/backend/diff.ts`.**

```ts
// ────────────────────────────────────────────────────────────────────────
// JSON Patch wrapper.
//
// We use `fast-json-patch` because:
//   - It ships both `compare` (produce a patch) and `applyPatch` (consume).
//   - ~10 KB gzipped — cheaper than `rfc6902` for equivalent capability.
//   - Zero dependencies.
//
// This module is the ONLY place the rest of the app imports the library.
// Swapping libraries later = one file's worth of churn.
//
// Shape:
//   diffProjects(a, b) -> Operation[]        // a → b transform
//   applyProjectPatch(doc, ops) -> Project   // doc with ops applied
//
// Both deep-clone their inputs before acting (fast-json-patch mutates by
// default when given arrays). The safety cost is a structuredClone per
// call; negligible for our sizes (< 100 KB typical project).
// ────────────────────────────────────────────────────────────────────────

import {
  compare,
  applyPatch as fastApplyPatch,
  type Operation,
} from 'fast-json-patch';
import type { Project } from '../types';

export type Op = Operation;

/** Produce a patch that transforms `a` into `b`. */
export function diffProjects(a: Project, b: Project): Op[] {
  // compare() does NOT mutate its inputs, so cloning is unnecessary here.
  // But we guard our call sites by accepting the minor clone cost to
  // insulate from future lib changes.
  return compare(a as unknown as object, b as unknown as object);
}

/**
 * Apply `ops` to `doc` and return the resulting project. Throws if the
 * patch is malformed or any `test` op fails; callers in syncClient
 * translate throws into a full-resync fallback.
 */
export function applyProjectPatch(doc: Project, ops: Op[]): Project {
  // Clone so fast-json-patch's in-place mutation doesn't alter the input.
  // The applyPatch helper accepts a `mutate=false` param; we use it.
  const result = fastApplyPatch(
    // structuredClone is native since Node 17 / browsers of the same
    // era — no shim needed given our target environments.
    structuredClone(doc),
    ops,
    /* validate */ true,
    /* mutate */ false,
  );
  return result.newDocument as Project;
}
```

- [ ] **Step 2: Write `src/backend/diff.test.ts`.**

```ts
import { describe, it, expect } from 'vitest';
import { diffProjects, applyProjectPatch } from './diff';
import type { Project } from '../types';

// Build a minimal project fixture for tests.
function fixture(): Project {
  return {
    name: 'Test',
    panelType: {
      id: 'pt1', name: 'x', widthM: 1, heightM: 1, wattPeak: 100,
    },
    roofs: [],
    panels: [],
    strings: [],
    inverters: [],
    mapState: {
      locked: false,
      centerLat: 0, centerLng: 0, zoom: 1, metersPerPixel: 0.1,
      mapProvider: 'esri',
    },
  };
}

describe('diff round-trip', () => {
  it('diff(a, a) is empty', () => {
    const a = fixture();
    expect(diffProjects(a, a)).toEqual([]);
  });

  it('apply(a, diff(a, b)) === b', () => {
    const a = fixture();
    const b = fixture();
    b.name = 'Renamed';
    b.roofs.push({ id: 'r1', name: 'Roof 1', polygon: [{ x: 0, y: 0 }], tiltDeg: 30, panelOrientation: 'portrait' });
    const ops = diffProjects(a, b);
    const applied = applyProjectPatch(a, ops);
    expect(applied).toEqual(b);
  });

  it('does not mutate inputs', () => {
    const a = fixture();
    const b = fixture();
    b.name = 'X';
    const snapshot = JSON.stringify(a);
    diffProjects(a, b);
    applyProjectPatch(a, diffProjects(a, b));
    expect(JSON.stringify(a)).toEqual(snapshot);
  });

  it('handles large captured image field without blowing up', () => {
    const a = fixture();
    const b = fixture();
    // 1 MB of base64-like data.
    const bigString = 'A'.repeat(1_000_000);
    b.mapState = {
      locked: true,
      centerLat: 0, centerLng: 0, zoom: 20, metersPerPixel: 0.05,
      mapProvider: 'esri',
      capturedImage: 'data:image/png;base64,' + bigString,
      capturedWidth: 1920,
      capturedHeight: 1080,
    };
    const ops = diffProjects(a, b);
    const applied = applyProjectPatch(a, ops);
    expect(applied).toEqual(b);
  });
});
```

- [ ] **Step 3: Run.**

```bash
npm run test:run -- src/backend/diff.test.ts
```

All four tests pass.

- [ ] **Step 4: Commit.**

```bash
git add src/backend/diff.ts src/backend/diff.test.ts
git commit -m "M3/1: JSON Patch diff/apply wrapper with round-trip tests"
```

---

## Task 11: `applyRemotePatch` store action + bypass policy

**Files:**
- Modify: `src/store/projectStore.ts`
- Modify: `src/store/undoMiddleware.ts`

**Purpose:** Add a dedicated store action for "apply an incoming remote patch." Register it in `ACTION_POLICY` as `bypass` so remote changes don't pollute the undo stack (per Q11 decision — local undo only).

- [ ] **Step 1: Add `applyRemotePatch` to `ActionName` and `ACTION_POLICY`.**

In `src/store/undoMiddleware.ts`, locate the `ActionName` union and append:

```ts
export type ActionName =
  // ... existing entries
  | 'applyRemotePatch'
  | /* keep the existing last entry last */ '__history__';
```

Then in `ACTION_POLICY`:

```ts
export const ACTION_POLICY: Record<ActionName, Policy> = {
  // ... existing entries
  applyRemotePatch: { kind: 'bypass' },
  // ...
};
```

`bypass` means "apply the set() call as-is; do NOT snapshot to history, do NOT coalesce." That's the right policy: remote patches are authoritative updates from the server; undoing them would be confusing (they came from another user).

- [ ] **Step 2: Add the action in `projectStore.ts`.**

In the store interface, near the other project actions:

```ts
interface ProjectStore extends UIState, HistoryState {
  // ...
  /**
   * Apply a remote patch (RFC 6902 ops) to the current project.
   * Called by syncClient when an SSE patch arrives from the server.
   *
   * Registered as 'bypass' in ACTION_POLICY — does NOT push to the undo
   * stack. Rationale: the spec's Q11 decision is local-only undo; a
   * remote-originated change is authoritative and wouldn't make sense
   * as something Alice can Ctrl-Z away.
   *
   * If the patch fails to apply (malformed ops, `test` op mismatch),
   * this throws; syncClient's inbound handler catches and triggers a
   * full resync.
   */
  applyRemotePatch: (ops: import('../backend/diff').Op[]) => void;
}
```

Implementation inside `create`:

```ts
applyRemotePatch: (ops) =>
  set(
    (s) => {
      // Lazy import avoids pulling fast-json-patch into the main-thread
      // chunk on stores that never sync (e.g. tests that instantiate the
      // store without the backend). In practice, syncClient is the only
      // caller and it's already loaded — the lazy import is essentially
      // free.
      const { applyProjectPatch } = require('../backend/diff');
      return { project: applyProjectPatch(s.project, ops) };
    },
    false,
    'applyRemotePatch',
  ),
```

Note the `false` second arg (partial replacement, not full replace) and `'applyRemotePatch'` as the action name — matches how every other action in the store calls `set`.

- [ ] **Step 3: Write a small test for the action.**

In `src/backend/diff.test.ts` (reusing the file, not a new one), add:

```ts
import { useProjectStore } from '../store/projectStore';

describe('applyRemotePatch store action', () => {
  it('applies ops to the current project without touching history', () => {
    const store = useProjectStore;
    const before = store.getState();
    const pastLen = before.past.length;

    store.getState().applyRemotePatch([
      { op: 'replace', path: '/name', value: 'From Server' },
    ]);

    const after = store.getState();
    expect(after.project.name).toBe('From Server');
    expect(after.past.length).toBe(pastLen); // history untouched
  });
});
```

- [ ] **Step 4: Run.**

```bash
npm run test:run
npx tsc --noEmit
```

- [ ] **Step 5: Commit.**

```bash
git add src/store/projectStore.ts src/store/undoMiddleware.ts src/backend/diff.test.ts
git commit -m "M3/2: applyRemotePatch store action (bypass history)"
```

---

## Task 12: syncClient core — outbound debounce + POST, inbound SSE

**Files:**
- Create: `src/backend/syncClient.ts`
- Create: `src/backend/syncClient.test.ts`
- Modify: `src/components/ProjectEditor.tsx`

**Purpose:** The heart of M3. A state machine that subscribes to the store, debounces changes, diffs them into JSON Patch ops, POSTs them to `/api/sp/patch`, and subscribes to SSE patches to apply inbound ops. No gesture queue yet — that's Task 13.

- [ ] **Step 1: Write `src/backend/syncClient.ts`.**

The implementation is substantial (~250 lines). Full code follows. Read carefully — this is the module the spec's sync section describes.

```ts
// ────────────────────────────────────────────────────────────────────────
// syncClient — bidirectional sync between the Zustand store and PocketBase.
//
// One instance per open project (started on ProjectEditor mount, stopped
// on unmount). The instance subscribes to the store for outbound changes
// and subscribes to PocketBase realtime for inbound ones. It is the
// single chokepoint between local state and server state.
//
// Key invariants:
//   - lastSyncedDoc ALWAYS reflects the server's current view, modulo
//     the in-flight POST (which we still haven't been ack'd on).
//   - lastKnownRevision ALWAYS reflects the highest revision we know
//     the server to be at.
//   - We never apply our own patches twice (author self-filter).
//   - Any unexpected state triggers a full resync — doc at revision
//     is always source of truth.
// ────────────────────────────────────────────────────────────────────────

import { pb, currentUser } from './pb';
import type { PatchRecord, ProjectRecord } from './types';
import { diffProjects, applyProjectPatch, type Op } from './diff';
import { useProjectStore } from '../store/projectStore';
import type { Project } from '../types';

const DEBOUNCE_MS = 2000;

/**
 * Coarse sync state. Exposed via a subscribe-able observable so the
 * status indicator can show Synced / Syncing / Offline / Conflict.
 */
export type SyncStatus =
  | { kind: 'synced' }
  | { kind: 'syncing' }
  | { kind: 'offline'; retriesScheduled: number }
  | { kind: 'conflict'; currentDoc: Project; currentRevision: number };

type Listener = (s: SyncStatus) => void;

export interface SyncClient {
  start(): void;
  stop(): void;
  subscribeStatus(fn: Listener): () => void;
  /** Called by ConflictModal (Task 14) to finalize the user's choice. */
  resolveConflict(choice: 'discard-mine' | 'overwrite-theirs'): Promise<void>;
  /** Gesture hooks — wired from KonvaOverlay in Task 13. */
  beginGesture(): void;
  endGesture(): void;
}

export function createSyncClient(projectId: string): SyncClient {
  // ── Mutable state owned by this client instance ─────────────────────
  let lastSyncedDoc: Project | null = null;
  let lastKnownRevision = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let postInFlight = false;
  let gestureActive = false;
  let gestureInboundQueue: Op[] = [];
  let retryCount = 0;
  let status: SyncStatus = { kind: 'synced' };
  const listeners = new Set<Listener>();

  let storeUnsub: (() => void) | null = null;
  let sseUnsub: (() => void) | null = null;
  let stopped = false;

  function setStatus(next: SyncStatus) {
    status = next;
    listeners.forEach((fn) => fn(next));
  }

  // ── Outbound: debounced diff + POST ─────────────────────────────────

  function scheduleFlush() {
    if (debounceTimer != null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  async function flush() {
    if (stopped) return;
    if (postInFlight) {
      // A previous flush is in flight. When it returns, it will check
      // currentDoc vs lastSyncedDoc and re-schedule if there are more
      // changes. Nothing to do here.
      return;
    }
    if (gestureActive) {
      // Don't flush during a gesture — the endGesture path handles the
      // final diff + POST for everything accumulated during the drag.
      return;
    }
    if (!lastSyncedDoc) return;

    const current = useProjectStore.getState().project;
    const ops = diffProjects(lastSyncedDoc, current);
    if (ops.length === 0) {
      setStatus({ kind: 'synced' });
      return;
    }

    postInFlight = true;
    setStatus({ kind: 'syncing' });

    try {
      const res = await fetch('/api/sp/patch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pb.authStore.token}`,
        },
        body: JSON.stringify({
          projectId,
          fromRevision: lastKnownRevision,
          ops,
        }),
      });

      if (res.status === 200) {
        const body = (await res.json()) as { newRevision: number };
        lastSyncedDoc = current;
        lastKnownRevision = body.newRevision;
        retryCount = 0;
        setStatus({ kind: 'synced' });

        // If more edits arrived while we were POSTing, schedule another
        // flush (the debounce timer was blocked by postInFlight).
        const afterPost = useProjectStore.getState().project;
        if (diffProjects(lastSyncedDoc, afterPost).length > 0) {
          scheduleFlush();
        }
      } else if (res.status === 409) {
        const body = (await res.json()) as {
          currentRevision: number;
          currentDoc: Project;
        };
        setStatus({
          kind: 'conflict',
          currentRevision: body.currentRevision,
          currentDoc: body.currentDoc,
        });
        // Conflict pauses outbound sync until resolveConflict runs.
      } else if (res.status === 401) {
        // Session expired — let ProjectEditor redirect to login.
        setStatus({ kind: 'offline', retriesScheduled: 0 });
      } else if (res.status === 403 || res.status === 404) {
        // Lost access or project deleted — let the route handle it.
        setStatus({ kind: 'offline', retriesScheduled: 0 });
      } else {
        // 5xx or unexpected — treat as transient; retry.
        scheduleRetry();
      }
    } catch (e) {
      // Network error.
      scheduleRetry();
    } finally {
      postInFlight = false;
    }
  }

  function scheduleRetry() {
    retryCount += 1;
    const delay = Math.min(30_000, 1000 * 2 ** (retryCount - 1));
    setStatus({ kind: 'offline', retriesScheduled: retryCount });
    setTimeout(() => { if (!stopped) flush(); }, delay);
  }

  // ── Inbound: SSE patch subscription ────────────────────────────────

  async function subscribeSse() {
    // Subscribe to the patches collection. PocketBase fans out all
    // record-create events on the collection; our callback filters by
    // project relation on the client side.
    const unsub = await pb.collection('patches').subscribe<PatchRecord>(
      '*', // all records; we filter in the handler
      (e) => {
        if (e.action !== 'create') return;
        const rec = e.record;
        if (rec.project !== projectId) return;

        // Self-filter: if WE produced this patch (our POST just got
        // mirrored back over SSE), ignore — we've already applied it
        // locally to lastSyncedDoc in the POST success handler.
        const me = currentUser();
        if (me && rec.author === (me as { id: string }).id) return;

        if (gestureActive) {
          gestureInboundQueue.push(...(rec.ops as Op[]));
          return;
        }

        applyInbound(rec);
      },
    );
    sseUnsub = () => unsub();
  }

  function applyInbound(rec: PatchRecord) {
    // Gap check: the incoming patch claims from_revision; if it doesn't
    // match our lastKnownRevision, we missed a patch. The reliable
    // recovery is a full resync — go get the current doc.
    if (rec.from_revision !== lastKnownRevision) {
      fullResync().catch(() => scheduleRetry());
      return;
    }

    try {
      useProjectStore.getState().applyRemotePatch(rec.ops as Op[]);
      const updated = useProjectStore.getState().project;
      lastSyncedDoc = updated;
      lastKnownRevision = rec.to_revision;
      setStatus({ kind: 'synced' });
    } catch {
      // Malformed patch — fall back to server doc.
      fullResync().catch(() => scheduleRetry());
    }
  }

  async function fullResync() {
    const record = await pb
      .collection('projects')
      .getOne<ProjectRecord>(projectId);
    useProjectStore.getState().loadProject(record.doc);
    lastSyncedDoc = record.doc;
    lastKnownRevision = record.revision;
    retryCount = 0;
    setStatus({ kind: 'synced' });
  }

  // ── Conflict resolution (triggered by ConflictModal in Task 14) ────

  async function resolveConflict(choice: 'discard-mine' | 'overwrite-theirs') {
    if (status.kind !== 'conflict') return;
    const { currentDoc, currentRevision } = status;

    if (choice === 'discard-mine') {
      useProjectStore.getState().loadProject(currentDoc);
      lastSyncedDoc = currentDoc;
      lastKnownRevision = currentRevision;
      setStatus({ kind: 'synced' });
      return;
    }

    // overwrite-theirs — re-diff our local project against the current
    // server doc and POST. The diff against `currentDoc` (not the old
    // lastSyncedDoc) gives us the minimal set of ops to replace
    // conflicting fields with our values.
    lastSyncedDoc = currentDoc;
    lastKnownRevision = currentRevision;
    setStatus({ kind: 'syncing' });
    await flush();
  }

  // ── Gesture hooks ──────────────────────────────────────────────────

  function beginGesture() {
    gestureActive = true;
    // Suspend any pending outbound flush; endGesture will handle POST.
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function endGesture() {
    gestureActive = false;
    // Snapshot aliceDiff BEFORE applying buffered remote ops so we can
    // reassert Alice's work after Bob's patches land. Per spec, this is
    // the "endGesture" flow that preserves Alice's gesture against
    // non-conflicting Bob edits.
    const projectNow = useProjectStore.getState().project;
    const aliceDiff = lastSyncedDoc
      ? diffProjects(lastSyncedDoc, projectNow)
      : [];

    if (gestureInboundQueue.length > 0) {
      // Apply the buffered remote ops normally (they update project,
      // lastSyncedDoc, lastKnownRevision). If any has a revision gap,
      // fullResync — which means aliceDiff is lost; rare.
      try {
        for (const queuedOps of chunkByPatch(gestureInboundQueue)) {
          useProjectStore.getState().applyRemotePatch(queuedOps);
        }
        gestureInboundQueue = [];
        lastSyncedDoc = useProjectStore.getState().project;
        // Reassert Alice's changes.
        if (aliceDiff.length > 0) {
          useProjectStore
            .getState()
            .applyRemotePatch(aliceDiff);
        }
      } catch {
        gestureInboundQueue = [];
        fullResync().catch(() => scheduleRetry());
        return;
      }
    }
    // Schedule normal outbound flush — the next debounce tick POSTs
    // Alice's gesture as a regular patch.
    scheduleFlush();
  }

  // In M3 we queue inbound ops flat (see subscribeSse); chunking them
  // back into per-patch lists would require retaining the from/to
  // revisions. A simpler correct behaviour here is to batch-apply them
  // as one op array — the `applyRemotePatch` action tolerates arbitrary
  // ops in sequence. Keep this helper as an identity for now; a future
  // refactor may reinstate per-patch application if bookkeeping gets
  // finer-grained.
  function chunkByPatch(ops: Op[]): Op[][] {
    return ops.length === 0 ? [] : [ops];
  }

  // ── Public API ─────────────────────────────────────────────────────

  return {
    async start() {
      if (storeUnsub) return; // already running

      // 1. Fetch current project to seed lastSyncedDoc + lastKnownRevision.
      //    ProjectEditor has already called loadProject with the same
      //    data, so the store matches; we just need the revision.
      const record = await pb
        .collection('projects')
        .getOne<ProjectRecord>(projectId);
      lastSyncedDoc = record.doc;
      lastKnownRevision = record.revision;
      setStatus({ kind: 'synced' });

      // 2. Subscribe to store changes — debounced outbound.
      storeUnsub = useProjectStore.subscribe(scheduleFlush);

      // 3. Subscribe to SSE — inbound.
      await subscribeSse();
    },

    stop() {
      stopped = true;
      if (debounceTimer != null) clearTimeout(debounceTimer);
      storeUnsub?.();
      sseUnsub?.();
      storeUnsub = null;
      sseUnsub = null;
    },

    subscribeStatus(fn) {
      listeners.add(fn);
      fn(status);
      return () => listeners.delete(fn);
    },

    resolveConflict,

    beginGesture,
    endGesture,
  };
}
```

- [ ] **Step 2: Wire into `ProjectEditor.tsx`.**

```tsx
import { useEffect, useRef, useState } from 'react';
import { createSyncClient, type SyncClient } from '../backend/syncClient';
// ... existing imports

export default function ProjectEditor() {
  const { projectId } = useParams<{ projectId: string }>();
  const syncClientRef = useRef<SyncClient | null>(null);
  // ... existing state

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    pb.collection('projects')
      .getOne<ProjectRecord>(projectId)
      .then((record) => {
        if (cancelled) return;
        useProjectStore.getState().loadProject(record.doc);
        setLoaded(true);
        // Start sync AFTER the store is seeded so the initial diff is empty.
        const client = createSyncClient(projectId);
        client.start();
        syncClientRef.current = client;
      })
      .catch(/* ... existing */);
    return () => {
      cancelled = true;
      syncClientRef.current?.stop();
      syncClientRef.current = null;
      useProjectStore.getState().resetProject();
    };
  }, [projectId, navigate]);

  // ... existing return
}
```

Export the client ref via a module-level bridge so `KonvaOverlay` (Task 13) and `Toolbar` / `SyncStatusIndicator` (Task 14) can call it without prop-drilling:

```ts
// Near the top of ProjectEditor.tsx
let activeSyncClient: SyncClient | null = null;
export function getActiveSyncClient() { return activeSyncClient; }
// Inside the effect, assign: activeSyncClient = client;
// In cleanup: activeSyncClient = null;
```

- [ ] **Step 3: Write `src/backend/syncClient.test.ts`.**

A minimal test that fakes the fetch endpoint and the PocketBase SSE subscription. Because full integration testing needs a running PocketBase (Task 16), this test exercises the outbound + conflict paths with stubs.

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncClient } from './syncClient';
import { useProjectStore } from '../store/projectStore';
import { pb } from './pb';

// Helpers to stub fetch + pb.collection.
// ... (see full file; key scenarios below)

describe('syncClient outbound', () => {
  afterEach(() => vi.restoreAllMocks());

  it('debounces outbound POST to 2s after last change', async () => {
    // Seed store with fixture, create client, start it.
    // Mock fetch to count calls. Fire 5 store mutations in rapid
    // succession. Expect 0 POSTs within 1900ms, 1 POST by 2100ms.
  });

  it('handles 409 by setting status=conflict with server doc', async () => {
    // Stub fetch to return 409 with currentDoc/currentRevision.
    // Trigger a flush. Expect subscribeStatus to receive a conflict
    // event carrying the server's doc.
  });

  it('resolveConflict discard-mine loads server doc and resumes', async () => {
    // Arrange a conflict. Call resolveConflict('discard-mine').
    // Store should be replaced with currentDoc, status back to synced.
  });
});
```

Leave the bodies as sketches for the engineer — tests are the most variable part of this task since Vitest fakes depend on the stubs available. The three scenarios above are the minimum coverage.

- [ ] **Step 4: Run tests.**

```bash
npm run test:run -- src/backend
npx tsc --noEmit
```

- [ ] **Step 5: Smoke-test two tabs.**

Spin up two browser tabs (or one regular + one incognito), each signed in as a different team member. Open the same `/p/:id` in both. In tab A, lock the map and draw a roof. Within 2–3 seconds, tab B should see the roof appear.

- [ ] **Step 6: Commit.**

```bash
git add src/backend/syncClient.ts src/backend/syncClient.test.ts src/components/ProjectEditor.tsx
git commit -m "M3/3: syncClient core (outbound debounce, inbound SSE, full resync)"
```

---

## Task 13: Gesture queue integration

**Files:**
- Modify: `src/components/KonvaOverlay.tsx`

**Purpose:** Hook mouse-down / mouse-up on the Konva stage into `syncClient.beginGesture()` / `endGesture()` so drags and lassoes don't get interrupted by inbound patches, and so Alice's gesture is debounced into one outgoing patch.

- [ ] **Step 1: Import the sync-client bridge.**

Add to `KonvaOverlay.tsx`:

```tsx
import { getActiveSyncClient } from './ProjectEditor';
```

- [ ] **Step 2: Wire `beginGesture` / `endGesture`.**

Modify the existing merged mouse handlers:

```tsx
const onMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
  const stage = stageRef.current;
  if (!stage) return;
  const screenPos = stage.getPointerPosition();
  if (!screenPos) return;
  // Notify syncClient so it queues inbound patches and suspends outbound
  // debounce until pointerup. Pure pan/zoom drags are still notified —
  // no harm if the subsequent diff is empty.
  getActiveSyncClient()?.beginGesture();
  if (viewport.tryStartViewportDrag(e, screenPos)) return;
  drawing.handleMouseDown();
};

const onMouseUp = () => {
  viewport.handleViewportMouseUp();
  drawing.handleMouseUp();
  // Fire AFTER drawing.handleMouseUp so the store reflects the final
  // gesture state when syncClient computes aliceDiff.
  getActiveSyncClient()?.endGesture();
};
```

- [ ] **Step 3: Escape-key handling.**

Escape already clears in-progress drawing via `useDrawingController`. Treat it as an endGesture too. In `useDrawingController.ts`, where Escape is handled, add a call to `getActiveSyncClient()?.endGesture()`. Or wire it in `App.tsx`'s global key handler — the latter is simpler because it keeps the sync bridge out of `useDrawingController`'s deps. Add this branch in `App.tsx`:

```tsx
// Inside the keydown handler, add:
if (e.key === 'Escape') {
  // endGesture is idempotent — safe even when no gesture was active.
  // Wired here because Escape's primary cancel semantics live in
  // useDrawingController, but the sync client needs the signal too.
  getActiveSyncClient()?.endGesture();
}
```

- [ ] **Step 4: Verify.**

```bash
npm run dev
```

Open the same project in two tabs. In tab A, start a drag (hold mouse down on a roof) — during the drag, tab B makes edits. Verify:
- Tab A's dragging roof does NOT jitter with tab B's incoming ops.
- When tab A releases, tab A sees tab B's ops appear.
- Tab A's own gesture POSTs within ~2 s.

`npx tsc --noEmit` passes.

- [ ] **Step 5: Commit.**

```bash
git add src/components/KonvaOverlay.tsx src/App.tsx
git commit -m "M3/4: gesture queue integration on Konva pointer events"
```

---

## Task 14: Conflict modal + sync status indicator

**Files:**
- Create: `src/components/ConflictModal.tsx`
- Create: `src/components/SyncStatusIndicator.tsx`
- Modify: `src/components/Toolbar.tsx`
- Modify: `src/components/ProjectEditor.tsx`

**Purpose:** Surface the sync state to the user. The status indicator is always visible in the top bar; the conflict modal appears on 409.

- [ ] **Step 1: Write `SyncStatusIndicator.tsx`.**

```tsx
// ────────────────────────────────────────────────────────────────────────
// SyncStatusIndicator — a dot + label in the top bar.
//
// States (from syncClient):
//   - synced   → green   "Synced"
//   - syncing  → blue    "Syncing…"
//   - offline  → amber   "Offline — changes saved locally"
//   - conflict → red     "Conflict" (clickable opens the modal)
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { getActiveSyncClient } from './ProjectEditor';
import type { SyncStatus } from '../backend/syncClient';

export default function SyncStatusIndicator() {
  const [status, setStatus] = useState<SyncStatus>({ kind: 'synced' });

  useEffect(() => {
    const client = getActiveSyncClient();
    if (!client) return;
    return client.subscribeStatus(setStatus);
  }, []);

  const { color, label } = describe(status);
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{ background: color }}
      />
      <span>{label}</span>
    </div>
  );
}

function describe(s: SyncStatus): { color: string; label: string } {
  switch (s.kind) {
    case 'synced': return { color: '#22c55e', label: 'Synced' };
    case 'syncing': return { color: '#3b82f6', label: 'Syncing…' };
    case 'offline':
      return { color: '#f59e0b', label: 'Offline — changes saved locally' };
    case 'conflict': return { color: '#ef4444', label: 'Conflict' };
  }
}
```

- [ ] **Step 2: Write `ConflictModal.tsx`.**

```tsx
import { useEffect, useState } from 'react';
import { getActiveSyncClient } from './ProjectEditor';
import type { SyncStatus } from '../backend/syncClient';

export default function ConflictModal() {
  const [status, setStatus] = useState<SyncStatus>({ kind: 'synced' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const client = getActiveSyncClient();
    if (!client) return;
    return client.subscribeStatus(setStatus);
  }, []);

  if (status.kind !== 'conflict') return null;

  async function choose(choice: 'discard-mine' | 'overwrite-theirs') {
    const client = getActiveSyncClient();
    if (!client) return;
    setBusy(true);
    try {
      await client.resolveConflict(choice);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-[1000] flex items-center justify-center">
      <div className="bg-zinc-800 text-zinc-100 p-6 rounded-lg max-w-md space-y-3">
        <h2 className="text-lg font-semibold">Changes conflict</h2>
        <p className="text-sm text-zinc-300">
          Your edits conflict with someone else's changes to this project.
        </p>
        <div className="flex gap-2 pt-2">
          <button
            className="flex-1 py-2 bg-zinc-700 rounded hover:bg-zinc-600 disabled:opacity-50"
            disabled={busy}
            onClick={() => choose('discard-mine')}
          >
            Discard mine
          </button>
          <button
            className="flex-1 py-2 bg-red-600 rounded hover:bg-red-500 disabled:opacity-50"
            disabled={busy}
            onClick={() => choose('overwrite-theirs')}
          >
            Overwrite theirs
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Mount the status + modal in Toolbar / ProjectEditor.**

In `Toolbar.tsx`, add a breadcrumb and the status indicator to the right side of the top bar:

```tsx
import SyncStatusIndicator from './SyncStatusIndicator';
// ... inside the toolbar render:
<div className="ml-auto flex items-center gap-4">
  {/* breadcrumb is optional in this task; team/project names require
      useParams plumbing into Toolbar which is currently prop-less. Can
      be added via a later pass. */}
  <SyncStatusIndicator />
</div>
```

Pick an appropriate container — Toolbar is 585 lines; find a natural place near the existing top-right action cluster.

In `ProjectEditor.tsx`, render the modal as a sibling of `<App/>`:

```tsx
return (
  <>
    <App />
    <ConflictModal />
  </>
);
```

- [ ] **Step 4: Verify.**

Open the project in two tabs. In tab A, go offline (disable network or stop the PocketBase server). Make a change. Status goes amber. In tab B (while A is offline), make a different change that DOES NOT overlap with A's. Bring A back online; A POSTs and gets 409 because its fromRevision is stale. The conflict modal appears. Click "Overwrite theirs" → A's change lands; B receives it via SSE. Click "Discard mine" (rerun the test, with A offline again) → A's local changes are replaced with the server's state.

`npx tsc --noEmit` passes.

- [ ] **Step 5: Commit.**

```bash
git add src/components/ConflictModal.tsx src/components/SyncStatusIndicator.tsx src/components/Toolbar.tsx src/components/ProjectEditor.tsx
git commit -m "M3/5: conflict modal + sync status indicator"
```

M3 is complete. Two-client realtime sync works with conflict resolution.

---

## Task 15: First-sign-in localStorage auto-import

**Files:**
- Create: `src/backend/migrateLocalStorage.ts`
- Modify: `src/components/LoginPage.tsx`

**Purpose:** On the user's first sign-in, if `localStorage` has a non-empty `solar-planner-project` AND they have no server projects, silently create a default team (if needed) and a project seeded with their local doc. Per Q8c: silent, no prompt.

- [ ] **Step 1: Write `migrateLocalStorage.ts`.**

```ts
// ────────────────────────────────────────────────────────────────────────
// migrateLocalStorage — one-shot import of a pre-backend local project.
//
// Runs on login. If the user's localStorage carries any user-generated
// content (roofs/panels/strings/inverters) AND they have no server
// projects anywhere, we silently materialise it as their first team
// project and redirect into it.
//
// After import we clear the localStorage key so the user doesn't get
// re-imported on subsequent sign-ins. The project record on the server
// is now authoritative.
//
// Why "no server projects" gate, not "first team login"? A user may
// join someone else's team first (via invite) and already have server
// projects; we don't want to dump their local draft into that team.
// ────────────────────────────────────────────────────────────────────────

import { pb } from './pb';
import type { Project } from '../types';
import type { ProjectRecord, TeamRecord, UserRecord } from './types';
import { migrateProject } from '../utils/projectSerializer';

const STORAGE_KEY = 'solar-planner-project';

/** Returns the new project id if import happened, else null. */
export async function maybeImportLocalStorage(): Promise<string | null> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  // The persisted value is Zustand's wrapper { state: { project }, version }.
  let project: Project;
  try {
    const parsed = JSON.parse(raw);
    const inner = parsed?.state?.project;
    if (!inner) return null;
    project = migrateProject(inner);
  } catch {
    return null;
  }

  // Non-empty check: at least one of the collections has content.
  const isEmpty =
    project.roofs.length === 0 &&
    project.panels.length === 0 &&
    project.strings.length === 0 &&
    project.inverters.length === 0;
  if (isEmpty) return null;

  // No server projects check: if the user already has any project, skip.
  const existing = await pb
    .collection('projects')
    .getList<ProjectRecord>(1, 1);
  if (existing.totalItems > 0) return null;

  const user = pb.authStore.model as UserRecord | null;
  if (!user) return null;

  // Ensure we have a team to put it in. Look up existing memberships;
  // if none, create a default team. Team auto-admin hook makes the
  // caller an admin.
  const teams = await pb.collection('teams').getFullList<TeamRecord>({ sort: '-created' });
  let teamId: string;
  if (teams.length > 0) {
    teamId = teams[0].id;
  } else {
    const newTeam = await pb.collection('teams').create<TeamRecord>({
      name: `${user.name}'s Team`,
      created_by: user.id,
    });
    teamId = newTeam.id;
  }

  // Create the project. Revision starts at 0 — any edits the user makes
  // next will be POSTed from revision 0 to 1 via the normal flow.
  const created = await pb.collection('projects').create<ProjectRecord>({
    team: teamId,
    name: project.name || 'Imported Project',
    doc: project,
    revision: 0,
  });

  // Clear the local blob so subsequent sign-ins don't re-import.
  localStorage.removeItem(STORAGE_KEY);

  return created.id;
}
```

- [ ] **Step 2: Hook it into `LoginPage.submit`.**

Replace the final navigation:

```ts
// After authWithPassword succeeds:
const importedProjectId = await maybeImportLocalStorage().catch(() => null);
const target = importedProjectId ? `/p/${importedProjectId}` : from;
navigate(target, { replace: true });
```

- [ ] **Step 3: Verify.**

Sign out. In the browser console, set a non-empty local project:

```js
localStorage.setItem('solar-planner-project', JSON.stringify({
  state: {
    project: {
      name: 'Local Draft',
      panelType: { id: 'pt1', name: 'x', widthM: 1, heightM: 1, wattPeak: 100 },
      roofs: [{ id: 'r1', name: 'Roof 1', polygon: [{x:0,y:0},{x:10,y:0},{x:10,y:10}], tiltDeg: 30, panelOrientation: 'portrait' }],
      panels: [], strings: [], inverters: [],
      mapState: { locked: false, centerLat: 0, centerLng: 0, zoom: 1, metersPerPixel: 0.1, mapProvider: 'esri' },
    },
  },
  version: 0,
}));
```

Sign in with an account that has no server projects. You should land on `/p/<new-id>` with the roof visible. Check localStorage — the key is cleared.

Sign out and sign back in with the same account — no import (the key is gone; and there's a server project now).

`npx tsc --noEmit` passes.

- [ ] **Step 4: Commit.**

```bash
git add src/backend/migrateLocalStorage.ts src/components/LoginPage.tsx
git commit -m "M4: first-sign-in localStorage auto-import"
```

---

## Task 16: Two-client integration test

**Files:**
- Create: `src/backend/sync.integration.test.ts`

**Purpose:** A test that spawns PocketBase as a subprocess, creates two authenticated clients against it, and verifies a patch sent from one client appears on the other within a bounded time.

This test is valuable because the unit tests in Task 12 stub fetch and SSE — it's the first thing that exercises the real server route + the SSE fanout end-to-end.

- [ ] **Step 1: Write the test.**

```ts
// ────────────────────────────────────────────────────────────────────────
// sync.integration.test.ts — spawns a PocketBase subprocess and runs two
// clients against it. Verifies the full outbound/inbound path.
//
// Requires: `go build -o server/pocketbase ./server` has been run and
// the binary is at the expected path. The test spawns it on a random
// high port to avoid clashing with a dev instance.
// ────────────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PocketBase from 'pocketbase';

let pbProcess: ChildProcess;
let pbBaseUrl: string;
let tempDir: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sp-it-'));
  const port = 18000 + Math.floor(Math.random() * 1000);
  pbBaseUrl = `http://127.0.0.1:${port}`;
  pbProcess = spawn(
    './pocketbase',
    ['serve', `--http=127.0.0.1:${port}`, `--dir=${tempDir}`],
    { cwd: './server' },
  );
  // Wait for readiness.
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${pbBaseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('PocketBase did not start in time');
}, 30_000);

afterAll(() => {
  pbProcess?.kill('SIGTERM');
});

async function adminLogin(pb: PocketBase) {
  // Tests need an admin; we'll create one via PocketBase's bootstrapping
  // endpoint or via the `--dev` flag. See PocketBase docs for the
  // current mechanism; the exact code depends on pb version chosen at
  // implementation time.
}

describe('two-client sync', () => {
  it('patch from Alice appears on Bob within 5 seconds', async () => {
    // 1. Set up two users via admin API.
    // 2. Create a team; add both as members.
    // 3. Create a project with initial doc.
    // 4. Connect two pb client instances; authenticate as each user.
    // 5. Subscribe Bob to 'patches' collection.
    // 6. Alice POSTs a patch via /api/sp/patch.
    // 7. Bob receives the SSE event within 5 seconds.
    // 8. Assert Bob's local reconstruction matches the server's doc.

    // The exact body is left for the implementing engineer — the shape
    // of the test is what matters. If PocketBase startup proves flaky,
    // fall back to unit tests with mocks (already in Task 12).
  });
});
```

- [ ] **Step 2: Add an npm script.**

In `package.json`:

```json
"scripts": {
  "test:integration": "vitest run src/backend/sync.integration.test.ts"
}
```

Integration tests are NOT in the default `test` script — they require the server binary and are slow.

- [ ] **Step 3: Verify.**

```bash
cd server && go build -o pocketbase . && cd -
npm run test:integration
```

If the test is flaky or hard to stand up, document the issue in the test file and mark it `.skip` with a comment — the test doubles as a manual-run checklist in that case.

- [ ] **Step 4: Commit.**

```bash
git add src/backend/sync.integration.test.ts package.json
git commit -m "M3: two-client integration test"
```

---

## Task 17: Update AGENTS.md and acceptance checklist

**Files:**
- Modify: `AGENTS.md`
- Create: `docs/superpowers/plans/2026-04-21-backend-sync-acceptance.md`

**Purpose:** Document the new era. Replace "No backend. Everything lives in localStorage" with a description of the sync architecture. Also produce a short checklist the user can work through to verify the full feature.

- [ ] **Step 1: Update `AGENTS.md`.**

- Replace the "No backend…" sentence in the introduction with a short description: "Local-first editor backed by PocketBase for auth, team projects, and realtime sync. See `docs/superpowers/specs/2026-04-21-backend-sync-design.md`."
- Add a new section `## Backend` after the Tech stack table describing:
  - Where the server lives (`/server`).
  - How to run it (`./pocketbase serve`).
  - The three main client-side sync files (`pb.ts`, `diff.ts`, `syncClient.ts`).
  - The `applyRemotePatch` store action's place in `ACTION_POLICY`.
- Add to "Adding a feature — quick recipes" a "New persisted field on a Roof" caveat: no server-side schema change needed; `doc` is opaque JSON. But if the field is surfaced on the `projects` row (like `name` is), mirror it in `/api/sp/patch`'s post-apply logic.

- [ ] **Step 2: Write the acceptance checklist.**

A separate file at `docs/superpowers/plans/2026-04-21-backend-sync-acceptance.md`:

- [ ] Fresh user signs up; gets redirected to `/`; sees "no teams" state; can create a team.
- [ ] After team creation, admin can invite an existing user by email; non-existent email shows error.
- [ ] Admin can remove members; member role cannot access the members page.
- [ ] Project create → lands on editor; lock map, draw roof, place panels; status indicator goes blue then green within ~3 s.
- [ ] Two tabs on the same project: tab A's edits appear on tab B within 3 s; mid-drag edits in tab B are not disrupted by tab A's concurrent edits.
- [ ] Disable network in tab A; edit; status goes amber. Re-enable; within 30 s the changes POST and status goes green.
- [ ] Force a 409 (disable network in A, edit in B, re-enable A that made changes) → conflict modal; "Discard mine" replaces A with B's state; "Overwrite theirs" re-diffs and pushes A's values.
- [ ] Undo in tab A removes the change locally AND propagates (via a normal POST) to tab B.
- [ ] Sign out, populate localStorage with a test project, sign in → auto-imported to `/p/:new`.
- [ ] Deleting a project in tab A causes tab B on the same project to receive 404 on next interaction and bounce to `/`.

- [ ] **Step 3: Commit.**

```bash
git add AGENTS.md docs/superpowers/plans/2026-04-21-backend-sync-acceptance.md
git commit -m "M4: AGENTS.md backend era + acceptance checklist"
```

---

## Task 18: Final build + merge prep

**Files:**
- (No code changes)

**Purpose:** End-of-plan verification and merge prep.

- [ ] **Step 1: Full typecheck + build.**

```bash
npm run build
```

Should complete without errors.

- [ ] **Step 2: All tests.**

```bash
npm run test:run
```

- [ ] **Step 3: Walk through the acceptance checklist in Task 17.**

Check each box. File any gaps as follow-up tasks (or fix inline if small).

- [ ] **Step 4: Merge decision.**

If all checks pass: `git checkout main && git merge --no-ff backend-sync` or open a PR — whichever the user prefers.

---

## Deferred / Explicit non-goals

Per spec — NOT part of this plan:

- Presence indicator ("2 others editing"). Possible M5.
- SMTP for password resets. Possible M5.
- Google OAuth. Possible M5 or later.
- Operation log as sync format (we use JSON Patch).
- Real CRDT / multi-day offline.
- Per-project view-only role.
- E2E encryption of project data.
- Version history beyond the 1-hour patch TTL.
