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
import { useNavigate } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { TeamRecord } from '../backend/types';
import { useAuthUser } from './AppShell';

export default function NewTeamPage() {
  const user = useAuthUser();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  // `busy` doubles as a submit-button disabled flag and a "show ellipsis"
  // signal. We keep it separate from `error` so a retry after a failed
  // submit can clear the error while the busy spinner kicks in.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Defensive: AuthGuard already blocks unauthenticated callers, but the
    // type of useAuthUser allows null so we narrow here too. Without this
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
      // Surface server validation messages (e.g. "name: required") rather
      // than a generic "failed". `err instanceof Error` narrows the
      // unknown without losing the upstream message.
      setError(err instanceof Error ? err.message : 'Create failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100">
      <div className="max-w-sm mx-auto p-6 space-y-3">
        <h1 className="text-xl font-semibold">New team</h1>
        <form onSubmit={submit} className="space-y-3">
          <input
            className="w-full px-3 py-2 bg-zinc-800 rounded"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Team name"
            required
            minLength={1}
            maxLength={100}
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full py-2 bg-blue-600 rounded disabled:opacity-50"
          >
            {busy ? '…' : 'Create'}
          </button>
        </form>
      </div>
    </div>
  );
}
