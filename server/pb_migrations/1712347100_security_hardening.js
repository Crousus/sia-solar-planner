/// <reference path="../pb_data/types.d.ts" />

// Security hardening (audit findings, 2026-10).
//
// WHY a new migration instead of editing the older ones:
//   Earlier migrations have already been applied to deployed databases;
//   PocketBase never re-runs an applied migration, so editing history would
//   leave production on the vulnerable rules while fresh dev DBs got the
//   fixed ones. This file is the single place that sets the FINAL rule set
//   for every collection we own. If you change a rule later, add another
//   migration — don't edit this one.
//
// Rule-writing conventions used below (PocketBase filter syntax):
//
//   * `@collection.team_members:me.*` — an ALIASED join on team_members.
//     All conditions that share the `:me` alias apply to the SAME joined
//     row, so `me.team ?= team && me.user ?= @request.auth.id` reads as
//     "there is ONE membership row binding the caller to this team". The
//     original team_members list rule (`team.id ?= @collection.team_members.team`)
//     never referenced @request.auth at all and therefore matched every
//     row for every signed-in user — that was finding H3.
//
//   * Update rules are evaluated against the record's CURRENT (pre-update)
//     values, with the incoming payload only visible via `@request.body.*`.
//     So "you are an admin of `team`" says nothing about the team the row
//     will be moved INTO. Every update rule that guards a tenant-scoping
//     relation (team, user, created_by) therefore also pins that relation:
//       (@request.body.X:isset = false || @request.body.X = X)
//     i.e. "either don't send it, or send the value it already has". The
//     lenient form (allow resending the same value) keeps clients that
//     PATCH whole objects working. Missing this pin was finding C1
//     (team_members.team move → admin of any team).
//
//   * `approved` on users is only writable by superusers. Request hooks in
//     handlers/approval.go enforce the same thing in Go (defense in depth);
//     the rule here makes a self-approval attempt fail loudly (400) rather
//     than being silently stripped.

const MEMBER = (teamExpr) =>
  `@request.auth.id != '' && @collection.team_members:me.team ?= ${teamExpr} && @collection.team_members:me.user ?= @request.auth.id`;
const ADMIN = (teamExpr) =>
  `${MEMBER(teamExpr)} && @collection.team_members:me.role ?= 'admin'`;
const PINNED = (field) =>
  `(@request.body.${field}:isset = false || @request.body.${field} = ${field})`;

