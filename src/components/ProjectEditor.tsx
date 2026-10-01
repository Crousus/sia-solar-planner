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
// ProjectEditor — mounted at /p/:projectId.
//
// Lifecycle:
//   1. On mount, fetch the project record from the server.
//   2. Call store.loadProject(record.doc) to hand it to the existing
//      Zustand store. The editor (<App/>) doesn't know or care that
//      the project came from the server — it just reads the store like
//      it always has. Keeping the editor server-agnostic is what makes
//      it possible to develop the canvas in isolation.
//   3. On unmount, call store.resetProject() so the next /p/:id load
//      starts from a clean slate. Without this, navigating from project
//      A to project B would briefly flash A's roofs/panels because the
//      next mount's fetch is async.
//
// The same mount persists across the roof ↔ diagram view toggle (one
// layout route in AppShell; App.tsx picks the view from the URL), so the
// sync client, undo history and tool state survive view switches.
//
// Sync: a per-mount SyncClient (backend/syncClient.ts, ADR-016) owns the
// initial fetch so the editor's doc and the sync baseline come from the
// same server response.
//
// Error handling:
//   404 (project deleted) and 403 (caller is not a team member) are
//   treated as "you can't see this project" — we redirect to the home
//   page rather than show a scary error. Any other error surfaces with
//   a Back link.
// ────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { InverterModelRecord, ProjectRecord } from '../backend/types';
import { panelTypeFromCatalogRecord, useProjectStore } from '../store/projectStore';
import { createSyncClient, type SyncClient } from '../backend/syncClient';
import { markServerEra } from '../backend/migrateLocalStorage';
import { dismissToast, pushToast } from '../store/toastStore';
import { formatErrorForUser } from '../utils/errorClassify';
import App from '../App';
import ConflictModal from './ConflictModal';

// Module-level bridge so sibling components (KonvaOverlay's gesture
// hooks in Task 13, SyncStatusIndicator in Task 14) can access the
// active client without React context or prop drilling. The variable
// is null outside of a mounted ProjectEditor — callers must null-check.
//
// Why module-level rather than context:
//   - Only one ProjectEditor can be mounted at a time (single-editor
//     route), so there's no multi-instance ambiguity.
//   - Callers are imperative (a Konva pointerdown handler isn't a React
//     hook consumer) and would awkwardly wrap in useContext or prop-drill.
//   - Tests don't need to reset this because each test either doesn't
//     mount ProjectEditor (unit tests of syncClient directly) or does
//     (and the cleanup below resets the ref on unmount).
let activeSyncClient: SyncClient | null = null;
export function getActiveSyncClient(): SyncClient | null {
  return activeSyncClient;
}

// The team that owns the currently-open project. Set synchronously
// before setLoaded(true) so the Toolbar can read it as soon as <App/>
// mounts. Null when no project is open (outside ProjectEditor).
let activeProjectTeamId: string | null = null;
export function getActiveProjectTeamId(): string | null {
  return activeProjectTeamId;
}

// The user id that created the currently-open project. Empty string
// for legacy projects created before the `created_by` field existed
// (migration 1712346900). Read by exportPdf to populate the "Planner"
// identity on the printed PDF — falls back to a blank planner block
// when unset.
let activeProjectCreatorId: string | null = null;
export function getActiveProjectCreatorId(): string | null {
  return activeProjectCreatorId;
}

