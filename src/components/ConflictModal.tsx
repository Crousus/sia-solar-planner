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
// ConflictModal — appears when syncClient status is 'conflict'.
//
// A 409 from the server means someone else advanced the project past
// our lastKnownRevision. The user picks:
//   - "Discard mine": loadProject(serverDoc); our local edits are gone.
//   - "Overwrite theirs": re-diff our local doc against theirs and POST;
//     server's ops are clobbered where fields overlap.
//
// Deliberately NOT offering auto-merge: this is a user-supervised step
// (Q9 in the spec). Merge semantics for array fields (roofs, panels) are
// not obvious enough to do silently — a naive last-writer-wins on an
// array would either drop items or duplicate them depending on how we
// order ops. Forcing the user to pick makes the data loss (if any)
// explicit rather than surprise-destructive.
//
// Why a sibling of <App/> rather than nested inside it: the modal needs
// to overlay the entire canvas, including the Konva stage, and live
// outside the toolbar's stacking context. Rendering as a sibling with
// a high z-index is the simplest way to guarantee it paints on top of
// everything else.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getActiveSyncClient } from './ProjectEditor';
import type { SyncStatus } from '../backend/syncClient';

export default function ConflictModal() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SyncStatus>({ kind: 'synced' });
  // `busy` gates the buttons during the async resolveConflict call.
  // Without it a rapid double-click could fire two resolve attempts —
  // the second would see status back at 'synced' and short-circuit, but
  // disabling the buttons while the first is in flight is cleaner UX.
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const client = getActiveSyncClient();
    if (!client) return;
    return client.subscribeStatus(setStatus);
  }, []);

  // Early return when not conflicting — nothing to render. This also
  // means we don't keep a stale `busy=true` across transitions: as soon
  // as status flips back to 'synced' (after resolve completes), the
  // component unmounts its modal DOM entirely, and busy is reset when
  // it re-mounts on the next conflict.
  if (status.kind !== 'conflict') return null;

  async function choose(choice: 'discard-mine' | 'overwrite-theirs') {
    const client = getActiveSyncClient();
    if (!client) return;
    setBusy(true);
    try {
      // resolveConflict is responsible for transitioning status back to
      // 'synced' (or 'syncing') on success, which unmounts this modal.
      // We still clear `busy` in finally for the error case.
      await client.resolveConflict(choice);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      // z-[1000] is comfortably above the Konva stage (default stacking)
      // and any toolbar dropdowns (~z-50). Backdrop uses a heavy blur +
      // dark tint to push the modal forward without hard black — keeps
      // the rest of the UI readable as context.
      className="fixed inset-0 z-[1000] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-modal-title"
      style={{
        background: 'rgba(6, 6, 8, 0.6)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      <div className="surface rounded-[14px] p-6 max-w-md w-[92%] space-y-4">
        <div>
          <span className="tech-label">SYNC · CONFLICT</span>
          <h2
            id="conflict-modal-title"
            className="mt-1 font-editorial text-[28px] leading-[1.05] tracking-tight text-ink-50"
          >
            {t('conflict.title')}
          </h2>
        </div>
        <p className="text-[13.5px] text-ink-300 leading-relaxed">
          {t('conflict.body')}
        </p>
        <div className="flex gap-2 pt-1">
          <button
            className="btn btn-ghost flex-1 justify-center"
            style={{ padding: '9px 12px', fontSize: 12.5 }}
            disabled={busy}
            onClick={() => choose('discard-mine')}
          >
            {t('conflict.discardMine')}
          </button>
          <button
            className="btn btn-primary flex-1 justify-center"
            style={{ padding: '9px 12px', fontSize: 12.5 }}
            disabled={busy}
            onClick={() => choose('overwrite-theirs')}
          >
            {busy ? t('conflict.working') : t('conflict.overwriteTheirs')}
          </button>
        </div>
      </div>
    </div>
  );
}
