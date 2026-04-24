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
import i18next from 'i18next';
import type { TFunction } from 'i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { ProjectRecord, TeamRecord, TeamMemberRecord, CustomerRecord } from '../backend/types';
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
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [customerFilter, setCustomerFilter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        // Expand the customer relation so the project row can display the
        // customer name without a separate fetch per row.
        expand: 'customer',
      }),
      pb.collection('team_members').getFirstListItem<TeamMemberRecord>(
        `team="${teamId}" && user="${user.id}"`
      ),
      pb.collection('customers').getFullList<CustomerRecord>({
        filter: `team="${teamId}"`,
        sort: 'name',
      }),
    ])
      .then(([teamRec, projs, me, custs]) => {
        if (cancelled) return;
        setTeam(teamRec);
        setProjects(projs);
        setMyRole(me.role);
        setCustomers(custs);
      })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [teamId, user]);

  // Project creation moved to /teams/:teamId/projects/new — see
  // NewProjectPage. That page captures name + optional client + address
  // + notes before creating the record, so we don't need any inline
  // create logic here anymore. The "New project" button below is a
  // plain <Link> to that route.

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
      width="wide"
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
                className="font-mono text-[12.5px] text-ink-400 hover:text-ink-200 transition-colors"
              >
                {t('team.allTeams')}
              </Link>
              <span className="font-mono text-[12.5px] text-ink-500">/</span>
              <span className="font-mono text-[12.5px] text-ink-300 tabular-nums">
                {team!.id.slice(0, 10)}
              </span>
            </div>
            <div className="flex items-end justify-between gap-4">
              <div className="min-w-0">
                <span className="tech-label" style={{ fontSize: 12 }}>TEAM</span>
                <h1
                  // `break-words` instead of truncate — a team name is
                  // brand-like; hiding characters with an ellipsis erodes
                  // the identity. Allow wrap across up to two lines.
                  className="mt-1 font-editorial text-[44px] leading-[1.05] tracking-tight text-ink-50 break-words"
                  title={team!.name}
                >
                  {team!.name}
                </h1>
                <div className="mt-2.5 flex items-center gap-3 font-mono text-[13px] text-ink-400">
                  <span>
                    <span className="text-ink-200 tabular-nums">
                      {projects!.length}
                    </span>{' '}
                    {t('team.projectUnit', { count: projects!.length })}
                  </span>
                  {/* role badge — mono caps, low key */}
                  <span className="chip chip-amber" style={{ fontSize: 12 }}>
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
                  {myRole === 'admin' && (
                    <Link
                      to={`/teams/${team!.id}/branding`}
                      className="hover:text-ink-200 transition-colors"
                    >
                      {t('team.branding')}
                    </Link>
                  )}
                  <Link
                    to={`/teams/${team!.id}/customers`}
                    className="hover:text-ink-200 transition-colors"
                  >
                    {t('team.customers')}
                  </Link>
                  {/* Hardware catalog link — global, not team-scoped,
                      so the URL has no team segment. Placed next to
                      customers so both "adjacent" DBs (customer &
                      hardware) live together in the nav. */}
                  <Link
                    to="/catalog"
                    className="hover:text-ink-200 transition-colors"
                  >
                    {t('team.catalog')}
                  </Link>
                </div>
              </div>

              <Link
                to={`/teams/${team!.id}/projects/new`}
                className="btn btn-primary shrink-0"
                style={{ padding: '11px 18px', fontSize: 14 }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <span>{t('team.newProject')}</span>
              </Link>
            </div>
          </header>

          {customers.length > 0 && (
            <div className="mb-4 flex items-center gap-2">
              <select
                className="input"
                value={customerFilter ?? ''}
                onChange={(e) => setCustomerFilter(e.target.value || null)}
                style={{ maxWidth: 240, padding: '6px 10px', fontSize: 13 }}
              >
                <option value="">{t('customer.allCustomers')}</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}

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
              <span className="tech-label relative" style={{ fontSize: 12 }}>EMPTY · 00 PROJECTS</span>
              <h2 className="relative mt-3 font-editorial text-[34px] text-ink-50 leading-none">
                {t('team.emptyProjectsTitle')}
              </h2>
              <p className="relative mt-3 text-ink-300 text-[15px] max-w-sm mx-auto">
                {t('team.emptyProjectsBody')}
              </p>
              <div className="relative mt-6">
                <Link
                  to={`/teams/${team!.id}/projects/new`}
                  className="btn btn-primary"
                  style={{ padding: '12px 20px', fontSize: 14 }}
                >
                  {`${t('team.newProject')} →`}
                </Link>
              </div>
            </div>
          ) : (
            <ul className="space-y-2">
              {(customerFilter
                ? projects!.filter((p) => p.customer === customerFilter)
                : projects!
              ).map((p, i) => {
                // Human-readable relative time for the updated stamp.
                // Kept inline because it's the only date formatting on
                // this page; factoring out a util would be premature.
                const updated = new Date(p.updated);
                const stamp = relativeTime(updated, t);
                // Derive list-row metadata from the opaque `doc` JSON.
                // The server already shipped the full doc down (getFullList
                // above), so reading meta/mapState here costs nothing
                // extra — we're just using more of what we already have.
                const meta = p.doc?.meta;
                // Prefer the expanded customer name; fall back to legacy
                // meta.client for projects created before the customer DB.
                const client = p.expand?.customer?.name ?? meta?.client?.trim();
                const addressLabel = meta?.address?.formatted;
                // Only locked projects have a captured backdrop — the
                // base64 dataURL lives on mapState when `locked === true`.
                // Narrowed here so TS understands capturedImage exists.
                const thumb =
                  p.doc?.mapState?.locked === true
                    ? p.doc.mapState.capturedImage
                    : null;
                return (
                  <li key={p.id}>
                    <div
                      className="surface-row group relative flex items-stretch gap-4 rounded-xl p-4 border"
                      style={{ borderColor: 'var(--hairline)' }}
                    >
                      {/* Numeric index — vertically centered against the
                          taller row so it reads as a list counter rather
                          than an inline label. */}
                      <span
                        className="font-mono text-[13px] text-ink-400 tabular-nums shrink-0 w-8 self-center"
                        style={{ letterSpacing: '0.05em' }}
                      >
                        {String(i + 1).padStart(2, '0')}
                      </span>

                      {/*
                        Thumbnail slot. Two modes:
                        (1) Locked → render the captured satellite image.
                            The doc carries it as a base64 dataURL, which
                            <img src> accepts directly. `object-cover`
                            crops to the aspect ratio of the slot; we
                            keep the image full-quality on disk (we never
                            downscale) because this is the only preview
                            the user sees outside the editor.
                        (2) Unlocked → a compact placeholder with the
                            document glyph, echoing the pre-thumbnail
                            design. Signals "no imagery captured yet"
                            without needing a text label.
                        Note: we intentionally DO NOT lazy-load or
                        defer-decode these. The list is short (tens at
                        most), the dataURLs are already in memory, and
                        loading="lazy" would only add flicker on scroll.
                      */}
                      <div
                        className="shrink-0 overflow-hidden rounded-lg grid place-items-center"
                        style={{
                          width: 128,
                          height: 84,
                          background: 'linear-gradient(135deg, #171013 0%, #0b0809 100%)',
                          border: '1px solid var(--hairline-strong)',
                        }}
                        aria-hidden
                      >
                        {thumb ? (
                          <img
                            src={thumb}
                            alt=""
                            className="block w-full h-full object-cover"
                            draggable={false}
                          />
                        ) : (
                          <svg
                            width="20"
                            height="20"
                            viewBox="0 0 16 16"
                            fill="none"
                            style={{ color: 'var(--sun-300)', opacity: 0.7 }}
                          >
                            <path
                              d="M4 2.5a1 1 0 0 1 1-1h4.5L13 5v8.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-11Z"
                              stroke="currentColor"
                              strokeWidth="1.2"
                              strokeLinejoin="round"
                            />
                            <path d="M9 1.5V5h4" stroke="currentColor" strokeWidth="1.2" />
                          </svg>
                        )}
                      </div>

                      <Link
                        to={`/p/${p.id}`}
                        // `::before` spans the full row so the entire
                        // tile is clickable; individual spans inside
                        // remain selectable text when not clicking.
                        className="flex-1 min-w-0 flex flex-col justify-center gap-1 before:absolute before:inset-0 before:rounded-xl"
                      >
                        <span className="block truncate font-medium text-[16px] text-ink-100">
                          {p.name || t('team.untitledProject')}
                        </span>
                        {/* Second line: client · address. Both optional.
                            Rendered on ONE line with a bullet separator
                            when both are present; collapses cleanly to
                            just one of them when the other is missing.
                            Hidden entirely when neither is set so the
                            row doesn't reserve vertical space for nothing. */}
                        {(client || addressLabel) && (
                          <span className="block truncate text-[13.5px] text-ink-300">
                            {client && <span>{client}</span>}
                            {client && addressLabel && (
                              <span className="mx-1.5 text-ink-500">·</span>
                            )}
                            {addressLabel && <span>{addressLabel}</span>}
                          </span>
                        )}
                        <span className="block font-mono text-[12px] text-ink-400">
                          {t('team.revUpdated', { rev: String(p.revision ?? 0), stamp })}
                        </span>
                      </Link>
                      {myRole === 'admin' && (
                        <button
                          onClick={() => deleteProject(p.id)}
                          className="btn btn-danger relative shrink-0 self-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                          title="Delete project"
                          style={{ padding: '6px 11px', fontSize: 13 }}
                        >
                          {t('team.deleteProject')}
                        </button>
                      )}
                      <span
                        className="text-ink-400 text-[18px] transition-all relative self-center group-hover:translate-x-0.5 group-hover:text-sun-300"
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
  // Fall through to an absolute date — formatted in the app's active
  // locale (read from i18next so the toggle in the header drives it, not
  // the browser default). German → "24.04.2026", English → "04/24/2026".
  // Zero-padded 2-digit day/month so the dotted form stays column-aligned
  // in list views — `dateStyle: 'short'` would drop the leading zeros.
  return d.toLocaleDateString(i18next.language, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}
