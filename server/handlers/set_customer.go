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
	"net/http"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

// setCustomerRequest is the body parsed from POST /api/sp/set-customer.
type setCustomerRequest struct {
	ProjectID string `json:"projectId"`
	// CustomerID is the ID of the customer to link. Empty string unlinks.
	CustomerID string `json:"customerId"`
}

// handleSetCustomer sets or clears the `customer` relation field on a project.
//
// Why a dedicated endpoint (not the default collection PATCH):
//   projects.updateRule is null — all project mutations go through custom
//   endpoints. /api/sp/patch owns doc+revision updates; this endpoint owns
//   the single customer relation field, keeping both concerns separate and
//   the patch endpoint free of non-OCC logic.
//
// No transaction needed: we're updating one field with no concurrent-write
// conflict risk (two users simultaneously picking a different customer is
// a "last write wins" scenario that's acceptable for a relation field).
func handleSetCustomer(app *pocketbase.PocketBase, re *core.RequestEvent) error {
	if re.Auth == nil || re.Auth.Collection().Name != "users" {
		return re.UnauthorizedError("sign-in required", nil)
	}

	body := setCustomerRequest{}
	if err := re.BindBody(&body); err != nil {
		return re.BadRequestError("invalid JSON body", err)
	}
	if body.ProjectID == "" {
		return re.BadRequestError("projectId required", nil)
	}

	project, err := app.FindRecordById("projects", body.ProjectID)
	if err != nil {
		return re.NotFoundError("project not found", nil)
	}

	// Verify the caller is a member of this project's team.
	teamID := project.GetString("team")
	members, err := app.FindRecordsByFilter(
		"team_members",
		"team = {:team} && user = {:user}",
		"", 1, 0,
		map[string]any{"team": teamID, "user": re.Auth.Id},
	)
	if err != nil || len(members) == 0 {
		return re.ForbiddenError("not a member of this project's team", nil)
	}

	if body.CustomerID != "" {
		// Verify the customer belongs to the same team as the project,
		// so a member cannot link a project to another team's customer.
		customer, err := app.FindRecordById("customers", body.CustomerID)
		if err != nil {
			return re.NotFoundError("customer not found", nil)
		}
		if customer.GetString("team") != teamID {
			return re.ForbiddenError("customer does not belong to this project's team", nil)
		}
		project.Set("customer", body.CustomerID)
	} else {
		// Empty string clears the relation field in PocketBase.
		project.Set("customer", "")
	}

	if err := app.Save(project); err != nil {
		return re.InternalServerError("save project failed", err)
	}

	return re.JSON(http.StatusOK, map[string]string{"ok": "true"})
}
