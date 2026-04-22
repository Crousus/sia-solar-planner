// ────────────────────────────────────────────────────────────────────────
// TeamPicker — the `/` page for a signed-in user.
//
// Shows the teams they're in. One click navigates to the team view.
// Empty state directs them to create their first team.
//
// Access scoping: PocketBase row-level rules for the `teams` collection
// permit list/view only to members, so an unfiltered getFullList here
// returns exactly the user's teams. If the rule ever loosens, we'd need
// an explicit filter here to avoid leaking other teams.
//
// Design: "Command Console" aesthetic — atmospheric background, pill top
// bar with brand mark + user menu, dashboard-style content using .surface
// / .surface-row primitives from src/index.css. Mono meta rows on each
// team tile reinforce the "technical directory" feel.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { TeamRecord } from '../backend/types';
import { useAuthUser } from './AppShell';
import { PageShell } from './PageShell';

export default function TeamPicker() {
  const { t } = useTranslation();
  const user = useAuthUser();
  const navigate = useNavigate();
  // null = still loading; [] = loaded but empty (drives the empty-state UI).
  // One tri-state field beats separate `loading` + `data` booleans — the
  // render conditions stay exhaustive and there's no "loading but also
  // have stale data" middle ground.
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
    // authStore.clear() is synchronous — wipes the in-memory token and
    // localStorage entry, firing the onChange subscription in AppShell
    // which rerenders the tree. The navigate() call moves us to /login
    // proactively so the AuthGuard redirect doesn't briefly render the
    // now-unauthorized TeamPicker.
    pb.authStore.clear();
    navigate('/login', { replace: true });
  }

  return (
    <PageShell
      label="FIG_01 · WORKSPACES"
      userEmail={user?.email}
      onSignOut={signOut}
    >
      <header className="flex items-end justify-between mb-8">
        <div>
          <span className="tech-label">01 · Index</span>
          <h1 className="mt-1 font-editorial text-[48px] leading-[1.05] tracking-tight text-ink-50">
            {t('team.yourTeams')}
          </h1>
        </div>
        <Link
          to="/teams/new"
          className="btn btn-primary"
          style={{ padding: '9px 14px', fontSize: 12.5 }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span>{t('team.newTeam')}</span>
        </Link>
      </header>

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

      {!teams ? (
        /* Skeleton row — 3 stub tiles so the page doesn't jank on load.
           Width + height match the real row so the hand-off is invisible. */
        <ul className="space-y-2">
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="surface rounded-xl h-[68px] animate-pulse"
              style={{ opacity: 0.4 - i * 0.08 }}
              aria-hidden
            />
          ))}
        </ul>
      ) : teams.length === 0 ? (
        /* Empty state. Framed as a terminal prompt rather than a console
           error to keep the tone inviting. The CTA is the hero of the
           empty state; the tech-label supplies auxiliary context. */
        <div
          className="surface rounded-2xl px-8 py-14 text-center relative overflow-hidden"
        >
          {/* Scarlet bloom behind the headline — atmospheric, subtle.
              Positioned absolute so it doesn't shift centered text. */}
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none animate-drift"
            style={{
              background:
                'radial-gradient(ellipse 50% 50% at 50% 0%, rgba(255,99,99,0.15), transparent 70%)',
            }}
          />
          <span className="tech-label relative">EMPTY · 00 TEAMS</span>
          <h2 className="relative mt-3 font-editorial text-[32px] text-ink-50 leading-none">
            {t('team.noTeamsTitle')}
          </h2>
          <p className="relative mt-3 text-ink-300 text-[14px] max-w-sm mx-auto">
            {t('team.noTeamsBody')}
          </p>
          <div className="relative mt-6">
            <Link
              to="/teams/new"
              className="btn btn-primary"
              style={{ padding: '10px 16px', fontSize: 13 }}
            >
              {t('team.createFirstTeam')}
            </Link>
          </div>
        </div>
      ) : (
        <ul className="space-y-2">
          {/* Map param is `team` (not `t`) to avoid shadowing the
              `t` translation function from useTranslation(). */}
          {teams.map((team, i) => (
            <li key={team.id}>
              <Link
                to={`/teams/${team.id}`}
                className="surface-row group flex items-center gap-4 rounded-xl px-4 py-3.5 border transition-all"
                style={{ borderColor: 'var(--hairline)' }}
              >
                {/* Numeric index in mono — reinforces "table of contents"
                    quality, scans top-down without needing a heading. */}
                <span
                  className="font-mono text-[11px] text-ink-400 tabular-nums shrink-0 w-6"
                  style={{ letterSpacing: '0.05em' }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                {/* Square avatar swatch — derived-color from team id so each
                    team has a stable visual anchor without needing
                    user-uploaded avatars. */}
                <span
                  aria-hidden
                  className="shrink-0 grid place-items-center rounded-lg font-mono font-semibold"
                  style={{
                    width: 32,
                    height: 32,
                    background: avatarTint(team.id),
                    color: 'var(--ink-50)',
                    border: '1px solid var(--hairline-strong)',
                    fontSize: 12,
                    letterSpacing: '0.02em',
                  }}
                >
                  {team.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block truncate font-medium text-ink-100">
                    {team.name}
                  </span>
                  <span className="mt-0.5 block font-mono text-[10.5px] text-ink-400">
                    /teams/{team.id.slice(0, 10)}
                  </span>
                </span>
                {/* Chevron — only reveals on hover to keep the row clean */}
                <span
                  className="text-ink-400 transition-transform group-hover:translate-x-0.5 group-hover:text-sun-300"
                  aria-hidden
                >
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}

/*
 * Deterministic "tint" for a team avatar from its id. Five near-black
 * backgrounds with a trace of hue so teams are distinguishable without
 * introducing loud colors that'd fight the scarlet accent. Using string
 * hash → index keeps the palette stable per team across renders.
 */
function avatarTint(id: string): string {
  const palette = [
    'linear-gradient(135deg, #2b1416 0%, #17090a 100%)', // warm
    'linear-gradient(135deg, #1a1320 0%, #0d0913 100%)', // violet
    'linear-gradient(135deg, #0f1a1a 0%, #070e0e 100%)', // teal
    'linear-gradient(135deg, #201a10 0%, #110e08 100%)', // amber
    'linear-gradient(135deg, #1a1a20 0%, #0c0c12 100%)', // slate
  ];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
