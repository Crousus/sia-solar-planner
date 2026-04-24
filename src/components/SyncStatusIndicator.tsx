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
// SyncStatusIndicator — a dot + label in the top bar.
//
// States (from syncClient):
//   - synced   → green   "Synced"
//   - syncing  → blue    "Syncing…"
//   - offline  → amber   "Offline — changes saved locally"
//   - conflict → red     "Conflict" (click opens the modal — ConflictModal
//              subscribes to the same status, so there's no extra wiring.)
//
// Why subscribe here (not via React context): syncClient is created
// imperatively in ProjectEditor's effect and exposed via a module-level
// bridge (getActiveSyncClient). Reading it in an effect lets us survive
// the strict-mode double-invoke and handle the "no active client" case
// (before ProjectEditor mounts, or outside of /p/:id routes entirely —
// though this component should only be mounted under ProjectEditor).
//
// We intentionally default to `{ kind: 'synced' }`. If there's no active
// client yet (brief window between toolbar mount and the editor's effect
// attaching a client), showing "Synced" is the least-misleading fallback;
// the real status will swap in as soon as subscribeStatus fires with the
// client's current value (it emits immediately on subscribe).
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { getActiveSyncClient } from './ProjectEditor';
import type { SyncStatus } from '../backend/syncClient';

export default function SyncStatusIndicator() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SyncStatus>({ kind: 'synced' });

  useEffect(() => {
    // Read the bridge once on mount. If the client isn't ready yet
    // (shouldn't happen under normal ProjectEditor mount order, but
    // defensive), we simply stay on the default 'synced' label until
    // the user navigates away/back. A more elaborate fix would be a
    // module-level pub/sub for the client reference itself, but that's
    // overkill for a status badge.
    const client = getActiveSyncClient();
    if (!client) return;
    // subscribeStatus returns an unsubscribe fn; returning it from the
    // effect plugs directly into React's cleanup contract.
    return client.subscribeStatus(setStatus);
  }, []);

  const { color, label } = describe(status, t);
  return (
    <div
      // aria-live="polite" so screen readers announce transitions
      // (e.g. "Syncing…" → "Synced") without interrupting the user.
      className="flex items-center gap-2 text-xs select-none"
      title={label}
      aria-live="polite"
    >
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{ background: color }}
      />
      <span style={{ color: 'var(--ink-200)' }}>{label}</span>
    </div>
  );
}

/**
 * Map the discriminated status to a (color, label) pair. Centralizing
 * this here (rather than inlining in the JSX) keeps the switch exhaustive
 * — TypeScript will flag a missing arm if SyncStatus gains a new variant.
 * Colors are literal hex values (not Tailwind classes) because we're
 * painting a `background` on an inline style; the palette mirrors the
 * semantic conventions already used across the app (green=ok, amber=warn,
 * red=danger, blue=activity).
 */
function describe(s: SyncStatus, t: TFunction): { color: string; label: string } {
  switch (s.kind) {
    case 'synced':
      return { color: '#22c55e', label: t('sync.synced') };
    case 'syncing':
      return { color: '#3b82f6', label: t('sync.syncing') };
    case 'offline':
      return { color: '#f59e0b', label: t('sync.offline') };
    case 'conflict':
      return { color: '#ef4444', label: t('sync.conflict') };
  }
}
