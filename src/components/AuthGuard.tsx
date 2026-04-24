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

// ────────────────────────────────────────────────────────────────────────
// AuthGuard — redirects unauthenticated visitors to /login.
//
// Usage: <AuthGuard><ProtectedPage/></AuthGuard> in the route element.
//
// We pass the requested location via `state.from` so LoginPage can
// bounce the user back after successful sign-in. Without this, a user
// who bookmarked /p/ab12cd and isn't signed in would land on /
// after login rather than the project they intended to open.
//
// `replace` (rather than push) means the /login entry replaces the
// guarded URL in browser history; otherwise the back button after
// signing in would re-trigger the guard and bounce to /login again.
// ────────────────────────────────────────────────────────────────────────

import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthUser } from './AppShell';

export default function AuthGuard({ children }: { children: ReactNode }) {
  const user = useAuthUser();
  const location = useLocation();
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
}
