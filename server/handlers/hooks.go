// Solar Planner - Frontend web application for designing and planning rooftop solar panel installations
// Copyright (C) 2026  Johannes Wenz github.com/Crousus
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package handlers

import (
	"fmt"
	"net/http"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// ── teams + team_members ───────────────────────────────────────────────

// registerTeamHooks wires three invariants around teams:
//
//  1. teams.created_by is the authenticated caller, never a client value
//     (audit: it was client-supplied and spoofable — any user could create
//     a team "created by" a colleague). Same pattern as projects.created_by.
//
//  2. The creator becomes the team's first admin (team_members row).
//
//  3. A team always keeps at least one admin: the last admin can't be
//     demoted or removed via the API. Otherwise an admin could
//     accidentally (or a compromised admin deliberately) orphan a team so
//     that nobody can manage members any more.
func registerTeamHooks(app core.App) {
	// Why OnRecordCreateRequest (request-scoped) instead of
	// OnRecordAfterCreateSuccess (model-scoped): model events don't carry
	// the authenticated caller — `Auth` lives on RequestEvent, which is
	// only embedded in *RequestEvent hook events. Non-API creates (admin
	// UI with a superuser token, migrations, internal code) are handled by
	// the `isUserCaller` branch below.
	app.OnRecordCreateRequest("teams").BindFunc(func(e *core.RecordRequestEvent) error {
		// Superuser (admin UI) creates keep the submitted created_by: a
		// superuser id lives in _superusers and can't satisfy the users
		// relation anyway, and the admin explicitly picked an owner.
		if !isUserCaller(e.RequestEvent) {
			return e.Next()
		}

		// Set BEFORE e.Next() so the value passes validation (the field is
		// required) and is what gets persisted. Clients may keep sending
		// created_by — it's simply overwritten.
		e.Record.Set("created_by", e.Auth.Id)

		if err := e.Next(); err != nil {
			return err
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
			// (Not a single transaction: the default handler has already
			// committed and written the response by now. Worst case if the
			// delete also fails is an orphan team only a superuser sees.)
			if delErr := e.App.Delete(e.Record); delErr != nil {
				e.App.Logger().Error("team auto-admin rollback failed", "team", e.Record.Id, "error", delErr)
			}
			return fmt.Errorf("could not create team_members admin row: %w", err)
		}
		return nil
	})

	// Last-admin guard (update: demotion).
	app.OnRecordUpdateRequest("team_members").BindFunc(func(e *core.RecordRequestEvent) error {
		orig := e.Record.Original()
		if orig.GetString("role") == "admin" && e.Record.GetString("role") != "admin" {
			if err := ensureAnotherAdmin(e.App, orig.GetString("team"), orig.Id); err != nil {
				return e.BadRequestError(err.Error(), nil)
			}
		}
		return e.Next()
	})
	// Last-admin guard (delete: removal). Cascade deletes triggered by
	// deleting the team itself don't go through this request hook, so
	// deleting a whole team still works.
	app.OnRecordDeleteRequest("team_members").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.Record.GetString("role") == "admin" {
			if err := ensureAnotherAdmin(e.App, e.Record.GetString("team"), e.Record.Id); err != nil {
				return e.BadRequestError(err.Error(), nil)
			}
		}
		return e.Next()
	})
}

// ensureAnotherAdmin returns an error unless `team` has at least one admin
// membership other than `exceptMemberID`.
func ensureAnotherAdmin(app core.App, team, exceptMemberID string) error {
	n, err := app.CountRecords("team_members", dbx.HashExp{"team": team, "role": "admin"}, dbx.Not(dbx.HashExp{"id": exceptMemberID}))
	if err != nil {
		return fmt.Errorf("could not verify remaining admins")
	}
	if n == 0 {
		return fmt.Errorf("a team must keep at least one admin")
	}
	return nil
}

// ── projects ───────────────────────────────────────────────────────────

// Stamps the authenticated caller onto `projects.created_by` during the
// create request so the client can't impersonate a different "planner"
// at creation time. The client is allowed to send `created_by` in the
// payload but we always overwrite it here — trusting client-supplied
// identity on a field that feeds the printed PDF would be a soft
// forgery vector (any team member could produce an export that names a
// colleague as the planner).
func registerProjectCreator(app core.App) {
	app.OnRecordCreateRequest("projects").BindFunc(func(e *core.RecordRequestEvent) error {
		if isUserCaller(e.RequestEvent) {
			e.Record.Set("created_by", e.Auth.Id)
		}
		return e.Next()
	})
}

// ── global catalogs ────────────────────────────────────────────────────

// registerCatalogHooks protects the GLOBAL panel_models / inverter_models
// catalogs, which every team reads. A write there is a cross-tenant write,
// so (together with the API rules in migration 1712347100):
//
//   - created_by is forced to the caller → update/delete rules can
//     restrict edits to the creator.
//   - DELETE from a regular user becomes a soft delete (deleted = true).
//     Projects reference catalog rows (projects.panel_model, and inverter
//     ids inside the opaque doc), the whole app is built around
//     soft-delete, and a hard delete by any signed-in user was the
//     "anyone can wipe the catalog" finding. Mapping DELETE → soft delete
//     (rather than just forbidding it) keeps the existing CatalogPage
//     delete buttons working unchanged. Superusers still hard-delete.
func registerCatalogHooks(app core.App) {
	for _, name := range []string{"panel_models", "inverter_models"} {
		app.OnRecordCreateRequest(name).BindFunc(func(e *core.RecordRequestEvent) error {
			if isUserCaller(e.RequestEvent) {
				e.Record.Set("created_by", e.Auth.Id)
			}
			return e.Next()
		})
		app.OnRecordDeleteRequest(name).BindFunc(func(e *core.RecordRequestEvent) error {
			if e.HasSuperuserAuth() {
				return e.Next()
			}
			e.Record.Set("deleted", true)
			if err := e.App.Save(e.Record); err != nil {
				return e.BadRequestError("could not delete catalog entry", err)
			}
			return e.NoContent(http.StatusNoContent)
		})
	}
}

// ── patches TTL ────────────────────────────────────────────────────────

// Hourly cleanup: delete patches records older than 1 hour. Their only
// purpose is live SSE fanout to currently-connected clients; offline
// clients reconnect and full-resync against `doc` at the current
// revision. Keeping historical patches costs disk and pollutes list
// queries.
func registerPatchTTL(app core.App) {
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
