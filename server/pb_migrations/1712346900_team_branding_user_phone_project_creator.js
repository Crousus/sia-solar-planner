/// <reference path="../pb_data/types.d.ts" />

// Branding + planner-identity migration.
//
// Three orthogonal additions, bundled in one migration because they all
// back a single user-facing feature (branded PDF exports) and it's
// easier to roll forward/back as a unit:
//
//   1. `teams.logo`         — file, optional, single file, max 2 MB.
//      Rendered in the PDF sidebar in place of the scarlet brand square.
//      Access to the file itself follows the teams collection's viewRule
//      (member-of-team), so logos are not world-readable.
//
//   2. `teams.company_name` — text, optional. Shown in the PDF kicker
//      slot (the existing "SOLARPLAN" wordmark) when set. The in-app
//      branding is unchanged; this only drives exports.
//
//   3. `users.phone`        — text, optional. Paired with `users.name`
//      to make up the "Planner" identity block in the PDF.
//
//   4. `projects.created_by` — relation to users. Optional so that
//      existing rows (created before this migration) remain valid
//      without a backfill; new rows are populated server-side by the
//      OnRecordCreateRequest hook (see server/handlers/hooks.go).
//      "Planner" on the PDF = this user. We set it server-side rather
//      than trusting the client so a malicious client can't impersonate
//      a different planner at creation time.

migrate((app) => {
  // ── teams: logo + company_name ────────────────────────────────────────
  const teams = app.findCollectionByNameOrId('teams');
  if (!teams.fields.getByName('logo')) {
    teams.fields.add(new FileField({
      name: 'logo',
      required: false,
      maxSelect: 1,
      // 2 MB is generous for a logo — typical PNG/SVG logos are <100 KB.
      // The cap exists mostly to prevent accidental full-res artwork
      // uploads that would bloat every PDF export.
      maxSize: 2 * 1024 * 1024,
      mimeTypes: [
        'image/png',
        'image/jpeg',
        'image/svg+xml',
        'image/webp',
      ],
    }));
  }
  if (!teams.fields.getByName('company_name')) {
    teams.fields.add(new TextField({
      name: 'company_name',
      required: false,
      max: 200,
    }));
  }
  app.save(teams);

  // ── users: phone ──────────────────────────────────────────────────────
  const users = app.findCollectionByNameOrId('users');
  if (!users.fields.getByName('phone')) {
    users.fields.add(new TextField({
      name: 'phone',
      required: false,
      max: 50,
    }));
  }
  app.save(users);

  // ── projects: created_by ──────────────────────────────────────────────
  //
  // NOT marked required=true even though every NEW row gets one set by
  // the hook. Reason: existing rows pre-date this migration and have no
  // value to backfill; marking required would either need a data-only
  // backfill pass (brittle — which user should we assign?) or break the
  // migration outright. Leaving it optional lets legacy rows keep
  // rendering with "unknown planner" on the PDF (falls back gracefully).
  //
  // cascadeDelete: false — a user record deletion must NOT silently
  // cascade-delete every project they created. The project stays; the
  // relation becomes a dangling id that the client tolerates (planner
  // label collapses to blank in the UI and on the PDF).
  const projects = app.findCollectionByNameOrId('projects');
  if (!projects.fields.getByName('created_by')) {
    projects.fields.add(new RelationField({
      name: 'created_by',
      required: false,
      collectionId: users.id,
      cascadeDelete: false,
      maxSelect: 1,
    }));
  }
  app.save(projects);
}, (app) => {
  // Down migration: reverse in order so a re-applied migration starts
  // from a clean slate.
  const projects = app.findCollectionByNameOrId('projects');
  if (projects.fields.getByName('created_by')) {
    projects.fields.removeByName('created_by');
    app.save(projects);
  }

  const users = app.findCollectionByNameOrId('users');
  if (users.fields.getByName('phone')) {
    users.fields.removeByName('phone');
    app.save(users);
  }

  const teams = app.findCollectionByNameOrId('teams');
  if (teams.fields.getByName('logo')) {
    teams.fields.removeByName('logo');
  }
  if (teams.fields.getByName('company_name')) {
    teams.fields.removeByName('company_name');
  }
  app.save(teams);
});
