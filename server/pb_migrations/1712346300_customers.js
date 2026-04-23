/// <reference path="../pb_data/types.d.ts" />

// Adds the `customers` collection (team-scoped contact data) and a
// `customer` relation field on `projects`.
//
// Why `customer` lives on the projects collection (not inside doc.meta):
//   Top-level PocketBase columns are SQL-filterable; JSON blob fields are
//   not. Keeping it as a proper relation lets the server filter
//   projects-by-customer without a full table scan, and lets PocketBase's
//   expand mechanism return the customer record in a single query.
//
// Why cascadeDelete: false on projects.customer:
//   Deleting a customer should NOT cascade-delete their projects. The
//   relation is simply nulled. Deleting the customer is admin-gated anyway.

migrate((app) => {
  const teams = app.findCollectionByNameOrId('teams');

  // ── customers ──────────────────────────────────────────────────────
  // Rules mirror the `projects` pattern: any team member can list/view/
  // create/update; only admins can delete (same policy as project delete).
  const customers = new Collection({
    type: 'base',
    name: 'customers',
    listRule:   "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id",
    viewRule:   "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id",
    createRule: "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id",
    updateRule: "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id",
    deleteRule: "@request.auth.id != '' && @collection.team_members.team ?= team && @collection.team_members.user ?= @request.auth.id && @collection.team_members.role ?= 'admin'",
    fields: [
      { name: 'team',        type: 'relation', required: true,  collectionId: teams.id, cascadeDelete: true, maxSelect: 1 },
      { name: 'name',        type: 'text',     required: true,  min: 1, max: 200 },
      { name: 'street',      type: 'text',     required: false, max: 200 },
      { name: 'housenumber', type: 'text',     required: false, max: 20  },
      { name: 'city',        type: 'text',     required: false, max: 100 },
      { name: 'postcode',    type: 'text',     required: false, max: 20  },
      { name: 'country',     type: 'text',     required: false, max: 100 },
      { name: 'phone',       type: 'text',     required: false, max: 50  },
      { name: 'email',       type: 'email',    required: false },
      { name: 'notes',       type: 'text',     required: false, max: 5000 },
      { name: 'created',     type: 'autodate', onCreate: true,  onUpdate: false },
      { name: 'updated',     type: 'autodate', onCreate: true,  onUpdate: true  },
    ],
  });
  app.save(customers);

  // ── projects.customer ───────────────────────────────────────────────
  // Optional relation — null means "no customer linked". cascadeDelete:
  // false so deleting a customer doesn't cascade-delete their projects.
  const projects = app.findCollectionByNameOrId('projects');
  projects.fields.add(new RelationField({
    name: 'customer',
    collectionId: customers.id,
    cascadeDelete: false,
    required: false,
    maxSelect: 1,
  }));
  app.save(projects);
}, (app) => {
  // Down: remove field first (FK constraint), then drop the collection.
  const projects = app.findCollectionByNameOrId('projects');
  projects.fields.removeByName('customer');
  app.save(projects);
  app.delete(app.findCollectionByNameOrId('customers'));
});
