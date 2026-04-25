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
// LoginPage — sign in / sign up sharing one toggled form.
//
// Sign up requires `name` per the users-collection rule; we prompt for it
// only in the sign-up branch.
//
// After sign-up we immediately authWithPassword because PocketBase's create
// endpoint returns a record but not a session token.
//
// Design notes:
//   - Full redesign to the "Command Console" aesthetic: atmospheric
//     near-black background with scarlet corner bloom, a centered
//     hairline-bordered card, Instrument Serif italic hero headline, and
//     FIG_## monospace trail labels. All visual primitives come from
//     src/index.css (.surface, .input, .btn-primary, .page-atmosphere,
//     .tech-label) so the page stays mostly markup.
//   - Error messages surface in a hairline scarlet chip rather than raw
//     red text — consistent with the chip/badge language used elsewhere.
//   - The mode toggle is now a subtle link-in-caption on a single line,
//     which matches the Raycast pattern of downplaying secondary actions
//     so the primary CTA has uncontested weight.
//
// Error handling is intentionally generic: PocketBase returns rich
// per-field validation errors (err.response.data) but inline field errors
// are a bigger UX investment. For M2/1 we show the top-level message.
// ────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { ClientResponseError } from 'pocketbase';
import { pb } from '../backend/pb';
import { maybeImportLocalStorage } from '../backend/migrateLocalStorage';
import { formatErrorForUser } from '../utils/errorClassify';

type Mode = 'signin' | 'signup';

// Shape of router-supplied state on a redirect from AuthGuard. Optional
// everywhere because direct navigations to /login (typed in the address
// bar, no redirect) carry no state.
interface LocationState {
  from?: { pathname?: string };
}

