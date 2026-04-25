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
// AccountPage — /account — edit my own display name + phone.
//
// Kept deliberately minimal: these are the two fields that drive the
// "Planner" identity on PDF exports. Anything more (password reset,
// email change, delete account) is out of scope until a user asks for
// it — PocketBase exposes those operations directly through the admin
// UI for self-serve needs.
//
// The PB SDK's `users.update` will hot-swap the record on the authStore,
// so useAuthUser() re-renders with the new values on success without a
// page reload. No need to manually refetch or navigate.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { UserRecord } from '../backend/types';
import { useAuthUser } from './AppShell';
import { PageShell } from './PageShell';
import { formatErrorForUser } from '../utils/errorClassify';

export default function AccountPage() {
  const { t } = useTranslation();
  const user = useAuthUser();
  const navigate = useNavigate();

  // Local form state seeded from the auth record. We seed once on mount
  // (and whenever the record id changes) rather than keeping the inputs
  // as controlled mirrors of `user` — that would clobber in-flight edits
  // every time the PB SDK refreshed the auth token (which happens on a
  // schedule and would otherwise reset typed-but-unsaved values).
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!user) return;
    setName(user.name ?? '');
    setPhone(user.phone ?? '');
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function signOut() {
    pb.authStore.clear();
    navigate('/login', { replace: true });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // `update` patches the record AND refreshes the authStore record
      // field-by-field, so useAuthUser() subscribers pick up the new
      // name/phone automatically. The returned record is the fresh row.
      await pb.collection('users').update<UserRecord>(user.id, {
        name: name.trim(),
        // Send the phone even when blank — we want to explicitly clear
        // a previously-set value. PB treats an empty string as "unset"
        // for optional text fields, matching our intent.
        phone: phone.trim(),
      });
      setSaved(true);
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error('[AccountPage] save failed', err);
      setError(formatErrorForUser(err, t));
    } finally {
      setBusy(false);
    }
  }

  if (!user) return null; // AuthGuard already bounced; defensive only.

  return (
    <PageShell
      label="FIG_06 · ACCOUNT"
      userEmail={user.email}
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
        <span className="tech-label">PROFILE</span>
        <h1 className="mt-1 font-editorial text-[44px] leading-[1.05] tracking-tight text-ink-50">
          {t('account.title')}
        </h1>
        <p className="mt-3 text-ink-300 text-[14px] max-w-sm">
          {t('account.desc')}
        </p>
      </div>

      <form onSubmit={submit} className="surface rounded-[14px] p-6 space-y-4">
        {/* Email is shown read-only — changing it is a security-sensitive
            operation (PB sends a verification email) that we deliberately
            don't surface here. Users can change it via the admin UI. */}
        <div>
          <span className="field-label">{t('login.emailLabel')}</span>
          <div
            className="input"
            style={{
              opacity: 0.6,
              cursor: 'not-allowed',
              userSelect: 'text',
            }}
          >
            {user.email}
          </div>
        </div>

        <label className="block">
          <span className="field-label">{t('login.nameLabel')}</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('login.namePlaceholder')}
            required
            minLength={1}
            maxLength={100}
            autoComplete="name"
          />
        </label>

        <label className="block">
          <span className="field-label">{t('account.phoneLabel')}</span>
          <input
            className="input"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t('account.phonePlaceholder')}
            maxLength={50}
            autoComplete="tel"
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

        {saved && !error && (
          <div
            role="status"
            className="rounded-lg px-3 py-2 text-[12.5px]"
            style={{
              background: 'rgba(99, 199, 99, 0.08)',
              border: '1px solid rgba(99, 199, 99, 0.35)',
              color: '#9fd69f',
            }}
          >
            {t('account.saved')}
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
                <span>{t('account.saving')}</span>
              </>
            ) : (
              <span>{t('account.save')}</span>
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
