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
	"github.com/pocketbase/pocketbase/plugins/jsvm"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"
)

func main() {
	app := pocketbase.New()

	// Wire up the jsvm plugin so PocketBase picks up our JS migrations in
	// ./pb_migrations (and JS hooks in ./pb_hooks, should we ever add any).
	//
	// Why this is needed:
	//   The stock `./pocketbase` binary (examples/base/main.go in the
	//   PocketBase repo) registers this automatically, so most users never
	//   see this step. Custom builds — which we need for our /api/sp/patch
	//   route and Go-side hooks — do NOT get it for free; without this
	//   call, our JS migrations simply never execute and the SQLite file
	//   ends up with only the built-in collections (users, _superusers,
	//   …). The blank `_ "…/migrations"` import only registers Go-code
	//   migrations, NOT the JS files.
	//
	// Defaults we rely on:
	//   - MigrationsDir resolves to <data>/../pb_migrations → ./pb_migrations
	//   - HooksDir resolves to <data>/../pb_hooks → ./pb_hooks
	//   Both live next to the binary in our deploy layout, so defaults fit.
	jsvm.MustRegister(app, jsvm.Config{})

	// Register the migrate command with JS templates + automigrate so that
	// `./pocketbase serve` applies any pending JS migration on boot. The
	// stock binary also does this in examples/base/main.go. We want this
	// in prod too — the server is single-node and migrations are authored
	// by us, not user-submitted. Baking Automigrate:true into code
	// prevents an operator from starting the server without it and
	// producing a schema-less SQLite.
	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{
		TemplateLang: migratecmd.TemplateLangJS,
		Automigrate:  true,
	})

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
