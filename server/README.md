# Solar Planner — PocketBase server

Single-binary Go server embedding PocketBase. Hosts auth, teams, projects,
and our custom `/api/sp/patch` RFC 6902 endpoint (added in later tasks).

## Prerequisites

- Go 1.22+ (`go version`)

## Build

```bash
cd server
go build -o pocketbase .
```

Produces a `pocketbase` binary in `server/` (gitignored). The binary is
self-contained and ships everything (SQLite driver, admin UI assets,
migrations).

## Run (dev)

```bash
./pocketbase serve --http=127.0.0.1:8090
```

On first boot, the JS migrations in `pb_migrations/` run automatically
(automigrate baked into `main.go`), creating `users` (extended), `teams`,
and `team_members` collections.

## Admin / superuser

The PocketBase admin UI is at <http://127.0.0.1:8090/_/>. On the very
first run it will prompt you to create a superuser in the browser.

For non-interactive setup (CI, scripts), create one via CLI instead:

```bash
./pocketbase superuser upsert admin@example.com "ChangeMe-Dev-1234"
```

`upsert` creates the account if missing or rotates the password if it
already exists — idempotent, so it's safe to re-run.

## Reset local data

The SQLite file and uploads live under `pb_data/` (gitignored). To wipe
and start fresh:

```bash
rm -rf pb_data && ./pocketbase serve --http=127.0.0.1:8090
```

Migrations re-run from scratch on the empty data dir.

## SPA integration

The Vite dev server at the repo root proxies `/api/*` to
`http://127.0.0.1:8090` (see `vite.config.ts`). Run both:

```bash
# terminal 1 — backend
cd server && ./pocketbase serve --http=127.0.0.1:8090

# terminal 2 — frontend
npm run dev
```

The SPA talks to PocketBase transparently via the proxy; no CORS dance
needed in dev.
