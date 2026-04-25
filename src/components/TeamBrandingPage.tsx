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
// TeamBrandingPage — /teams/:teamId/branding — logo + company name.
//
// Admin-only (client-side gating for UX; the API rule itself — teams
// updateRule = admin-of-team — is the real security boundary). A
// non-admin who lands here sees the current branding but the save
// button is hidden.
//
// File upload: PocketBase's update API accepts FormData when the
// collection has a file field. We build a FormData body whose keys are
// the field names; the SDK unwraps the response as a typed record as
// usual.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { TeamMemberRecord, TeamRecord } from '../backend/types';
import { useAuthUser } from './AppShell';
import { PageShell } from './PageShell';
import { formatErrorForUser } from '../utils/errorClassify';

export default function TeamBrandingPage() {
  const { t } = useTranslation();
  const { teamId } = useParams<{ teamId: string }>();
  const user = useAuthUser();
  const navigate = useNavigate();

  const [team, setTeam] = useState<TeamRecord | null>(null);
  const [myRole, setMyRole] = useState<'admin' | 'member' | null>(null);
  const [companyName, setCompanyName] = useState('');
  // The pending logo is kept separate from the saved logo URL: the
  // preview below renders the File via `URL.createObjectURL` when the
  // user has selected a new file but not yet hit save, and falls back
  // to the server-side URL otherwise.
  const [pendingLogo, setPendingLogo] = useState<File | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function signOut() {
    pb.authStore.clear();
    navigate('/login', { replace: true });
  }

  useEffect(() => {
    if (!teamId || !user) return;
    let cancelled = false;
    Promise.all([
      pb.collection('teams').getOne<TeamRecord>(teamId),
      pb
        .collection('team_members')
        .getFirstListItem<TeamMemberRecord>(
          `team="${teamId}" && user="${user.id}"`,
        ),
    ])
      .then(([teamRec, me]) => {
        if (cancelled) return;
        setTeam(teamRec);
        setCompanyName(teamRec.company_name ?? '');
        setMyRole(me.role);
      })
      .catch((err) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[TeamBrandingPage] initial fetch failed', err);
        setError(formatErrorForUser(err, t));
      });
    return () => { cancelled = true; };
  }, [teamId, user, t]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!team) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // Three cases:
      //   (a) user picked a new logo file → multipart upload
      //   (b) user clicked "remove logo"  → send `logo: null` to clear
      //   (c) neither                      → plain JSON update
      // We always update `company_name` in the same request so the
      // two fields never drift out of sync if one half of a save fails.
      let body: FormData | Record<string, string | null>;
      if (pendingLogo) {
        const fd = new FormData();
        fd.append('company_name', companyName.trim());
        fd.append('logo', pendingLogo);
        body = fd;
      } else if (removeLogo) {
        body = { company_name: companyName.trim(), logo: null };
      } else {
        body = { company_name: companyName.trim() };
      }
      const updated = await pb
        .collection('teams')
        .update<TeamRecord>(team.id, body);
      setTeam(updated);
      setPendingLogo(null);
      setRemoveLogo(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setSaved(true);
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error('[TeamBrandingPage] save failed', err);
      setError(formatErrorForUser(err, t));
    } finally {
      setBusy(false);
    }
  }

  const isAdmin = myRole === 'admin';
  // Build the preview URL. Priority:
  //   1. User just picked a new file (show the local blob)
  //   2. User checked "remove logo" (show placeholder)
  //   3. Server has a stored logo (show it via pb.files.getUrl)
  //   4. Nothing set (placeholder)
  // `pb.files.getURL` in SDK v0.26+ (lower-case 'rl' is the older
  // name — we use getURL here; grep confirmed the SDK exposes both).
  const pendingLogoUrl = pendingLogo ? URL.createObjectURL(pendingLogo) : null;
  const savedLogoUrl = !removeLogo && team?.logo
    ? pb.files.getURL(team, team.logo)
    : null;
  const logoUrl = pendingLogoUrl ?? savedLogoUrl;

  // Revoke the blob URL when the pending file changes or component
  // unmounts — otherwise we leak a blob reference per pick.
  useEffect(() => {
    return () => {
      if (pendingLogoUrl) URL.revokeObjectURL(pendingLogoUrl);
    };
  }, [pendingLogoUrl]);

  return (
    <PageShell
      label="FIG_07 · BRANDING"
      userEmail={user?.email}
      onSignOut={signOut}
      width="narrow"
    >
      <div className="mb-6 flex items-center gap-2">
        <Link
          to={teamId ? `/teams/${teamId}` : '/'}
          className="font-mono text-[14px] text-ink-300 hover:text-ink-100 transition-colors"
        >
          {team ? `← ${team.name}` : t('team.allTeams')}
        </Link>
      </div>

      <div className="mb-8">
        <span className="tech-label">EXPORTS</span>
        <h1 className="mt-1 font-editorial text-[44px] leading-[1.05] tracking-tight text-ink-50">
          {t('branding.title')}
        </h1>
        <p className="mt-3 text-ink-300 text-[14px] max-w-sm">
          {t('branding.desc')}
        </p>
      </div>

      {!team ? (
        <div className="surface rounded-[14px] p-6 text-ink-300 text-[13px]">
          {t('team.loading')}
        </div>
      ) : (
        <form onSubmit={submit} className="surface rounded-[14px] p-6 space-y-5">
          {/* Logo preview + picker. The preview slot has fixed dimensions
              so an empty state and a loaded state occupy the same space —
              no layout jump when a file is picked. */}
          <div>
            <span className="field-label">{t('branding.logoLabel')}</span>
            <div
              className="mt-2 rounded-lg flex items-center justify-center overflow-hidden"
              style={{
                // Tall enough for a wide wordmark logo, not so tall that
                // it dominates the form card. White background because
                // most logos are designed for light backgrounds and can
                // disappear against the app's dark surface.
                height: 120,
                background: '#ffffff',
                border: '1px solid var(--hairline)',
              }}
            >
              {logoUrl ? (
                <img
                  src={logoUrl}
                  alt=""
                  style={{
                    maxWidth: '80%',
                    maxHeight: '80%',
                    objectFit: 'contain',
                  }}
                />
              ) : (
                <span
                  className="font-mono text-[11px]"
                  style={{ color: '#999' }}
                >
                  {t('branding.noLogo')}
                </span>
              )}
            </div>
            {isAdmin && (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setPendingLogo(f);
                    if (f) setRemoveLogo(false);
                  }}
                  className="text-[12px] text-ink-300"
                />
                {team.logo && !pendingLogo && (
                  <button
                    type="button"
                    onClick={() => setRemoveLogo((v) => !v)}
                    className="btn btn-ghost text-[12px]"
                    style={{ padding: '5px 10px' }}
                  >
                    {removeLogo
                      ? t('branding.removeLogoUndo')
                      : t('branding.removeLogo')}
                  </button>
                )}
              </div>
            )}
            <p className="mt-1.5 text-[11px] text-ink-400 font-mono">
              {t('branding.logoHint')}
            </p>
          </div>

          <label className="block">
            <span className="field-label">{t('branding.companyNameLabel')}</span>
            <input
              className="input"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder={t('branding.companyNamePlaceholder')}
              maxLength={200}
              disabled={!isAdmin}
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
            {isAdmin ? (
              <button
                type="submit"
                disabled={busy}
                className="btn btn-primary flex-1 justify-center"
                style={{ padding: '10px 14px', fontSize: 13 }}
              >
                {busy ? t('account.saving') : t('account.save')}
              </button>
            ) : (
              <div className="text-[12px] text-ink-400 flex-1">
                {t('branding.readOnly')}
              </div>
            )}
            <Link
              to={`/teams/${team.id}`}
              className="btn btn-ghost"
              style={{ padding: '10px 14px', fontSize: 13 }}
            >
              {t('team.cancel')}
            </Link>
          </div>
        </form>
      )}
    </PageShell>
  );
}
