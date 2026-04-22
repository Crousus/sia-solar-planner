/// <reference path="../pb_data/types.d.ts" />

// Relax `patches.from_revision` from required=true to required=false.
//
// Same PocketBase v0.23 gotcha as `projects.revision`: a NumberField
// with required=true rejects the Go zero value (0) as "blank". The very
// first patch on a new project has `from_revision: 0` (the project
// starts at revision 0), so every first-save request fails with
//   { "from_revision": { "code": "validation_required", "message": "Cannot be blank." } }
// at `/api/sp/patch`, surfacing to the client as a 500.
//
// Only `from_revision` is affected — `to_revision` has `min: 1` so it's
// always ≥ 1 and never hits the zero-value path.
//
// Forward-only so every environment converges.

migrate((app) => {
  const patches = app.findCollectionByNameOrId('patches');
  const field = patches.fields.getByName('from_revision');
  if (field) {
    field.required = false;
    app.save(patches);
  }
}, (app) => {
  const patches = app.findCollectionByNameOrId('patches');
  const field = patches.fields.getByName('from_revision');
  if (field) {
    field.required = true;
    app.save(patches);
  }
});
