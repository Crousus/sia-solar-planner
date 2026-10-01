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

// rules_test.go — collection API rules + request hooks (migration
// 1712347100 and hooks.go). Each test names the audit finding it pins.

import (
	"net/http"
	"testing"
)

// C1: an admin of team A must not be able to move their own membership
// row into team B (which made them admin of B).
func TestTeamMembershipTakeoverRejected(t *testing.T) {
	e := newEnv(t, envConfig{})
	victim := e.createUser("victim", true)
	attacker := e.createUser("attacker", true)
	victimTeam := e.createTeam("VictimCo", victim)
	evilTeam := e.createTeam("EvilCo", attacker)
	mine := e.membership(evilTeam, attacker)

	r := e.do(http.MethodPatch, "/api/collections/team_members/records/"+mine.Id, attacker.token,
		map[string]any{"team": victimTeam.Id})
	expectDenied(t, r)
	if got := e.reload("team_members", mine.Id).GetString("team"); got != evilTeam.Id {
		t.Fatalf("membership moved to %s", got)
	}

	// Re-assigning the row to another user is pinned too.
	r = e.do(http.MethodPatch, "/api/collections/team_members/records/"+mine.Id, attacker.token,
		map[string]any{"user": victim.rec.Id})
	expectDenied(t, r)

	// And the attacker still can't see or administer the victim team.
	expectStatus(t, e.do(http.MethodGet, "/api/collections/teams/records/"+victimTeam.Id, attacker.token, nil), 404)
	expectDenied(t, e.do(http.MethodPatch, "/api/collections/teams/records/"+victimTeam.Id, attacker.token,
		map[string]any{"name": "pwned"}))

	// Positive control: a legit role change by an admin still works, and
	// resending the unchanged team value is tolerated.
	member := e.createUser("member", true)
	m := e.addMember(evilTeam, member, "member")
	r = e.do(http.MethodPatch, "/api/collections/team_members/records/"+m.Id, attacker.token,
		map[string]any{"role": "admin", "team": evilTeam.Id})
	expectStatus(t, r, 200)
}

// Members (not admins) can't change their own role.
func TestMemberCannotSelfPromote(t *testing.T) {
	e := newEnv(t, envConfig{})
	admin := e.createUser("admin", true)
	member := e.createUser("member", true)
	team := e.createTeam("T", admin)
	m := e.addMember(team, member, "member")

	expectDenied(t, e.do(http.MethodPatch, "/api/collections/team_members/records/"+m.Id, member.token,
		map[string]any{"role": "admin"}))
	// Nor create a second, admin row for themselves.
	expectDenied(t, e.do(http.MethodPost, "/api/collections/team_members/records", member.token,
		map[string]any{"team": team.Id, "user": member.rec.Id, "role": "admin"}))
	if e.reload("team_members", m.Id).GetString("role") != "member" {
		t.Fatal("member self-promoted")
	}
}

func TestLastAdminCannotBeRemovedOrDemoted(t *testing.T) {
	e := newEnv(t, envConfig{})
	admin := e.createUser("admin", true)
	team := e.createTeam("T", admin)
	m := e.membership(team, admin)

	expectStatus(t, e.do(http.MethodPatch, "/api/collections/team_members/records/"+m.Id, admin.token,
		map[string]any{"role": "member"}), 400)
	expectStatus(t, e.do(http.MethodDelete, "/api/collections/team_members/records/"+m.Id, admin.token, nil), 400)

	// With a second admin, demotion works.
	other := e.createUser("other", true)
	e.addMember(team, other, "admin")
	expectStatus(t, e.do(http.MethodPatch, "/api/collections/team_members/records/"+m.Id, admin.token,
		map[string]any{"role": "member"}), 200)
}

