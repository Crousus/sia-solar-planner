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
// NewTeamPage — minimal form to create a team.
//
// On success the server-side hook (see server/pb_hooks/) auto-creates a
// team_members row pairing the creator with role='admin'. So we don't
// need a follow-up create call here — the navigation to /teams/:id will
// find the user already a member, and TeamView's role lookup will see
// them as admin.
// ────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { pb } from '../backend/pb';
import { formatErrorForUser } from '../utils/errorClassify';
import type { TeamRecord } from '../backend/types';
import { useAuthUser } from './AppShell';
import { PageShell } from './PageShell';

export default function NewTeamPage() {
  const { t } = useTranslation();
  const user = useAuthUser();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  // `busy` doubles as a submit-button disabled flag and a "show spinner"
  // signal. Separate from `error` so a retry after a failed submit can
  // clear the error while the busy spinner kicks in.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    pb.authStore.clear();
    navigate('/login', { replace: true });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Defensive: AuthGuard already blocks unauthenticated callers, but
    // useAuthUser's type allows null so we narrow here too. Without this
    // guard `user.id` below would be a type error.
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const team = await pb.collection('teams').create<TeamRecord>({
        name: name.trim(),
        created_by: user.id,
      });
      navigate(`/teams/${team.id}`);
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error('[NewTeamPage] create failed', err);
      // formatErrorForUser handles validation (400/422 with field
      // payloads) by surfacing the field-level reason in the detail
      // line, network failures with their own headline, etc. — same
      // signal as `err.message` carried, with categorised wording.
      setError(formatErrorForUser(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell
      label="FIG_03 · NEW TEAM"
      userEmail={user?.email}
      onSignOut={signOut}
      width="narrow"
    >
      <div className="mb-6 flex items-center gap-2">
        <Link
          to="/"
          className="font-mono text-[14px] text-ink-300 hover:text-ink-100 transition-colors"
        >
          {t('team.allTeams')}
        </Link>
      </div>

      <div className="mb-8">
        <span className="tech-label">CREATE</span>
        <h1 className="mt-1 font-editorial text-[44px] leading-[1.05] tracking-tight text-ink-50">
          {t('team.newTeam')}
        </h1>
        <p className="mt-3 text-ink-300 text-[14px] max-w-sm">
          {t('team.newTeamDesc')}
        </p>
      </div>

      <form onSubmit={submit} className="surface rounded-[14px] p-6 space-y-4">
        <label className="block">
          <span className="field-label">{t('team.teamName')}</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('team.teamNamePlaceholder')}
            required
            minLength={1}
            maxLength={100}
            autoFocus
          />
        </label>

        {error && (
          <div
            role="alert"
            className="rounded-lg px-3 py-2 text-[12.5px]"
            style={{
              background: 'rgba(255, 99, 99, 0.08)',
              border: '1px solid rgba(255, 99, 99, 0.35)',
              color: 'var(--sun-200)',
            }}
          >
            {error}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={busy}
            className="btn btn-primary flex-1 justify-center"
            style={{ padding: '10px 14px', fontSize: 13 }}
          >
            {busy ? (
              <>
                <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                  <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                </svg>
                <span>{t('team.creating')}</span>
              </>
            ) : (
              <span>{t('team.createTeam')}</span>
            )}
          </button>
          <Link
            to="/"
            className="btn btn-ghost"
            style={{ padding: '10px 14px', fontSize: 13 }}
          >
            {t('team.cancel')}
          </Link>
        </div>
      </form>
    </PageShell>
  );
}
