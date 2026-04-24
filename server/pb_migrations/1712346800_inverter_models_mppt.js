/// <reference path="../pb_data/types.d.ts" />

// Adds MPPT-related fields to inverter_models.
//
// These fields are commonly listed on datasheet spec tables and are
// important for string layout design:
//   mpptCount      — how many independent MPPT trackers the inverter has
//   maxDcCurrentA  — maximum DC input current per string / per MPPT (A)
//   stringsPerMppt — how many parallel strings each MPPT port accepts

migrate((app) => {
  const col = app.findCollectionByNameOrId('inverter_models');
  col.fields.add(new Field({ name: 'mpptCount',      type: 'number', required: false }));
  col.fields.add(new Field({ name: 'maxDcCurrentA',  type: 'number', required: false }));
  col.fields.add(new Field({ name: 'stringsPerMppt', type: 'number', required: false }));
  app.save(col);
}, (app) => {
  const col = app.findCollectionByNameOrId('inverter_models');
  col.fields.removeByName('mpptCount');
  col.fields.removeByName('maxDcCurrentA');
  col.fields.removeByName('stringsPerMppt');
  app.save(col);
});