// H3: team_members list/view must be scoped to the caller's teams.
func TestTeamMembersListScopedToOwnTeams(t *testing.T) {
	e := newEnv(t, envConfig{})
	alice := e.createUser("alice", true)
	bob := e.createUser("bob", true)
	mallory := e.createUser("mallory", true)
	teamA := e.createTeam("A", alice)
	e.addMember(teamA, bob, "member")
	teamM := e.createTeam("M", mallory)

	r := e.do(http.MethodGet, "/api/collections/team_members/records?perPage=200", mallory.token, nil)
	expectStatus(t, r, 200)
	items, _ := r.body["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("mallory sees %d memberships, want 1 (her own)", len(items))
	}
	if items[0].(map[string]any)["team"] != teamM.Id {
		t.Fatalf("mallory sees foreign membership: %v", items[0])
	}

	// Direct view of a foreign membership → 404.
	bobRow := e.membership(teamA, bob)
	expectStatus(t, e.do(http.MethodGet, "/api/collections/team_members/records/"+bobRow.Id, mallory.token, nil), 404)

	// Positive: alice sees both rows of team A.
	r = e.do(http.MethodGet, "/api/collections/team_members/records?filter=team%3D%22"+teamA.Id+"%22&expand=user", alice.token, nil)
	expectStatus(t, r, 200)
	if n := len(r.body["items"].([]any)); n != 2 {
		t.Fatalf("alice sees %d rows of her team, want 2", n)
	}
}

// H3 (users): only self + co-members are viewable.
func TestUsersViewRestrictedToCoMembers(t *testing.T) {
	e := newEnv(t, envConfig{})
	alice := e.createUser("alice", true)
	bob := e.createUser("bob", true)
	stranger := e.createUser("stranger", true)
	team := e.createTeam("A", alice)
	e.addMember(team, bob, "member")
	e.createTeam("S", stranger)

	expectStatus(t, e.do(http.MethodGet, "/api/collections/users/records/"+alice.rec.Id, alice.token, nil), 200)
	expectStatus(t, e.do(http.MethodGet, "/api/collections/users/records/"+alice.rec.Id, bob.token, nil), 200)
	expectStatus(t, e.do(http.MethodGet, "/api/collections/users/records/"+alice.rec.Id, stranger.token, nil), 404)
	// A user with no team at all can still see themselves.
	loner := e.createUser("loner", true)
	expectStatus(t, e.do(http.MethodGet, "/api/collections/users/records/"+loner.rec.Id, loner.token, nil), 200)
	expectStatus(t, e.do(http.MethodGet, "/api/collections/users/records/"+alice.rec.Id, loner.token, nil), 404)
	// No enumeration.
	expectDenied(t, e.do(http.MethodGet, "/api/collections/users/records", alice.token, nil))
}

// teams.created_by is forced server-side; creator becomes admin.
func TestTeamCreatedByForced(t *testing.T) {
	e := newEnv(t, envConfig{})
	alice := e.createUser("alice", true)
	bob := e.createUser("bob", true)

	r := e.do(http.MethodPost, "/api/collections/teams/records", alice.token,
		map[string]any{"name": "Spoof", "created_by": bob.rec.Id})
	expectStatus(t, r, 200)
	team := e.reload("teams", r.str("id"))
	if team.GetString("created_by") != alice.rec.Id {
		t.Fatalf("created_by = %s, want caller %s", team.GetString("created_by"), alice.rec.Id)
	}
	if e.membership(team, alice).GetString("role") != "admin" {
		t.Fatal("creator is not admin")
	}
	// Client may omit created_by entirely now.
	expectStatus(t, e.do(http.MethodPost, "/api/collections/teams/records", alice.token,
		map[string]any{"name": "NoCreator"}), 200)
	// And an admin can't re-attribute the team later.
	expectDenied(t, e.do(http.MethodPatch, "/api/collections/teams/records/"+team.Id, alice.token,
		map[string]any{"created_by": bob.rec.Id}))
	expectStatus(t, e.do(http.MethodPatch, "/api/collections/teams/records/"+team.Id, alice.token,
		map[string]any{"name": "Renamed"}), 200)
}

