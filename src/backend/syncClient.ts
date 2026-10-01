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
// syncClient — bidirectional sync between the Zustand store and PocketBase.
//
// One instance per open project (started on ProjectEditor mount, stopped
// on unmount). The instance subscribes to the store for outbound changes
// and to PocketBase realtime for inbound ones. It is the single
// chokepoint between local state and server state. Design: ADR-016.
//
// Three docs matter at any moment:
//
//   base      the SERVER-CONFIRMED doc at `baseRevision`. It only ever
//             changes to something the server has committed: a fetched
//             record, an inbound patch applied on top of it, the doc we
//             sent once the server ACKs it with 200, or the `currentDoc`
//             of a 409. It is JSON-normalised (toJsonDoc) so it is exactly
//             what the server holds — index-addressed diffs computed
//             against it therefore apply cleanly on the server.
//
//   local     the store's `project`: base + unsent local edits (+ any
//             in-flight POST's edits).
//
//   inflight  the doc we POSTed but haven't had ACKed yet. At most one at
//             a time — the server enforces OCC on `fromRevision`, so a
//             second parallel POST would always 409.
//
// Whenever `base` moves underneath unsent local work (collaborator patch,
// 409, resync, reconnect, gesture drain) we never simply copy the store
// into the baseline (that was the old data-loss bug: unsent edits were
// absorbed into the baseline and never POSTed). Instead `advanceBase`
// three-way-merges the local doc onto the new server doc BY ENTITY ID
// (rebaseProject in diff.ts) and writes the result to the store via the
// bypass action `applyRemotePatch`. Non-overlapping edits from both sides
// survive; same-field conflicts open the conflict modal instead of being
// resolved silently in either direction.
//
// Inbound patches are keyed by `from_revision` in `pendingInbound` and
// applied strictly in revision order. A gap is NOT immediately a resync:
// while our own POST is in flight, a collaborator's patch can legally
// arrive with from_revision = ourRevision+1 before our 200 does (our own
// echo is filtered by deviceId, so we only learn our revision from the
// response). We wait for the POST to settle and only resync if the gap
// persists.
// ────────────────────────────────────────────────────────────────────────

import { pb, currentUser } from './pb';
import type { PatchRecord, ProjectRecord } from './types';
// The store write goes through `applyRemotePatch` (bypass in
// ACTION_POLICY) so React subscribers re-render and remote/rebased
// changes stay out of the undo stack. We use `applyProjectPatch` directly
// only on our private `base` copy.
import {
  applyProjectPatch,
  diffProjects,
  rebaseProject,
  toJsonDoc,
  type Op,
} from './diff';
import { useProjectStore } from '../store/projectStore';
import type { Project } from '../types';
import { repairReferences } from '../utils/repairReferences';

/**
 * rebaseProject + referential repair. The id-wise merge is schema-blind,
 * so concurrent edits can leave refs dangling (panel on a roof the
 * collaborator deleted, edge to a removed diagram node, two panels both
 * numbered #7 in one string). EVERY merge result goes through here before
 * it reaches the store or finalDoc: the repair then shows up as an
 * ordinary local edit (store ≠ base) and is POSTed by the next flush, so
 * the server converges on the repaired doc too. repairReferences returns
 * its input unchanged when nothing is broken, so the common path costs
 * one sweep and no extra diff work.
 */
function mergeAndRepair(base: Project, theirs: Project, mine: Project) {
  const { doc, conflicts } = rebaseProject(base, theirs, mine);
  return { doc: repairReferences(doc), conflicts };
}

// 1 second chosen to balance "feels instant to collaborators" against
// "batches enough keystrokes into one patch to be efficient". Rapid
// scrub gestures (vertex drags, slider scrubs) are additionally held
// via beginGesture/endGesture so the debounce timer never fires mid-
// gesture — see gesture section below.
const DEBOUNCE_MS = 1000;

// Browsers cap the combined body size of in-flight `keepalive` requests
// at 64 KiB per origin. We stay a little below so a small concurrent
// keepalive (analytics, another tab's flush) doesn't push us over and
// get the request rejected outright. Larger patches (e.g. the map-lock
// patch carrying a base64 capture) go out as normal fetches; the
// beforeunload prompt covers the window where those could be lost.
const KEEPALIVE_MAX_BYTES = 60_000;

