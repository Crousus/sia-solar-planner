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
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { pb } from '../backend/pb';
import type { TeamMemberRecord, UserRecord } from '../backend/types';
import { useAuthUser } from './AppShell';

interface MemberWithUser {
  member: TeamMemberRecord;
  user: UserRecord;
}

export default function TeamMembers() {
  const { t } = useTranslation();
  const { teamId } = useParams<{ teamId: string }>();
  const me = useAuthUser();

  const [rows, setRows] = useState<MemberWithUser[] | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        // tempting callers to assume expansions are always present.
        // Cast through `unknown` to a narrowly-typed local shape so the
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

  if (error && !rows) return <Shell><p className="text-red-400">{error}</p></Shell>;
  if (!rows) return <Shell><p>{t('team.loading')}</p></Shell>;

  return (
    <Shell>
      <header className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold">{t('team.membersTitle')}</h1>
        <Link className="text-sm underline" to={`/teams/${teamId}`}>{t('team.backToTeam')}</Link>
      </header>

      <ul className="space-y-2 mb-6">
        {rows.map(({ member, user }) => (
          <li key={member.id} className="flex items-center gap-2 bg-zinc-800 rounded p-3">
            <span className="flex-1">
              <span className="font-medium">{user.name}</span>{' '}
              <span className="text-zinc-400 text-sm">({user.email})</span>
            </span>
            <span className="text-xs uppercase tracking-wider text-zinc-400">{member.role}</span>
            {/* Hide the Remove button on the caller's own row to prevent
                self-removal — which would leave the user looking at a
                page they no longer have access to. The server enforces
                the same on its delete rule (admin can't remove self if
                they're the last admin), but UI gating avoids the round
                trip. */}
            {user.id !== me?.id && (
              <button
                onClick={() => removeMember(member.id)}
                className="text-sm text-red-400 underline"
              >
                {t('team.removeMember')}
              </button>
            )}
          </li>
        ))}
      </ul>

      <form onSubmit={invite} className="flex gap-2">
        <input
          type="email"
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          placeholder={t('team.inviteByEmail')}
          className="flex-1 px-3 py-2 bg-zinc-800 rounded"
          required
        />
        <button
          type="submit"
          disabled={busy}
          className="px-4 py-2 bg-blue-600 rounded disabled:opacity-50"
        >
          {busy ? t('team.inviting') : t('team.invite')}
        </button>
      </form>
      {error && <p className="mt-2 text-red-400 text-sm">{error}</p>}
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
