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

// patch_test.go — /api/sp/patch (audit finding H4).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

func patchBody(projectID string, from int, ops any) map[string]any {
	return map[string]any{"projectId": projectID, "fromRevision": from, "ops": ops, "deviceId": "tab-1"}
}

func TestPatchHappyPathAndConflict(t *testing.T) {
	e := newEnv(t, envConfig{})
	alice := e.createUser("alice", true)
	team := e.createTeam("A", alice)
	p := e.createProject(team, map[string]any{"name": "Old", "roofs": []any{}})

	ops := []map[string]any{
		{"op": "replace", "path": "/name", "value": "New"},
		{"op": "add", "path": "/roofs/-", "value": map[string]any{"id": "r1"}},
		{"op": "test", "path": "/name", "value": "New"},
	}
	r := e.do(http.MethodPost, "/api/sp/patch", alice.token, patchBody(p.Id, 0, ops))
	expectStatus(t, r, 200)
	if r.body["newRevision"] != float64(1) {
		t.Fatalf("newRevision = %v", r.body["newRevision"])
	}
	got := e.reload("projects", p.Id)
	if got.GetInt("revision") != 1 || got.GetString("name") != "New" {
		t.Fatalf("project not updated: rev=%d name=%s", got.GetInt("revision"), got.GetString("name"))
	}
	n, _ := e.app.CountRecords("patches")
	if n != 1 {
		t.Fatalf("patches rows = %d, want 1", n)
	}

	// Stale revision → 409 with current state.
	r = e.do(http.MethodPost, "/api/sp/patch", alice.token, patchBody(p.Id, 0, ops[:1]))
	expectStatus(t, r, 409)
	if r.body["currentRevision"] != float64(1) || r.body["currentDoc"] == nil {
		t.Fatalf("bad conflict body: %s", r.raw)
	}

	if c := projectLockCount(); c != 0 {
		t.Fatalf("lock map leaked %d entries", c)
	}
}

func TestPatchRejectsNonMembersWithoutOracle(t *testing.T) {
	e := newEnv(t, envConfig{})
	alice := e.createUser("alice", true)
	mallory := e.createUser("mallory", true)
	team := e.createTeam("A", alice)
	p := e.createProject(team, map[string]any{"name": "P"})
	ops := []map[string]any{{"op": "replace", "path": "/name", "value": "pwned"}}

	a := e.do(http.MethodPost, "/api/sp/patch", mallory.token, patchBody(p.Id, 0, ops))
	b := e.do(http.MethodPost, "/api/sp/patch", mallory.token, patchBody("nonexistent0001", 0, ops))
	expectStatus(t, a, 404)
	expectStatus(t, b, 404)
	if a.str("message") != b.str("message") {
		t.Fatalf("existence oracle: %q vs %q", a.str("message"), b.str("message"))
	}
	if e.reload("projects", p.Id).GetString("name") != "Project" {
		t.Fatal("non-member patched the project")
	}

	// Random ids must not grow the lock map.
	for i := 0; i < 50; i++ {
		e.do(http.MethodPost, "/api/sp/patch", mallory.token, patchBody(fmt.Sprintf("rand%011d", i), 0, ops))
	}
	if c := projectLockCount(); c != 0 {
		t.Fatalf("lock map grew to %d entries", c)
	}

	// Anonymous → 401.
	expectStatus(t, e.do(http.MethodPost, "/api/sp/patch", "", patchBody(p.Id, 0, ops)), 401)
}

