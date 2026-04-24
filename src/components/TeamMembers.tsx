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
// TeamMembers — /teams/:teamId/members — admin-only invite + remove UI.
//
// Route gating: AppShell wraps this in <AuthGuard>, but does NOT gate
// admin-only access. The API itself enforces that only admins can
// create/delete team_members (PocketBase rule). So a non-admin who
// somehow lands on this URL will see the member list (allowed) but get
// a server error on invite/remove. Showing the page anyway is OK
// because the team list link to it is already conditioned on admin.
//
// Invite UX: looks up the user by email first. The `users` collection
// view rule allows authenticated users to look up by exact email; this
// is intentional to support the invite flow. Without it we'd need a
// server-side "invite by email" RPC.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { TeamMemberRecord, UserRecord } from '../backend/types';
import { useAuthUser } from './AppShell';
import { PageShell } from './PageShell';

interface MemberWithUser {
  member: TeamMemberRecord;
  user: UserRecord;
}

export default function TeamMembers() {
  const { t } = useTranslation();
  const { teamId } = useParams<{ teamId: string }>();
  const me = useAuthUser();
  const navigate = useNavigate();

  const [rows, setRows] = useState<MemberWithUser[] | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    pb.authStore.clear();
    navigate('/login', { replace: true });
  }

  async function reload() {
    if (!teamId) return;
    // expand: 'user' tells PocketBase to attach the related user record
    // under `expand.user`. Saves us a second round-trip per row.
    const members = await pb
      .collection('team_members')
      .getFullList<TeamMemberRecord>({ filter: `team="${teamId}"`, expand: 'user' });
    setRows(
      members.map((m) => ({
        member: m,
        // PocketBase attaches expanded relations under `m.expand`, but our
        // hand-maintained TeamMemberRecord type (in backend/types.ts)
        // doesn't model that field — keeping it off the base type avoids
        // tempting callers to assume expansions are always present. Cast
        // through `unknown` to a narrowly-typed local shape so the
        // assertion is explicit at the use site, not at the type def.
        user: (m as unknown as { expand: { user: UserRecord } }).expand.user,
      })),
    );
  }

  useEffect(() => {
    reload().catch((e) => setError((e as Error).message));
    // Reload is stable per teamId — not including it in deps prevents
    // an infinite re-fetch loop on identity changes (it's recreated on
    // every render). The teamId dep alone is the correct trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!teamId) return;
    setBusy(true);
    setError(null);
    try {
      // Step 1: find the user by exact email. If none exists we surface
      // a friendly message rather than the cryptic 404 PocketBase returns.
      let targetUser: UserRecord;
      try {
        targetUser = await pb
          .collection('users')
          .getFirstListItem<UserRecord>(`email="${inviteEmail.trim()}"`);
      } catch {
        setError(t('team.noUserWithEmail'));
        return;
      }
      // Step 2: client-side dedupe so we don't send a doomed-to-fail
      // create. The server's unique constraint on (team, user) would
      // also reject it, but a UI message is friendlier.
      if (rows?.some((r) => r.user.id === targetUser.id)) {
        setError(t('team.alreadyInTeam'));
        return;
      }
      await pb.collection('team_members').create<TeamMemberRecord>({
        team: teamId,
        user: targetUser.id,
        role: 'member',
      });
      setInviteEmail('');
      await reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Invite failed.');
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(memberId: string) {
    if (!confirm(t('team.removeMemberConfirm'))) return;
    await pb.collection('team_members').delete(memberId);
    await reload();
  }

  return (
    <PageShell
      label="FIG_04 · MEMBERS"
      userEmail={me?.email}
      onSignOut={signOut}
    >
      <div className="mb-6 flex items-center gap-2">
        <Link
          to={`/teams/${teamId}`}
          className="font-mono text-[11px] text-ink-400 hover:text-ink-200 transition-colors"
        >
          {t('team.backToTeam')}
        </Link>
      </div>

      <div className="mb-8">
        <span className="tech-label">TEAM ACCESS</span>
        <h1 className="mt-1 font-editorial text-[44px] leading-[1.05] tracking-tight text-ink-50">
          {t('team.membersTitle')}
        </h1>
        {rows && (
          <div className="mt-2 font-mono text-[11px] text-ink-400">
            <span className="text-ink-200 tabular-nums">{rows.length}</span>{' '}
            {t('team.memberUnit', { count: rows.length })}
          </div>
        )}
      </div>

      {/* Invite form up top so the primary action is visible without
          scrolling. Follows the same rounded .surface card idiom as
          NewTeamPage; the input+button sit side-by-side for a familiar
          "type email, press enter" UX. */}
      <form onSubmit={invite} className="surface rounded-[14px] p-5 mb-6">
        <span className="field-label mb-2 block">{t('team.inviteByEmail')}</span>
        <div className="flex gap-2">
          <input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder={t('team.inviteEmailPlaceholder')}
            className="input flex-1"
            required
          />
          <button
            type="submit"
            disabled={busy || !inviteEmail}
            className="btn btn-primary shrink-0"
            style={{ padding: '9px 14px', fontSize: 12.5 }}
          >
            {busy ? (
              <>
                <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                  <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                </svg>
                <span>{t('team.inviting')}</span>
              </>
            ) : (
              <span>{t('team.invite')}</span>
            )}
          </button>
        </div>
        {error && (
          <div
            role="alert"
            className="mt-3 rounded-lg px-3 py-2 text-[12.5px]"
            style={{
              background: 'rgba(255, 99, 99, 0.08)',
              border: '1px solid rgba(255, 99, 99, 0.35)',
              color: 'var(--sun-200)',
            }}
          >
            {error}
          </div>
        )}
      </form>

      {!rows ? (
        <ul className="space-y-2">
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="surface rounded-xl h-[56px] animate-pulse"
              style={{ opacity: 0.4 - i * 0.08 }}
              aria-hidden
            />
          ))}
        </ul>
      ) : rows.length === 0 ? (
        /* Empty state is unlikely (the creator is always a member) but
           defended so the UI doesn't render a bare heading. */
        <p className="text-ink-300 text-[14px]">{t('team.noMembers')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map(({ member, user }) => (
            <li
              key={member.id}
              className="surface-row group flex items-center gap-4 rounded-xl px-4 py-3.5 border"
              style={{ borderColor: 'var(--hairline)' }}
            >
              {/* Initials avatar — same visual language as TeamPicker. */}
              <span
                aria-hidden
                className="shrink-0 grid place-items-center rounded-lg font-mono font-semibold"
                style={{
                  width: 32,
                  height: 32,
                  background: 'linear-gradient(135deg, #1a1213 0%, #0c0809 100%)',
                  color: 'var(--ink-50)',
                  border: '1px solid var(--hairline-strong)',
                  fontSize: 11,
                }}
              >
                {user.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block truncate font-medium text-ink-100">
                  {user.name}
                </span>
                <span className="mt-0.5 block font-mono text-[10.5px] text-ink-400 truncate">
                  {user.email}
                </span>
              </span>
              {/* Role chip — scarlet-tinted for admin, neutral for member.
                  The chip-amber class is now scarlet (name preserved for
                  API stability) so admin reads as the "primary" role. */}
              <span
                className={`chip ${member.role === 'admin' ? 'chip-amber' : ''}`}
                style={{ fontSize: 10 }}
              >
                {member.role}
              </span>
              {/* Hide Remove on the caller's own row to prevent self-removal —
                  which would leave the user on a page they no longer have
                  access to. Server enforces the same but UI gating avoids
                  the round trip. */}
              {user.id !== me?.id && (
                <button
                  onClick={() => removeMember(member.id)}
                  className="btn btn-danger shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                  style={{ padding: '4px 8px' }}
                >
                  {t('team.removeMember')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
