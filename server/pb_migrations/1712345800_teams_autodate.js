/// <reference path="../pb_data/types.d.ts" />

// Add `created` and `updated` autodate fields to `teams` and
// `team_members`. They were missing from the initial schema migration —
// PocketBase v0.23 stopped auto-adding these fields, so collections now
// need them declared explicitly. The client sorts team lists by `-created`
// and `-updated` (TeamPicker, TeamView, migrateLocalStorage); without
// these fields the `sort=` query param hits PB's "unknown field" path
// and returns 400 "Something went wrong" for every list request.
//
// Why a separate migration rather than amending the initial one:
// `automigrate` only applies unseen migrations. Editing a migration that
// has already run on any deployment is a silent no-op — the fix never
// ships. A forward-only migration guarantees every environment converges.

migrate((app) => {
  for (const collName of ['teams', 'team_members']) {
    const coll = app.findCollectionByNameOrId(collName);
    // Use AutodateField — the generic `Field` constructor doesn't bind
    // type-specific options (onCreate/onUpdate). AutodateField is the
    // public constructor exposed by PocketBase's jsvm in v0.23+.
    if (!coll.fields.getByName('created')) {
      coll.fields.add(new AutodateField({
        name: 'created',
        onCreate: true,
        onUpdate: false,
      }));
    }
    if (!coll.fields.getByName('updated')) {
      coll.fields.add(new AutodateField({
        name: 'updated',
        onCreate: true,
        onUpdate: true,
      }));
    }
    app.save(coll);
  }
}, (app) => {
  for (const collName of ['teams', 'team_members']) {
    const coll = app.findCollectionByNameOrId(collName);
    if (coll.fields.getByName('updated')) coll.fields.removeByName('updated');
    if (coll.fields.getByName('created')) coll.fields.removeByName('created');
    app.save(coll);
  }
});
