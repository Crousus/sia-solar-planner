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
// Task 12/13 adds the syncClient subscription here (outbound diff + POST
// of patches, inbound SSE for collaborator changes). This task stops
// short of that — opening a project works but nothing is synced back
// to the server yet. Edits made here will be lost on refresh until
// Task 12 wires the patch stream.
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
  const [error, setError] = useState<string | null>(null);
  // `loaded` gates rendering of <App/>. We can't render it until the
  // store has a real project doc — otherwise the canvas would render
  // briefly with whatever stale state was in the store from a previous
  // session (or the default initialProject, which would look like a
  // half-loaded blank project to the user).
  const [loaded, setLoaded] = useState(false);
  // Holds the active syncClient instance for the lifetime of this mount.
  // We use a ref (not state) because nothing in React's render path
  // depends on the client — only imperative paths (unmount cleanup,
  // sibling components via getActiveSyncClient) need to read it.
  const syncClientRef = useRef<SyncClient | null>(null);
  // Holds the unsubscribe handle for the sync-status → toast bridge so
  // unmount cleanup can drop it without leaking a closure that still
  // references the dead client.
  const statusUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!projectId) return;
    // `cancelled` prevents a race when the user navigates away mid-fetch:
    // the in-flight Promise still resolves, but we ignore its result so
    // we don't loadProject() into an unmounted/unrelated tree. Without
    // this flag a fast back-button press could overwrite the next page's
    // state with this page's late-arriving doc.
    let cancelled = false;
    pb.collection('projects')
      .getOne<ProjectRecord>(projectId, {
        // Expand panel_model so we can override doc.panelType with the
        // catalog record's live values (see block below). Customer is
        // expanded too so downstream consumers (e.g. settings page)
        // don't need a separate fetch.
        expand: 'panel_model,customer',
      })
      .then(async (record) => {
        if (cancelled) return;
        // ── Live reference: catalog → doc.panelType ──────────────────
        // If this project is linked to a panel_models catalog entry,
        // replace whatever doc.panelType had with a fresh PanelType
        // derived from the catalog record. This is the core of the
        // "live reference" semantic: any edit to the catalog entry
        // takes effect on all linked projects on next load.
        //
        // Legacy projects (panel_model is empty string) skip this step
        // and continue using whatever panelType was embedded in the doc
        // — matches the backwards-compat promise.
        //
        // We mutate record.doc IN PLACE rather than building a new
        // object because loadProject takes the doc by reference and
        // any downstream sync machinery will diff against it. Writing
        // the catalog value before loadProject ensures the diff
        // baseline already has the catalog values, so catalog-sourced
        // panel data isn't treated as an "edit" waiting to be flushed.
        if (record.expand?.panel_model) {
          record.doc.panelType = panelTypeFromCatalogRecord(record.expand.panel_model);
        }

        const store = useProjectStore.getState();
        // We use getState() rather than a hook subscription because
        // loadProject is an action we just want to fire once — no need
        // to re-render this component when other store fields change.
        store.loadProject(record.doc);

        // Wire up the catalog context so Sidebar + model pickers can
        // read/write them. Order: project id → model id → inverter
        // cache. The cache fetch is async; we set the rest synchronously
        // so Sidebar doesn't briefly show "no catalog info" during the
        // round-trip.
        store.setActivePbProjectId(record.id);
        store.setActivePanelModelId(record.panel_model || null);

        // Batch-fetch all inverter model records referenced in the doc.
        // The inverters array is usually small (≤5), but batching
        // through one filter query (via `id ?= "..." || id ?= "..."`)
        // still avoids N individual fetches. Deduped before the query so
        // two inverters sharing a model don't fetch twice.
        const modelIds = Array.from(
          new Set(
            record.doc.inverters
              .map((i) => i.inverterModelId)
              .filter((id): id is string => !!id),
          ),
        );
        if (modelIds.length > 0) {
          try {
            // Use `?=` (array contains) style via OR; PB filter DSL
            // doesn't have an `in` operator so we OR per-id. For the
            // tens-of-inverters scale we care about, the string is
            // short and PB handles it fine.
            const filter = modelIds.map((id) => `id="${id}"`).join(' || ');
            const recs = await pb.collection('inverter_models').getFullList<InverterModelRecord>({ filter });
            if (!cancelled) {
              const cache: Record<string, InverterModelRecord> = {};
              for (const r of recs) cache[r.id] = r;
              store.setInverterModelCache(cache);
            }
          } catch {
            // Cache miss on any id simply means the sidebar shows the
            // inverter's user-editable name with no manufacturer
            // metadata — degraded but functional. Swallow to avoid
            // blocking the editor mount on a catalog fetch.
          }
        }

        // Set before setLoaded so Toolbar can read it on first render.
        activeProjectTeamId = record.team;
        // `created_by` is empty string for legacy projects (pre-migration
        // 1712346900). Normalize to null so callers only need one falsy
        // check — matches the pattern for activeProjectTeamId when no
        // project is open.
        activeProjectCreatorId = record.created_by || null;
        setLoaded(true);
        // Start the sync client AFTER loadProject so its initial
        // `lastSyncedDoc` fetch aligns with the doc we just loaded.
        // `start()` does its own getOne internally, which means the
        // client will briefly fetch the project twice at startup —
        // acceptable for simplicity; we could optimize by passing the
        // record through, but that would couple the client's startup
        // signature to this caller.
        const client = createSyncClient(projectId);
        // Fire-and-forget: start is async (awaits the initial fetch and
        // SSE subscription) but we don't block rendering on it. If the
        // initial fetch fails the client will simply stay in `synced`
        // status with no lastSyncedDoc; the next user edit will schedule
        // a flush that early-exits until the subscribe completes on the
        // next tick (or surfaces an error via the retry path).
        void client.start();
        syncClientRef.current = client;
        activeSyncClient = client;

        // ── Sync error → toast ─────────────────────────────────────────
        // The status badge (SyncStatusIndicator) already shows the
        // current state at a glance, but the user can easily miss it
        // while focused on the canvas. A toast adds a louder beat so
        // they don't keep editing unaware that nothing is being saved.
        //
        // Strategy:
        //   1. Wait `OFFLINE_GRACE_MS` after the first sign of offline
        //      before toasting — short network blips that auto-recover
        //      shouldn't bother the user. The retry mechanic in
        //      syncClient already handles them silently.
        //   2. Once the toast is up, keep it up until status returns to
        //      `synced`, at which point we dismiss it and post a brief
        //      success ("connection restored") toast.
        //   3. Conflicts have their own UI (ConflictModal); don't toast
        //      for those.
        //
        // We hold the in-flight toast id in a closure variable rather
        // than reactive state because the subscription handler isn't a
        // React effect — a ref/state would buy nothing here.
        const OFFLINE_GRACE_MS = 5000;
        let offlineToastId: string | null = null;
        let offlineGraceTimer: ReturnType<typeof setTimeout> | null = null;
        const unsubStatus = client.subscribeStatus((status) => {
          if (status.kind === 'offline') {
            if (offlineToastId || offlineGraceTimer) return; // already pending/shown
            offlineGraceTimer = setTimeout(() => {
              offlineGraceTimer = null;
              offlineToastId = pushToast('error', t('errors.syncOffline'), {
                dedupeKey: `sync-offline:${projectId}`,
              });
            }, OFFLINE_GRACE_MS);
          } else if (status.kind === 'synced') {
            // Cancel a pending grace toast that hadn't fired yet.
            if (offlineGraceTimer) {
              clearTimeout(offlineGraceTimer);
              offlineGraceTimer = null;
            }
            // If we had actually shown the offline toast, swap it for
            // a brief "restored" success message so the user knows the
            // editor caught up.
            if (offlineToastId) {
              dismissToast(offlineToastId);
              offlineToastId = null;
              pushToast('success', t('errors.syncRestored'));
            }
          }
        });
        // Stash on the ref's metadata-by-closure so the unmount cleanup
        // can find it. We piggyback on syncClientRef.current's own stop
        // path by capturing the unsub in the outer-scope variable below.
        statusUnsubRef.current = unsubStatus;
      })
      .catch((err) => {
        if (cancelled) return;
        // 404 (project deleted/renamed) and 403 (not a member) both mean
        // the user can't see this project — bounce to the home page rather
        // than surface a scary error. `replace: true` so the back button
        // doesn't loop them straight back into the failing /p/:id URL.
        if (err?.status === 404 || err?.status === 403) {
          navigate('/', { replace: true });
          return;
        }
        // eslint-disable-next-line no-console
        console.error('[ProjectEditor] project fetch failed', err);
        setError(formatErrorForUser(err, t));
      });
    return () => {
      cancelled = true;
      // Drop the status → toast bridge before stop() so any final state
      // emission during stop doesn't fire a stray toast for a project
      // we're navigating away from.
      statusUnsubRef.current?.();
      statusUnsubRef.current = null;
      // Stop the sync client BEFORE resetting the store — stop() clears
      // its debounce timer and store subscription, so the resetProject()
      // below won't trigger a spurious outbound flush for a doc the
      // user is about to navigate away from.
      syncClientRef.current?.stop();
      syncClientRef.current = null;
      activeSyncClient = null;
      activeProjectTeamId = null;
      activeProjectCreatorId = null;
      // Clear the store on unmount so the next project load starts clean.
      // See header comment for why this matters across project navigation.
      const store = useProjectStore.getState();
      store.resetProject();
      // Clear catalog context — resetProject only wipes the `project`
      // slice; the catalog fields are UI-state outside that slice and
      // would otherwise leak into the next project mount (e.g. the
      // previous project's panel_model id ghosting through the sidebar
      // for a frame).
      store.setActivePbProjectId(null);
      store.setActivePanelModelId(null);
      store.setInverterModelCache({});
    };
  }, [projectId, navigate, t]);

  if (error) {
    return (
      <div className="min-h-screen bg-zinc-900 text-zinc-100 p-6">
        <p className="text-red-400">Failed to open project: {error}</p>
        <Link className="underline mt-3 inline-block" to="/">← Back</Link>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="min-h-screen bg-zinc-900 text-zinc-100 p-6">
        Loading…
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
