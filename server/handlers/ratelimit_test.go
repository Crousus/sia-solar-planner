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

// ratelimit_test.go — audit finding L7 (superuser brute force).

import (
	"net/http"
	"testing"
)

func TestSuperuserAuthIsRateLimited(t *testing.T) {
	e := newEnv(t, envConfig{keepRateLimits: true})
	if !e.app.Settings().RateLimits.Enabled {
		t.Fatal("migration did not enable rate limiting")
	}
	e.superuserToken() // creates root@example.com

	attempt := func(ip string) int {
		return e.do(http.MethodPost, "/api/collections/_superusers/auth-with-password", "",
			map[string]any{"identity": "root@example.com", "password": "guess-guess-guess"},
			"X-Real-IP", ip).status
	}

	// The client IP comes from nginx's X-Real-IP (trusted proxy header).
	for i := 0; i < 5; i++ {
		if s := attempt("203.0.113.7"); s != 400 {
			t.Fatalf("attempt %d: status %d, want 400 (bad credentials)", i+1, s)
		}
	}
	if s := attempt("203.0.113.7"); s != 429 {
		t.Fatalf("6th attempt: status %d, want 429", s)
	}
	// Per-IP: a different client is unaffected.
	if s := attempt("198.51.100.20"); s != 400 {
		t.Fatalf("other IP: status %d, want 400", s)
	}
}