migrate((app) => {
  // ── users ────────────────────────────────────────────────────────────
  const users = app.findCollectionByNameOrId('users');
  // Self-registration stays public (the approval gate decides whether the
  // new account can sign in), but the payload may not approve itself.
  users.createRule = "@request.body.approved:isset = false || @request.body.approved = false";
  // Owner-only update (PocketBase's default), and `approved` is frozen.
  users.updateRule = `id = @request.auth.id && ${PINNED('approved')}`;
  // View: yourself, or someone who shares at least one team with you.
  // Previously ANY signed-in user could fetch ANY user's name/phone by id.
  // Two aliased joins: `me` = one of the caller's memberships, `them` =
  // one of the target's memberships, constrained to the same team.
  users.viewRule =
    "id = @request.auth.id || (" +
    "@collection.team_members:me.user ?= @request.auth.id && " +
    "@collection.team_members:them.user ?= id && " +
    "@collection.team_members:them.team ?= @collection.team_members:me.team)";
  // listRule stays null (superusers only) — no user enumeration. Inviting
  // by email goes through POST /api/sp/team-members (handlers/team_invite.go).
  users.listRule = null;
  app.save(users);

  // ── teams ────────────────────────────────────────────────────────────
  const teams = app.findCollectionByNameOrId('teams');
  teams.listRule = MEMBER('id');
  teams.viewRule = MEMBER('id');
  // Any signed-in user may create a team. `created_by` is overwritten with
  // the caller in handlers/hooks.go, so the client can't name somebody else.
  teams.createRule = "@request.auth.id != ''";
  teams.updateRule = `${ADMIN('id')} && ${PINNED('created_by')}`;
  teams.deleteRule = ADMIN('id');
  app.save(teams);

  // ── team_members ─────────────────────────────────────────────────────
  const teamMembers = app.findCollectionByNameOrId('team_members');
  // H3 fix: only memberships of teams the caller belongs to.
  teamMembers.listRule = MEMBER('team');
  teamMembers.viewRule = MEMBER('team');
  // Create: caller must be admin of the team named in the payload (on
  // create, `team` IS the payload value, so no extra pin is needed).
  teamMembers.createRule = ADMIN('team');
  // C1 fix: an admin may change a member's ROLE, but never re-home the row
  // to another team or re-assign it to another user.
  teamMembers.updateRule = `${ADMIN('team')} && ${PINNED('team')} && ${PINNED('user')}`;
  teamMembers.deleteRule = ADMIN('team');
  app.save(teamMembers);

  // ── projects ─────────────────────────────────────────────────────────
  const projects = app.findCollectionByNameOrId('projects');
  projects.listRule = MEMBER('team');
  projects.viewRule = MEMBER('team');
  // A linked customer must belong to the same team as the project. Without
  // this a member could attach (and then expand/read) another team's
  // customer record by guessing its id. `panel_model` points at the
  // GLOBAL catalog, so any existing id is legitimately linkable.
  projects.createRule = `${MEMBER('team')} && (@request.body.customer:isset = false || @request.body.customer = '' || @request.body.customer.team = team)`;
  // Still null — /api/sp/patch, /api/sp/set-customer and
  // /api/sp/set-panel-model are the only write paths.
  projects.updateRule = null;
  projects.deleteRule = ADMIN('team');
  app.save(projects);

  // ── patches (server-written; read-only for members) ──────────────────
  const patches = app.findCollectionByNameOrId('patches');
  patches.listRule = MEMBER('project.team');
  patches.viewRule = MEMBER('project.team');
  patches.createRule = null;
  patches.updateRule = null;
  patches.deleteRule = null;
  // The ops column must hold the largest patch /api/sp/patch accepts
  // (25 MB body cap, see handlers/patch.go). It was 10 MB, so locking a
  // map with a big captured image produced a patch that passed the doc
  // limit (20 MB) but 500'd when the patches row was saved.
  const opsField = patches.fields.getByName('ops');
  if (opsField) {
    opsField.maxSize = 25 * 1024 * 1024;
  }
  app.save(patches);

  // ── customers ────────────────────────────────────────────────────────
  const customers = app.findCollectionByNameOrId('customers');
  customers.listRule = MEMBER('team');
  customers.viewRule = MEMBER('team');
  customers.createRule = MEMBER('team');
  // Pin `team` so a member can't move a customer into a team they don't
  // belong to (or out of reach of their own team's admins).
  customers.updateRule = `${MEMBER('team')} && ${PINNED('team')}`;
  customers.deleteRule = ADMIN('team');
  app.save(customers);

  // ── global catalogs: panel_models / inverter_models ──────────────────
  //
  // These are shared across ALL teams, so a write is a cross-tenant write.
  // Policy:
  //   * create: any signed-in (and therefore approved, see approval gate)
  //     user. `created_by` is forced to the caller by a Go hook.
  //   * update/delete: only the creator. Legacy rows that pre-date
  //     `created_by` (empty) stay editable by any signed-in user — there is
  //     no truthful owner to backfill; a superuser can claim them by
  //     setting created_by in the admin UI.
  //   * DELETE never hard-deletes for regular users: handlers/hooks.go turns
  //     it into `deleted = true` (projects may still reference the row and
  //     the app is built around soft-delete). Superusers still hard-delete.
  const userId = users.id;
  for (const name of ['panel_models', 'inverter_models']) {
    const col = app.findCollectionByNameOrId(name);
    if (!col.fields.getByName('created_by')) {
      col.fields.add(new RelationField({
        name: 'created_by',
        required: false,
        collectionId: userId,
        cascadeDelete: false,
        maxSelect: 1,
      }));
    }
    const owner = "@request.auth.id != '' && (created_by = '' || created_by = @request.auth.id)";
    col.listRule = "@request.auth.id != ''";
    col.viewRule = "@request.auth.id != ''";
    col.createRule = "@request.auth.id != ''";
    col.updateRule = `${owner} && ${PINNED('created_by')}`;
    col.deleteRule = owner;
    app.save(col);
  }

  // ── rate limiting + trusted proxy ────────────────────────────────────
  //
  // PocketBase ships a rate limiter but leaves it disabled. Without it the
  // superuser auth endpoint (reachable through nginx at
  // /api/collections/_superusers/auth-with-password) can be brute-forced.
  //
  // Limits are per client IP. In production every request arrives via the
  // nginx container, so PocketBase must read the client IP from the
  // X-Real-IP header nginx sets (nginx.conf: `proxy_set_header X-Real-IP
  // $remote_addr`, which OVERWRITES any client-supplied value). Without
  // this, every user would share nginx's IP and one bad actor would lock
  // everybody out. NOTE: this header is only trustworthy while the backend
  // is NOT exposed directly; if you publish port 8090, a client can spoof
  // X-Real-IP and dodge the limiter.
  //
  // Loopback is excluded so local tooling (integration test harness,
  // `curl` on the host) isn't throttled — anyone on loopback already owns
  // the box.
  const settings = app.settings();
  settings.trustedProxy.headers = ['X-Real-IP'];
  settings.trustedProxy.useLeftmostIP = false;
  settings.rateLimits.enabled = true;
  settings.rateLimits.excludedIPs = ['127.0.0.1', '::1'];
  // Order matters only for equal-specificity labels; PocketBase picks the
  // most specific matching label first (collection:action, then *:action,
  // then path prefixes).
  settings.rateLimits.rules = [
    // Superuser login: 5 attempts/minute/IP.
    { label: '_superusers:auth', audience: '', maxRequests: 5, duration: 60 },
    // Every other password/OTP/OAuth2 login: 20/minute/IP.
    { label: '*:auth', audience: '', maxRequests: 20, duration: 60 },
    // E-mail-sending endpoints (spam / enumeration amplifiers).
    { label: '*:requestOTP', audience: '', maxRequests: 5, duration: 60 },
    { label: '*:requestPasswordReset', audience: '', maxRequests: 5, duration: 60 },
    { label: '*:requestVerification', audience: '', maxRequests: 5, duration: 60 },
    { label: '*:requestEmailChange', audience: '', maxRequests: 5, duration: 60 },
    // Sign-ups.
    { label: 'users:create', audience: '', maxRequests: 10, duration: 300 },
    { label: '*:create', audience: '', maxRequests: 20, duration: 5 },
    // Expensive custom routes: LLM-backed parsing and member lookup by email.
    { label: 'POST /api/sp/parse-datasheet', audience: '', maxRequests: 10, duration: 60 },
    { label: 'POST /api/sp/team-members', audience: '', maxRequests: 20, duration: 60 },
    { label: '/api/batch', audience: '', maxRequests: 3, duration: 1 },
    // Catch-all; generous because the sync client and realtime chatter.
    { label: '/api/', audience: '', maxRequests: 300, duration: 10 },
  ];
  app.save(settings);
}, (app) => {
  // Down: intentionally a no-op for the access rules. Rolling back to the
  // previous rule set would re-open the audited vulnerabilities; recover
  // forward with a new migration instead. We only drop the added
  // `created_by` catalog columns so a re-apply starts clean.
  for (const name of ['panel_models', 'inverter_models']) {
    const col = app.findCollectionByNameOrId(name);
    if (col.fields.getByName('created_by')) {
      col.fields.removeByName('created_by');
      app.save(col);
    }
  }
});
