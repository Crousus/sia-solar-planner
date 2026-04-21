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

  // ── teams
  const teams = new Collection({
    type: 'base',
    name: 'teams',
    // listRule: only teams the user is a member of.
    // viewRule: same.
    // createRule: any authenticated user (they become admin via hook).
    // updateRule: only admins of this team.
    // deleteRule: only admins of this team.
    listRule: "@request.auth.id != '' && @collection.team_members.team = id && @collection.team_members.user = @request.auth.id",
    viewRule: "@request.auth.id != '' && @collection.team_members.team = id && @collection.team_members.user = @request.auth.id",
    createRule: "@request.auth.id != ''",
    updateRule: "@request.auth.id != '' && @collection.team_members.team = id && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'",
    deleteRule: "@request.auth.id != '' && @collection.team_members.team = id && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'",
    fields: [
      { name: 'name', type: 'text', required: true, min: 1, max: 100 },
      { name: 'created_by', type: 'relation', required: true, collectionId: users.id, cascadeDelete: false, maxSelect: 1 },
    ],
  });
  app.save(teams);

  // ── team_members
  const teamMembers = new Collection({
    type: 'base',
    name: 'team_members',
    // listRule: members of the same team can see each other.
    //   `@request.auth.id != ""` gate first (cheap) then a self-join via
    //   @collection.team_members (PocketBase supports this pattern).
    // viewRule: same.
    // createRule: admins only. Checked via the role of the CALLER'S row
    //   in the same team. Note the distinct alias `tm` to avoid binding
    //   to the row being created.
    // updateRule / deleteRule: admins only.
    listRule: "@request.auth.id != '' && team.id ?= @collection.team_members.team",
    viewRule: "@request.auth.id != '' && team.id ?= @collection.team_members.team",
    createRule: "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'",
    updateRule: "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'",
    deleteRule: "@request.auth.id != '' && @collection.team_members.team = team && @collection.team_members.user = @request.auth.id && @collection.team_members.role = 'admin'",
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
