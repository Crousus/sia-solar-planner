// ────────────────────────────────────────────────────────────────────────
// syncClient — bidirectional sync between the Zustand store and PocketBase.
//
// One instance per open project (started on ProjectEditor mount, stopped
// on unmount). The instance subscribes to the store for outbound changes
// and subscribes to PocketBase realtime for inbound ones. It is the
// single chokepoint between local state and server state.
//
// Key invariants:
//   - lastSyncedDoc ALWAYS reflects the server's current view, modulo
//     the in-flight POST (which we still haven't been ack'd on).
//   - lastKnownRevision ALWAYS reflects the highest revision we know
//     the server to be at.
//   - We never apply our own patches twice (author self-filter).
//     Limitation: two tabs signed in as the SAME user will mutually
//     filter each other's patches, so live sync between same-user tabs
//     doesn't work in M3. The common fix is filtering by a per-tab
//     deviceId rather than userId; deferred until we need it.
//   - Any unexpected state triggers a full resync — doc at revision
//     is always source of truth.
//
// Why a plain factory (createSyncClient) rather than a React context or
// singleton module:
//   - A project's lifetime is bounded by ProjectEditor's mount — creating
//     the client per-mount (and stopping it on unmount) mirrors that
//     lifecycle exactly, with zero risk of state from project A leaking
//     into project B.
//   - Tests can instantiate the client freely with stubbed fetch and
//     pocketbase without mocking a module-level singleton.
//   - Sibling components (KonvaOverlay, SyncStatusIndicator) access the
//     live instance through the `getActiveSyncClient()` bridge in
//     ProjectEditor — React context would work too but is heavier for
//     what is effectively a single mutable ref.
// ────────────────────────────────────────────────────────────────────────

import { pb, currentUser } from './pb';
import type { PatchRecord, ProjectRecord } from './types';
// We import `diffProjects` directly — `applyProjectPatch` is NOT used
// here because the store's `applyRemotePatch` action already wraps it,
// and routing through the store is required so React subscribers re-
// render.
import { diffProjects, type Op } from './diff';
import { useProjectStore } from '../store/projectStore';
import type { Project } from '../types';

// 2 seconds chosen to balance "feels instant to collaborators" against
// "batches enough keystrokes into one patch to be efficient". Rapid
// scrub gestures (vertex drags, slider scrubs) are additionally held
// via beginGesture/endGesture so the debounce timer never fires mid-
// gesture — see gesture section below.
const DEBOUNCE_MS = 2000;

/**
 * Coarse sync state. Exposed via a subscribe-able observable so the
 * status indicator (Task 14) can show Synced / Syncing / Offline /
 * Conflict. A discriminated union rather than separate booleans so
 * consumers can switch on `kind` and get type-narrowed access to the
 * extra payload (retries count, server doc, etc.) without having to
 * correlate multiple fields themselves.
 */
export type SyncStatus =
  | { kind: 'synced' }
  | { kind: 'syncing' }
  | { kind: 'offline'; retriesScheduled: number }
  | { kind: 'conflict'; currentDoc: Project; currentRevision: number };

type Listener = (s: SyncStatus) => void;

export interface SyncClient {
  start(): Promise<void>;
  stop(): void;
  subscribeStatus(fn: Listener): () => void;
  /** Called by ConflictModal (Task 14) to finalize the user's choice. */
  resolveConflict(choice: 'discard-mine' | 'overwrite-theirs'): Promise<void>;
  /** Gesture hooks — wired from KonvaOverlay in Task 13. */
  beginGesture(): void;
  endGesture(): void;
}

