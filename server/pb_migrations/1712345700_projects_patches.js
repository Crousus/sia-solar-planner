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
// updateRule to null (nobody via default endpoint).
// `name` is also updated via /api/sp/patch — a rename is just a JSON
// Patch op that touches the name field, so no separate endpoint needed.

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
    // updateRule: null (nobody via default endpoint). /api/sp/patch is
    //   the only write path for `doc`, `revision`, and `name`.
    updateRule: null,
    deleteRule: "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'",
    fields: [
      { name: 'team', type: 'relation', required: true, collectionId: teams.id, cascadeDelete: true, maxSelect: 1 },
      { name: 'name', type: 'text', required: true, min: 1, max: 200 },
      { name: 'doc', type: 'json', required: true, maxSize: 20000000 }, // 20 MB — captured image can be multi-MB base64
      { name: 'revision', type: 'number', required: true, min: 0, onlyInt: true },
      // v0.23: `created`/`updated` are NOT auto-added anymore — they're
      // opt-in autodate fields. We include both so the dashboard + any
      // client-side sorting by creation time works out of the box.
      { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
      { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
    ],
  });
  app.save(projects);

  const patches = new Collection({
    type: 'base',
    name: 'patches',
    // listRule / viewRule: any team member of the project's team.
    //   PB supports dotted navigation: `project.team` dereferences the
    //   projects record's team relation.
    listRule: "@request.auth.id != '' && @collection.team_members.team = project.team && @collection.team_members.user = @request.auth.id",
    viewRule: "@request.auth.id != '' && @collection.team_members.team = project.team && @collection.team_members.user = @request.auth.id",
    // createRule: null — only the server-side /api/sp/patch handler
    //   creates rows, via app.Save with no user context. Direct POSTs
    //   to /api/collections/patches get 403.
    createRule: null,
    updateRule: null,
    // deleteRule: null for HTTP access. TTL cron uses app.Delete which
    //   bypasses rules (hook context).
    deleteRule: null,
    fields: [
      { name: 'project', type: 'relation', required: true, collectionId: projects.id, cascadeDelete: true, maxSelect: 1 },
      { name: 'author', type: 'relation', required: true, collectionId: users.id, cascadeDelete: false, maxSelect: 1 },
      { name: 'from_revision', type: 'number', required: true, min: 0, onlyInt: true },
      { name: 'to_revision', type: 'number', required: true, min: 1, onlyInt: true },
      { name: 'ops', type: 'json', required: true, maxSize: 10000000 }, // 10 MB upper bound; normal patches are < 10 KB
      // v0.23: explicit autodate — required by the TTL cron index below,
      // which sorts patches by age. `updated` isn't needed for patches
      // (they're append-only), but we add it for consistency.
      { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
      { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
    ],
    // NOTE: indexes are set in a second save() pass below. In v0.23 the
    // collection validator checks index SQL against the DB schema at the
    // time `app.save()` runs. For a brand-new collection the SQL table
    // hasn't been materialised yet when the first save validates, so an
    // index that references a custom column (e.g. `created`) can trip
    // "no such column" even though the field is in the spec. Splitting
    // the save into "create with fields" then "add indexes" sidesteps
    // that race by guaranteeing the physical table exists first.
  });
  app.save(patches);

  patches.indexes = [
    // Query helper for TTL cron — find old patches fast.
    'CREATE INDEX idx_patches_created ON patches (created)',
    // Not strictly required but speeds up the SSE filter on project.
    'CREATE INDEX idx_patches_project ON patches (project)',
  ];
  app.save(patches);
}, (app) => {
  app.delete(app.findCollectionByNameOrId('patches'));
  app.delete(app.findCollectionByNameOrId('projects'));
});
