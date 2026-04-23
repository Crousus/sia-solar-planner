/// <reference path="../pb_data/types.d.ts" />

// Adds an optional `panel_model` relation from `projects` to the global
// `panel_models` catalog.
//
// Why this is a top-level relation (not JSON in doc.meta):
//   Same reasoning as the `customer` field added in 1712346300_customers.js:
//   top-level PocketBase columns are SQL-filterable and expand-able in a
//   single query, while JSON blob fields require full table scans to
//   filter on.
//
// Why cascadeDelete: false:
//   Deleting a catalog entry must NOT cascade-delete projects that
//   referenced it. In practice the catalog uses a `deleted` soft-delete
//   flag so this should rarely fire, but if someone hard-deletes an
//   entry the projects simply end up with a null relation — preferable
//   to silently losing customer work.
//
// Why required: false:
//   Existing projects (predating this migration) have no panel model
//   linked, and plenty of early-stage planning happens before a module
//   has been chosen. Making it required would break all existing rows
//   and force users to pick a placeholder.

migrate((app) => {
  // Look up the catalog collection we want to point at. This migration
  // must run after 1712346500_panel_models.js — PocketBase runs
  // migrations in filename order, and the numeric prefix enforces that.
  const panelModels = app.findCollectionByNameOrId('panel_models');

  const projects = app.findCollectionByNameOrId('projects');
  projects.fields.add(new RelationField({
    name: 'panel_model',
    collectionId: panelModels.id,
    cascadeDelete: false,
    required: false,
    maxSelect: 1,
  }));
  app.save(projects);
}, (app) => {
  // Down: just remove the field from projects. We deliberately do NOT
  // delete the panel_models collection here — that's the job of the
  // 1712346500 migration's down handler, which will run after this one
  // during a rollback (reverse filename order).
  const projects = app.findCollectionByNameOrId('projects');
  projects.fields.removeByName('panel_model');
  app.save(projects);
});
