/// <reference path="../pb_data/types.d.ts" />

// Initial schema migration — users, teams, team_members.
//
// IDs: PocketBase default 15-char base36 auto-ids. We do NOT use our
// app's 8-char base36 uid() for outer records — that's for in-project
// entities (roof/panel/string/inverter IDs) and stays inside the JSON
// `doc` field on projects.

migrate((app) => {
  // ── users — extend the built-in auth collection with a `name` field.
  const users = app.findCollectionByNameOrId('users');
  // Add `name` as a required text field if it isn't already there.
  // PocketBase's built-in users collection ships with name/avatar/verified
  // in newer versions, but we set the API rules explicitly to lock down
  // user enumeration.
  if (!users.fields.getByName('name')) {
    users.fields.add(new TextField({
      name: 'name',
      required: true,
      min: 1,
      max: 100,
    }));
  }
  // Lock down user listing — members should be able to see OTHER users'
  // names (for displaying "Inviter: Alice" and in team member lists),
  // but only by direct ID lookup, not by email enumeration. The list
  // rule empty string = deny-all; view rule = authenticated.
  users.listRule = null;
  users.viewRule = '@request.auth.id != ""';
  app.save(users);

  // ── teams + team_members
  //
  // Circular rule references:
  //   The `teams` list/view/update/delete rules cross-reference
  //   `@collection.team_members`, and vice versa. PocketBase validates
  //   rule expressions at save-time and will refuse to save a rule that
  //   names a collection that doesn't exist yet. So we do a two-pass:
  //     1. create both collections with EMPTY rules (access fully locked
  //        down — only server code can touch them, which is safe during
  //        migration).
  //     2. set the real rules and re-save once both exist.

  // ── teams (pass 1 — no rules yet)
  const teams = new Collection({
    type: 'base',
    name: 'teams',
    // Rules filled in pass 2 below.
    fields: [
      { name: 'name', type: 'text', required: true, min: 1, max: 100 },
      { name: 'created_by', type: 'relation', required: true, collectionId: users.id, cascadeDelete: false, maxSelect: 1 },
    ],
  });
  app.save(teams);

  // ── team_members (pass 1 — no rules yet)
  const teamMembers = new Collection({
    type: 'base',
    name: 'team_members',
    // Rules filled in pass 2 below.
    fields: [
      { name: 'team', type: 'relation', required: true, collectionId: teams.id, cascadeDelete: true, maxSelect: 1 },
      { name: 'user', type: 'relation', required: true, collectionId: users.id, cascadeDelete: true, maxSelect: 1 },
      { name: 'role', type: 'select', required: true, maxSelect: 1, values: ['admin', 'member'] },
    ],
    indexes: [
      // Composite unique — a user can only appear once per team.
      'CREATE UNIQUE INDEX idx_team_members_team_user ON team_members (team, user)',
    ],
  });
  app.save(teamMembers);

  // ── pass 2: now that both collections exist, install the cross-
  // referencing access rules.
  //
  // teams:
  //   listRule: only teams the user is a member of.
  //   viewRule: same.
  //   createRule: any authenticated user (they become admin via hook).
  //   updateRule: only admins of this team.
  //   deleteRule: only admins of this team.
  teams.listRule = "@request.auth.id != '' && @collection.team_members.team = id && @collection.team_members.user = @request.auth.id";
  teams.viewRule = "@request.auth.id != '' && @collection.team_members.team = id && @collection.team_members.user = @request.auth.id";
  teams.createRule = "@request.auth.id != ''";
  teams.updateRule = "@request.auth.id != '' && @collection.team_members.team = id && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'";
  teams.deleteRule = "@request.auth.id != '' && @collection.team_members.team = id && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'";
  app.save(teams);

  // team_members:
  //   listRule: members of the same team can see each other.
  //     `@request.auth.id != ""` gate first (cheap) then a self-join via
  //     @collection.team_members (PocketBase supports this pattern).
  //   viewRule: same.
  //   createRule / updateRule / deleteRule: admins only. Checked via the
  //     role of the CALLER'S row in the same team.
  teamMembers.listRule = "@request.auth.id != '' && team.id ?= @collection.team_members.team";
  teamMembers.viewRule = "@request.auth.id != '' && team.id ?= @collection.team_members.team";
  teamMembers.createRule = "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'";
  teamMembers.updateRule = "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'";
  teamMembers.deleteRule = "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'";
  app.save(teamMembers);
}, (app) => {
  // Down migration: reverse order of deletion to avoid FK constraints.
  app.delete(app.findCollectionByNameOrId('team_members'));
  app.delete(app.findCollectionByNameOrId('teams'));
  // Users is a built-in collection; we only added a field. Remove it.
  const users = app.findCollectionByNameOrId('users');
  if (users.fields.getByName('name')) {
    users.fields.removeByName('name');
    app.save(users);
  }
});
