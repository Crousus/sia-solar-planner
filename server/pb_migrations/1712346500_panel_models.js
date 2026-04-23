/// <reference path="../pb_data/types.d.ts" />

// Adds the `panel_models` collection — a global catalog of PV module
// specs shared across every team in the instance.
//
// Why no `team` field (unlike customers/projects):
//   A solar panel's physical and electrical specs don't belong to any one
//   team — an "SPR-MAX3-400" is the same module whether team A or team B
//   references it. Making the catalog instance-global lets every team
//   browse and reuse manufacturer entries without each team needing to
//   re-enter the same datasheet numbers. Deduplication happens at the
//   schema level instead of being a convention.
//
// Why auth rules are "any authenticated user":
//   Because the catalog is global and not team-gated, we can't use the
//   team_members back-reference pattern that customers/projects use.
//   Any logged-in user can list/view/create/update/delete entries. If we
//   later want to restrict curation to admins, we'd add a separate
//   migration for that policy change.
//
// Why `deleted` is a plain bool with no PB-side enforcement:
//   Soft-delete is a client-side concern here: we want to keep historic
//   project references intact after an entry is pulled from the active
//   catalog, but PocketBase rules don't need to hide deleted rows — the
//   app filters on `deleted != true` when rendering pickers. Hard delete
//   is still available via the delete rule for true mistakes.

migrate((app) => {
  // ── panel_models ───────────────────────────────────────────────────
  const panelModels = new Collection({
    type: 'base',
    name: 'panel_models',
    listRule:   "@request.auth.id != ''",
    viewRule:   "@request.auth.id != ''",
    createRule: "@request.auth.id != ''",
    updateRule: "@request.auth.id != ''",
    deleteRule: "@request.auth.id != ''",
    fields: [
      { name: 'manufacturer',        type: 'text',     required: true,  max: 100 },
      { name: 'model',               type: 'text',     required: true,  max: 100 },
      // Physical dimensions are in meters (SI) so downstream geometry
      // code (roof placement, packing) never has to deal with mm/cm unit
      // conversions.
      { name: 'widthM',              type: 'number',   required: true  },
      { name: 'heightM',             type: 'number',   required: true  },
      { name: 'wattPeak',            type: 'number',   required: true  },
      { name: 'efficiencyPct',       type: 'number',   required: false },
      { name: 'weightKg',            type: 'number',   required: false },
      // Electrical characteristics — optional because not every datasheet
      // reliably reports every value, and string-sizing calculators can
      // still function with a subset.
      { name: 'voc',                 type: 'number',   required: false },
      { name: 'isc',                 type: 'number',   required: false },
      { name: 'vmpp',                type: 'number',   required: false },
      { name: 'impp',                type: 'number',   required: false },
      { name: 'tempCoefficientPmax', type: 'number',   required: false },
      { name: 'warrantyYears',       type: 'number',   required: false },
      { name: 'datasheetUrl',        type: 'url',      required: false },
      // Soft-delete flag — app-enforced, not an access rule. See header.
      { name: 'deleted',             type: 'bool',     required: false },
      { name: 'created',             type: 'autodate', onCreate: true,  onUpdate: false },
      { name: 'updated',             type: 'autodate', onCreate: true,  onUpdate: true  },
    ],
  });
  app.save(panelModels);
}, (app) => {
  // Down: drop the collection. No FK to clean up here — the projects
  // relation to panel_models is added in a separate migration whose own
  // down handler removes that field first.
  app.delete(app.findCollectionByNameOrId('panel_models'));
});
