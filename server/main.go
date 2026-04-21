// server/main.go — PocketBase host for Solar Planner.
//
// Composition:
//   - Embeds the PocketBase framework. `app.Start()` boots the built-in
//     HTTP server, SQLite connection, admin UI, auth routes, and realtime
//     SSE endpoint.
//   - Registers our custom /api/sp/patch route (see handlers/patch.go).
//   - Registers lifecycle hooks (see handlers/hooks.go): auto-admin on
//     team creation, TTL cron on patches.
//
// Why a single binary?
//   PocketBase's design — one Go binary embedding SQLite — keeps ops to
//   "scp and ./pocketbase serve". Adding a separate service would double
//   the deployment burden for a team tool that runs on a single VPS.
//
// Why custom route alongside stock collections?
//   The default PocketBase record-update endpoint ignores the body's shape
//   beyond known collection fields and has no notion of RFC 6902 JSON Patch
//   or per-row revision-based optimistic concurrency. Implementing both
//   would require so much filtering of the default behaviour that it's
//   simpler to disable update-via-default-endpoint for projects (rule set
//   to @request.auth.id = "") and route all edits through /api/sp/patch.
package main

import (
	"log"
	"os"

	"solar-planner/server/handlers"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	_ "github.com/pocketbase/pocketbase/migrations"
)

func main() {
	app := pocketbase.New()

	// `automigrate: true` on the default migrate runner auto-applies any
	// JS file in ./pb_migrations on boot. We want this in prod too — the
	// server is single-node and migrations are authored by us, not
	// user-submitted. The `--automigrate` flag is also accepted as a CLI
	// override, but baking it into code prevents an operator from starting
	// the server without it and producing a schema-less SQLite.
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		handlers.RegisterRoutes(app, e)
		return e.Next()
	})

	handlers.RegisterHooks(app)

	if err := app.Start(); err != nil {
		log.Printf("pocketbase exited: %v", err)
		os.Exit(1)
	}
}
