/// <reference path="../pb_data/types.d.ts" />

// Relax `projects.revision` from required=true to required=false.
//
// Why: PocketBase v0.23's NumberField treats the Go zero value (0) as
// "blank" during required-validation, so `required: true` rejects our
// canonical initial revision of 0 with
//   { "revision": { "code": "validation_required", "message": "Cannot be blank." } }
// at `POST /api/collections/projects/records`. Every newly-created
// project wants revision=0 (the first patch bumps to 1), so required is
// actually hostile to the intended semantics.
//
// Semantic invariant is preserved elsewhere: the client always writes
// `revision: 0` on create, and the only other write path is
// `/api/sp/patch` (the default updateRule is null), which always sets
// revision to a non-null integer. `min: 0` + `onlyInt: true` still
// forbid negative or fractional values.
//
// Forward-only migration so every environment converges regardless of
// whether the original projects collection was created before or after
// this fix ships.

migrate((app) => {
  const projects = app.findCollectionByNameOrId('projects');
  const revision = projects.fields.getByName('revision');
  if (revision) {
    revision.required = false;
    app.save(projects);
  }
}, (app) => {
  const projects = app.findCollectionByNameOrId('projects');
  const revision = projects.fields.getByName('revision');
  if (revision) {
    revision.required = true;
    app.save(projects);
  }
});
