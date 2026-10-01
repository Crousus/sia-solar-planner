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
//
//	projects.updateRule is null — all project mutations go through custom
//	endpoints. /api/sp/patch owns doc+revision updates; this endpoint owns
//	the single customer relation field, keeping both concerns separate and
//	the patch endpoint free of non-OCC logic.
//
// No transaction needed: we're updating one field with no concurrent-write
// conflict risk (two users simultaneously picking a different customer is
// a "last write wins" scenario that's acceptable for a relation field).
//
// Error policy: "project doesn't exist" and "you're not in its team"
// return the same 404 (no existence oracle); likewise for customers of
// another team.
func handleSetCustomer(re *core.RequestEvent) error {
	if !isUserCaller(re) {
		return re.UnauthorizedError("sign-in required", nil)
	}

	body := setCustomerRequest{}
	if err := re.BindBody(&body); err != nil {
		return re.BadRequestError("invalid JSON body", nil)
	}
	if body.ProjectID == "" {
		return re.BadRequestError("projectId required", nil)
	}

	project, err := re.App.FindRecordById("projects", body.ProjectID)
	if err != nil || !isTeamMember(re.App, project.GetString("team"), re.Auth.Id) {
		return re.NotFoundError("project not found", nil)
	}
	teamID := project.GetString("team")

	if body.CustomerID != "" {
		// The customer must belong to the same team as the project, so a
		// member cannot link (and then expand/read) another team's customer.
		customer, err := re.App.FindRecordById("customers", body.CustomerID)
		if err != nil || customer.GetString("team") != teamID {
			return re.NotFoundError("customer not found", nil)
		}
		project.Set("customer", body.CustomerID)
	} else {
		// Empty string clears the relation field in PocketBase.
		project.Set("customer", "")
	}

	if err := re.App.Save(project); err != nil {
		re.App.Logger().Error("set-customer save failed", "project", project.Id, "error", err)
		return re.InternalServerError("save project failed", nil)
	}

	return re.JSON(http.StatusOK, map[string]string{"ok": "true"})
}

type setPanelModelRequest struct {
	ProjectID string `json:"projectId"`
	// PanelModelID links a global catalog row. Empty string unlinks.
	PanelModelID string `json:"panelModelId"`
}

// handleSetPanelModel sets or clears projects.panel_model.
//
// Why it exists: projects.updateRule is null, so the client's previous
// `pb.collection('projects').update(id, { panel_model })` call (in
// projectStore.setPanelModelFromCatalog) can never succeed for a regular
// user. Rather than opening the generic update rule (which would also let
// members rewrite `team`, `doc`, `revision`, …) this narrow endpoint owns
// the one column, mirroring set-customer.
//
// panel_models is a GLOBAL catalog, so any existing, non-deleted row is a
// legitimate link target regardless of team.
func handleSetPanelModel(re *core.RequestEvent) error {
	if !isUserCaller(re) {
		return re.UnauthorizedError("sign-in required", nil)
	}

	body := setPanelModelRequest{}
	if err := re.BindBody(&body); err != nil {
		return re.BadRequestError("invalid JSON body", nil)
	}
	if body.ProjectID == "" {
		return re.BadRequestError("projectId required", nil)
	}

	project, err := re.App.FindRecordById("projects", body.ProjectID)
	if err != nil || !isTeamMember(re.App, project.GetString("team"), re.Auth.Id) {
		return re.NotFoundError("project not found", nil)
	}

	if body.PanelModelID != "" {
		model, err := re.App.FindRecordById("panel_models", body.PanelModelID)
		if err != nil || model.GetBool("deleted") {
			return re.NotFoundError("panel model not found", nil)
		}
	}
	project.Set("panel_model", body.PanelModelID)

	if err := re.App.Save(project); err != nil {
		re.App.Logger().Error("set-panel-model save failed", "project", project.Id, "error", err)
		return re.InternalServerError("save project failed", nil)
	}
	return re.JSON(http.StatusOK, map[string]string{"ok": "true"})
}
