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
import { Link, useNavigate, useParams } from 'react-router-dom';
import { pb } from '../backend/pb';
import type { InverterModelRecord, ProjectRecord } from '../backend/types';
import { panelTypeFromCatalogRecord, useProjectStore } from '../store/projectStore';
import { createSyncClient, type SyncClient } from '../backend/syncClient';
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

export default function ProjectEditor() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
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
        setError(err?.message ?? 'Failed to load project');
      });
    return () => {
      cancelled = true;
      // Stop the sync client BEFORE resetting the store — stop() clears
      // its debounce timer and store subscription, so the resetProject()
      // below won't trigger a spurious outbound flush for a doc the
      // user is about to navigate away from.
      syncClientRef.current?.stop();
      syncClientRef.current = null;
      activeSyncClient = null;
      activeProjectTeamId = null;
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
  }, [projectId, navigate]);

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