// customers.team is pinned on update.
func TestCustomerCannotMoveTeams(t *testing.T) {
	e := newEnv(t, envConfig{})
	alice := e.createUser("alice", true)
	teamA := e.createTeam("A", alice)
	teamB := e.createTeam("B", alice) // alice is in both teams
	other := e.createUser("other", true)
	teamX := e.createTeam("X", other)
	c := e.createCustomer(teamA, "Cust")

	expectDenied(t, e.do(http.MethodPatch, "/api/collections/customers/records/"+c.Id, alice.token,
		map[string]any{"team": teamB.Id}))
	expectDenied(t, e.do(http.MethodPatch, "/api/collections/customers/records/"+c.Id, alice.token,
		map[string]any{"team": teamX.Id}))
	if e.reload("customers", c.Id).GetString("team") != teamA.Id {
		t.Fatal("customer moved")
	}
	expectStatus(t, e.do(http.MethodPatch, "/api/collections/customers/records/"+c.Id, alice.token,
		map[string]any{"name": "Renamed", "street": nil}), 200)
}

// projects createRule: customer must be in the project's team; created_by forced.
func TestProjectCreateRejectsForeignCustomer(t *testing.T) {
	e := newEnv(t, envConfig{})
	alice := e.createUser("alice", true)
	bob := e.createUser("bob", true)
	teamA := e.createTeam("A", alice)
	teamB := e.createTeam("B", bob)
	foreign := e.createCustomer(teamB, "BobCust")
	own := e.createCustomer(teamA, "AliceCust")

	payload := func(customer string) map[string]any {
		p := map[string]any{"team": teamA.Id, "name": "P", "doc": map[string]any{"name": "P"}, "revision": 0, "created_by": bob.rec.Id}
		if customer != "" {
			p["customer"] = customer
		}
		return p
	}
	expectDenied(t, e.do(http.MethodPost, "/api/collections/projects/records", alice.token, payload(foreign.Id)))

	r := e.do(http.MethodPost, "/api/collections/projects/records", alice.token, payload(own.Id))
	expectStatus(t, r, 200)
	if got := e.reload("projects", r.str("id")).GetString("created_by"); got != alice.rec.Id {
		t.Fatalf("projects.created_by = %s, want caller", got)
	}
	expectStatus(t, e.do(http.MethodPost, "/api/collections/projects/records", alice.token, payload("")), 200)
	// Not a member of B → can't create there at all.
	p := payload("")
	p["team"] = teamB.Id
	expectDenied(t, e.do(http.MethodPost, "/api/collections/projects/records", alice.token, p))
}

// M6: global catalogs — creator-owned edits, DELETE = soft delete.
func TestCatalogOwnershipAndSoftDelete(t *testing.T) {
	e := newEnv(t, envConfig{})
	alice := e.createUser("alice", true)
	bob := e.createUser("bob", true)

	r := e.do(http.MethodPost, "/api/collections/panel_models/records", alice.token, map[string]any{
		"manufacturer": "ACME", "model": "P1", "widthM": 1.1, "heightM": 1.7, "wattPeak": 400,
		"created_by": bob.rec.Id,
	})
	expectStatus(t, r, 200)
	id := r.str("id")
	if got := e.reload("panel_models", id).GetString("created_by"); got != alice.rec.Id {
		t.Fatalf("catalog created_by = %s, want caller", got)
	}

	// Bob can read but not poison or delete Alice's row.
	expectStatus(t, e.do(http.MethodGet, "/api/collections/panel_models/records/"+id, bob.token, nil), 200)
	expectDenied(t, e.do(http.MethodPatch, "/api/collections/panel_models/records/"+id, bob.token,
		map[string]any{"wattPeak": 9999}))
	expectDenied(t, e.do(http.MethodDelete, "/api/collections/panel_models/records/"+id, bob.token, nil))

	// Alice's DELETE soft-deletes.
	expectStatus(t, e.do(http.MethodDelete, "/api/collections/panel_models/records/"+id, alice.token, nil), 204)
	if !e.reload("panel_models", id).GetBool("deleted") {
		t.Fatal("expected soft delete")
	}

	// Inverter catalog behaves the same; superuser can hard-delete.
	r = e.do(http.MethodPost, "/api/collections/inverter_models/records", alice.token, map[string]any{
		"manufacturer": "ACME", "model": "I1", "maxAcPowerW": 5000,
	})
	expectStatus(t, r, 200)
	inv := r.str("id")
	expectStatus(t, e.do(http.MethodDelete, "/api/collections/inverter_models/records/"+inv, alice.token, nil), 204)
	if !e.reload("inverter_models", inv).GetBool("deleted") {
		t.Fatal("expected inverter soft delete")
	}
	su := e.superuserToken()
	expectStatus(t, e.do(http.MethodDelete, "/api/collections/inverter_models/records/"+inv, su, nil), 204)
	if _, err := e.app.FindRecordById("inverter_models", inv); err == nil {
		t.Fatal("superuser delete should hard-delete")
	}
}

