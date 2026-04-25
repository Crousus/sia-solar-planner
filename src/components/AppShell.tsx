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

import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BrowserRouter,
  Routes,
  Route,
} from 'react-router-dom';
import { pb } from '../backend/pb';
import type { UserRecord } from '../backend/types';
import { pushToast } from '../store/toastStore';
import { classifyError, headlineForCategory } from '../utils/errorClassify';
import LoginPage from './LoginPage';
import AuthGuard from './AuthGuard';
import Toaster from './Toaster';
import TeamPicker from './TeamPicker';
import NewTeamPage from './NewTeamPage';
import TeamView from './TeamView';
import TeamMembers from './TeamMembers';
import NewProjectPage from './NewProjectPage';
import ProjectSettingsPage from './ProjectSettingsPage';
import CustomersPage from './CustomersPage';
import CatalogPage from './CatalogPage';
import AccountPage from './AccountPage';
import TeamBrandingPage from './TeamBrandingPage';

// Lazy-loaded: the project editor pulls in Leaflet, Konva, @xyflow/react
// and a few other canvas-heavy deps that account for most of the main
// bundle. Splitting only this one route means /login, /teams, /catalog,
// etc. download a much smaller initial chunk; the editor chunk streams
// in on the first /p/:id navigation. No other routes are split — any
// page the user is likely to open before the editor stays eager so
// there's no flash-of-spinner on the common warm path.
const ProjectEditor = lazy(() => import('./ProjectEditor'));

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

/**
 * Hook: route uncaught browser errors and unhandled promise rejections
 * into the toast store so the user sees a visible message instead of
 * the failure being swallowed into the devtools console (where most
 * users never look).
 *
 * Why this lives in AppShell rather than as a free top-level effect:
 *   - We need access to `t()` for the localised message. AppShell is
 *     already inside the i18n provider via main.tsx's import order.
 *   - Mounting once at the root guarantees a single set of listeners;
 *     a free `window.addEventListener` at module scope would either
 *     leak in HMR or require careful cleanup.
 *
 * Filtering rationale:
 *   - We dedupe by message+source so a render loop firing the same
 *     error 60 Hz collapses to one card the user can dismiss.
 *   - We ignore "ResizeObserver loop limit exceeded" (a known benign
 *     warning emitted by libraries like react-leaflet on rapid resizes)
 *     and "Script error." (the opaque cross-origin form, which gives
 *     us nothing actionable to show the user).
 */
