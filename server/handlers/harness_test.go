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

// harness_test.go — shared test fixture.
//
// How it works:
//  1. TestMain registers our JS migrations (../pb_migrations) into
//     PocketBase's global migration registry via jsvm, exactly like
//     main.go does at runtime.
//  2. It builds ONE migrated "template" data dir (system migrations + ours).
//  3. Each test clones the template through tests.NewTestAppWithConfig
//     (fast: no re-migration), calls Register(app, opts) — the same wiring
//     main() uses — triggers OnServe on a fresh router and serves it from
//     an httptest.Server. Tests then speak plain HTTP to it, so rules,
//     hooks, middleware and custom routes are all exercised end-to-end.
//
// We use a real HTTP server rather than tests.ApiScenario because most of
// these tests are multi-step flows (sign up → log in → use token → …).

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
	"github.com/pocketbase/pocketbase/tests"
)

var templateDataDir string

func TestMain(m *testing.M) {
	code, err := setupAndRun(m)
	if err != nil {
		panic(err)
	}
	os.Exit(code)
}

func setupAndRun(m *testing.M) (int, error) {
	root, err := os.MkdirTemp("", "sp-handlers-test-")
	if err != nil {
		return 1, err
	}
	defer os.RemoveAll(root)

	templateDataDir = filepath.Join(root, "pb_data")
	if err := os.MkdirAll(templateDataDir, 0o755); err != nil {
		return 1, err
	}

	migrationsDir, err := filepath.Abs("../pb_migrations")
	if err != nil {
		return 1, err
	}

	base := core.NewBaseApp(core.BaseAppConfig{DataDir: templateDataDir})
	// Registers the JS migrations into core.AppMigrations (global). Must
	// happen exactly once per process.
	if err := jsvm.Register(base, jsvm.Config{
		MigrationsDir: migrationsDir,
		HooksDir:      filepath.Join(root, "no_hooks"),
		TypesDir:      root,
	}); err != nil {
		return 1, err
	}
	if err := base.Bootstrap(); err != nil {
		return 1, err
	}
	if err := base.RunAllMigrations(); err != nil {
		return 1, err
	}
	// Close the DB so the template is fully checkpointed before cloning.
	if err := base.ClearBootstrap(); err != nil {
		return 1, err
	}

	return m.Run(), nil
}

// ── per-test environment ──────────────────────────────────────────────

type testEnv struct {
	t   *testing.T
	app *tests.TestApp
	srv *httptest.Server
}

type envConfig struct {
	opts Options
	// keepRateLimits leaves the migration's rate-limit settings enabled.
	// Most tests turn them off: every request comes from the same IP and
	// the suite would trip `*:auth` quickly.
	keepRateLimits bool
}