export default function LoginPage() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState(false);
  const [busy, setBusy] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();
  // Default landing target after auth = root. The guard hands us the
  // intended URL via state.from when it bounced the user here.
  const from = (location.state as LocationState | null)?.from?.pathname ?? '/';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPendingApproval(false);
    setBusy(true);
    try {
      if (mode === 'signup') {
        // PocketBase users collection supports creation by anyone (see
        // built-in auth collection create rule). `passwordConfirm` is
        // required by the SDK even though we collect the password once;
        // PB validates equality server-side and rejects mismatches.
        await pb.collection('users').create({
          email,
          password,
          passwordConfirm: password,
          name,
        });
      }
      // For both branches we end with a fresh password auth so the
      // authStore is populated identically — sign-up doesn't auto-auth.
      await pb.collection('users').authWithPassword(email, password);
      // Task 15: one-shot auto-import of a pre-backend localStorage draft.
      // Fires on BOTH sign-in and sign-up paths; see migrateLocalStorage
      // for full gating logic. `.catch(() => null)` is deliberate: a failed
      // import must NOT block login — the user still reaches `from` and
      // the localStorage blob is preserved so a later attempt can succeed.
      const importedProjectId = await maybeImportLocalStorage().catch(
        () => null,
      );
      const target = importedProjectId ? `/p/${importedProjectId}` : from;
      navigate(target, { replace: true });
    } catch (err: unknown) {
      // When REQUIRE_APPROVAL is active on the server, a fresh sign-up
      // succeeds (account created) but the subsequent authWithPassword is
      // rejected with 403. Rather than showing a red error we show a neutral
      // "awaiting approval" notice — the user did nothing wrong.
      if (
        mode === 'signup' &&
        err instanceof ClientResponseError &&
        err.status === 403
      ) {
        setPendingApproval(true);
      } else {
        // eslint-disable-next-line no-console
        console.error('[LoginPage] auth failed', err);
        // Classifier-formatted message gives the user a real headline:
        // "Cannot reach the server" for backend down, "Some fields aren't
        // valid" for a 400 validation, etc. — instead of PocketBase's
        // generic "Failed to authenticate." boilerplate.
        setError(formatErrorForUser(err, t));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center page-atmosphere text-ink-100 relative overflow-hidden">
      {/*
        Decorative corner markers — pure ornament, `aria-hidden`.
        They echo the FIG_## labels on raycast.com and frame the hero as a
        "blueprint" rather than a web form. Positioned at the viewport edges
        so the content card doesn't carry their weight.
      */}
      <span
        aria-hidden
        className="tech-label absolute top-6 left-6 select-none"
      >
        FIG_00 · ACCESS TERMINAL
      </span>
      <span
        aria-hidden
        className="tech-label absolute top-6 right-6 select-none"
      >
        SOLAR / PLANNER · v0.1
      </span>
      <span
        aria-hidden
        className="tech-label absolute bottom-6 left-6 select-none opacity-70"
      >
        AUTH · {mode === 'signin' ? '01 SIGN-IN' : '02 REGISTER'}
      </span>
      <span
        aria-hidden
        className="tech-label absolute bottom-6 right-6 select-none opacity-70"
      >
        ↵ RETURN TO SUBMIT
      </span>

      {/*
        The card is intentionally narrow (360px target) so the hero headline
        reads as the dominant element. `.surface` carries the glass + hairline
        look; additional rounding (14px) nudges it toward the Raycast card
        radius. z-index lifts it above the atmospheric layer.
      */}
      <div className="relative z-10 w-full max-w-[380px] px-6">
        {/* Hero wordmark — two lines, asymmetrical.
             Line 1: italic Instrument Serif for "Solar" (the signature move).
             Line 2: all-caps tight-tracked sans for "/planner" with a thin
                     hairline on the left as a compositional anchor. */}
        <div className="mb-8 select-none">
          <div className="flex items-baseline gap-2">
            <span
              className="font-editorial text-[56px] leading-none tracking-tight"
              style={{ color: 'var(--ink-50)' }}
            >
              Solar
            </span>
            {/* Scarlet dot — punctuation glyph. Tiny but tonally important:
                it's the one overt color signal on the hero. */}
            <span
              className="inline-block rounded-full"
              style={{
                width: 10,
                height: 10,
                background: 'var(--sun-400)',
                boxShadow: '0 0 14px 2px var(--glow-red)',
              }}
            />
          </div>
          <div className="mt-2 flex items-center gap-3">
            <span
              className="h-px w-8"
              style={{ background: 'var(--hairline-strong)' }}
            />
            <span className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-300">
              Planner · precision PV layout
            </span>
          </div>
        </div>

        <form onSubmit={submit} className="surface rounded-[14px] p-6 space-y-4">
          {/* Mode header — the card's own small caption. The `mode` label
              lives in mono caps so it reads as a state indicator, not a
              heading. The heading itself is the Instrument Serif hero above. */}
          <div className="flex items-center justify-between">
            <span className="tech-label">
              {mode === 'signin' ? t('login.signIn') : t('login.signUp')}
            </span>
            {/* Live status dot — mirrors the "system armed" vocabulary used
                in the Toolbar's locked state. Pulses on idle so the card
                feels alive; goes scarlet-steady while busy. */}
            <span className="relative flex items-center justify-center" style={{ width: 10, height: 10 }}>
              <span
                className={`absolute inset-0 rounded-full ${busy ? '' : 'animate-pulse-sun'}`}
                style={{ background: 'var(--sun-400)', filter: 'blur(5px)', opacity: busy ? 0.9 : 0.6 }}
              />
              <span
                className="relative rounded-full"
                style={{ width: 6, height: 6, background: 'var(--sun-300)' }}
              />
            </span>
          </div>

          {mode === 'signup' && (
            <label className="block">
              <span className="field-label">{t('login.nameLabel')}</span>
              <input
                className="input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
                placeholder={t('login.namePlaceholder')}
              />
            </label>
          )}

          <label className="block">
            <span className="field-label">{t('login.emailLabel')}</span>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder={t('login.emailPlaceholder')}
            />
          </label>

          <label className="block">
            <span className="field-label">{t('login.passwordLabel')}</span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              // Hint password managers: current-password for sign-in,
              // new-password for sign-up. Must be dynamic because the
              // toggle swaps the semantic.
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              minLength={8}
              placeholder={
                mode === 'signup'
                  ? t('login.passwordPlaceholderNew')
                  : t('login.passwordPlaceholderExisting')
              }
            />
          </label>

          {/* Error — hairline scarlet-tinted chip. */}
          {error && (
            <div
              role="alert"
              className="rounded-lg px-3 py-2 text-[12.5px] leading-snug"
              style={{
                background: 'rgba(255, 99, 99, 0.08)',
                border: '1px solid rgba(255, 99, 99, 0.35)',
                color: 'var(--sun-200)',
              }}
            >
              {error}
            </div>
          )}

          {/* Approval-pending notice — shown after a successful sign-up when
              the server requires admin approval before the account is usable.
              Neutral amber tint rather than scarlet because this isn't an
              error — the registration succeeded; it just needs a review. */}
          {pendingApproval && (
            <div
              role="status"
              className="rounded-lg px-3 py-2 text-[12.5px] leading-snug"
              style={{
                background: 'rgba(245, 158, 11, 0.08)',
                border: '1px solid rgba(245, 158, 11, 0.35)',
                color: 'var(--sun-300)',
              }}
            >
              {t('login.pendingApproval')}
            </div>
          )}

          {/* Primary CTA — wide, scarlet. The kbd hint on the right reinforces
              the "type and hit Enter" interaction the tech-label in the
              bottom-right already references. */}
          <button
            type="submit"
            className="btn btn-primary w-full justify-center"
            style={{ padding: '10px 14px', fontSize: 13 }}
            disabled={busy}
          >
            {busy ? (
              <>
                <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                  <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                </svg>
                <span>
                  {mode === 'signin' ? t('login.signingIn') : t('login.creatingAccount')}
                </span>
              </>
            ) : (
              <>
                <span>
                  {mode === 'signin' ? t('login.signIn') : t('login.signUp')}
                </span>
                <span className="kbd ml-1" style={{ minWidth: 18, height: 16, fontSize: 9.5, color: 'var(--ink-50)', borderColor: 'rgba(255,255,255,0.3)', background: 'rgba(0,0,0,0.25)' }}>
                  ↵
                </span>
              </>
            )}
          </button>

          {/* Mode toggle — understated, centered, link-ish. Kept text-only
              on purpose: the primary CTA shouldn't have visual competition. */}
          <div className="pt-1 text-center text-[12.5px]">
            <span className="text-ink-400">
              {mode === 'signin' ? t('login.noAccount') : t('login.alreadyRegistered')}
            </span>{' '}
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'signin' ? 'signup' : 'signin');
                setError(null);
              }}
              className="font-medium transition-colors"
              style={{ color: 'var(--sun-300)' }}
            >
              {mode === 'signin' ? t('login.createOne') : t('login.signInLink')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
