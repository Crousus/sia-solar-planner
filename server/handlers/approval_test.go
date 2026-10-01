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

// approval_test.go — audit finding C2 (approval gate ineffective).

import (
	"net/http"
	"strings"
	"testing"
)

func login(e *testEnv, email string) resp {
	e.t.Helper()
	return e.do(http.MethodPost, "/api/collections/users/auth-with-password", "",
		map[string]any{"identity": email, "password": testPassword})
}

func TestApprovalGateBlocksTokenIssuance(t *testing.T) {
	e := newEnv(t, envConfig{opts: Options{RequireApproval: true}})
	pending := e.createUser("pending", false)
	ok := e.createUser("ok", true)

	// Password login: 403, and crucially NO token in the body.
	r := login(e, pending.email)
	expectStatus(t, r, 403)
	if strings.Contains(string(r.raw), `"token"`) {
		t.Fatalf("token leaked for unapproved user: %s", r.raw)
	}

	// Wrong password still gets PocketBase's generic 400 (no pending
	// message → no account-existence oracle).
	r = e.do(http.MethodPost, "/api/collections/users/auth-with-password", "",
		map[string]any{"identity": pending.email, "password": "wrong-password-123"})
	expectStatus(t, r, 400)
	if strings.Contains(string(r.raw), "pending") {
		t.Fatal("pending-approval message shown for wrong password")
	}

	// A token minted earlier (e.g. while the gate was broken) can't be
	// refreshed into a new one…
	r = e.do(http.MethodPost, "/api/collections/users/auth-refresh", pending.token, nil)
	expectDenied(t, r)
	if strings.Contains(string(r.raw), `"token"`) {
		t.Fatalf("auth-refresh issued a token: %s", r.raw)
	}
	// …and is treated as anonymous everywhere else.
	expectStatus(t, e.do(http.MethodGet, "/api/collections/users/records/"+pending.rec.Id, pending.token, nil), 404)
	expectStatus(t, e.do(http.MethodPost, "/api/collections/teams/records", pending.token,
		map[string]any{"name": "x"}), 400, 401, 403)
	expectStatus(t, e.do(http.MethodPost, "/api/sp/patch", pending.token,
		map[string]any{"projectId": "x", "fromRevision": 0, "ops": []any{}}), 401)

	// Approved users are unaffected.
	r = login(e, ok.email)
	expectStatus(t, r, 200)
	if r.str("token") == "" {
		t.Fatal("approved user got no token")
	}
	expectStatus(t, e.do(http.MethodPost, "/api/collections/users/auth-refresh", ok.token, nil), 200)

	// Superuser approval unlocks the account.
	su := e.superuserToken()
	expectStatus(t, e.do(http.MethodPatch, "/api/collections/users/records/"+pending.rec.Id, su,
		map[string]any{"approved": true}), 200)
	expectStatus(t, login(e, pending.email), 200)
}

func TestSignupCannotSelfApprove(t *testing.T) {
	for _, gate := range []bool{true, false} {
		e := newEnv(t, envConfig{opts: Options{RequireApproval: gate}})

		// Explicit approved:true in the sign-up payload → rejected.
		r := e.do(http.MethodPost, "/api/collections/users/records", "", map[string]any{
			"email": "sneaky@example.com", "password": testPassword, "passwordConfirm": testPassword,
			"name": "Sneaky", "approved": true,
		})
		expectDenied(t, r)
		if rec, err := e.app.FindAuthRecordByEmail("users", "sneaky@example.com"); err == nil && rec.GetBool("approved") {
			t.Fatalf("gate=%v: self-approved account created", gate)
		}

		// Normal sign-up works and lands unapproved.
		r = e.do(http.MethodPost, "/api/collections/users/records", "", map[string]any{
			"email": "normal@example.com", "password": testPassword, "passwordConfirm": testPassword,
			"name": "Normal",
		})
		expectStatus(t, r, 200)
		rec, err := e.app.FindAuthRecordByEmail("users", "normal@example.com")
		if err != nil || rec.GetBool("approved") {
			t.Fatalf("gate=%v: new user approved=%v err=%v", gate, rec != nil && rec.GetBool("approved"), err)
		}

		if gate {
			expectStatus(t, login(e, "normal@example.com"), 403)
		} else {
			// Gate off (dev default): unapproved users may sign in.
			expectStatus(t, login(e, "normal@example.com"), 200)
		}
	}
}

func TestSelfUpdateCannotApprove(t *testing.T) {
	e := newEnv(t, envConfig{opts: Options{RequireApproval: false}})
	u := e.createUser("u", false)

	expectDenied(t, e.do(http.MethodPatch, "/api/collections/users/records/"+u.rec.Id, u.token,
		map[string]any{"approved": true}))
	if e.reload("users", u.rec.Id).GetBool("approved") {
		t.Fatal("user self-approved via update")
	}
	// Ordinary profile edits (AccountPage) still work.
	expectStatus(t, e.do(http.MethodPatch, "/api/collections/users/records/"+u.rec.Id, u.token,
		map[string]any{"name": "New Name", "phone": "123"}), 200)
}
