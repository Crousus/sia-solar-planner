/// <reference path="../pb_data/types.d.ts" />

// Fix customers access rules: replace `=` with `?=` for @collection.*
// back-reference comparisons.
//
// Why: PocketBase evaluates `@collection.team_members.team = X` as
// "ALL team_members rows have team=X" (false for any set with ≥2 rows).
// `?=` means "ANY row matches", which is the intended check.
// The same bug was fixed for teams/projects/patches in migration
// 1712346000_rules_any_of.js; the customers migration was written after
// that fix and accidentally repeated the original `=` pattern.

migrate((app) => {
  const customers = app.findCollectionByNameOrId('customers');
  customers.listRule   = "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id";
  customers.viewRule   = "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id";
  customers.createRule = "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id";
  customers.updateRule = "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id";
  customers.deleteRule = "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id && @collection.team_members.role ?= 'admin'";
  app.save(customers);
}, (app) => {
  // Down: restore `=` (reverts to the buggy-but-once-was-deployed state).
  const customers = app.findCollectionByNameOrId('customers');
  customers.listRule   = "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id";
  customers.viewRule   = "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id";
  customers.createRule = "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id";
  customers.updateRule = "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id";
  customers.deleteRule = "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'";
  app.save(customers);
});
