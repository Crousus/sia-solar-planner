# Solar Planner — PocketBase server

Single-binary Go server embedding PocketBase (v0.40). Hosts auth, teams,
projects, and our custom `/api/sp/*` endpoints (RFC 6902 patch sync,
customer / panel-model linking, invite-by-email, datasheet import proxy).

## Prerequisites

- Go 1.27.1+ (`go version`). PocketBase v0.40 requires Go 1.27 (it moved
  to `encoding/json/v2`). The old PocketBase v0.23 crashed at startup when
  built with Go 1.27 — that version is no longer used.

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
(automigrate baked into `main.go`), creating every collection (`users`
extended, `teams`, `team_members`, `projects`, `patches`, `customers`,
`panel_models`, `inverter_models`) and the final API rules / rate limits
(`1712347100_security_hardening.js`). Custom routes, hooks and middleware
are wired in `handlers/register.go`.

## Admin / superuser

The PocketBase admin UI is at <http://127.0.0.1:8090/_/>. On the very
first run it will prompt you to create a superuser in the browser.

For non-interactive setup (CI, scripts), create one via CLI instead:

```bash
./pocketbase superuser upsert admin@example.com "ChangeMe-Dev-1234"
```

`upsert` creates the account if missing or rotates the password if it
already exists — idempotent, so it's safe to re-run.

## Tests

```bash
cd server
go vet ./... && go test ./...
```

The handler tests (`handlers/*_test.go`) boot a real PocketBase test app
with all JS migrations applied, register the same hooks/routes as
`main.go`, and talk to it over HTTP. They cover the API rules, the
approval gate, `/api/sp/patch` limits, the SSRF gate and rate limiting.

## Security model (summary)

- **Tenancy** is enforced by collection API rules (latest set in
  `pb_migrations/1712347100_security_hardening.js`) plus Go request hooks
  in `handlers/`. Update rules pin tenant-scoping relations
  (`team`, `user`, `created_by`) because PocketBase evaluates update rules
  against the record's *current* values.
- **Users** can only view themselves and people they share a team with;
  user listing is superuser-only. Adding members by e-mail goes through
  `POST /api/sp/team-members` (team admins only).
- **Global catalogs** (`panel_models`, `inverter_models`): any signed-in
  user may create; only the creator may edit; `DELETE` by a regular user
  is turned into a soft delete (`deleted = true`).
- **Custom routes** check membership by hand and return the same 404 for
  "doesn't exist" and "not yours".
- **Datasheet import** URLs must be public http(s) URLs: the host is
  resolved and every address must be globally routable (see
  `handlers/ssrf.go`).
- **Rate limiting** is enabled by migration, keyed on the `X-Real-IP`
  header that nginx sets. That header is only trustworthy while port 8090
  is *not* exposed directly — if you publish it, clients can spoof their
  IP and evade the limiter. Loopback is exempt.

### `REQUIRE_APPROVAL`

| Value | Behaviour |
|---|---|
| unset / anything else (default; dev, integration tests) | New sign-ups can log in immediately. |
| `true` (production `docker-compose.yml`) | New sign-ups get `403 pending approval` on every token-issuing endpoint (password, OAuth2, OTP, auth-refresh) until a superuser sets `users.approved = true` in the admin UI. Existing tokens of unapproved users are treated as anonymous. |

Regardless of the flag, `approved` can only be written by superusers, so
turning the gate on later can't be pre-empted by self-approved accounts.

## Upgrading an existing deployment

- The backend image now runs as uid/gid `10001` (non-root). Volumes
  created by the previous root-running image contain root-owned files;
  fix them once before starting the new image:

  ```bash
  docker compose run --rm --user root backend chown -R 10001:10001 /app/pb_data
  ```

- PocketBase v0.23 → v0.40 applies its own system migrations on first
  boot. Take a backup of `pb_data` first.

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
needed in dev. `/pdf/*` is proxied to `pdf-service` on `:3002` (it does
not go through this server).

Design rationale for the security model: `adr/ADR-017-api-security-model.md`.