func TestPatchRejectsDangerousPatches(t *testing.T) {
	e := newEnv(t, envConfig{})
	alice := e.createUser("alice", true)
	team := e.createTeam("A", alice)
	p := e.createProject(team, map[string]any{"name": "P", "blob": map[string]any{"a": "x"}})

	// Copy bomb: each copy doubles the document. With evanphx defaults
	// (AccumulatedCopySizeLimit = 0 → unlimited) 40 of these exhaust RAM.
	bomb := []map[string]any{}
	for i := 0; i < 40; i++ {
		bomb = append(bomb, map[string]any{"op": "copy", "from": "/blob", "path": fmt.Sprintf("/blob/c%d", i)})
	}
	expectStatus(t, e.do(http.MethodPost, "/api/sp/patch", alice.token, patchBody(p.Id, 0, bomb)), 400)

	expectStatus(t, e.do(http.MethodPost, "/api/sp/patch", alice.token, patchBody(p.Id, 0,
		[]map[string]any{{"op": "move", "from": "/blob", "path": "/moved"}})), 400)
	expectStatus(t, e.do(http.MethodPost, "/api/sp/patch", alice.token, patchBody(p.Id, 0,
		[]map[string]any{{"op": "bogus", "path": "/x"}})), 400)
	expectStatus(t, e.do(http.MethodPost, "/api/sp/patch", alice.token, patchBody(p.Id, 0,
		[]map[string]any{{"op": "add", "value": 1}})), 400)
	expectStatus(t, e.do(http.MethodPost, "/api/sp/patch", alice.token, patchBody(p.Id, 0, []any{})), 400)

	// Too many ops.
	many := make([]map[string]any, maxPatchOps+1)
	for i := range many {
		many[i] = map[string]any{"op": "test", "path": "/name", "value": "P"}
	}
	expectStatus(t, e.do(http.MethodPost, "/api/sp/patch", alice.token, patchBody(p.Id, 0, many)), 400)

	// Oversized body → 413 before parsing.
	big := bytes.Repeat([]byte("a"), maxPatchBodyBytes+1024)
	op, _ := json.Marshal([]map[string]any{{"op": "replace", "path": "/name", "value": string(big)}})
	raw, _ := json.Marshal(map[string]any{"projectId": p.Id, "fromRevision": 0, "ops": json.RawMessage(op)})
	expectStatus(t, e.do(http.MethodPost, "/api/sp/patch", alice.token, raw), 413)

	// Over-long deviceId.
	b := patchBody(p.Id, 0, []map[string]any{{"op": "replace", "path": "/name", "value": "x"}})
	b["deviceId"] = string(bytes.Repeat([]byte("d"), 65))
	expectStatus(t, e.do(http.MethodPost, "/api/sp/patch", alice.token, b), 400)

	// Nothing above changed the project.
	if e.reload("projects", p.Id).GetInt("revision") != 0 {
		t.Fatal("a rejected patch was applied")
	}
}

// The copy limit itself (defense in depth if `copy` is ever re-allowed).
func TestApplyOptionsBoundCopies(t *testing.T) {
	doc := []byte(`{"blob":"` + string(bytes.Repeat([]byte("x"), 600<<10)) + `"}`)
	ops := []byte(`[{"op":"copy","from":"/blob","path":"/b1"},{"op":"copy","from":"/blob","path":"/b2"}]`)
	allowedPatchOps["copy"] = true
	defer delete(allowedPatchOps, "copy")
	patch, err := decodeAndValidatePatch(ops)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := applyBounded(patch, doc); err == nil {
		t.Fatal("expected AccumulatedCopySizeLimit to trip")
	}
}

// Legit worst case: locking the map puts a multi-MB captured image into
// the doc in ONE op. That must still go through end-to-end (body cap,
// doc cap, and patches.ops maxSize all have to agree).
func TestPatchAcceptsLargeCapturedImage(t *testing.T) {
	e := newEnv(t, envConfig{})
	alice := e.createUser("alice", true)
	team := e.createTeam("A", alice)
	p := e.createProject(team, map[string]any{"name": "P", "mapState": map[string]any{"locked": false}})

	img := "data:image/png;base64," + string(bytes.Repeat([]byte("A"), 15<<20))
	ops := []map[string]any{{"op": "replace", "path": "/mapState", "value": map[string]any{
		"locked": true, "capturedImage": img,
	}}}
	expectStatus(t, e.do(http.MethodPost, "/api/sp/patch", alice.token, patchBody(p.Id, 0, ops)), 200)
	if e.reload("projects", p.Id).GetInt("revision") != 1 {
		t.Fatal("large patch not applied")
	}
}
