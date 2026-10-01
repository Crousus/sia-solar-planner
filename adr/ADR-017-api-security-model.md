# ADR-017: API Security Model (Tenancy, Approval Gate, Outbound-URL Gates)

- **Status:** Accepted
- **Date:** 2026-10-01
- **Requirement:** Any signed-in user, and any anonymous visitor who can reach the public URL, must be unable to read or change another team's data, enumerate accounts, exhaust server resources, or make our services fetch internal URLs. The production deployment must also be able to keep self-registered accounts inert until an operator approves them.

## Context

A security audit of the stack (PocketBase v0.23 server, nginx, `ocr-service`, `pdf-service`) found that tenancy was enforced inconsistently:

1. **Update rules were checked against the record's current values.** A member could `PATCH` a `team_members`, `customers` or `projects` row and move it into another team (or rename `created_by`), because the rule only looked at where the row lived *before* the update.
2. **Users were enumerable.** `users` list/view rules let any signed-in user read every account. The invite form relied on this to turn an e-mail into a user id.
3. **The approval gate leaked tokens.** It hooked `OnRecordAuthWithPasswordRequest` and returned 403 *after* `e.Next()`, by which time PocketBase had already written the 200 + token. OAuth2/OTP/refresh were not covered at all, and `approved` was writable by the user themselves.
4. **`/api/sp/patch` had no bounds.** Unlimited body size and op count, and `copy` ops (unlimited `AccumulatedCopySizeLimit` in `evanphx/json-patch`) let a few KB of request expand to gigabytes of RAM. "Not found" and "not a member" returned different statuses, which leaked project ids.
5. **SSRF in both sidecars.** The datasheet gate was a string-prefix blocklist that missed Docker service names (`backend`, `pdf-service`), link-local/metadata, CGNAT, IPv6 forms and any DNS name resolving to a private address. `ocr-service` followed redirects blindly. `pdf-service` handed request JSON straight to react-pdf, whose `<Image src>` performs HTTP requests (`{uri, method, headers}`) or `fs.readFile` (plain paths).
6. **The admin UI and superuser API were publicly reachable** through nginx, and there were no rate limits or security headers.

## Decision

1. **Collection API rules are the primary tenancy boundary.** The final rule set lives in `server/pb_migrations/1712347100_security_hardening.js`. Every update rule *pins* its tenant-scoping relations (`team`, `user`, `created_by`): the request body may not change them. `projects.updateRule` and all `patches` write rules are `null`; project rows change only through the custom routes. `team_members` is visible to members of the same team only, and only team admins can create, update or delete memberships. A Go hook (`ensureAnotherAdmin` in `handlers/hooks.go`) refuses to demote or remove a team's last admin.
2. **No user enumeration.** `users.listRule = null` (superusers only). `users.viewRule` shows yourself and people you share a team with. Invite-by-e-mail goes through `POST /api/sp/team-members` (`handlers/team_invite.go`), which only a team admin can call and which returns only the created membership. The remaining oracle ("is this e-mail registered?") is rate-limited.
3. **Approval gate in three layers** (`handlers/approval.go`, enabled with `REQUIRE_APPROVAL=true`, set in the production `docker-compose.yml`):
   - `approved` is superuser-only writable, regardless of the flag, so turning the gate on later can't be pre-empted by self-approved accounts.
   - `OnRecordAuthRequest` (which every token-issuing flow passes through) rejects unapproved users *before* `e.Next()`.
   - A middleware after PocketBase's token loader drops `e.Auth` for unapproved users, so tokens already in circulation act as anonymous everywhere, including `/api/sp/*` and realtime.
4. **Global catalogs (`panel_models`, `inverter_models`) are creator-owned.** Any signed-in user may create; `created_by` is forced to the caller by a hook; only the creator may update (rows with an empty `created_by` stay editable). A regular user's `DELETE` is converted into a soft delete (`deleted = true`) so projects that reference a row never dangle.
5. **Custom routes check membership by hand, before taking any lock, and return the same 404 for "doesn't exist" and "not yours".** All routes are registered in one place, `handlers/register.go` (`Register(app, OptionsFromEnv())`), so the Go tests boot exactly the production wiring.
6. **`/api/sp/patch` is bounded:** 25 MB body, at most 20 000 ops, only `add`/`remove`/`replace`/`test`, `ApplyWithOptions` with a copy-size limit as defence in depth, and a 20 MB result cap (413). Per-project locks are reference-counted so the lock map can't grow without bound.
7. **Outbound URLs are validated by resolution, not by string matching.** `handlers/ssrf.go` requires http(s) on the default port, a dotted non-numeric host outside internal suffixes, and that *every* resolved address is globally routable. `ocr-service` repeats the check, pins the connection to the validated IP, follows redirects manually with per-hop validation, and caps download size/time, page count, LLM input and concurrency. `pdf-service` authenticates the caller (`users/auth-refresh`, `users` collection only) *before* parsing the body, accepts images only as `data:image/png|jpeg;base64` URIs, re-constructs `SolarPlanDoc` props from the validated payload, and caps concurrent renders. All three return generic error messages.
8. **Edge hardening in nginx:** security headers and a CSP, per-zone rate limits (auth, sign-up, PDF render, datasheet import), and `/_/`, `/api/_/` and `/api/collections/_superusers/` return 404 — the admin UI is reached through an SSH tunnel to `127.0.0.1:8090`. PocketBase's own rate limiter is enabled by migration, keyed on nginx's `X-Real-IP`. Dev compose binds every port to `127.0.0.1`; all service images run as non-root.

## Consequences

- **Pros:** Tenancy holds even for hand-crafted API requests, not just the UI. The Go suite (`server/handlers/*_test.go`) boots a real PocketBase test app with all migrations and exercises rules, the approval gate, patch limits, the SSRF gate and rate limiting, so regressions show up in `go test`.
- **Cons:** Operators must not publish port 8090 directly — `X-Real-IP` would become client-controlled and the rate limiter could be evaded. Admin access requires an SSH tunnel. Invitations work only for already-registered addresses. A rule change now needs a new migration *and* a test; editing rules in the admin UI is overwritten on the next deploy.
- **Residual risks:** DNS rebinding between the Go check and a sidecar's own resolution is mitigated by IP pinning in `ocr-service` but not formally excluded. The invite endpoint is an e-mail registration oracle for any signed-in user (anyone can create a team and be its admin), bounded only by rate limiting.
