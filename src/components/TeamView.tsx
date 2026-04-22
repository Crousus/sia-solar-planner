// ────────────────────────────────────────────────────────────────────────
// TeamView — /teams/:teamId — project list for one team.
//
// Three concurrent fetches on mount: the team itself, its projects, and
// the caller's team_members row (to know whether they're admin and may
// see the "Members" link / Delete buttons). We Promise.all them so the
// page renders once, fully populated, instead of three separate loading
// flickers.
//
// Why no client-side filter on team_members in the team_members fetch:
// PocketBase's getFirstListItem with `team=X && user=Y` is server-side
// and cheap (the row is unique per pair). Doing it client-side would
// require pulling every member of every team the user belongs to.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { pb } from '../backend/pb';
import type { ProjectRecord, TeamRecord, TeamMemberRecord } from '../backend/types';
import type { Project } from '../types';
import { initialProject } from '../store/projectStore';
import { useAuthUser } from './AppShell';

export default function TeamView() {
  const { t } = useTranslation();
  const { teamId } = useParams<{ teamId: string }>();
  const user = useAuthUser();
  const navigate = useNavigate();

  const [team, setTeam] = useState<TeamRecord | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null);
  const [myRole, setMyRole] = useState<'admin' | 'member' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `creating` gates the New Project button so a slow server doesn't let
  // a double-click create two empty projects.
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!teamId || !user) return;
    let cancelled = false;
    Promise.all([
      pb.collection('teams').getOne<TeamRecord>(teamId),
      pb.collection('projects').getFullList<ProjectRecord>({
        filter: `team="${teamId}"`,
        sort: '-updated',
      }),
      pb.collection('team_members').getFirstListItem<TeamMemberRecord>(
        `team="${teamId}" && user="${user.id}"`
      ),
    ])
      .then(([teamRec, projs, me]) => {
        if (cancelled) return;
        setTeam(teamRec);
        setProjects(projs);
        setMyRole(me.role);
      })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [teamId, user]);

  async function createProject() {
    if (!teamId) return;
    setCreating(true);
    try {
      // The server stores the entire Project document as opaque JSON in
      // the `doc` column. Seeding with a valid initial Project (rather
      // than an empty {}) means the editor can render immediately
      // without a "needs setup" branch — and the diff/patch path in
      // later tasks always operates on a well-formed document.
      //
      // We import the SAME `initialProject` value the store uses on first
      // load (Task 9), so a server-created row and a local-only project
      // start from byte-identical shapes. This avoids subtle drift bugs
      // where a "fresh from server" project differs from a "fresh in
      // editor" one — important once Task 12/13 turns on diff-based sync.
      const doc: Project = initialProject;
      const created = await pb.collection('projects').create<ProjectRecord>({
        team: teamId,
        name: 'Untitled Project',
        doc,
        revision: 0,
      });
      navigate(`/p/${created.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Create failed.');
    } finally {
      setCreating(false);
    }
  }

  async function deleteProject(projectId: string) {
    // confirm() is the simplest acceptable UX for a destructive action
    // in a small internal tool. A modal would be over-engineering at
    // this stage; if usage grows we can swap for a styled dialog.
    if (!confirm(t('team.deleteProjectConfirm'))) return;
    try {
      await pb.collection('projects').delete(projectId);
      // Optimistic local update — avoids re-fetching the entire list to
      // remove one row. If the delete fails we already alerted; the
      // server-side row remains and a refresh will show it again.
      setProjects((list) => list?.filter((p) => p.id !== projectId) ?? null);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Delete failed.');
    }
  }

  if (error) return <Shell><p className="text-red-400">{error}</p></Shell>;
  if (!team || !projects || !myRole) return <Shell><p>Loading…</p></Shell>;

  return (
    <Shell>
      <header className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold">{team.name}</h1>
        <nav className="text-sm space-x-3">
          <Link to="/" className="underline">{t('team.allTeams')}</Link>
          {myRole === 'admin' && (
            <Link to={`/teams/${team.id}/members`} className="underline">{t('team.membersTitle')}</Link>
          )}
        </nav>
      </header>

      {projects.length === 0 ? (
        <p className="text-zinc-400">{t('team.emptyProjectsTitle')}</p>
      ) : (
        <ul className="space-y-2">
          {projects.map((p) => (
            <li key={p.id} className="flex items-center gap-2 bg-zinc-800 rounded p-3">
              <Link to={`/p/${p.id}`} className="flex-1 hover:underline">
                {p.name || t('team.untitledProject')}
              </Link>
              {myRole === 'admin' && (
                <button
                  onClick={() => deleteProject(p.id)}
                  className="text-sm text-red-400 underline"
                >
                  {t('team.deleteProject')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6">
        <button
          onClick={createProject}
          disabled={creating}
          className="px-4 py-2 bg-blue-600 rounded disabled:opacity-50"
        >
          {creating ? t('team.creating') : `+ ${t('team.newProject')}`}
        </button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100">
      <div className="max-w-2xl mx-auto p-6">{children}</div>
    </div>
  );
}