func TestSetCustomerAndPanelModel(t *testing.T) {
	e := newEnv(t, envConfig{})
	alice := e.createUser("alice", true)
	bob := e.createUser("bob", true)
	teamA := e.createTeam("A", alice)
	teamB := e.createTeam("B", bob)
	project := e.createProject(teamA, map[string]any{"name": "P"})
	foreign := e.createCustomer(teamB, "BobCust")
	own := e.createCustomer(teamA, "AliceCust")

	expectStatus(t, e.do(http.MethodPost, "/api/sp/set-customer", alice.token,
		map[string]any{"projectId": project.Id, "customerId": foreign.Id}), 404)
	expectStatus(t, e.do(http.MethodPost, "/api/sp/set-customer", alice.token,
		map[string]any{"projectId": project.Id, "customerId": own.Id}), 200)
	// Non-member and non-existent project are indistinguishable.
	a := e.do(http.MethodPost, "/api/sp/set-customer", bob.token, map[string]any{"projectId": project.Id})
	b := e.do(http.MethodPost, "/api/sp/set-customer", bob.token, map[string]any{"projectId": "doesnotexist123"})
	expectStatus(t, a, 404)
	expectStatus(t, b, 404)
	if a.str("message") != b.str("message") {
		t.Fatalf("existence oracle: %q vs %q", a.str("message"), b.str("message"))
	}

	r := e.do(http.MethodPost, "/api/collections/panel_models/records", alice.token, map[string]any{
		"manufacturer": "ACME", "model": "P1", "widthM": 1, "heightM": 1.7, "wattPeak": 400,
	})
	expectStatus(t, r, 200)
	expectStatus(t, e.do(http.MethodPost, "/api/sp/set-panel-model", alice.token,
		map[string]any{"projectId": project.Id, "panelModelId": r.str("id")}), 200)
	if e.reload("projects", project.Id).GetString("panel_model") != r.str("id") {
		t.Fatal("panel_model not set")
	}
	expectStatus(t, e.do(http.MethodPost, "/api/sp/set-panel-model", bob.token,
		map[string]any{"projectId": project.Id, "panelModelId": r.str("id")}), 404)
}

func TestAddTeamMemberByEmail(t *testing.T) {
	e := newEnv(t, envConfig{})
	alice := e.createUser("alice", true)
	bob := e.createUser("bob", true)
	carol := e.createUser("carol", true)
	team := e.createTeam("A", alice)
	e.addMember(team, bob, "member")

	// Non-admin member can't add people.
	expectStatus(t, e.do(http.MethodPost, "/api/sp/team-members", bob.token,
		map[string]any{"teamId": team.Id, "email": carol.email}), 404)
	// Admin can.
	r := e.do(http.MethodPost, "/api/sp/team-members", alice.token,
		map[string]any{"teamId": team.Id, "email": carol.email})
	expectStatus(t, r, 200)
	if e.membership(team, carol).GetString("role") != "member" {
		t.Fatal("carol not added as member")
	}
	expectStatus(t, e.do(http.MethodPost, "/api/sp/team-members", alice.token,
		map[string]any{"teamId": team.Id, "email": carol.email}), 400)
	expectStatus(t, e.do(http.MethodPost, "/api/sp/team-members", alice.token,
		map[string]any{"teamId": team.Id, "email": "nobody@example.com"}), 404)
	expectStatus(t, e.do(http.MethodPost, "/api/sp/team-members", alice.token,
		map[string]any{"teamId": team.Id, "email": carol.email, "role": "owner"}), 400)
}