export default function ProjectEditor() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  // `navigate` and `t` are read through refs inside the load effect so
  // the effect depends on `projectId` ONLY. With them in the dep list, a
  // language switch (new `t`) or a router-context change (new
  // `navigate`) tore the whole editor down: stop(), resetProject(),
  // refetch, undo history gone.
  const navigateRef = useRef(navigate);
  const tRef = useRef(t);
  navigateRef.current = navigate;
  tRef.current = t;
  const [error, setError] = useState<string | null>(null);
  // `loaded` gates rendering of <App/>. We can't render it until the
  // store has a real project doc — otherwise the canvas would render
  // briefly with whatever stale state was in the store from a previous
  // session (or the default initialProject, which would look like a
  // half-loaded blank project to the user).
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    // `cancelled` covers the whole async chain: every continuation after
    // an await re-checks it so a fast navigation (or React StrictMode's
    // mount→unmount→mount) never loads project A into the store while
    // project B is open, and never leaves a sync client running.
    let cancelled = false;
    setError(null);
    setLoaded(false);

    // Create the client FIRST and register it with the cleanup below,
    // so whatever happens later (fetch failure, cancellation mid-await)
    // the cleanup always stops exactly the client this effect created.
    // Previously the client was created after an await and a cancelled
    // effect still started one — a leaked client that diffed project B's
    // store content against project A's baseline and POSTed it to A.
    const client = createSyncClient(projectId, {
      // Final-flush failures after unmount: the editor is gone, so a
      // toast is the only way left to tell the user.
      onUnsavedChanges: (reason) => {
        const key =
          reason === 'conflict' ? 'sync.unsavedConflict'
          : reason === 'network' ? 'sync.unsavedNetwork'
          : 'sync.unsavedRejected';
        pushToast('error', tRef.current(key), { dedupeKey: `sync-unsaved:${projectId}` });
      },
    });
    activeSyncClient = client;

    // ── Sync status → toast ──────────────────────────────────────────
    // The status badge (SyncStatusIndicator) shows the state at a
    // glance, but it's easy to miss while focused on the canvas.
    //   1. Offline: wait OFFLINE_GRACE_MS before toasting so short blips
    //      that the retry loop absorbs don't bother the user; dismiss
    //      and post "restored" once we're synced again.
    //   2. Rejected (server refused our patch even after a resync):
    //      toast immediately — edits are not being saved.
    //   3. Conflicts have their own UI (ConflictModal).
    const OFFLINE_GRACE_MS = 5000;
    let offlineToastId: string | null = null;
    let offlineGraceTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubStatus = client.subscribeStatus((status) => {
      if (status.kind === 'offline') {
        if (offlineToastId || offlineGraceTimer) return; // already pending/shown
        offlineGraceTimer = setTimeout(() => {
          offlineGraceTimer = null;
          offlineToastId = pushToast('error', tRef.current('errors.syncOffline'), {
            dedupeKey: `sync-offline:${projectId}`,
          });
        }, OFFLINE_GRACE_MS);
      } else if (status.kind === 'error' && status.reason === 'rejected') {
        pushToast('error', tRef.current('sync.rejectedToast'), {
          dedupeKey: `sync-rejected:${projectId}`,
        });
      } else if (status.kind === 'synced') {
        if (offlineGraceTimer) {
          clearTimeout(offlineGraceTimer);
          offlineGraceTimer = null;
        }
        if (offlineToastId) {
          dismissToast(offlineToastId);
          offlineToastId = null;
          pushToast('success', tRef.current('errors.syncRestored'));
        }
      }
    });

    (async () => {
      // ONE fetch feeds both the store and the sync baseline. start()
      // subscribes to realtime before calling `load`, buffers any patch
      // committed in between, and reconciles by revision once the record
      // is in — the old "GET here, second GET inside start()" sequence
      // could see two different revisions and the next diff would
      // revert a collaborator's (or our own just-flushed) edit.
      const record = await client.start<ProjectRecord>({
        load: () =>
          pb.collection('projects').getOne<ProjectRecord>(projectId, {
            // panel_model: live catalog override below. customer: so
            // downstream consumers don't need a separate fetch.
            expand: 'panel_model,customer',
          }),
        onLoaded: (rec) => {
          if (cancelled) return;
          // ── Live reference: catalog → doc.panelType ──────────────────
          // If this project is linked to a panel_models entry, the
          // editor uses the catalog's current values instead of the
          // copy embedded in the doc, so catalog edits reach every
          // linked project on next open. Legacy projects (empty
          // panel_model) keep their embedded panelType.
          //
          // We build a NEW doc instead of mutating rec.doc: the sync
          // baseline is the raw server doc, and the override is a real
          // local change. If the catalog differs from the stored copy,
          // the first flush POSTs it so the server doc (PDF export,
          // settings page, collaborators) converges on the catalog
          // values. (The previous comment here claimed the override was
          // part of the baseline; it never was — start() fetched its own
          // un-overridden copy — and the claim was misleading.)
          const doc = rec.expand?.panel_model
            ? { ...rec.doc, panelType: panelTypeFromCatalogRecord(rec.expand.panel_model) }
            : rec.doc;
          const store = useProjectStore.getState();
          store.loadProject(doc);
          // Catalog context for Sidebar + model pickers.
          store.setActivePbProjectId(rec.id);
          store.setActivePanelModelId(rec.panel_model || null);
          activeProjectTeamId = rec.team;
          // `created_by` is '' for legacy projects; normalise to null.
          activeProjectCreatorId = rec.created_by || null;
          // This browser now runs the server-backed editor: any legacy
          // `solar-planner-project` blob is not a pre-auth draft.
          markServerEra();
        },
      });
      if (cancelled || !record) return;

      // Batch-fetch the inverter catalog records referenced in the doc
      // (deduped, one OR-filter query — PB's filter DSL has no `in`).
      // Awaited before setLoaded so the sidebar doesn't flash "no
      // manufacturer info"; failures are swallowed (degraded but usable).
      const modelIds = Array.from(
        new Set(
          record.doc.inverters
            .map((i) => i.inverterModelId)
            .filter((id): id is string => !!id),
        ),
      );
      if (modelIds.length > 0) {
        try {
          const filter = modelIds.map((id) => `id="${id}"`).join(' || ');
          const recs = await pb.collection('inverter_models').getFullList<InverterModelRecord>({ filter });
          if (cancelled) return;
          const cache: Record<string, InverterModelRecord> = {};
          for (const r of recs) cache[r.id] = r;
          useProjectStore.getState().setInverterModelCache(cache);
        } catch {
          if (cancelled) return;
        }
      }
      if (cancelled) return;
      setLoaded(true);
    })().catch((err) => {
      if (cancelled) return;
      // 404 (deleted) / 403 (not a member): bounce home. `replace` so
      // Back doesn't loop into the failing URL.
      if (err?.status === 404 || err?.status === 403) {
        navigateRef.current('/', { replace: true });
        return;
      }
      // eslint-disable-next-line no-console
      console.error('[ProjectEditor] project fetch failed', err);
      setError(formatErrorForUser(err, tRef.current));
    });

    return () => {
      cancelled = true;
      // Drop the status → toast bridge before stop() so teardown doesn't
      // fire a stray toast for a project we're leaving.
      unsubStatus();
      if (offlineGraceTimer) clearTimeout(offlineGraceTimer);
      // stop() BEFORE resetProject: it snapshots the store's project for
      // the final flush and drops its store subscription, so the reset
      // below is neither flushed nor lost.
      client.stop();
      if (activeSyncClient === client) activeSyncClient = null;
      activeProjectTeamId = null;
      activeProjectCreatorId = null;
      const store = useProjectStore.getState();
      store.resetProject();
      // Catalog context lives outside the `project` slice; clear it so
      // the previous project's ids don't ghost into the next mount.
      store.setActivePbProjectId(null);
      store.setActivePanelModelId(null);
      store.setInverterModelCache({});
    };
  }, [projectId]);

  if (error) {
    return (
      <div className="min-h-screen bg-zinc-900 text-zinc-100 p-6">
        <p className="text-red-400">{t('editor.openFailed', { message: error })}</p>
        <Link className="underline mt-3 inline-block" to="/">{t('editor.back')}</Link>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="min-h-screen bg-zinc-900 text-zinc-100 p-6">
        {t('team.loading')}
      </div>
    );
  }
  // ConflictModal is a sibling of <App/> (not a child) so it overlays
  // the entire editor, including the Konva canvas, without being subject
  // to any transform/stacking-context quirks inside App's layout. The
  // modal renders null unless status.kind === 'conflict', so there's no
  // cost when synced — it just registers the status subscription.
  return (
    <>
      <App />
      <ConflictModal />
    </>
  );
}