function useGlobalErrorToasts() {
  const { t } = useTranslation();
  useEffect(() => {
    function shouldIgnore(message: string): boolean {
      // ResizeObserver's "loop completed with undelivered notifications"
      // (and the older "limit exceeded" wording) is a no-op warning the
      // browser fires when an observer callback synchronously triggers
      // another layout. It surfaces in dev under Konva/Leaflet without
      // any user-visible bug, so suppress it from the toast channel.
      if (/ResizeObserver/i.test(message)) return true;
      // Cross-origin script errors deliver only "Script error." with no
      // stack — there's nothing to show the user beyond a vague "X
      // happened" so we'd rather skip than cry-wolf.
      if (message === 'Script error.') return true;
      return false;
    }

    function emit(reason: unknown, fallbackMessage: string) {
      // Classify so the headline matches what actually happened (network
      // unreachable vs. auth expired vs. server crash vs. unknown). The
      // user-grade message goes in the title; the technical payload
      // goes in the detail row so devs can still triage from a screenshot.
      const { category, detail, dedupeKey } = classifyError(reason);
      const message =
        detail || fallbackMessage || t('errors.unexpectedDetail');
      if (shouldIgnore(message)) return;
      pushToast('error', headlineForCategory(category, t), {
        detail: message,
        dedupeKey: `${category}:${dedupeKey}`,
      });
    }

    function onError(event: ErrorEvent) {
      // ErrorEvent carries the actual thrown object on `event.error`
      // when available — that's what we want to classify (a bare
      // `event.message` string would miss .status / .originalError).
      // Fall back to the message string for cross-origin / synthesized
      // events that strip the error object.
      const reason = event.error ?? event.message;
      emit(reason, event.message);
    }

    function onRejection(event: PromiseRejectionEvent) {
      emit(event.reason, '');
    }

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [t]);
}

export default function AppShell() {
  useGlobalErrorToasts();
  return (
    <BrowserRouter>
      <Toaster />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<AuthGuard><TeamPicker /></AuthGuard>} />
        <Route path="/teams/new" element={<AuthGuard><NewTeamPage /></AuthGuard>} />
        <Route path="/teams/:teamId" element={<AuthGuard><TeamView /></AuthGuard>} />
        <Route path="/teams/:teamId/members" element={<AuthGuard><TeamMembers /></AuthGuard>} />
        {/*
          Project bootstrap — captures initial metadata (name, client,
          address, notes) before creating the record. Replaces the old
          direct "create empty then navigate" flow on TeamView. Sits
          under the team's URL namespace so breadcrumb + auth gating
          match the surrounding pages.
        */}
        <Route path="/teams/:teamId/projects/new" element={<AuthGuard><NewProjectPage /></AuthGuard>} />
        {/*
          Project editor (Task 9). The dynamic segment is the PB record id
          of the project row. ProjectEditor handles fetch/loadProject on
          mount and resetProject on unmount; the underlying <App/> stays
          server-agnostic.
        */}
        {/*
          The editor has two views — roof plan (default) and block diagram.
          Both mount the same ProjectEditor; App.tsx reads the URL to pick
          which pane to render. Having it in the path (rather than local
          state) means reloading / deep-linking / back-forward all preserve
          the current view without extra persistence wiring.
        */}
        {['/p/:projectId', '/p/:projectId/diagram'].map((path) => (
          <Route
            key={path}
            path={path}
            element={
              <AuthGuard>
                {/* Suspense boundary only wraps the editor route — all
                    other pages import eagerly and never suspend. A plain
                    full-screen shell is used as the fallback rather than
                    a spinner component because the editor chunk is small
                    over local dev and cached on repeat visits; a
                    lightweight placeholder is less jarring than a
                    gratuitous spinner that flashes for 50 ms. */}
                <Suspense fallback={<EditorLoadingShell />}>
                  <ProjectEditor />
                </Suspense>
              </AuthGuard>
            }
          />
        ))}
        {/*
          Settings page for a project — name, client, address, notes.
          Lives at /p/:id/settings so breadcrumbs read naturally
          ("← back to editor"). Doesn't mount the editor; patches the
          project doc directly via /api/sp/patch.
        */}
        <Route path="/p/:projectId/settings" element={<AuthGuard><ProjectSettingsPage /></AuthGuard>} />
        <Route path="/teams/:teamId/customers" element={<AuthGuard><CustomersPage /></AuthGuard>} />
        {/*
          Hardware catalog — global (not team-scoped). Panel and inverter
          models live in shared collections so any team can link to them.
          Kept at a top-level path for that reason.
        */}
        <Route path="/catalog" element={<AuthGuard><CatalogPage /></AuthGuard>} />
        {/*
          Self-service profile page. Drives the "Planner" identity
          (name + phone) that appears on PDF exports of projects this
          user creates. Deliberately minimal — password/email changes
          go through the PB admin UI.
        */}
        <Route path="/account" element={<AuthGuard><AccountPage /></AuthGuard>} />
        {/*
          Team branding — logo + company name uploaded by a team admin,
          consumed only by PDF exports. Gated at component level to
          admins; non-admins get a read-only view (so they can see what
          their team's brand looks like but can't edit it).
        */}
        <Route path="/teams/:teamId/branding" element={<AuthGuard><TeamBrandingPage /></AuthGuard>} />
      </Routes>
    </BrowserRouter>
  );
}

// Minimal placeholder shown while the lazy-loaded editor chunk downloads.
// Matches the app's dark drafting-table background so the transition from
// "loading" to "editor mounted" is just a content swap, not a background
// flash. Intentionally unstyled beyond the background — no spinner, no
// text — because on a warm cache this is invisible and on a cold cache
// the bar should be "app is loading", not "something is wrong".
function EditorLoadingShell() {
  return (
    <div
      className="h-full w-full"
      style={{ background: 'var(--ink-950)' }}
    />
  );
}
