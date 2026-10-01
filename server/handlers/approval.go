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

// approval.go — the admin-approval gate for new user accounts.
//
// Threat model: when REQUIRE_APPROVAL=true a freshly signed-up account
// must not be able to do ANYTHING with the API until a superuser flips
// users.approved to true. Three layers enforce that:
//
//  1. `approved` is superuser-only writable. The users create/update API
//     rules reject it (migration 1712347100) and the request hooks below
//     strip/restore it as a second line of defense. This always applies,
//     regardless of REQUIRE_APPROVAL, so flipping the env var on later
//     can't be pre-empted by accounts that self-approved while it was off.
//
//  2. No token for unapproved users. We bind OnRecordAuthRequest, which
//     every token-issuing flow funnels through (password, OAuth2, OTP,
//     auth-refresh, impersonate) and — crucially — we reject BEFORE
//     calling e.Next(). The previous implementation hooked
//     OnRecordAuthWithPasswordRequest and checked AFTER e.Next(); in
//     PocketBase ≥0.23 the default handler writes the 200 + token inside
//     e.Next(), so the 403 came too late and the token had already been
//     sent (audit finding C2).
//
//  3. Tokens already in circulation stop working. A middleware right after
//     PocketBase's auth-token loader drops e.Auth for unapproved users, so
//     a token minted before the gate was fixed (or before a superuser
//     revoked approval) is treated as anonymous on every route — including
//     our custom /api/sp/* handlers and realtime subscriptions.

import (
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
)

// pendingApprovalMessage is shown by the login page (LoginPage.tsx detects
// the 403 and renders its own localized copy; this text is a fallback).
const pendingApprovalMessage = "Your account is pending approval. An administrator will review your registration."

func registerApprovalHooks(app core.App, opts Options) {
	// ── Layer 1: `approved` is not client-writable ─────────────────────
	app.OnRecordCreateRequest("users").BindFunc(func(e *core.RecordRequestEvent) error {
		if !e.HasSuperuserAuth() {
			e.Record.Set("approved", false)
		}
		return e.Next()
	})
	app.OnRecordUpdateRequest("users").BindFunc(func(e *core.RecordRequestEvent) error {
		if !e.HasSuperuserAuth() {
			// Restore whatever was persisted; the payload can't change it.
			e.Record.Set("approved", e.Record.Original().GetBool("approved"))
		}
		return e.Next()
	})
	// OAuth2 sign-up builds the new record from client-supplied
	// `createData`. Strip `approved` there too (OAuth2 isn't enabled
	// today, but this keeps the invariant if someone turns it on).
	app.OnRecordAuthWithOAuth2Request("users").BindFunc(func(e *core.RecordAuthWithOAuth2RequestEvent) error {
		if e.CreateData != nil {
			delete(e.CreateData, "approved")
		}
		return e.Next()
	})

	if !opts.RequireApproval {
		return
	}

	// ── Layer 2: no token for unapproved users ─────────────────────────
	//
	// Wrong-password attempts never reach this hook (the password handler
	// fails first with PocketBase's generic "Failed to authenticate"), so
	// the pending-approval message only appears AFTER a correct password —
	// it doesn't turn the login form into an account-existence oracle.
	app.OnRecordAuthRequest("users").BindFunc(func(e *core.RecordAuthRequestEvent) error {
		if !e.Record.GetBool("approved") {
			return e.ForbiddenError(pendingApprovalMessage, nil)
		}
		return e.Next()
	})
}

// registerApprovalMiddleware installs layer 3 (see file header). It must
// be called from inside OnServe because that's where the router exists.
func registerApprovalMiddleware(se *core.ServeEvent, opts Options) {
	if !opts.RequireApproval {
		return
	}
	se.Router.Bind(&hook.Handler[*core.RequestEvent]{
		Id: "spApprovalGate",
		// +1 = immediately after PocketBase's loadAuthToken middleware and
		// before the rate limiter / route handlers, so everything
		// downstream sees the request as anonymous.
		Priority: apis.DefaultLoadAuthTokenMiddlewarePriority + 1,
		Func: func(e *core.RequestEvent) error {
			if e.Auth != nil &&
				e.Auth.Collection().Name == "users" &&
				!e.Auth.GetBool("approved") {
				e.Auth = nil
				// Advertise why, for clients that care; the body of
				// whatever the route returns (401/403/404) stays generic.
				e.Response.Header().Set("X-SP-Approval", "pending")
			}
			return e.Next()
		},
	})
}

// isUserCaller reports whether the request is authenticated as a regular
// app user (as opposed to anonymous or a superuser token). Custom routes
// use it so that superuser tokens — which belong to the _superusers
// collection and can't satisfy users relations — get a clear 401.
func isUserCaller(re *core.RequestEvent) bool {
	return re.Auth != nil && re.Auth.Collection().Name == "users"
}
