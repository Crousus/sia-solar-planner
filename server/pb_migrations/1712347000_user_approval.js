/// <reference path="../pb_data/types.d.ts" />

// User approval gate migration.
//
// Adds `approved: bool` to the `users` collection so that newly-registered
// accounts can be held in a "pending" state until a superadmin approves them.
// The approval gate is only enforced when the server is started with
// REQUIRE_APPROVAL=true (see server/handlers/hooks.go). In dev/staging the
// flag is not set, so no gate exists and the field is purely informational.
//
// Backfill strategy:
//   All existing user rows are set to approved=true so current users are
//   not locked out when this migration runs on an existing database. Only
//   accounts created AFTER this migration run get approved=false by default.

migrate((app) => {
  const users = app.findCollectionByNameOrId('users');

  if (!users.fields.getByName('approved')) {
    users.fields.add(new BoolField({
      name: 'approved',
      required: false,
      // SQLite stores FALSE (0) for rows that omit this field on INSERT,
      // which is the behaviour we want for new sign-ups. No explicit default
      // needed; PocketBase BoolField defaults to false (0) in SQLite.
    }));
    app.save(users);

    // Backfill: mark every existing user as approved so they can still
    // sign in after the migration. New registrations arrive with approved=0.
    // We use raw SQL because PocketBase JS migrations don't expose a bulk-
    // update helper; the column is safe to target by name after the save()
    // above has created it.
    app.db().newQuery('UPDATE users SET approved = 1').execute();
  }
}, (app) => {
  // Down: remove the field. Existing data is lost — acceptable because the
  // field was only added by this migration.
  const users = app.findCollectionByNameOrId('users');
  if (users.fields.getByName('approved')) {
    users.fields.removeByName('approved');
    app.save(users);
  }
});
