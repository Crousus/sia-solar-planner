/// <reference path="../pb_data/types.d.ts" />

// Adds the `inverter_models` collection — a global catalog of inverter
// specs shared across every team in the instance.
//
// Why no `team` field and why global auth rules:
//   Same reasoning as panel_models (see 1712346500_panel_models.js): the
//   inverter catalog describes manufacturer hardware, not team-owned
//   data, so it lives instance-wide and any authenticated user can
//   curate it.
//
// Why `maxAcPowerW` is the only required electrical field:
//   Inverter sizing (DC:AC ratio) is the single most-used value in the
//   planner, so we make it mandatory. Everything else (phases, MPPT
//   counts, DC voltage limits) is optional because datasheets vary and
//   partial entries are still useful for rough planning.

migrate((app) => {
  // ── inverter_models ────────────────────────────────────────────────
  const inverterModels = new Collection({
    type: 'base',
    name: 'inverter_models',
    listRule:   "@request.auth.id != ''",
    viewRule:   "@request.auth.id != ''",
    createRule: "@request.auth.id != ''",
    updateRule: "@request.auth.id != ''",
    deleteRule: "@request.auth.id != ''",
    fields: [
      { name: 'manufacturer',     type: 'text',     required: true,  max: 100 },
      { name: 'model',            type: 'text',     required: true,  max: 100 },
      { name: 'maxAcPowerW',      type: 'number',   required: true  },
      { name: 'maxDcPowerW',      type: 'number',   required: false },
      { name: 'efficiencyPct',    type: 'number',   required: false },
      // `phases` is semantically an enum (1 or 3) but stored as number
      // for simplicity — app-level validation clamps to {1,3}.
      { name: 'phases',           type: 'number',   required: false },
      { name: 'maxStrings',       type: 'number',   required: false },
      { name: 'maxInputVoltageV', type: 'number',   required: false },
      { name: 'datasheetUrl',     type: 'url',      required: false },
      // Soft-delete flag — app-enforced, see panel_models header.
      { name: 'deleted',          type: 'bool',     required: false },
      { name: 'created',          type: 'autodate', onCreate: true,  onUpdate: false },
      { name: 'updated',          type: 'autodate', onCreate: true,  onUpdate: true  },
    ],
  });
  app.save(inverterModels);
}, (app) => {
  // Down: drop the collection. No relation field on projects references
  // inverter_models yet (that's a future migration), so nothing to
  // unwire first.
  app.delete(app.findCollectionByNameOrId('inverter_models'));
});
