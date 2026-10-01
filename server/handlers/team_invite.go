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

// team_invite.go — POST /api/sp/team-members
//
// Adds an existing user to a team by e-mail address.
//
// WHY a custom route: users.listRule is null (superusers only) so that
// nobody can enumerate accounts, and users.viewRule only shows yourself and
// people you already share a team with. That means the client can't
// resolve "alice@example.com" → user id by itself, which the invite form
// (TeamMembers.tsx) needs. This endpoint does the lookup server-side, but
// only for a caller who is ADMIN of the target team, and only as part of
// actually adding the membership — it never returns other users' data
// beyond the created membership row's ids.
//
// Residual oracle: an admin learns whether an address is registered (404
// vs 200). Any user can become admin of their own team, so this is
// effectively "signed-in users can test whether an e-mail is registered",
// rate-limited by the `POST /api/sp/team-members` rule (migration
// 1712347100). That's the inherent cost of invite-by-email UX; inviting
// unregistered addresses would require an e-mail invite flow.

import (
	"net/http"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type addTeamMemberRequest struct {
	TeamID string `json:"teamId"`
	Email  string `json:"email"`
	// Role defaults to "member". Admins may add other admins.
	Role string `json:"role"`
}

func handleAddTeamMember(re *core.RequestEvent) error {
	if !isUserCaller(re) {
		return re.UnauthorizedError("sign-in required", nil)
	}
	body := addTeamMemberRequest{}
	if err := re.BindBody(&body); err != nil {
		return re.BadRequestError("invalid JSON body", nil)
	}
	email := strings.TrimSpace(body.Email)
	if body.TeamID == "" || email == "" || len(email) > 320 {
		return re.BadRequestError("teamId and email required", nil)
	}
	role := body.Role
	if role == "" {
		role = "member"
	}
	if role != "member" && role != "admin" {
		return re.BadRequestError("role must be member or admin", nil)
	}

	// Caller must be an admin of the team. Non-admin and non-existent team
	// both → 404 (no team-id oracle).
	if _, err := re.App.FindFirstRecordByFilter(
		"team_members",
		"team = {:team} && user = {:user} && role = 'admin'",
		dbx.Params{"team": body.TeamID, "user": re.Auth.Id},
	); err != nil {
		return re.NotFoundError("team not found", nil)
	}

	target, err := re.App.FindAuthRecordByEmail("users", email)
	if err != nil {
		return re.NotFoundError("no user with that email", nil)
	}

	if _, err := re.App.FindFirstRecordByFilter(
		"team_members",
		"team = {:team} && user = {:user}",
		dbx.Params{"team": body.TeamID, "user": target.Id},
	); err == nil {
		return re.BadRequestError("user is already a member of this team", nil)
	}

	col, err := re.App.FindCollectionByNameOrId("team_members")
	if err != nil {
		return re.InternalServerError("", nil)
	}
	member := core.NewRecord(col)
	member.Set("team", body.TeamID)
	member.Set("user", target.Id)
	member.Set("role", role)
	if err := re.App.Save(member); err != nil {
		re.App.Logger().Error("add team member failed", "team", body.TeamID, "error", err)
		return re.InternalServerError("could not add member", nil)
	}
	return re.JSON(http.StatusOK, map[string]string{
		"id":   member.Id,
		"team": body.TeamID,
		"user": target.Id,
		"role": role,
	})
}