func newEnv(t *testing.T, cfg envConfig) *testEnv {
	t.Helper()
	app, err := tests.NewTestAppWithConfig(core.BaseAppConfig{DataDir: templateDataDir})
	if err != nil {
		t.Fatalf("test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	if !cfg.keepRateLimits {
		app.Settings().RateLimits.Enabled = false
	}

	Register(app, cfg.opts)

	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	se := &core.ServeEvent{App: app, Router: router}
	var mux http.Handler
	err = app.OnServe().Trigger(se, func(e *core.ServeEvent) error {
		m, err := e.Router.BuildMux()
		mux = m
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &testEnv{t: t, app: app, srv: srv}
}

type resp struct {
	status int
	body   map[string]any
	raw    []byte
	header http.Header
}

func (r resp) str(k string) string {
	s, _ := r.body[k].(string)
	return s
}

// do sends a JSON request. body may be nil, a []byte (sent verbatim) or
// any JSON-marshalable value. headers are optional key/value pairs.
func (e *testEnv) do(method, path, token string, body any, headers ...string) resp {
	e.t.Helper()
	var rdr io.Reader
	switch b := body.(type) {
	case nil:
	case []byte:
		rdr = bytes.NewReader(b)
	default:
		buf, err := json.Marshal(b)
		if err != nil {
			e.t.Fatal(err)
		}
		rdr = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, e.srv.URL+path, rdr)
	if err != nil {
		e.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := resp{status: res.StatusCode, raw: raw, header: res.Header}
	_ = json.Unmarshal(raw, &out.body)
	return out
}

// ── fixtures (direct DB writes; bypass rules on purpose) ───────────────

const testPassword = "Correct-Horse-Battery-9"

type user struct {
	rec   *core.Record
	email string
	token string // pre-minted auth token (valid regardless of approval)
}

func (e *testEnv) createUser(name string, approved bool) user {
	e.t.Helper()
	col, err := e.app.FindCollectionByNameOrId("users")
	if err != nil {
		e.t.Fatal(err)
	}
	rec := core.NewRecord(col)
	email := name + "@example.com"
	rec.SetEmail(email)
	rec.SetPassword(testPassword)
	rec.Set("name", name)
	rec.Set("approved", approved)
	if err := e.app.Save(rec); err != nil {
		e.t.Fatalf("create user: %v", err)
	}
	tok, err := rec.NewAuthToken()
	if err != nil {
		e.t.Fatal(err)
	}
	return user{rec: rec, email: email, token: tok}
}

func (e *testEnv) superuserToken() string {
	e.t.Helper()
	col, err := e.app.FindCollectionByNameOrId(core.CollectionNameSuperusers)
	if err != nil {
		e.t.Fatal(err)
	}
	rec := core.NewRecord(col)
	rec.SetEmail("root@example.com")
	rec.SetPassword(testPassword)
	if err := e.app.Save(rec); err != nil {
		e.t.Fatal(err)
	}
	tok, err := rec.NewAuthToken()
	if err != nil {
		e.t.Fatal(err)
	}
	return tok
}

func (e *testEnv) createTeam(name string, admin user) *core.Record {
	e.t.Helper()
	col, _ := e.app.FindCollectionByNameOrId("teams")
	team := core.NewRecord(col)
	team.Set("name", name)
	team.Set("created_by", admin.rec.Id)
	if err := e.app.Save(team); err != nil {
		e.t.Fatal(err)
	}
	e.addMember(team, admin, "admin")
	return team
}

func (e *testEnv) addMember(team *core.Record, u user, role string) *core.Record {
	e.t.Helper()
	col, _ := e.app.FindCollectionByNameOrId("team_members")
	m := core.NewRecord(col)
	m.Set("team", team.Id)
	m.Set("user", u.rec.Id)
	m.Set("role", role)
	if err := e.app.Save(m); err != nil {
		e.t.Fatal(err)
	}
	return m
}

func (e *testEnv) membership(team *core.Record, u user) *core.Record {
	e.t.Helper()
	rec, err := e.app.FindFirstRecordByFilter("team_members", "team = {:t} && user = {:u}",
		dbx.Params{"t": team.Id, "u": u.rec.Id})
	if err != nil {
		e.t.Fatalf("no membership for %s in %s: %v", u.email, team.Id, err)
	}
	return rec
}

func (e *testEnv) createProject(team *core.Record, doc map[string]any) *core.Record {
	e.t.Helper()
	col, _ := e.app.FindCollectionByNameOrId("projects")
	p := core.NewRecord(col)
	p.Set("team", team.Id)
	p.Set("name", "Project")
	p.Set("doc", doc)
	p.Set("revision", 0)
	if err := e.app.Save(p); err != nil {
		e.t.Fatal(err)
	}
	return p
}

func (e *testEnv) createCustomer(team *core.Record, name string) *core.Record {
	e.t.Helper()
	col, _ := e.app.FindCollectionByNameOrId("customers")
	c := core.NewRecord(col)
	c.Set("team", team.Id)
	c.Set("name", name)
	if err := e.app.Save(c); err != nil {
		e.t.Fatal(err)
	}
	return c
}

func (e *testEnv) reload(collection, id string) *core.Record {
	e.t.Helper()
	rec, err := e.app.FindRecordById(collection, id)
	if err != nil {
		e.t.Fatalf("reload %s/%s: %v", collection, id, err)
	}
	return rec
}

func expectStatus(t *testing.T, r resp, want ...int) {
	t.Helper()
	for _, w := range want {
		if r.status == w {
			return
		}
	}
	t.Fatalf("status = %d, want one of %v; body=%s", r.status, want, truncateRunes(string(r.raw), 500))
}

// expectDenied accepts any of PocketBase's "no" answers. Which one a rule
// failure produces (400/403/404) is a PocketBase implementation detail;
// what matters is that it isn't a success and the DB didn't change.
func expectDenied(t *testing.T, r resp) {
	t.Helper()
	if r.status >= 200 && r.status < 300 {
		t.Fatalf("expected request to be denied, got %d: %s", r.status, truncateRunes(string(r.raw), 500))
	}
}