export function createSyncClient(projectId: string): SyncClient {
  // ── Mutable state owned by this client instance ─────────────────────
  // All of these live in closure rather than on an object field because
  // nothing outside this factory ever needs to read them — the public
  // surface is the SyncClient interface, and exposing internals would
  // invite tight coupling.
  let lastSyncedDoc: Project | null = null;
  let lastKnownRevision = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // `postInFlight` guards against two overlapping POSTs. If the debounce
  // timer fires again while a POST is in-flight (because the user kept
  // editing after the timer started), we DON'T start a second POST —
  // instead the success handler re-checks for pending diffs and schedules
  // another flush. This serialization is essential because the server
  // enforces optimistic concurrency on `fromRevision`: two parallel POSTs
  // would both claim the same revision, the second would 409, and we'd
  // flap into conflict UI for no reason.
  let postInFlight = false;
  // `gestureActive` suppresses BOTH outbound flushes (we don't want to
  // snapshot a half-dragged panel) AND inbound applies (we don't want
  // Bob's patch to yank the polygon out from under Alice's live drag).
  // Inbound ops are buffered into gestureInboundQueue during the gesture
  // and drained in endGesture().
  let gestureActive = false;
  let gestureInboundQueue: Op[] = [];
  // Exponential backoff on transient POST failures (5xx, network error).
  // We don't count 401/403/404 here — those indicate a permanent issue
  // (auth gone, project deleted) and retrying wouldn't help.
  let retryCount = 0;
  let status: SyncStatus = { kind: 'synced' };
  const listeners = new Set<Listener>();

  let storeUnsub: (() => void) | null = null;
  let sseUnsub: (() => void) | null = null;
  // `stopped` protects against late async work (a POST that completes
  // after the component unmounts) touching a dead client. Every async
  // path re-checks `stopped` before calling setStatus or re-entering
  // flush().
  let stopped = false;

  function setStatus(next: SyncStatus) {
    status = next;
    listeners.forEach((fn) => fn(next));
  }

  // ── Outbound: debounced diff + POST ─────────────────────────────────
  //
  // Flow: store change → scheduleFlush() (resets debounce) → after
  // DEBOUNCE_MS of quiet → flush() → POST /api/sp/patch. A successful
  // POST advances lastSyncedDoc + lastKnownRevision so subsequent diffs
  // are relative to the new baseline.

  function scheduleFlush() {
    if (debounceTimer != null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  async function flush() {
    if (stopped) return;
    // These early returns are NOT bugs — they're the three cases where a
    // flush should be delayed rather than cancelled:
    //   postInFlight: the success handler will re-schedule if new edits
    //                 arrived while the POST was in flight.
    //   gestureActive: endGesture will call scheduleFlush() itself.
    //   !lastSyncedDoc: start() hasn't completed yet; the first store
    //                   subscription firing before the initial fetch
    //                   resolves is harmless — nothing to diff against.
    if (postInFlight) return;
    if (gestureActive) return;
    if (!lastSyncedDoc) return;

    const current = useProjectStore.getState().project;
    const ops = diffProjects(lastSyncedDoc, current);
    if (ops.length === 0) {
      setStatus({ kind: 'synced' });
      return;
    }

    postInFlight = true;
    setStatus({ kind: 'syncing' });

    try {
      const res = await fetch('/api/sp/patch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The PocketBase JS SDK manages the token via authStore; we
          // forward it on manual fetch calls so our custom /api/sp/*
          // routes (which live outside the SDK) can authenticate via
          // the same bearer token.
          Authorization: `Bearer ${pb.authStore.token}`,
        },
        body: JSON.stringify({
          projectId,
          fromRevision: lastKnownRevision,
          ops,
        }),
      });

      if (res.status === 200) {
        const body = (await res.json()) as { newRevision: number };
        // Success: the server has accepted our ops. `current` is now
        // the new baseline — not `useProjectStore.getState().project`,
        // because the user may have continued editing during the POST
        // and we'd lose those deltas on the next diff.
        //
        // Guard against a concurrent fullResync having already advanced
        // us past body.newRevision. That happens when an SSE patch
        // arrives from another user while our own POST is still in
        // flight: lastKnownRevision is behind, the gap-check in
        // applyInbound fires, fullResync pulls the authoritative doc
        // (which already includes our ops too, because the server
        // accepted them before mirroring over SSE), then our 200
        // arrives with a stale newRevision. If lastKnownRevision is
        // already >= body.newRevision, the fullResync already installed
        // a newer baseline — leave state untouched rather than regressing.
        if (body.newRevision > lastKnownRevision) {
          lastSyncedDoc = current;
          lastKnownRevision = body.newRevision;
        }
        retryCount = 0;
        setStatus({ kind: 'synced' });

        // If more edits arrived while we were POSTing, schedule another
        // flush. The debounce timer was INACTIVE during the POST (it
        // fired once to enter flush()), so without this explicit check
        // late edits would sit unsynced until the NEXT user action.
        // The `lastSyncedDoc &&` guard is defensive — in practice it's
        // non-null by this point (we early-returned on !lastSyncedDoc
        // at the top of flush), but TS can't narrow through the
        // conditional assignment above, and an explicit check is cheap.
        const afterPost = useProjectStore.getState().project;
        if (lastSyncedDoc && diffProjects(lastSyncedDoc, afterPost).length > 0) {
          scheduleFlush();
        }
      } else if (res.status === 409) {
        // Server state diverged from our fromRevision baseline. The
        // response carries the authoritative doc + revision so the
        // ConflictModal can show the user what changed. We don't try
        // to auto-rebase — merge semantics on this data model would
        // be surprisingly subtle (string indexing, string/roof refs)
        // and "show the user both and ask" is the honest UX.
        const body = (await res.json()) as {
          currentRevision: number;
          currentDoc: Project;
        };
        setStatus({
          kind: 'conflict',
          currentRevision: body.currentRevision,
          currentDoc: body.currentDoc,
        });
      } else if (res.status === 401 || res.status === 403 || res.status === 404) {
        // Permanent failures: the token expired, we were kicked from
        // the team, or the project was deleted. Retrying won't help —
        // surface as offline with 0 retries so the UI can prompt the
        // user to re-auth / navigate away.
        setStatus({ kind: 'offline', retriesScheduled: 0 });
      } else {
        // 5xx / other transient server errors: back off and retry.
        scheduleRetry();
      }
    } catch {
      // Network error, DNS failure, CORS preflight, etc. Treat the same
      // as a 5xx — back off and retry. We deliberately don't surface
      // the error to the UI beyond the "offline, retries scheduled"
      // status; the exact reason isn't actionable from the user's end.
      scheduleRetry();
    } finally {
      postInFlight = false;
    }
  }

  function scheduleRetry() {
    retryCount += 1;
    // Capped exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s, …
    // Cap at 30s so a long offline period doesn't stretch to minutes
    // between retry attempts (bad UX — the user would think the app
    // is frozen even after connectivity returns).
    const delay = Math.min(30_000, 1000 * 2 ** (retryCount - 1));
    setStatus({ kind: 'offline', retriesScheduled: retryCount });
    setTimeout(() => { if (!stopped) flush(); }, delay);
  }

  // ── Inbound: SSE patch subscription ────────────────────────────────

  async function subscribeSse() {
    // PocketBase's realtime API uses wildcard '*' to subscribe to all
    // records of the collection — we filter client-side by projectId
    // rather than using a PB filter expression because the latter has
    // historically had flakier semantics across SDK versions, and the
    // volume of other projects' patches arriving at this tab is low
    // enough that the filter overhead is negligible.
    const unsub = await pb.collection('patches').subscribe<PatchRecord>(
      '*',
      (e) => {
        if (e.action !== 'create') return;
        const rec = e.record;
        if (rec.project !== projectId) return;

        // Self-filter: if WE produced this patch (our POST just got
        // mirrored back over SSE), ignore — we've already applied it
        // locally to lastSyncedDoc in the POST success handler. Without
        // this, every local edit would ALSO re-apply via SSE, doubling
        // the operation (e.g., an "add roof" op would insert the roof
        // twice into the array).
        const me = currentUser();
        if (me && rec.author === (me as { id: string }).id) return;

        if (gestureActive) {
          // Don't disrupt an ongoing drag. Buffer the op stream and
          // drain it in endGesture. Note: we append ALL ops from ALL
          // queued patches into one flat array; chunkByPatch below
          // treats the whole buffer as a single patch for replay.
          gestureInboundQueue.push(...(rec.ops as Op[]));
          return;
        }

        applyInbound(rec);
      },
    );
    // pb.collection().subscribe returns a callable unsubscribe function
    // directly; we wrap to match our typed `(() => void) | null`.
    sseUnsub = () => unsub();
  }

  function applyInbound(rec: PatchRecord) {
    // Gap check: the incoming patch claims from_revision; if it doesn't
    // match our lastKnownRevision, we missed a patch (possibly due to
    // a brief SSE disconnection that auto-reconnected). Replaying the
    // current patch on top of stale state would produce silent
    // divergence — the reliable recovery is a full resync.
    if (rec.from_revision !== lastKnownRevision) {
      fullResync().catch(() => scheduleRetry());
      return;
    }

    try {
      // applyRemotePatch is registered as 'bypass' in ACTION_POLICY so
      // it doesn't enter the undo stack — Alice shouldn't be able to
      // Ctrl-Z Bob's changes (would fight the server's authoritative
      // state). See Task 11 commit / projectStore for rationale.
      useProjectStore.getState().applyRemotePatch(rec.ops as Op[]);
      // After the store mutates, our lastSyncedDoc should be the NEW
      // project — taking it from the store avoids re-applying the
      // patch ourselves (which we've already done via applyRemotePatch).
      lastSyncedDoc = useProjectStore.getState().project;
      lastKnownRevision = rec.to_revision;
      setStatus({ kind: 'synced' });
    } catch {
      // applyPatch throws on malformed ops or failed `test` ops. Either
      // way local state is suspect — fall back to a full resync which
      // is guaranteed-consistent (getOne returns the server's current
      // doc verbatim).
      fullResync().catch(() => scheduleRetry());
    }
  }

  async function fullResync() {
    // The server's record at whatever revision it's currently at is
    // the source of truth. We replace our local doc wholesale — any
    // unsaved local edits are lost. That's a conscious trade-off: by
    // the time we hit this path we've already decided local state is
    // corrupt / out-of-sync, so preserving it would only prolong the
    // inconsistency.
    const record = await pb
      .collection('projects')
      .getOne<ProjectRecord>(projectId);
    useProjectStore.getState().loadProject(record.doc);
    lastSyncedDoc = record.doc;
    lastKnownRevision = record.revision;
    retryCount = 0;
    setStatus({ kind: 'synced' });
  }

  // ── Conflict resolution (triggered by ConflictModal in Task 14) ────

  async function resolveConflict(choice: 'discard-mine' | 'overwrite-theirs') {
    // Guard: if status has already flipped to something else (another
    // inbound patch landed, or the modal double-dispatched), treat the
    // call as a no-op rather than operating on stale conflict payload.
    if (status.kind !== 'conflict') return;
    const { currentDoc, currentRevision } = status;

    if (choice === 'discard-mine') {
      // User chose the server's version. Wholesale replace — same
      // semantics as fullResync, but without a second network round-trip
      // because we already have the server doc from the 409 response.
      useProjectStore.getState().loadProject(currentDoc);
      lastSyncedDoc = currentDoc;
      lastKnownRevision = currentRevision;
      setStatus({ kind: 'synced' });
      return;
    }

    // overwrite-theirs — re-diff our local project against the current
    // server doc and POST. The new diff will contain ops that "undo"
    // the collaborator's changes AND re-apply our own, which is exactly
    // what "keep mine" means in OCC semantics.
    lastSyncedDoc = currentDoc;
    lastKnownRevision = currentRevision;
    setStatus({ kind: 'syncing' });
    await flush();
  }

  // ── Gesture hooks ──────────────────────────────────────────────────
  //
  // A "gesture" is a continuous interaction (vertex drag, slider scrub,
  // panel paint-drag) that produces many store writes in rapid succession.
  // Without these hooks, the 2s debounce would still eventually fire —
  // but during the gesture, two bad things could happen:
  //   1. An inbound patch from a collaborator would yank the data out
  //      from under the user's pointer (polygon vertex they're dragging
  //      suddenly moves).
  //   2. The debounce timer could fire if the gesture paused > 2s,
  //      uploading a half-committed state.
  // Both are prevented by bracketing gestures with begin/end hooks.

  function beginGesture() {
    gestureActive = true;
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function endGesture() {
    gestureActive = false;
    // Snapshot aliceDiff BEFORE applying buffered remote ops so we can
    // reassert Alice's work after Bob's patches land. Order matters:
    // we apply Bob's ops to get a consistent base (aligned with Bob's
    // from_revision → to_revision chain), then re-apply Alice's local
    // diff on top. This is NOT a proper OT merge — if Alice and Bob
    // touched the same field, Alice's value wins. Acceptable for M3;
    // proper conflict detection at the op level is a future concern.
    const projectNow = useProjectStore.getState().project;
    const aliceDiff = lastSyncedDoc
      ? diffProjects(lastSyncedDoc, projectNow)
      : [];

    if (gestureInboundQueue.length > 0) {
      try {
        for (const queuedOps of chunkByPatch(gestureInboundQueue)) {
          useProjectStore.getState().applyRemotePatch(queuedOps);
        }
        gestureInboundQueue = [];
        // Intentionally set lastSyncedDoc BEFORE re-applying Alice's diff.
        // The baseline we want for the next flush is "server + Bob's ops",
        // so that diffProjects(lastSyncedDoc, store) yields exactly
        // Alice's ops when we re-apply them to the store below. Moving
        // this assignment after the Alice re-apply would make the next
        // flush see no diff and silently drop Alice's gesture from the
        // outbound POST.
        lastSyncedDoc = useProjectStore.getState().project;
        if (aliceDiff.length > 0) {
          // Alice's edits get re-applied via applyRemotePatch (bypass)
          // rather than as local mutations — we don't want to double-
          // count them in undo history (the original gestures already
          // produced history entries). The server will receive these
          // via the next flush() and accept them as a legit patch.
          useProjectStore.getState().applyRemotePatch(aliceDiff);
        }
      } catch {
        // If anything throws during replay, abandon the queue and
        // full-resync. Safer than leaving the store in a half-applied
        // state where lastSyncedDoc doesn't match the project anymore.
        gestureInboundQueue = [];
        fullResync().catch(() => scheduleRetry());
        return;
      }
    }
    scheduleFlush();
  }

  // M3 simplification: treat the buffered inbound queue as a single op
  // array. applyRemotePatch tolerates arbitrary ops in sequence. A future
  // refactor may reinstate per-patch chunking if we need to preserve
  // from/to revisions for each queued patch (currently we only track
  // the aggregate, which is fine because revision numbers are strictly
  // monotonic and the chunkByPatch output feeds straight back into the
  // store without a network round-trip).
  function chunkByPatch(ops: Op[]): Op[][] {
    return ops.length === 0 ? [] : [ops];
  }

  // ── Public API ─────────────────────────────────────────────────────

  return {
    async start() {
      // Idempotence guard: if start() is called twice (e.g., a React
      // strict-mode double-invoke, or a caller bug), we don't want two
      // store subscriptions firing the same flush.
      if (storeUnsub) return;

      // Initial fetch establishes the baseline. Note we don't call
      // loadProject here — ProjectEditor already did it before mounting
      // the editor, and loadProject resets UI state which would be
      // disruptive on re-entry. We just snapshot the server doc as
      // lastSyncedDoc.
      const record = await pb
        .collection('projects')
        .getOne<ProjectRecord>(projectId);
      lastSyncedDoc = record.doc;
      lastKnownRevision = record.revision;
      setStatus({ kind: 'synced' });

      // Zustand v4 subscribe: the callback receives (state, prevState)
      // but we ignore them — scheduleFlush reads the current state
      // itself via getState() inside flush(). The subscribe signature
      // tolerates a 0-arg callback since extra args are simply unused.
      storeUnsub = useProjectStore.subscribe(scheduleFlush);

      await subscribeSse();
    },

    stop() {
      stopped = true;
      if (debounceTimer != null) clearTimeout(debounceTimer);
      storeUnsub?.();
      sseUnsub?.();
      storeUnsub = null;
      sseUnsub = null;
    },

    subscribeStatus(fn) {
      listeners.add(fn);
      // Fire immediately with current status so subscribers render the
      // correct state on mount without waiting for the next change.
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
