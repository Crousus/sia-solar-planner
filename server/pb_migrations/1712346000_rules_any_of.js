/// <reference path="../pb_data/types.d.ts" />

// Rewrite access rules to use the "any of" operator `?=` for set/scalar
// comparisons against `@collection.*`.
//
// Bug observed: teams listing returned zero rows even for users with
// matching team_members. The rules used `@collection.team_members.X = Y`
// where the left side is a multi-valued set (all matching team_members
// rows) and the right side is a scalar. PocketBase's filter grammar
// requires the `?=` operator for that shape — plain `=` is evaluated as
// "all elements equal", which only holds for single-element sets. With
// ≥2 team_members records in the collection (common once the first user
// joins any second team), every such rule collapses to false and every
// list/view/create silently denies access.
//
// The affected rules span teams, team_members write paths, projects,
// and patches. This migration rewrites all of them in one pass so the
// schema is consistent.
//
// Why forward-only: automigrate skips migrations already applied on a
// given deployment. Editing the earlier 1712345600 / 1712345700 files
// in-place wouldn't re-run anywhere the migration already succeeded.

migrate((app) => {
  // ── teams
  const teams = app.findCollectionByNameOrId('teams');
  teams.listRule   = "@request.auth.id != '' && @collection.team_members.team ?= id && @collection.team_members.user ?= @request.auth.id";
  teams.viewRule   = "@request.auth.id != '' && @collection.team_members.team ?= id && @collection.team_members.user ?= @request.auth.id";
  // createRule unchanged — "any authenticated user can create a team".
  teams.updateRule = "@request.auth.id != '' && @collection.team_members.team ?= id && @collection.team_members.user ?= @request.auth.id && @collection.team_members.role ?= 'admin'";
  teams.deleteRule = "@request.auth.id != '' && @collection.team_members.team ?= id && @collection.team_members.user ?= @request.auth.id && @collection.team_members.role ?= 'admin'";
  app.save(teams);

  // ── team_members
  //   list/view rules already used ?= correctly. Only the write paths
  //   need the operator switch.
  const teamMembers = app.findCollectionByNameOrId('team_members');
  teamMembers.createRule = "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id && @collection.team_members.role ?= 'admin'";
  teamMembers.updateRule = "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id && @collection.team_members.role ?= 'admin'";
  teamMembers.deleteRule = "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id && @collection.team_members.role ?= 'admin'";
  app.save(teamMembers);

  // ── projects
  const projects = app.findCollectionByNameOrId('projects');
  projects.listRule   = "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id";
  projects.viewRule   = "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id";
  projects.createRule = "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id";
  // updateRule stays null — /api/sp/patch is the only write path.
  projects.deleteRule = "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id && @collection.team_members.role ?= 'admin'";
  app.save(projects);

  // ── patches
  const patches = app.findCollectionByNameOrId('patches');
  patches.listRule = "@request.auth.id != '' && @collection.team_members.team ?= project.team && @collection.team_members.user ?= @request.auth.id";
  patches.viewRule = "@request.auth.id != '' && @collection.team_members.team ?= project.team && @collection.team_members.user ?= @request.auth.id";
  // createRule / updateRule / deleteRule stay null — server-only writes.
  app.save(patches);
}, (app) => {
  // Down migration: restore the original (buggy) `=` syntax. Useful only
  // for rolling back a bad deploy; real recovery goes forward with
  // another migration.
  const teams = app.findCollectionByNameOrId('teams');
  teams.listRule   = "@request.auth.id != '' && @collection.team_members.team = id && @collection.team_members.user = @request.auth.id";
  teams.viewRule   = "@request.auth.id != '' && @collection.team_members.team = id && @collection.team_members.user = @request.auth.id";
  teams.updateRule = "@request.auth.id != '' && @collection.team_members.team = id && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'";
  teams.deleteRule = "@request.auth.id != '' && @collection.team_members.team = id && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'";
  app.save(teams);

  const teamMembers = app.findCollectionByNameOrId('team_members');
  teamMembers.createRule = "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'";
  teamMembers.updateRule = "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'";
  teamMembers.deleteRule = "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'";
  app.save(teamMembers);

  const projects = app.findCollectionByNameOrId('projects');
  projects.listRule   = "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id";
  projects.viewRule   = "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id";
  projects.createRule = "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id";
  projects.deleteRule = "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'";
  app.save(projects);

  const patches = app.findCollectionByNameOrId('patches');
  patches.listRule = "@request.auth.id != '' && @collection.team_members.team = project.team && @collection.team_members.user = @request.auth.id";
  patches.viewRule = "@request.auth.id != '' && @collection.team_members.team = project.team && @collection.team_members.user = @request.auth.id";
  app.save(patches);
});
