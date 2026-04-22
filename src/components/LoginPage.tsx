// ────────────────────────────────────────────────────────────────────────
// LoginPage — sign in and sign up share one UI toggle.
//
// Sign up also requires `name` per our users-collection rule; we prompt
// for it only in the sign-up branch.
//
// Why no separate /signup route? The sign-up flow is short enough
// that a mode toggle on the same page is simpler than a second route.
// After signup we immediately sign in (PB's create endpoint returns
// a record but not a token — we call authWithPassword afterwards).
//
// Error handling is intentionally generic: PocketBase returns rich
// per-field validation errors (err.response.data) but surfacing them
// inline would require a bespoke field-error map. For M2/1 we just
// show the top-level message; richer UX can wait until we see real
// failure modes from users.
// ────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { pb } from '../backend/pb';
import { maybeImportLocalStorage } from '../backend/migrateLocalStorage';

type Mode = 'signin' | 'signup';

// Shape of router-supplied state on a redirect from AuthGuard. Typed as
// optional everywhere because direct navigations to /login (typed in the
// address bar, no redirect) carry no state.
interface LocationState {
  from?: { pathname?: string };
}

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // i18n: all user-visible strings in this form route through the
  // `login` namespace in src/locales. Error text stays untranslated
  // because it is passed through verbatim from PocketBase (see the
  // `catch` block in submit()); wiring translations for PB's error
  // messages is a separate task that needs a mapping layer.
  const { t } = useTranslation();

  const navigate = useNavigate();
  const location = useLocation();
  // Default landing target after auth = root. The guard hands us the
  // intended URL via state.from when it bounced the user here.
  const from = (location.state as LocationState | null)?.from?.pathname ?? '/';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
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
      // Task 15: one-shot auto-import of a pre-backend localStorage
      // draft. Fires on BOTH sign-in and sign-up paths because a user
      // might have tried the app offline (writing to localStorage)
      // before creating an account, and then signed up — we still want
      // to bring their draft forward. See migrateLocalStorage.ts for
      // the full gating logic (non-empty local doc + no server
      // projects). If an import happens, redirect into the new project
      // instead of whatever `from` pointed at; otherwise preserve the
      // existing behavior of honoring AuthGuard's intended target.
      //
      // The `.catch(() => null)` is deliberate: a failed import
      // (network hiccup during the project create, a permission
      // regression) must NOT block login. The user still gets to
      // their intended destination; they can retry by refreshing,
      // and the localStorage blob is preserved (see the module's
      // post-success removeItem) so a later attempt can succeed.
      const importedProjectId = await maybeImportLocalStorage().catch(
        () => null,
      );
      const target = importedProjectId ? `/p/${importedProjectId}` : from;
      navigate(target, { replace: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Sign-in failed.';
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-900 text-zinc-100">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 p-6 bg-zinc-800 rounded-lg">
        <h1 className="text-xl font-semibold">
          {mode === 'signin' ? t('login.signIn') : t('login.signUp')}
        </h1>

        {mode === 'signup' && (
          <label className="block">
            <span className="text-sm">{t('login.nameLabel')}</span>
            <input
              className="w-full mt-1 px-3 py-2 bg-zinc-700 rounded"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
            />
          </label>
        )}

        <label className="block">
          <span className="text-sm">{t('login.emailLabel')}</span>
          <input
            className="w-full mt-1 px-3 py-2 bg-zinc-700 rounded"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </label>

        <label className="block">
          <span className="text-sm">{t('login.passwordLabel')}</span>
          <input
            className="w-full mt-1 px-3 py-2 bg-zinc-700 rounded"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            // Hint password managers to offer the right credential:
            // current-password for sign-in, new-password for sign-up.
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            minLength={8}
          />
        </label>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          className="w-full py-2 bg-blue-600 rounded hover:bg-blue-500 disabled:opacity-50"
          disabled={busy}
        >
          {/*
            Busy label is mode-specific so password managers / screen
            readers announce the action in progress, not a bare ellipsis.
          */}
          {busy
            ? mode === 'signin'
              ? t('login.signingIn')
              : t('login.creatingAccount')
            : mode === 'signin'
              ? t('login.signIn')
              : t('login.signUp')}
        </button>

        <button
          type="button"
          className="w-full text-sm text-zinc-400 underline"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin');
            setError(null);
          }}
        >
          {/*
            Two translation keys joined by a space rather than one
            interpolated string: keeps the prompt and the call-to-action
            independently reorderable per locale (e.g. a translator may
            want only the CTA or may move punctuation around).
          */}
          {mode === 'signin'
            ? `${t('login.noAccount')} ${t('login.createOne')}`
            : `${t('login.alreadyRegistered')} ${t('login.signInLink')}`}
        </button>
      </form>
    </div>
  );
}
