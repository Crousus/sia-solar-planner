// ────────────────────────────────────────────────────────────────────────
// AppShell — router host + auth session management.
//
// Responsibilities:
//   - Wire react-router-dom v7 routes (declarative API — same as v6).
//   - Expose the authenticated user to the React tree via a shallow
//     useAuthUser() hook (no Context — the PocketBase SDK's authStore
//     is already a singleton with change subscriptions, we just adapt
//     it to React state).
//   - Redirect unauthenticated users to /login for protected routes
//     (delegated to <AuthGuard/> per-route, not done globally here so
//     /login itself stays reachable when signed out).
//
// Why no <AuthContext.Provider>? The PocketBase SDK is the source of
// truth for the current auth; wrapping it in Context would add a
// second truth-source to keep in sync. Instead, components that need
// the user call useAuthUser() which subscribes to authStore directly.
// The PB SDK persists auth to localStorage so a page reload restores
// the session before React even mounts — useState's initializer can
// read pb.authStore.record synchronously and avoid a flash of "logged
// out" UI.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
} from 'react-router-dom';
import { pb } from '../backend/pb';
import type { UserRecord } from '../backend/types';
import LoginPage from './LoginPage';
import AuthGuard from './AuthGuard';
import TeamPicker from './TeamPicker';
import NewTeamPage from './NewTeamPage';
import TeamView from './TeamView';
import TeamMembers from './TeamMembers';
import ProjectEditor from './ProjectEditor';

/**
 * React-friendly view onto pb.authStore. Re-renders on login/logout.
 *
 * The cast through `UserRecord | null` is safe because we only ever
 * authenticate via the `users` collection; if a future code path
 * authenticates a different collection (admins, say), this hook would
 * need to widen its return type.
 */
export function useAuthUser(): UserRecord | null {
  const [user, setUser] = useState<UserRecord | null>(
    (pb.authStore.record as UserRecord | null) ?? null
  );
  useEffect(() => {
    // onChange fires synchronously on login, logout, and token refresh.
    // The SDK normalises the second arg to AuthRecord (the stored
    // record) — what used to be `model` in older SDK versions.
    const unsub = pb.authStore.onChange((_token, record) => {
      setUser((record as UserRecord | null) ?? null);
    });
    return () => unsub();
  }, []);
  return user;
}

export default function AppShell() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<AuthGuard><TeamPicker /></AuthGuard>} />
        <Route path="/teams/new" element={<AuthGuard><NewTeamPage /></AuthGuard>} />
        <Route path="/teams/:teamId" element={<AuthGuard><TeamView /></AuthGuard>} />
        <Route path="/teams/:teamId/members" element={<AuthGuard><TeamMembers /></AuthGuard>} />
        {/*
          Project editor (Task 9). The dynamic segment is the PB record id
          of the project row. ProjectEditor handles fetch/loadProject on
          mount and resetProject on unmount; the underlying <App/> stays
          server-agnostic.
        */}
        <Route path="/p/:projectId" element={<AuthGuard><ProjectEditor /></AuthGuard>} />
      </Routes>
    </BrowserRouter>
  );
}
