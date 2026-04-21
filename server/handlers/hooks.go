package handlers

import (
	"fmt"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

// RegisterHooks wires lifecycle integrations onto the PocketBase app.
// Called once from main(); idempotent per-boot.
func RegisterHooks(app *pocketbase.PocketBase) {
	registerTeamAutoAdmin(app)
	registerPatchTTL(app)
}

// After a `teams` record is created via the API, auto-insert a
// `team_members` row binding the creator as admin. Without this hook, the
// brand-new team's list rule (member-of) would exclude its own creator,
// rendering it invisible from the API.
//
// Why OnRecordCreateRequest (request-scoped) instead of
// OnRecordAfterCreateSuccess (model-scoped): in PocketBase v0.23 the
// RecordEvent emitted by *AfterCreateSuccess hooks does NOT carry the
// authenticated caller — `Auth` lives on RequestEvent, which is only
// embedded in *RequestEvent hook events. We need the caller's ID to pick
// an admin, so we bind at request time, call e.Next() to let the default
// create handler persist the team, and if that succeeded we then write the
// team_members row. Non-API creates (Admin UI, migrations, internal code)
// simply don't fire this hook — consistent with the "skip when caller
// unknown" branch in the original design.
//
// The two writes are NOT in a single transaction — a failure in the
// member insert tries to roll back by deleting the team. Acceptable risk:
// if the delete itself fails the worst case is an orphan team that the
// user can delete and retry.
func registerTeamAutoAdmin(app *pocketbase.PocketBase) {
	app.OnRecordCreateRequest("teams").BindFunc(func(e *core.RecordRequestEvent) error {
		// Run the default create first; bail if it fails so we don't
		// leave any partial state and so validation errors surface as
		// usual to the caller.
		if err := e.Next(); err != nil {
			return err
		}

		// `e.Auth` is the authenticated caller (embedded via RequestEvent).
		// If it's nil, the create came from an unauthenticated path we
		// don't expect for teams — skip auto-admin because we don't know
		// whom to elect. (In practice the collection's createRule should
		// reject anonymous creates, so this branch is defensive.)
		if e.Auth == nil {
			return nil
		}

		memberCollection, err := e.App.FindCollectionByNameOrId("team_members")
		if err != nil {
			return fmt.Errorf("team_members collection missing: %w", err)
		}

		member := core.NewRecord(memberCollection)
		member.Set("team", e.Record.Id)
		member.Set("user", e.Auth.Id)
		member.Set("role", "admin")
		if err := e.App.Save(member); err != nil {
			// Roll back the team creation by deleting it. This keeps the
			// invariant "every team has at least one admin member" true.
			// The returned error propagates to the HTTP caller as a 500.
			e.App.Delete(e.Record)
			return fmt.Errorf("could not create team_members admin row: %w", err)
		}
		return nil
	})
}

// Hourly cleanup: delete patches records older than 1 hour. Their only
// purpose is live SSE fanout to currently-connected clients; offline
// clients reconnect and full-resync against `doc` at the current
// revision. Keeping historical patches costs disk and pollutes list
// queries.
func registerPatchTTL(app *pocketbase.PocketBase) {
	app.Cron().MustAdd("trimPatches", "0 * * * *", func() {
		cutoff := time.Now().Add(-1 * time.Hour).UTC().Format(time.DateTime)
		_, err := app.DB().NewQuery(
			"DELETE FROM patches WHERE created < {:cutoff}",
		).Bind(map[string]any{"cutoff": cutoff}).Execute()
		if err != nil {
			// Log-and-continue. Next run will catch any rows missed.
			app.Logger().Error("trimPatches failed", "error", err)
		}
	})
}
