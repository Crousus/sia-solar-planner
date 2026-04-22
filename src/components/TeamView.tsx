// ────────────────────────────────────────────────────────────────────────
// TeamView — /teams/:teamId — project list for one team.
//
// Three concurrent fetches on mount: the team itself, its projects, and
// the caller's team_members row (for admin-only affordances). Promise.all
// so the page renders once, fully populated, instead of three separate
// loading flickers.
//
// Why no client-side filter on team_members: PocketBase's getFirstListItem
// with `team=X && user=Y` is server-side and cheap (the row is unique per
// pair). Doing it client-side would require pulling every member of every
// team the user belongs to.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { ProjectRecord, TeamRecord, TeamMemberRecord } from '../backend/types';
import type { Project } from '../types';
import { initialProject } from '../store/projectStore';
import { useAuthUser } from './AppShell';
import { PageShell } from './PageShell';

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

  async function signOut() {
    // Same pattern as TeamPicker — clear auth then navigate proactively
    // to avoid rendering an unauthorized route for a tick.
    pb.authStore.clear();
    navigate('/login', { replace: true });
  }

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
      // without a "needs setup" branch — and the diff/patch path always
      // operates on a well-formed document.
      //
      // We import the SAME `initialProject` the store uses on first load
      // (Task 9), so a server-created row and a local-only project start
      // from byte-identical shapes. Avoids subtle drift bugs where a
      // "fresh from server" project differs from a "fresh in editor"
      // one — important once diff-based sync is on.
      const doc: Project = initialProject;
      const created = await pb.collection('projects').create<ProjectRecord>({
        team: teamId,
        name: t('team.untitledProject'),
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
    // in a small internal tool. A modal is over-engineering at this
    // stage; if usage grows we can swap for a styled dialog.
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

  // Loading / error branches use the same PageShell so layout doesn't
  // shift between states — the content area just swaps what it shows.
  const loading = !team || !projects || !myRole;

  return (
    <PageShell
      label="FIG_02 · PROJECTS"
      userEmail={user?.email}
      onSignOut={signOut}
    >
      {error && (
        <div
          role="alert"
          className="rounded-lg px-3 py-2 text-[12.5px] mb-4"
          style={{
            background: 'rgba(255, 99, 99, 0.08)',
            border: '1px solid rgba(255, 99, 99, 0.35)',
            color: 'var(--sun-200)',
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div>
          <div className="h-6 w-40 rounded bg-white/[0.04] mb-3 animate-pulse" />
          <div className="h-11 w-72 rounded bg-white/[0.04] mb-10 animate-pulse" />
          <ul className="space-y-2">
            {[0, 1, 2].map((i) => (
              <li
                key={i}
                className="surface rounded-xl h-[60px] animate-pulse"
                style={{ opacity: 0.4 - i * 0.08 }}
                aria-hidden
              />
            ))}
          </ul>
        </div>
      ) : (
        <>
          <header className="mb-8">
            {/* Breadcrumb: small mono → Back link; kept textual rather than
                iconic so the "you are here" reads cleanly. */}
            <div className="flex items-center gap-2 mb-3">
              <Link
                to="/"
                className="font-mono text-[11px] text-ink-400 hover:text-ink-200 transition-colors"
              >
                {t('team.allTeams')}
              </Link>
              <span className="font-mono text-[11px] text-ink-500">/</span>
              <span className="font-mono text-[11px] text-ink-300 tabular-nums">
                {team!.id.slice(0, 10)}
              </span>
            </div>
            <div className="flex items-end justify-between gap-4">
              <div className="min-w-0">
                <span className="tech-label">TEAM</span>
                <h1
                  // `break-words` instead of truncate — a team name is
                  // brand-like; hiding characters with an ellipsis erodes
                  // the identity. Allow wrap across up to two lines.
                  className="mt-1 font-editorial text-[44px] leading-[1.05] tracking-tight text-ink-50 break-words"
                  title={team!.name}
                >
                  {team!.name}
                </h1>
                <div className="mt-2 flex items-center gap-3 font-mono text-[11px] text-ink-400">
                  <span>
                    <span className="text-ink-200 tabular-nums">
                      {projects!.length}
                    </span>{' '}
                    {t('team.projectUnit', { count: projects!.length })}
                  </span>
                  {/* role badge — mono caps, low key */}
                  <span className="chip chip-amber" style={{ fontSize: 10 }}>
                    {myRole}
                  </span>
                  {myRole === 'admin' && (
                    <Link
                      to={`/teams/${team!.id}/members`}
                      className="hover:text-ink-200 transition-colors"
                    >
                      {t('team.manageMembers')}
                    </Link>
                  )}
                </div>
              </div>

              <button
                onClick={createProject}
                disabled={creating}
                className="btn btn-primary shrink-0"
                style={{ padding: '9px 14px', fontSize: 12.5 }}
              >
                {creating ? (
                  <>
                    <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    <span>{t('team.creating')}</span>
                  </>
                ) : (
                  <>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                    <span>{t('team.newProject')}</span>
                  </>
                )}
              </button>
            </div>
          </header>

          {projects!.length === 0 ? (
            <div
              className="surface rounded-2xl px-8 py-14 text-center relative overflow-hidden"
            >
              <div
                aria-hidden
                className="absolute inset-0 pointer-events-none animate-drift"
                style={{
                  background:
                    'radial-gradient(ellipse 50% 50% at 50% 0%, rgba(255,99,99,0.12), transparent 70%)',
                }}
              />
              <span className="tech-label relative">EMPTY · 00 PROJECTS</span>
              <h2 className="relative mt-3 font-editorial text-[32px] text-ink-50 leading-none">
                {t('team.emptyProjectsTitle')}
              </h2>
              <p className="relative mt-3 text-ink-300 text-[14px] max-w-sm mx-auto">
                {t('team.emptyProjectsBody')}
              </p>
              <div className="relative mt-6">
                <button
                  onClick={createProject}
                  disabled={creating}
                  className="btn btn-primary"
                  style={{ padding: '10px 16px', fontSize: 13 }}
                >
                  {creating ? t('team.creating') : `${t('team.newProject')} →`}
                </button>
              </div>
            </div>
          ) : (
            <ul className="space-y-2">
              {projects!.map((p, i) => {
                // Human-readable relative time for the updated stamp.
                // Kept inline because it's the only date formatting on
                // this page; factoring out a util would be premature.
                const updated = new Date(p.updated);
                const stamp = relativeTime(updated, t);
                return (
                  <li key={p.id}>
                    <div
                      className="surface-row group relative flex items-center gap-4 rounded-xl px-4 py-3.5 border"
                      style={{ borderColor: 'var(--hairline)' }}
                    >
                      {/* Numeric index keeps the directory feel */}
                      <span
                        className="font-mono text-[11px] text-ink-400 tabular-nums shrink-0 w-6"
                        style={{ letterSpacing: '0.05em' }}
                      >
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      {/* Document-glyph avatar in the row slot — signals
                          "project" vs. team's initials avatar on the parent. */}
                      <span
                        aria-hidden
                        className="shrink-0 grid place-items-center rounded-lg"
                        style={{
                          width: 32,
                          height: 32,
                          background: 'linear-gradient(135deg, #171013 0%, #0b0809 100%)',
                          border: '1px solid var(--hairline-strong)',
                          color: 'var(--sun-300)',
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                          <path
                            d="M4 2.5a1 1 0 0 1 1-1h4.5L13 5v8.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-11Z"
                            stroke="currentColor"
                            strokeWidth="1.2"
                            strokeLinejoin="round"
                          />
                          <path d="M9 1.5V5h4" stroke="currentColor" strokeWidth="1.2" />
                        </svg>
                      </span>
                      <Link
                        to={`/p/${p.id}`}
                        className="flex-1 min-w-0 before:absolute before:inset-0 before:rounded-xl"
                      >
                        <span className="block truncate font-medium text-ink-100">
                          {p.name || t('team.untitledProject')}
                        </span>
                        <span className="mt-0.5 block font-mono text-[10.5px] text-ink-400">
                          {t('team.revUpdated', { rev: String(p.revision ?? 0), stamp })}
                        </span>
                      </Link>
                      {myRole === 'admin' && (
                        <button
                          onClick={() => deleteProject(p.id)}
                          className="btn btn-danger relative shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                          title="Delete project"
                          style={{ padding: '4px 8px' }}
                        >
                          {t('team.deleteProject')}
                        </button>
                      )}
                      <span
                        className="text-ink-400 transition-all relative group-hover:translate-x-0.5 group-hover:text-sun-300"
                        aria-hidden
                      >
                        →
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </PageShell>
  );
}

/*
 * Simple "N minutes ago" formatter. Intentionally minimal — falls back to
 * a locale date for anything >30d so we don't need a date library. If the
 * app ever needs richer relative time (hours, "tomorrow", etc.), swap in
 * date-fns or Intl.RelativeTimeFormat; for a project-list stamp this is
 * more than enough signal.
 */
function relativeTime(d: Date, t: TFunction): string {
  const now = Date.now();
  const diff = Math.max(0, now - d.getTime());
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return t('team.justNow');
  if (mins < 60) return t('team.minutesAgo', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('team.hoursAgo', { count: hrs });
  const days = Math.floor(hrs / 24);
  if (days < 30) return t('team.daysAgo', { count: days });
  return d.toLocaleDateString();
}
