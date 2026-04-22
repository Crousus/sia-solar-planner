// ────────────────────────────────────────────────────────────────────────
// TeamPicker — the `/` page for a signed-in user.
//
// Shows the teams they're in. One click navigates to the team view.
// Empty state directs them to create their first team.
//
// We rely on PocketBase's row-level access rules to scope the team list
// to the caller automatically: the `teams` collection's list/view rule
// permits only members. So an unfiltered `getFullList` here returns
// exactly the teams the user belongs to — no client-side filter on
// team_members needed. If the rule ever loosens, we'd need an explicit
// filter to avoid leaking other teams into this list.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { pb } from '../backend/pb';
import type { TeamRecord } from '../backend/types';
import { useAuthUser } from './AppShell';

export default function TeamPicker() {
  const { t } = useTranslation();
  const user = useAuthUser();
  const navigate = useNavigate();
  // null = still loading; [] = loaded but empty (drives the empty-state UI).
  // Using a single tri-state field instead of separate `loading` + `data`
  // booleans keeps the render conditions exhaustive and avoids the
  // "loading but also have stale data" middle ground.
  const [teams, setTeams] = useState<TeamRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The cancelled flag guards against the classic "component unmounted
    // before the await resolved" double-set warning. PocketBase's SDK
    // doesn't accept an AbortSignal on getFullList yet, so this is the
    // simplest correct pattern.
    let cancelled = false;
    pb.collection('teams')
      .getFullList<TeamRecord>({ sort: '-updated' })
      .then((list) => { if (!cancelled) setTeams(list); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  async function signOut() {
    // authStore.clear() is synchronous — it wipes the in-memory token and
    // localStorage entry, which fires the onChange subscription in
    // AppShell and re-renders the tree. The navigate() call moves us to
    // /login proactively so the AuthGuard redirect doesn't have to kick
    // in (avoids a brief render of the now-unauthorised TeamPicker).
    pb.authStore.clear();
    navigate('/login', { replace: true });
  }

  if (error) return <Shell><p className="text-red-400">{error}</p></Shell>;
  if (!teams) return <Shell><p>Loading…</p></Shell>;

  return (
    <Shell>
      <header className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold">{t('team.yourTeams')}</h1>
        <div className="text-sm text-zinc-400">
          {user?.email}
          <button className="ml-3 underline" onClick={signOut}>Sign out</button>
        </div>
      </header>

      {teams.length === 0 ? (
        <p className="text-zinc-400">
          {t('team.noTeamsBody')}{' '}
          <Link className="underline text-blue-400" to="/teams/new">{t('team.createFirstTeam')}</Link>
        </p>
      ) : (
        <ul className="space-y-2">
          {teams.map((team) => (
            <li key={team.id}>
              <Link
                to={`/teams/${team.id}`}
                className="block p-4 bg-zinc-800 rounded hover:bg-zinc-700"
              >
                {team.name}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6">
        <Link to="/teams/new" className="px-4 py-2 bg-blue-600 rounded">
          + {t('team.newTeam')}
        </Link>
      </div>
    </Shell>
  );
}

// Local layout wrapper. Each route page defines its own Shell rather than
// sharing one because the dashboard pages are intentionally narrow
// (max-w-2xl) while the project editor (Task 9) will be full-bleed —
// extracting a shared Shell now would just need a width prop right away.
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100">
      <div className="max-w-2xl mx-auto p-6">{children}</div>
    </div>
  );
}