// Initial project load: a few quick retries for transient failures
// (network blip, 5xx during a deploy) before the editor shows its error
// page. 4xx fails immediately — retrying a 404/403 can't succeed.
const MAX_LOAD_ATTEMPTS = 3;

// After stop() we keep trying to land the last edits a couple of times
// (each 409 is rebased onto the server's doc and re-sent). Bounded so a
// hot document can't keep a dead client looping forever.
const MAX_FINAL_FLUSH_ATTEMPTS = 3;

// ── Device id ────────────────────────────────────────────────────────
//
// Identifies THIS page instance for the SSE self-filter: the server
// stores it on each patches row and we drop rows carrying our own id
// (our echo) while applying everyone else's — including other tabs of
// the same user.
//
// Per page load (module-level), NOT sessionStorage. Chrome's "Duplicate
// tab" (and some session-restore paths) copy sessionStorage, which made
// two live tabs share an id and silently drop each other's patches as
// "echoes".
//
// sessionStorage was originally chosen so a reload kept the same id and
// "a mid-edit reload wouldn't double-apply its own in-flight patch".
// That concern no longer applies: the reloaded page loads its doc from
// the server (the store no longer rehydrates the project from storage)
// and subscribes BEFORE fetching. If the old page's last POST committed
// before the fetch, it's in the fetched doc and its echo (from_revision
// < fetched revision) is discarded as stale. If it committed after, the
// fetched doc lacks it and applying the echo is exactly right — the new
// page never had those edits locally, so nothing is applied twice.
let deviceId: string | null = null;
export function getDeviceId(): string {
  if (!deviceId) {
    deviceId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  return deviceId;
}

/**
 * Coarse sync state, observable via subscribeStatus. A discriminated
 * union so consumers can switch on `kind` and get the payload typed.
 *
 *   error/load-failed — the initial project load failed after retries.
 *   error/rejected    — the server rejected our patch (400) even after a
 *                       resync rebuilt the baseline; local edits are
 *                       kept, and the next edit retries.
 */
export type SyncStatus =
  | { kind: 'synced' }
  | { kind: 'syncing' }
  | { kind: 'offline'; retriesScheduled: number }
  | { kind: 'conflict'; currentDoc: Project; currentRevision: number }
  | { kind: 'error'; reason: 'load-failed' | 'rejected' };

/** Why edits could not be saved after the client was stopped. */
export type UnsavedReason = 'conflict' | 'network' | 'rejected';

export interface SyncClientOptions {
  /**
   * Called when stop() could not land the last local edits (final flush
   * hit an unresolvable conflict, a network error, or a rejection).
   * The client is already torn down at that point, so this is the only
   * channel left to tell the user — ProjectEditor turns it into a toast.
   */
  onUnsavedChanges?: (reason: UnsavedReason) => void;
}

/** Minimal shape start() needs from the loaded record. */
export interface LoadedRecord {
  doc: Project;
  revision: number;
}

export interface StartOptions<R extends LoadedRecord> {
  /**
   * Fetch the project record. Defaults to a plain getOne. ProjectEditor
   * passes its own loader (with `expand`) so the editor and the sync
   * baseline come from ONE fetch — there is no second fetch that could
   * return a different revision.
   */
  load?: () => Promise<R>;
  /**
   * Called synchronously once the record is loaded and the baseline is
   * installed, before any buffered realtime events are applied. This is
   * where the caller hydrates the store (loadProject). The caller must
   * not mutate `record.doc` in place — the baseline is snapshotted
   * before this call either way.
   */
  onLoaded?: (record: R) => void;
}

type Listener = (s: SyncStatus) => void;

export interface SyncClient {
  /**
   * Subscribe to realtime, load the project, install the baseline, then
   * start watching the store. Resolves with the loaded record, or null
   * if stop() was called meanwhile. Rejects if the load fails
   * permanently. Idempotent: a second call resolves to null.
   */
  start<R extends LoadedRecord = ProjectRecord>(opts?: StartOptions<R>): Promise<R | null>;
  stop(): void;
  subscribeStatus(fn: Listener): () => void;
  /** Called by ConflictModal to finalize the user's choice. */
  resolveConflict(choice: 'discard-mine' | 'overwrite-theirs'): Promise<void>;
  /** Gesture hooks — wired from KonvaOverlay. */
  beginGesture(): void;
  endGesture(): void;
}

interface InFlight {
  fromRevision: number;
  sentDoc: Project;
  keepalive: boolean;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function byteLength(s: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length * 3;
}

export function createSyncClient(projectId: string, options: SyncClientOptions = {}): SyncClient {
  // ── Mutable state owned by this client instance ─────────────────────
  // Closure-private: the public surface is the SyncClient interface.
  let base: Project | null = null;
  let baseRevision = 0;
  let inflight: InFlight | null = null;
  // Inbound patches not yet applied, keyed by from_revision. Holds
  // events that arrive before the initial load, during a gesture, or
  // ahead of a revision we haven't confirmed yet.
  const pendingInbound = new Map<number, PatchRecord>();
  // Set while the conflict modal is open. `serverDoc` keeps tracking the
  // server (inbound patches are applied to it) so the eventual choice is
  // made against the latest server state; the store is left alone and
  // outbound flushes are paused — an inbound patch must never silently
  // resolve an open conflict.
  let conflict: { serverDoc: Project; serverRevision: number } | null = null;
  // A full server snapshot (409 body / resync) that arrived mid-gesture;
  // integrated in endGesture so we don't yank data from under the
  // pointer.
  let deferredSnapshot: { doc: Project; revision: number } | null = null;
  // `gestureActive` suppresses outbound flushes (don't upload a half-
  // dragged state) and inbound store writes (don't move the vertex the
  // user is dragging). Inbound patches simply wait in pendingInbound.
  let gestureActive = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Separate timers per kind so a failing flush can't cancel a pending
  // resync retry (or vice versa) — both must eventually run.
  const retryTimers: Record<'flush' | 'resync', ReturnType<typeof setTimeout> | null> = {
    flush: null,
    resync: null,
  };
  // Exponential backoff counter for transient failures (5xx, network).
  let retryCount = 0;
  // Consecutive 400s. The first triggers a baseline-rebuilding resync;
  // a second in a row means the doc itself is unacceptable → error
  // status instead of an endless retry of the same bad diff.
  let rejectedCount = 0;
  let resyncRunning = false;
  let resyncQueued = false;
  let resyncAfterInflight = false;
  let started = false;
  // `stopped` guards every async continuation and every callback: a
  // late SSE event, PB_CONNECT, POST response or load result must never
  // touch the store after stop() — the store may already hold a
  // different project.
  let stopped = false;
  // Snapshot of the store's project taken in stop(), BEFORE the caller
  // resets the store. Post-stop flushes read this instead of the store.
  let finalDoc: Project | null = null;
  let finalAttempts = 0;
  let status: SyncStatus = { kind: 'synced' };
  const listeners = new Set<Listener>();
  // Teardown callbacks registered as subscriptions are established —
  // including ones that resolve after an await, so stop() during start()
  // still finds (or immediately runs) them.
  const cleanups: Array<() => void> = [];

  function addCleanup(fn: () => void) {
    if (stopped) fn();
    else cleanups.push(fn);
  }

  function setStatus(next: SyncStatus) {
    if (stopped) return;
    status = next;
    listeners.forEach((fn) => fn(next));
  }

  /** Pick the status that reflects current state (after a transition). */
  function settleStatus() {
    if (stopped || conflict) return;
    if (inflight) setStatus({ kind: 'syncing' });
    else if (retryTimers.flush || retryTimers.resync) return; // keep 'offline'
    else if (status.kind === 'error' && status.reason === 'rejected' && rejectedCount > 0) return;
    else setStatus({ kind: 'synced' });
  }

  function localDoc(): Project {
    return stopped ? (finalDoc as Project) : useProjectStore.getState().project;
  }

  function hasUnsentChanges(): boolean {
    if (!base) return false;
    return diffProjects(base, toJsonDoc(localDoc())).length > 0;
  }

  // Replace the store's project with `target` through the bypass action.
  // The diff is computed against the store's CURRENT project and applied
  // to that same object, so index-addressed ops are always correct here.
  function writeStore(target: Project) {
    if (stopped) return;
    const cur = useProjectStore.getState().project;
    const ops = diffProjects(cur, target);
    if (ops.length > 0) useProjectStore.getState().applyRemotePatch(ops);
  }

  function enterConflict(serverDoc: Project, serverRevision: number) {
    conflict = { serverDoc, serverRevision };
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    setStatus({ kind: 'conflict', currentDoc: serverDoc, currentRevision: serverRevision });
  }

  /**
   * THE rebase primitive. Moves the server-confirmed baseline to
   * `newBase` and carries the local unsent edits along (three-way merge
   * by entity id). Returns false if a same-field conflict was detected —
   * the conflict modal opens and neither the store nor `base` changes.
   *
   * Preconditions: base != null, not stopped, no gesture, no conflict.
   */
  function advanceBase(newBase: Project, newRevision: number): boolean {
    const local = useProjectStore.getState().project;
    const { doc, conflicts } = mergeAndRepair(base as Project, newBase, local);
    if (conflicts.length > 0) {
      enterConflict(newBase, newRevision);
      return false;
    }
    // Baseline first, then the store: the store write fires our store
    // subscription, and the resulting diff must be computed against the
    // NEW baseline (yielding exactly the local edits).
    base = newBase;
    baseRevision = newRevision;
    writeStore(doc);
    return true;
  }

  // ── Outbound: debounced diff + POST ─────────────────────────────────

  function scheduleFlush() {
    if (stopped) return;
    if (debounceTimer != null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void flush();
    }, DEBOUNCE_MS);
  }

  function scheduleRetry(kind: 'flush' | 'resync', action: () => void) {
    if (stopped) return;
    retryCount += 1;
    // Capped exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s, …
    const delay = Math.min(30_000, 1000 * 2 ** (retryCount - 1));
    const prev = retryTimers[kind];
    if (prev != null) clearTimeout(prev);
    retryTimers[kind] = setTimeout(() => {
      retryTimers[kind] = null;
      if (!stopped) action();
    }, delay);
    setStatus({ kind: 'offline', retriesScheduled: retryCount });
  }

  async function flush(): Promise<void> {
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    // Delayed, not cancelled:
    //   inflight      → its completion re-checks for pending edits.
    //   !base         → start() hasn't installed the baseline yet.
    //   gestureActive → endGesture schedules a flush.
    //   conflict      → resolveConflict flushes.
    // After stop() gestures/conflicts no longer matter (stop handles the
    // conflict case itself) — we just try to land finalDoc.
    if (inflight || !base) return;
    if (stopped ? finalDoc === null : gestureActive || conflict) return;

    const local = toJsonDoc(localDoc());
    const ops = diffProjects(base, local);
    if (ops.length === 0) {
      settleStatus();
      return;
    }

    const body = JSON.stringify({
      projectId,
      fromRevision: baseRevision,
      ops,
      // Page-scoped identifier — see getDeviceId().
      deviceId: getDeviceId(),
    });
    // keepalive lets the request outlive the page (tab close, reload,
    // navigation) — only possible under the browser's body-size cap.
    const keepalive = byteLength(body) <= KEEPALIVE_MAX_BYTES;
    const sent: InFlight = { fromRevision: baseRevision, sentDoc: local, keepalive };
    inflight = sent;
    setStatus({ kind: 'syncing' });

    let code: number;
    let payload: unknown = null;
    try {
      // NB: everything up to this fetch() call runs synchronously inside
      // the caller's tick, so pagehide/beforeunload handlers that call
      // flush() really do get the request on the wire before unload.
      const res = await fetch('/api/sp/patch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Our custom /api/sp/* routes live outside the SDK, so we
          // forward the SDK-managed bearer token by hand.
          Authorization: `Bearer ${pb.authStore.token}`,
        },
        body,
        keepalive,
      });
      code = res.status;
      // Parse BEFORE clearing `inflight`, otherwise a debounced flush
      // could start a second POST against the stale baseline while we
      // await the body.
      if (typeof res.json === 'function') {
        payload = await res.json().catch(() => null);
      }
    } catch {
      inflight = null;
      onTransientFailure();
      return;
    }
    inflight = null;

    if (code === 200) {
      const newRevision = (payload as { newRevision?: number } | null)?.newRevision;
      retryCount = 0;
      rejectedCount = 0;
      if (typeof newRevision !== 'number' || sent.fromRevision !== baseRevision) {
        // Defensive: the baseline moved while our POST was in flight
        // (shouldn't happen — any server-side change at our fromRevision
        // would have made this POST 409). Re-derive from the server.
        requestResync();
      } else {
        // The server applied exactly our ops to exactly `base`, so the
        // doc we sent IS the server's doc now. (NOT the store's current
        // project — edits made during the POST are still unsent.)
        base = sent.sentDoc;
        baseRevision = newRevision;
      }
      afterPost();
    } else if (code === 409) {
      const body409 = payload as { currentRevision?: number; currentDoc?: Project } | null;
      if (!body409?.currentDoc || typeof body409.currentRevision !== 'number') {
        if (stopped) options.onUnsavedChanges?.('conflict');
        else requestResync();
        return;
      }
      const serverDoc = toJsonDoc(body409.currentDoc);
      if (stopped) {
        // No UI left to ask the user. Try to land the edits by rebasing
        // the final snapshot onto the server doc; only give up (and tell
        // the user via the callback) on a true same-field conflict.
        const { doc, conflicts } = mergeAndRepair(base, serverDoc, toJsonDoc(finalDoc as Project));
        if (conflicts.length > 0 || finalAttempts >= MAX_FINAL_FLUSH_ATTEMPTS) {
          options.onUnsavedChanges?.('conflict');
          return;
        }
        finalAttempts += 1;
        base = serverDoc;
        baseRevision = body409.currentRevision;
        finalDoc = doc;
        void flush();
        return;
      }
      // Someone else committed first. Rebase our local work onto their
      // doc (opens the modal only on a same-field conflict) and retry.
      integrateSnapshot(serverDoc, body409.currentRevision);
      afterPost();
    } else if (code === 401 || code === 403 || code === 404) {
      // Permanent: token expired, kicked from the team, project deleted.
      if (stopped) options.onUnsavedChanges?.('rejected');
      else setStatus({ kind: 'offline', retriesScheduled: 0 });
    } else if (code >= 400 && code < 500) {
      // 400: the patch didn't apply on the server. With a correct
      // baseline that can't happen, so assume the baseline diverged:
      // resync (preserving local edits) and let the next flush send a
      // fresh diff. If THAT is rejected too, stop retrying the same bad
      // patch in a loop and surface an error; local edits stay in the
      // store and the next edit tries again.
      if (stopped) {
        options.onUnsavedChanges?.('rejected');
        return;
      }
      rejectedCount += 1;
      if (rejectedCount === 1) {
        requestResync({ thenFlush: true });
      } else {
        setStatus({ kind: 'error', reason: 'rejected' });
      }
    } else {
      onTransientFailure();
    }
  }

  function onTransientFailure() {
    if (stopped) {
      options.onUnsavedChanges?.('network');
      return;
    }
    scheduleRetry('flush', () => void flush());
  }

  /** Bookkeeping after any POST settles (200 or a handled 409). */
  function afterPost() {
    if (stopped) {
      // Keep draining finalDoc (edits made while the last POST was in
      // flight, or the rebased doc after a 409).
      if (finalAttempts < MAX_FINAL_FLUSH_ATTEMPTS && hasUnsentChanges()) {
        finalAttempts += 1;
        void flush();
      }
      return;
    }
    if (resyncAfterInflight) {
      resyncAfterInflight = false;
      requestResync();
    }
    processInbound();
    settleStatus();
    if (!conflict && hasUnsentChanges()) scheduleFlush();
  }

  // ── Inbound ─────────────────────────────────────────────────────────

  function onPatchEvent(e: { action: string; record: PatchRecord }) {
    if (stopped) return;
    if (e.action !== 'create') return;
    const rec = e.record;
    if (rec.project !== projectId) return;

    // Self-filter. Primary: deviceId identifies THIS page instance, so a
    // matching id is our own echo. Fallback for legacy rows without a
    // device_id: same author = skip (pre-deviceId behaviour).
    if (rec.device_id) {
      if (rec.device_id === getDeviceId()) return;
    } else {
      const me = currentUser();
      if (me && rec.author === (me as { id: string }).id) return;
    }

    pendingInbound.set(rec.from_revision, rec);
    processInbound();
  }

  /**
   * Apply every buffered patch that chains from the current server head,
   * in revision order, then rebase local work onto the result ONCE.
   */
  function processInbound() {
    if (stopped || !base || gestureActive) return;
    let head = conflict ? conflict.serverRevision : baseRevision;
    // Anything older than our head is already reflected (it was in a
    // fetched doc or a 409 body).
    for (const k of [...pendingInbound.keys()]) if (k < head) pendingInbound.delete(k);

    let doc = conflict ? conflict.serverDoc : base;
    let advanced = false;
    while (pendingInbound.has(head)) {
      const rec = pendingInbound.get(head) as PatchRecord;
      pendingInbound.delete(head);
      try {
        doc = applyProjectPatch(doc, rec.ops as Op[]);
      } catch {
        // Patch doesn't apply to what we believe the server holds →
        // our baseline is wrong. Rebuild it from the server.
        requestResync();
        return;
      }
      head = rec.to_revision;
      advanced = true;
    }

    if (advanced) {
      if (conflict) {
        // Keep the modal's server side current; don't touch the store.
        enterConflict(doc, head);
      } else if (advanceBase(doc, head)) {
        settleStatus();
      }
    }

    // A real gap (we missed an event). If our POST is in flight, the gap
    // may simply be our own revision — wait for the response.
    if (pendingInbound.size > 0 && !inflight) requestResync();
  }

  /**
   * Integrate a full server snapshot (resync GET or 409 body), carrying
   * local edits along. Never discards unsent work; never touches UI
   * state or undo history.
   */
  function integrateSnapshot(doc: Project, revision: number) {
    if (stopped || !base) return;
    const head = conflict ? conflict.serverRevision : baseRevision;
    // Equal revision still proceeds: a 400-triggered resync needs to
    // REPLACE a baseline that diverged at the same revision number.
    if (revision < head) return;
    for (const k of [...pendingInbound.keys()]) if (k < revision) pendingInbound.delete(k);
    if (conflict) {
      enterConflict(doc, revision);
      processInbound();
      return;
    }
    if (gestureActive) {
      if (!deferredSnapshot || revision >= deferredSnapshot.revision) {
        deferredSnapshot = { doc, revision };
      }
      return;
    }
    if (advanceBase(doc, revision)) processInbound();
  }

  /**
   * Fetch the server's current doc and integrate it. Replaces the old
   * `fullResync` → `loadProject` path, which discarded unsent edits and
   * reset tool mode / selection / undo history.
   */
  function requestResync(opts: { thenFlush?: boolean } = {}) {
    if (stopped || !base) return;
    if (inflight) {
      resyncAfterInflight = true;
      return;
    }
    if (resyncRunning) {
      resyncQueued = true;
      return;
    }
    resyncRunning = true;
    void (async () => {
      try {
        const record = await pb.collection('projects').getOne<ProjectRecord>(projectId);
        if (stopped) return;
        resyncRunning = false;
        retryCount = 0;
        if (retryTimers.resync != null) {
          clearTimeout(retryTimers.resync);
          retryTimers.resync = null;
        }
        integrateSnapshot(toJsonDoc(record.doc), record.revision);
        settleStatus();
        if (opts.thenFlush) void flush();
        else if (hasUnsentChanges()) scheduleFlush();
      } catch {
        resyncRunning = false;
        if (!stopped) scheduleRetry('resync', () => requestResync(opts));
      } finally {
        resyncRunning = false;
        if (resyncQueued && !stopped) {
          resyncQueued = false;
          requestResync();
        }
      }
    })();
  }

  // ── Conflict resolution (ConflictModal) ────────────────────────────

  async function resolveConflict(choice: 'discard-mine' | 'overwrite-theirs') {
    // Guard against double-dispatch or a stale modal.
    if (stopped || !conflict || !base) return;
    const { serverDoc, serverRevision } = conflict;
    conflict = null;

    if (choice === 'discard-mine') {
      // Take the server's version wholesale. Through applyRemotePatch
      // (not loadProject) so tool mode / selection / view survive.
      base = serverDoc;
      baseRevision = serverRevision;
      writeStore(serverDoc);
      setStatus({ kind: 'synced' });
      processInbound();
      return;
    }

    // Keep mine: three-way merge where conflicting fields resolve to the
    // local value but the collaborator's NON-conflicting changes are
    // kept (the old implementation re-diffed the whole local doc against
    // theirs and reverted everything they did).
    const { doc } = mergeAndRepair(base, serverDoc, useProjectStore.getState().project);
    base = serverDoc;
    baseRevision = serverRevision;
    writeStore(doc);
    setStatus({ kind: 'syncing' });
    processInbound();
    await flush();
  }

  // ── Gesture hooks ──────────────────────────────────────────────────
  //
  // A "gesture" is a continuous interaction (vertex drag, slider scrub,
  // panel paint-drag) bracketed by begin/end from KonvaOverlay. During
  // it we neither upload half-finished state nor apply collaborator
  // changes to the store. On end, buffered inbound patches go through
  // the same rebase path as any other inbound patch: revision advances
  // per patch (no guaranteed 409 afterwards), entity arrays merge by id
  // (no duplicated `add /panels/N`, no `remove` hitting the wrong panel).

  function beginGesture() {
    if (stopped) return;
    gestureActive = true;
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function endGesture() {
    if (stopped) return;
    gestureActive = false;
    if (deferredSnapshot) {
      const snap = deferredSnapshot;
      deferredSnapshot = null;
      integrateSnapshot(snap.doc, snap.revision);
    }
    processInbound();
    scheduleFlush();
  }

  // ── Page lifecycle ─────────────────────────────────────────────────

  function installWindowListeners() {
    if (typeof window === 'undefined') return;

    // Gesture safety valve: Konva's onMouseUp is canvas-scoped, so a
    // release outside the window (or a tab switch mid-drag) would leave
    // gestureActive stuck and stall sync. Window mouseup / visibility
    // change are reliable "gesture is over" signals.
    const onMouseUp = () => {
      if (gestureActive) endGesture();
    };

    // Tab hidden (switch, minimise, mobile app switch, and the step
    // before most closes): flush NOW instead of waiting out the
    // debounce. Hidden pages may be discarded without further events.
    const onVisibility = () => {
      if (gestureActive) endGesture();
      if (document.visibilityState === 'hidden') void flush();
    };

    // pagehide fires on close/navigation even where visibilitychange
    // doesn't (older Safari). React unmount cleanup does NOT run on
    // unload, so this is the only flush the closing page gets.
    const onPageHide = () => {
      if (gestureActive) endGesture();
      void flush();
    };

    // beforeunload: try to flush, and if edits still can't be guaranteed
    // to reach the server (non-keepalive large POST, edits queued behind
    // an in-flight POST, open conflict, retrying offline) ask the
    // browser to confirm leaving.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (stopped || !base) return;
      if (gestureActive) endGesture();
      void flush();
      const local = toJsonDoc(useProjectStore.getState().project);
      let unsafe: boolean;
      if (inflight) {
        unsafe = !inflight.keepalive || diffProjects(inflight.sentDoc, local).length > 0;
      } else {
        unsafe = diffProjects(base, local).length > 0;
      }
      if (unsafe) {
        e.preventDefault();
        // Legacy browsers need returnValue set to show the prompt.
        e.returnValue = '';
      }
    };

    window.addEventListener('mouseup', onMouseUp);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    addCleanup(() => {
      window.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    });
  }

  // ── Public API ─────────────────────────────────────────────────────

  return {
    async start<R extends LoadedRecord = ProjectRecord>(opts: StartOptions<R> = {}): Promise<R | null> {
      if (started || stopped) return null;
      started = true;

      // 1. Reconnect detection. PocketBase does NOT replay events missed
      //    while the SSE connection was down; it re-subscribes and emits
      //    PB_CONNECT. Any PB_CONNECT after the baseline is installed is
      //    a reconnect → resync (preserving local edits). The initial
      //    connect happens before the load completes (base still null)
      //    and is ignored. Not awaited: a slow/failed PB_CONNECT
      //    subscription must not block opening the editor.
      pb.realtime
        .subscribe('PB_CONNECT', () => {
          if (stopped || !base) return;
          requestResync();
        })
        .then((unsub) => addCleanup(() => void unsub()))
        .catch(() => { /* reconnect detection unavailable; non-fatal */ });

      // 2. Subscribe to patches BEFORE fetching the doc. Events that land
      //    between subscribe and fetch are buffered in pendingInbound
      //    (base is still null) and reconciled by revision afterwards —
      //    nothing committed in that window can be missed.
      try {
        const unsub = await pb.collection('patches').subscribe<PatchRecord>('*', onPatchEvent);
        addCleanup(() => void unsub());
        if (stopped) return null;
      } catch {
        if (stopped) return null;
        // Realtime unavailable: outbound sync still works; inbound
        // changes arrive via 409 rebases and reconnect resyncs.
      }

      // 3. Load, with a few retries for transient failures.
      const load = opts.load ?? (() => pb.collection('projects').getOne<ProjectRecord>(projectId) as unknown as Promise<R>);
      let record: R;
      for (let attempt = 1; ; attempt++) {
        try {
          record = await load();
          break;
        } catch (err) {
          if (stopped) return null;
          const code = (err as { status?: number } | null)?.status ?? 0;
          const transient = code === 0 || code >= 500;
          if (!transient || attempt >= MAX_LOAD_ATTEMPTS) {
            setStatus({ kind: 'error', reason: 'load-failed' });
            throw err;
          }
          setStatus({ kind: 'offline', retriesScheduled: attempt });
          await sleep(1000 * 2 ** (attempt - 1));
          if (stopped) return null;
        }
      }
      if (stopped) return null;

      // 4. Baseline = the RAW server doc, snapshotted before the caller
      //    can touch it. Anything the caller layers on top in onLoaded
      //    (e.g. the live catalog panelType) is a genuine local edit and
      //    will be POSTed, so the server doc converges to it.
      base = toJsonDoc(structuredClone(record.doc));
      baseRevision = record.revision;
      opts.onLoaded?.(record);
      if (stopped) return null;

      // 5. Watch the store, apply anything buffered since step 2, and
      //    push whatever onLoaded layered on top of the server doc.
      const storeUnsub = useProjectStore.subscribe(() => {
        if (!stopped) scheduleFlush();
      });
      addCleanup(storeUnsub);
      installWindowListeners();
      setStatus({ kind: 'synced' });
      processInbound();
      // Only when the caller hydrated the store from THIS record: then
      // any difference is a deliberate overlay (catalog panelType,
      // migrateProject back-fills) that should reach the server. Without
      // onLoaded the store holds whatever it held before, and pushing
      // that unprompted could overwrite the server with stale content.
      if (opts.onLoaded && hasUnsentChanges()) scheduleFlush();
      return record;
    },

    stop() {
      if (stopped) return;
      // Snapshot the local doc BEFORE the caller resets the store, then
      // tear everything down. A final flush runs on the snapshot: React
      // unmount cleanup can't await, but fetch() puts the request on the
      // wire synchronously (with keepalive when small enough).
      finalDoc = base ? useProjectStore.getState().project : null;
      const hadConflict = conflict !== null;
      const hadInflight = inflight !== null;
      stopped = true;
      if (debounceTimer != null) clearTimeout(debounceTimer);
      for (const k of ['flush', 'resync'] as const) {
        const tm = retryTimers[k];
        if (tm != null) clearTimeout(tm);
        retryTimers[k] = null;
      }
      debounceTimer = null;
      for (const fn of cleanups.splice(0)) {
        try { fn(); } catch { /* best-effort teardown */ }
      }
      if (!base || !finalDoc) return;
      if (hadConflict) {
        // The user never chose; we can't decide for them. Report so the
        // UI can warn that the conflicting edits weren't saved.
        if (hasUnsentChanges()) options.onUnsavedChanges?.('conflict');
        return;
      }
      // If a POST is in flight, its completion (afterPost) continues
      // with finalDoc; otherwise start the final flush now.
      if (!hadInflight) void flush();
    },

    subscribeStatus(fn) {
      listeners.add(fn);
      // Fire immediately so subscribers render the right state on mount.
      fn(status);
      return () => {
        listeners.delete(fn);
      };
    },

    resolveConflict,
    beginGesture,
    endGesture,
  };
}
