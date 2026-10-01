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
	"os"

	"github.com/pocketbase/pocketbase/core"
)

// Options carries deployment-time policy into the handler package.
//
// WHY a struct instead of reading env vars deep inside each hook: the Go
// tests need to boot the same wiring with different policies in one
// process (approval on / off). Reading os.Getenv at registration time
// inside the hooks made that impossible without t.Setenv races.
type Options struct {
	// RequireApproval gates sign-in on users.approved = true. See
	// approval.go for the full enforcement story.
	RequireApproval bool
}

// OptionsFromEnv builds Options from the process environment. Only
// main() should call this; tests construct Options directly.
//
//	REQUIRE_APPROVAL=true  → new sign-ups cannot obtain a token until a
//	                         superuser sets users.approved = true.
//
// The default is OFF so `./pocketbase serve` in dev and the vitest
// integration harness keep working without an approval step; the
// production docker-compose.yml sets it to "true".
func OptionsFromEnv() Options {
	return Options{
		RequireApproval: os.Getenv("REQUIRE_APPROVAL") == "true",
	}
}

// Register wires every custom route, middleware and lifecycle hook onto
// the app. It accepts core.App (not *pocketbase.PocketBase) so the test
// suite can call it on a tests.TestApp.
func Register(app core.App, opts Options) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		registerApprovalMiddleware(e, opts)
		registerRoutes(e)
		return e.Next()
	})

	registerTeamHooks(app)
	registerProjectCreator(app)
	registerCatalogHooks(app)
	registerPatchTTL(app)
	registerApprovalHooks(app, opts)
}

// registerRoutes attaches our custom /api/sp/* routes. Every handler
// resolves the app from the request event (re.App) rather than closing
// over a global, which keeps them usable from tests.
func registerRoutes(e *core.ServeEvent) {
	e.Router.POST("/api/sp/patch", handlePatch)
	// /api/sp/set-customer and /api/sp/set-panel-model own the two
	// relation columns on projects. projects.updateRule is null, so these
	// (plus /api/sp/patch) are the only project write paths. See
	// set_customer.go.
	e.Router.POST("/api/sp/set-customer", handleSetCustomer)
	e.Router.POST("/api/sp/set-panel-model", handleSetPanelModel)
	// /api/sp/team-members: admin-only "add a member by e-mail". Exists
	// because users.listRule is null (no user enumeration), so the client
	// cannot look a user up by e-mail itself. See team_invite.go.
	e.Router.POST("/api/sp/team-members", handleAddTeamMember)
	// /api/sp/parse-datasheet proxies to the ocr-service sidecar.
	// Auth + SSRF validation happen here; PDF download, OCR, and LLM
	// extraction happen in the Python service. See datasheetImport.go.
	e.Router.POST("/api/sp/parse-datasheet", handleDatasheetImport)
}
