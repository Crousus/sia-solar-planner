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
