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
// syncClient unit tests.
//
// Scope:
//   Outbound flush/debounce, 409 conflict handling, and (ADR-016) the
//   data-loss regressions: rebasing unsent edits over inbound patches,
//   gesture drain, stop() during start(), resync/reconnect preserving
//   local work, page-lifecycle flushes, and the page-scoped deviceId.
//
// Design: `installPbFakes` stubs pb.collection(...).getOne/subscribe and
// pb.realtime.subscribe (PB_CONNECT) and hands back emitters so tests
// can inject SSE patch events and reconnects deterministically. Fetch is
// stubbed globally per test.
// ────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncClient, getDeviceId, type SyncStatus } from './syncClient';
import { applyProjectPatch } from './diff';
import type { Panel } from '../types';
import { useProjectStore } from '../store/projectStore';
import { pb } from './pb';
import type { Project } from '../types';
import type { PatchRecord, ProjectRecord } from './types';

// Build a minimal server-side project fixture. Keeping this shape in sync
// with the real Project type is the test's responsibility — if the type
// gains a required field, the fixture needs updating and tsc will flag it.
function fixtureProject(overrides: Partial<Project> = {}): Project {
  return {
    name: 'Server Project',
    panelType: { id: 'pt', name: 'x', widthM: 1, heightM: 1, wattPeak: 100 },
    // One roof by default: the `panel()` helper below places panels on
    // 'r1', and the client's post-merge referential repair would
    // (correctly) drop panels whose roof doesn't exist.
    roofs: [{ id: 'r1', name: 'Roof 1', polygon: [], tiltDeg: 30, panelOrientation: 'portrait' }],
    panels: [],
    strings: [],
    inverters: [],
    mapState: {
      locked: false,
      centerLat: 0, centerLng: 0, zoom: 1, metersPerPixel: 0.1,
      mapProvider: 'esri',
    },
    ...overrides,
  };
}

/**
 * Build a fake PB surface that `createSyncClient` can call: collection
 * getOne/subscribe plus pb.realtime.subscribe (PB_CONNECT). The returned
 * handles let tests push SSE patch events, fire a reconnect, and change
 * what the server returns on later getOne calls (resyncs).
 */
interface PbFakes {
  /** Deliver a realtime `patches` create event to every subscriber. */
  emitPatch(rec: Partial<PatchRecord> & { from_revision: number; to_revision: number; ops: unknown[] }): void;
  /** Fire PB_CONNECT (simulates an SSE reconnect). */
  emitConnect(): void;
  getOne: ReturnType<typeof vi.fn>;
  /** Number of currently-registered (not unsubscribed) listeners. */
  activeSubscriptions(): number;
}

function installPbFakes(getOneResult: ProjectRecord, opts: { subscribeDelayMs?: number } = {}): PbFakes {
  const patchListeners = new Set<(e: unknown) => void>();
  const connectListeners = new Set<(data: unknown) => void>();
  const getOne = vi.fn().mockResolvedValue(getOneResult);
  const subscribe = vi.fn().mockImplementation(async (_topic: string, cb: (e: unknown) => void) => {
    if (opts.subscribeDelayMs) await new Promise((r) => setTimeout(r, opts.subscribeDelayMs));
    patchListeners.add(cb);
    return async () => { patchListeners.delete(cb); };
  });
  vi.spyOn(pb, 'collection').mockImplementation(((_name: string) => {
    return { getOne, subscribe } as unknown as ReturnType<typeof pb.collection>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
  vi.spyOn(pb.realtime, 'subscribe').mockImplementation(async (_topic: string, cb: (data: unknown) => void) => {
    connectListeners.add(cb);
    return async () => { connectListeners.delete(cb); };
  });
  return {
    emitPatch(rec) {
      const record = {
        project: 'proj1', author: 'bob', device_id: 'bob-device', ...rec,
      } as PatchRecord;
      for (const l of [...patchListeners]) l({ action: 'create', record });
    },
    emitConnect() {
      for (const l of [...connectListeners]) l({});
    },
    getOne,
    activeSubscriptions: () => patchListeners.size + connectListeners.size,
  };
}

/** Assemble a ProjectRecord envelope for server fetch stubs. */
function serverRecord(doc: Project, revision = 1): ProjectRecord {
  return {
    id: 'proj1',
    collectionId: 'c',
    collectionName: 'projects',
    created: '',
    updated: '',
    team: 't1',
    name: doc.name,
    doc,
    revision,
    customer: '',
    // panel_model required by the record type since the catalog
    // feature added it; tests don't exercise catalog behavior so an
    // empty string (same convention as customer above) is fine.
    panel_model: '',
    // created_by: empty string mirrors the server's default for legacy
    // rows. Sync tests don't exercise branding/planner behavior.
    created_by: '',
  };
}

beforeEach(() => {
  // Reset the store between tests. Without this, a test that mutates
  // the project would leak into the next test's "fresh client" scenario.
  useProjectStore.getState().resetProject();
  vi.useFakeTimers();
  // Also stub authStore.token — fetch sends it as a bearer header;
  // if it's undefined at init time the Authorization header is literally
  // "Bearer undefined", which the server accepts but it clutters logs.
  Object.defineProperty(pb.authStore, 'token', {
    value: 'test-token',
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  vi.useRealTimers();
});

describe('syncClient outbound flush', () => {
  it('debounces outbound POST to 1s after last change', async () => {
    const serverDoc = fixtureProject({ name: 'Original' });
    installPbFakes(serverRecord(serverDoc, 1));
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ newRevision: 2 }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = createSyncClient('proj1');
    // start() awaits the initial getOne; run microtasks so the fake
    // promise resolves before we enter the store-mutation phase.
    await client.start();

    // Mutate the store — this fires the subscription → scheduleFlush.
    useProjectStore.getState().setProjectName('Edit 1');
    // Mutate again at t~500ms — should RESET the debounce timer.
    vi.advanceTimersByTime(500);
    useProjectStore.getState().setProjectName('Edit 2');

    // At t=1499 (999ms after the most recent edit) the timer hasn't fired.
    vi.advanceTimersByTime(999);
    expect(fetchSpy).not.toHaveBeenCalled();

    // At t=1501 (1001ms after the most recent edit) the timer fires and
    // flush() is invoked. Because flush is async (awaits fetch), we also
    // flush pending microtasks to let the fetch stub resolve.
    vi.advanceTimersByTime(2);
    await vi.runAllTimersAsync();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/sp/patch');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.projectId).toBe('proj1');
    expect(body.fromRevision).toBe(1);
    expect(Array.isArray(body.ops)).toBe(true);

    client.stop();
  });

  // Regression test for the bug where toggling between roof/diagram views
  // (or any other unmount inside the 1 s debounce window) silently dropped
  // the pending edit. ProjectEditor's unmount cleanup calls stop(), and
  // the previous teardown path cleared the debounce timer without
  // flushing — the next mount fetched the pre-edit doc from the server
  // and the change disappeared.
  //
  // Fix lives in stop(): if a debounce timer is pending, fire one final
  // flush() before tearing down. Fire-and-forget by necessity (React
  // unmount cleanup is synchronous), but fetch() dispatches the request
  // before returning the Promise, so the bytes are on the wire by the
  // time control returns.
  it('flushes pending debounced changes when stop() is called mid-debounce', async () => {
    const serverDoc = fixtureProject({ name: 'Original' });
    installPbFakes(serverRecord(serverDoc, 1));
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ newRevision: 2 }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = createSyncClient('proj1');
    await client.start();

    // Edit the store — this schedules a debounced flush 1 s out.
    useProjectStore.getState().setProjectName('Pending edit');

    // Advance the clock by less than DEBOUNCE_MS so the timer hasn't
    // fired yet — this models a fast view toggle / nav-away within the
    // debounce window.
    vi.advanceTimersByTime(300);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Unmount path: stop() should flush the pending change before the
    // tear-down completes, even though the debounce timer never fired.
    client.stop();
    // flush() is async (awaits fetch); drain microtasks so the stub
    // resolves and we can observe the call. The stop()-issued POST is
    // already in flight — we're just waiting for the Promise chain to
    // settle in the fake-timer environment.
    await vi.runAllTimersAsync();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body);
    expect(body.fromRevision).toBe(1);
    expect(Array.isArray(body.ops)).toBe(true);
    expect(body.ops.length).toBeGreaterThan(0);
  });
});

describe('syncClient conflict handling', () => {
  it('handles 409 by setting status=conflict with server doc', async () => {
    const serverDoc = fixtureProject({ name: 'Original' });
    installPbFakes(serverRecord(serverDoc, 1));

    // The conflict response carries the server's current authoritative
    // doc + revision; the client surfaces both via setStatus.
    const conflictDoc = fixtureProject({ name: 'Bob Wins' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 409,
      json: () => Promise.resolve({
        currentRevision: 7,
        currentDoc: conflictDoc,
      }),
    }));

    const client = createSyncClient('proj1');
    await client.start();

    // Collect status transitions. subscribeStatus fires immediately
    // with the current status, so the first observation is 'synced'.
    const seen: SyncStatus[] = [];
    client.subscribeStatus((s) => seen.push(s));

    useProjectStore.getState().setProjectName('Alice Edit');
    vi.advanceTimersByTime(DEBOUNCE);
    await vi.runAllTimersAsync();

    // Expected sequence: synced (initial) → syncing (POST) → conflict.
    const last = seen[seen.length - 1];
    expect(last.kind).toBe('conflict');
    if (last.kind === 'conflict') {
      expect(last.currentRevision).toBe(7);
      expect(last.currentDoc).toEqual(conflictDoc);
    }

    client.stop();
  });

  it('resolveConflict discard-mine loads server doc and resumes', async () => {
    const serverDoc = fixtureProject({ name: 'Original' });
    installPbFakes(serverRecord(serverDoc, 1));

    const conflictDoc = fixtureProject({ name: 'Server Authoritative' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 409,
      json: () => Promise.resolve({
        currentRevision: 9,
        currentDoc: conflictDoc,
      }),
    }));

    const client = createSyncClient('proj1');
    await client.start();

    useProjectStore.getState().setProjectName('My Edit');
    vi.advanceTimersByTime(DEBOUNCE);
    await vi.runAllTimersAsync();

    // Verify pre-condition: we're in conflict.
    const seen: SyncStatus[] = [];
    client.subscribeStatus((s) => seen.push(s));
    expect(seen[0].kind).toBe('conflict');

    // Act: discard local changes.
    await client.resolveConflict('discard-mine');

    expect(useProjectStore.getState().project.name).toBe('Server Authoritative');
    // The last observed status should be 'synced'.
    const final = seen[seen.length - 1];
    expect(final.kind).toBe('synced');

    client.stop();
  });

  it('resolveConflict overwrite-theirs re-flushes against server doc', async () => {
    // Arrange a conflict identical to the 409 test, then return 200 on
    // the second POST to model the server accepting our "re-assert"
    // patch relative to the new baseline.
    const serverDoc = fixtureProject({ name: 'Original' });
    installPbFakes(serverRecord(serverDoc, 1));

    // Conflict doc at revision 9; after overwrite-theirs the client
    // should re-POST with fromRevision=9 (the conflict's currentRevision)
    // and the server ACKs with newRevision=10.
    const conflictDoc = fixtureProject({ name: 'Server Authoritative' });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        status: 409,
        json: () => Promise.resolve({
          currentRevision: 9,
          currentDoc: conflictDoc,
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ newRevision: 10 }),
      });
    vi.stubGlobal('fetch', fetchSpy);

    const client = createSyncClient('proj1');
    await client.start();

    useProjectStore.getState().setProjectName('My Edit');
    vi.advanceTimersByTime(DEBOUNCE);
    await vi.runAllTimersAsync();

    // Collect transitions after the conflict so we see syncing → synced.
    const seen: SyncStatus[] = [];
    client.subscribeStatus((s) => seen.push(s));
    expect(seen[0].kind).toBe('conflict');

    // Act: keep local changes, re-flush against server's revision 9.
    await client.resolveConflict('overwrite-theirs');
    await vi.runAllTimersAsync();

    // The second fetch should carry fromRevision=9 (NOT 1, the original).
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondCallBody = JSON.parse(
      (fetchSpy.mock.calls[1][1] as { body: string }).body,
    );
    expect(secondCallBody.fromRevision).toBe(9);

    // Status should have transitioned through syncing → synced.
    const kinds = seen.map((s) => s.kind);
    expect(kinds).toContain('syncing');
    expect(seen[seen.length - 1].kind).toBe('synced');

    client.stop();
  });
});

describe('syncClient gesture safety valve', () => {
  // Regression test for: Konva stage onMouseUp is canvas-scoped and won't
  // fire if the user releases the mouse outside the browser window (or
  // tab-switches mid-drag). Without a fallback, gestureActive stays true
  // forever and outbound flushes get suppressed indefinitely.
  //
  // We verify the fallback behaviorally rather than via internal state
  // inspection: gestures suppress outbound POSTs via the gestureActive
  // guard in flush(). So the observable test is:
  //   1. begin a gesture
  //   2. mutate the store (would normally schedule a flush)
  //   3. advance past the debounce window — no POST fires because
  //      gestureActive is true
  //   4. dispatch a window-level mouseup (the safety valve)
  //   5. the subsequent flush should now actually POST, proving that
  //      endGesture was called by our listener
  it('releases gesture on window mouseup so sync can resume', async () => {
    const serverDoc = fixtureProject({ name: 'Original' });
    installPbFakes(serverRecord(serverDoc, 1));
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ newRevision: 2 }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = createSyncClient('proj1');
    await client.start();

    // Simulate KonvaOverlay's onMouseDown handler.
    client.beginGesture();

    // Make an edit and advance past the debounce window. Because
    // gestureActive is true, flush() should early-return and no POST
    // should occur yet.
    useProjectStore.getState().setProjectName('Mid-gesture edit');
    vi.advanceTimersByTime(DEBOUNCE);
    await vi.runAllTimersAsync();
    expect(fetchSpy).not.toHaveBeenCalled();

    // The safety valve: a window-level mouseup should release the
    // gesture (equivalent to the user releasing the button outside the
    // canvas). endGesture() internally calls scheduleFlush(), so we
    // advance time again and expect the POST to fire.
    window.dispatchEvent(new Event('mouseup'));
    vi.advanceTimersByTime(DEBOUNCE);
    await vi.runAllTimersAsync();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    client.stop();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Regression tests for the ADR-016 data-loss fixes.
// ────────────────────────────────────────────────────────────────────────

function panel(id: string, cx = 0): Panel {
  return {
    id, roofId: 'r1', groupId: 'g1', cx, cy: 0,
    stringId: null, indexInString: null, orientation: 'portrait',
  };
}

/** Fetch stub that ACKs every POST with an incrementing revision. */
function ackingFetch(firstNewRevision: number) {
  let next = firstNewRevision;
  return vi.fn().mockImplementation(async () => ({
    status: 200,
    json: () => Promise.resolve({ newRevision: next++ }),
  }));
}

/** Fetch response we can resolve by hand (models a slow POST). */
function deferredResponse() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function postBodies(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body));
}

/** Start a client the way ProjectEditor does: store hydrated in onLoaded. */
async function startLoaded(serverDoc: Project, revision: number) {
  const fakes = installPbFakes(serverRecord(serverDoc, revision));
  const client = createSyncClient('proj1');
  await client.start({ onLoaded: (r) => useProjectStore.getState().loadProject(r.doc) });
  return { client, fakes };
}

/** Local edit that bypasses store actions (keeps tests independent of
 *  undo-policy details the store agent may change). */
function localSetPanels(panels: Panel[]) {
  useProjectStore.setState((s) => ({ project: { ...s.project, panels } }));
}

describe('ADR-016 #1: unsent local edits survive inbound patches', () => {
  it('local edit made before an inbound patch is still POSTed, against the server revision', async () => {
    const serverDoc = fixtureProject({ name: 'Original' });
    const { client, fakes } = await startLoaded(serverDoc, 1);
    const fetchSpy = ackingFetch(3);
    vi.stubGlobal('fetch', fetchSpy);

    // Alice edits; debounce pending.
    useProjectStore.getState().setProjectName('Alice');
    // Bob's patch lands before Alice's flush.
    fakes.emitPatch({
      from_revision: 1, to_revision: 2,
      ops: [{ op: 'replace', path: '/panelType/wattPeak', value: 450 }],
    });
    expect(useProjectStore.getState().project.name).toBe('Alice');
    expect(useProjectStore.getState().project.panelType.wattPeak).toBe(450);

    vi.advanceTimersByTime(DEBOUNCE);
    await vi.runAllTimersAsync();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [body] = postBodies(fetchSpy);
    expect(body.fromRevision).toBe(2);
    // Only Alice's op — NOT a revert of Bob's wattPeak, NOT empty.
    expect(body.ops).toEqual([{ op: 'replace', path: '/name', value: 'Alice' }]);
    // Server-side result of applying it to the server doc is correct.
    const serverAfter = applyProjectPatch(
      applyProjectPatch(serverDoc, [{ op: 'replace', path: '/panelType/wattPeak', value: 450 }]),
      body.ops,
    );
    expect(serverAfter.name).toBe('Alice');
    expect(serverAfter.panelType.wattPeak).toBe(450);
    expect(fakes.getOne).toHaveBeenCalledTimes(1); // no resync needed
    client.stop();
  });

  it('edits made while a POST is in flight are sent after the ACK', async () => {
    const { client } = await startLoaded(fixtureProject({ name: 'Original' }), 1);
    const first = deferredResponse();
    const fetchSpy = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ status: 200, json: () => Promise.resolve({ newRevision: 3 }) });
    vi.stubGlobal('fetch', fetchSpy);

    useProjectStore.getState().setProjectName('A');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    useProjectStore.getState().setProjectName('B'); // during flight

    first.resolve({ status: 200, json: () => Promise.resolve({ newRevision: 2 }) });
    await vi.runAllTimersAsync();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const bodies = postBodies(fetchSpy);
    expect(bodies[1].fromRevision).toBe(2);
    expect(bodies[1].ops).toEqual([{ op: 'replace', path: '/name', value: 'B' }]);
    client.stop();
  });

  it('a collaborator patch arriving before our own 200 is not treated as a gap', async () => {
    const { client, fakes } = await startLoaded(fixtureProject({ name: 'Original' }), 1);
    const first = deferredResponse();
    const fetchSpy = vi.fn().mockImplementationOnce(() => first.promise);
    vi.stubGlobal('fetch', fetchSpy);

    useProjectStore.getState().setProjectName('Mine');
    vi.advanceTimersByTime(DEBOUNCE);
    // Server committed ours as 1→2, then Bob's 2→3; Bob's SSE beats our 200.
    fakes.emitPatch({
      from_revision: 2, to_revision: 3,
      ops: [{ op: 'replace', path: '/panelType/wattPeak', value: 300 }],
    });
    first.resolve({ status: 200, json: () => Promise.resolve({ newRevision: 2 }) });
    await vi.runAllTimersAsync();

    expect(fakes.getOne).toHaveBeenCalledTimes(1); // no full resync
    expect(useProjectStore.getState().project.panelType.wattPeak).toBe(300);
    expect(useProjectStore.getState().project.name).toBe('Mine');
    client.stop();
  });

  it('a 400 resyncs once and then surfaces an error instead of retrying forever', async () => {
    const { client, fakes } = await startLoaded(fixtureProject({ name: 'Original' }), 1);
    const fetchSpy = vi.fn().mockResolvedValue({ status: 400, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchSpy);
    const seen: SyncStatus[] = [];
    client.subscribeStatus((st) => seen.push(st));

    useProjectStore.getState().setProjectName('Edit');
    vi.advanceTimersByTime(DEBOUNCE);
    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(120_000);
    await vi.runAllTimersAsync();

    expect(fakes.getOne).toHaveBeenCalledTimes(2); // initial + one resync
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(seen[seen.length - 1]).toEqual({ kind: 'error', reason: 'rejected' });
    // Local edit is still in the store.
    expect(useProjectStore.getState().project.name).toBe('Edit');
    client.stop();
  });
});

describe('ADR-016 #2: gesture drain', () => {
  it('rebases buffered inbound patches by id and advances the revision', async () => {
    const serverDoc = fixtureProject({ panels: [panel('p1'), panel('p2')] });
    const { client, fakes } = await startLoaded(serverDoc, 1);
    const fetchSpy = ackingFetch(4);
    vi.stubGlobal('fetch', fetchSpy);

    client.beginGesture();
    // Alice (mid-gesture) adds a panel and moves p2.
    localSetPanels([panel('p1'), panel('p2', 50), panel('alice')]);
    // Bob: delete p1 (index 0), then add his panel at the end.
    const bobOps1 = [{ op: 'remove', path: '/panels/0' }];
    const bobOps2 = [{ op: 'add', path: '/panels/1', value: panel('bob') }];
    fakes.emitPatch({ from_revision: 1, to_revision: 2, ops: bobOps1 });
    fakes.emitPatch({ from_revision: 2, to_revision: 3, ops: bobOps2 });
    // Nothing applied mid-gesture.
    expect(useProjectStore.getState().project.panels.map((p) => p.id)).toEqual(['p1', 'p2', 'alice']);

    client.endGesture();
    const ids = useProjectStore.getState().project.panels.map((p) => p.id);
    expect(ids).toEqual(['p2', 'bob', 'alice']); // no duplicates, right panel deleted
    expect(useProjectStore.getState().project.panels.find((p) => p.id === 'p2')!.cx).toBe(50);

    vi.advanceTimersByTime(DEBOUNCE);
    await vi.runAllTimersAsync();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [body] = postBodies(fetchSpy);
    expect(body.fromRevision).toBe(3); // revision advanced through both queued patches
    // Replaying our ops on the server's doc yields exactly the merged doc.
    const server3 = applyProjectPatch(applyProjectPatch(serverDoc, bobOps1 as never), bobOps2 as never);
    const after = applyProjectPatch(server3, body.ops);
    expect(after.panels.map((p) => p.id)).toEqual(['p2', 'bob', 'alice']);
    expect(after.panels.find((p) => p.id === 'p2')!.cx).toBe(50);
    expect(fakes.getOne).toHaveBeenCalledTimes(1);
    client.stop();
  });
});

describe('ADR-016 #4: stop() during start()', () => {
  it('stop before the realtime subscription resolves leaves nothing subscribed and never loads', async () => {
    const fakes = installPbFakes(serverRecord(fixtureProject({ name: 'Server' }), 1), { subscribeDelayMs: 50 });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const onLoaded = vi.fn();
    const client = createSyncClient('proj1');
    const started = client.start({ onLoaded });
    client.stop();
    await vi.runAllTimersAsync();

    await expect(started).resolves.toBeNull();
    expect(onLoaded).not.toHaveBeenCalled();
    expect(fakes.activeSubscriptions()).toBe(0);
    // No store subscription either: an edit triggers no POST.
    useProjectStore.getState().setProjectName('late edit');
    await vi.runAllTimersAsync();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fakes.getOne).not.toHaveBeenCalled();
  });

  it('stop while the load is in flight: late result never reaches the store', async () => {
    const fakes = installPbFakes(serverRecord(fixtureProject(), 1));
    const load = deferredResponse();
    const onLoaded = vi.fn();
    const client = createSyncClient('proj1');
    const started = client.start({ load: () => load.promise as Promise<ProjectRecord>, onLoaded });
    await vi.runAllTimersAsync(); // subscriptions established
    client.stop();
    load.resolve(serverRecord(fixtureProject({ name: 'Project A' }), 5));
    await expect(started).resolves.toBeNull();
    expect(onLoaded).not.toHaveBeenCalled();
    expect(fakes.activeSubscriptions()).toBe(0);
    // SSE event for this project after stop: ignored.
    const before = useProjectStore.getState().project;
    fakes.emitPatch({ from_revision: 5, to_revision: 6, ops: [{ op: 'replace', path: '/name', value: 'X' }] });
    expect(useProjectStore.getState().project).toBe(before);
  });
});

describe('ADR-016 #5: resync preserves local work', () => {
  it('a revision gap resyncs without dropping unsent edits or resetting UI state', async () => {
    const serverDoc = fixtureProject({ name: 'Original' });
    const { client, fakes } = await startLoaded(serverDoc, 1);
    const fetchSpy = ackingFetch(5);
    vi.stubGlobal('fetch', fetchSpy);
    useProjectStore.getState().setToolMode('place-panels');

    useProjectStore.getState().setProjectName('Mine');
    // Server moved to rev 3 with a change we missed (SSE dropped it).
    fakes.getOne.mockResolvedValue(serverRecord(
      fixtureProject({ name: 'Original', panelType: { ...serverDoc.panelType, wattPeak: 450 } }), 3,
    ));
    fakes.emitPatch({
      from_revision: 3, to_revision: 4,
      ops: [{ op: 'replace', path: '/panelType/name', value: 'bob' }],
    });
    await vi.advanceTimersByTimeAsync(0);

    const p = useProjectStore.getState().project;
    expect(p.name).toBe('Mine');
    expect(p.panelType.wattPeak).toBe(450);
    expect(p.panelType.name).toBe('bob');
    expect(useProjectStore.getState().toolMode).toBe('place-panels');

    vi.advanceTimersByTime(DEBOUNCE);
    await vi.runAllTimersAsync();
    const [body] = postBodies(fetchSpy);
    expect(body.fromRevision).toBe(4);
    expect(body.ops).toEqual([{ op: 'replace', path: '/name', value: 'Mine' }]);
    client.stop();
  });

  it('inbound patches during an open conflict do not resolve it', async () => {
    const { client, fakes } = await startLoaded(fixtureProject({ name: 'Original' }), 1);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 409,
      json: () => Promise.resolve({ currentRevision: 2, currentDoc: fixtureProject({ name: 'Bob' }) }),
    }));
    useProjectStore.getState().setProjectName('Alice');
    vi.advanceTimersByTime(DEBOUNCE);
    await vi.runAllTimersAsync();

    const seen: SyncStatus[] = [];
    client.subscribeStatus((st) => seen.push(st));
    expect(seen[0].kind).toBe('conflict');

    fakes.emitPatch({
      from_revision: 2, to_revision: 3,
      ops: [{ op: 'replace', path: '/panelType/wattPeak', value: 999 }],
    });
    const last = seen[seen.length - 1];
    expect(last.kind).toBe('conflict');
    if (last.kind === 'conflict') {
      expect(last.currentRevision).toBe(3);
      expect(last.currentDoc.panelType.wattPeak).toBe(999);
    }
    // Store untouched until the user decides.
    expect(useProjectStore.getState().project.name).toBe('Alice');
    expect(useProjectStore.getState().project.panelType.wattPeak).toBe(100);
    client.stop();
  });

  it('a 409 without overlapping fields auto-rebases instead of opening the modal', async () => {
    const serverDoc = fixtureProject({ name: 'Original' });
    const { client } = await startLoaded(serverDoc, 1);
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        status: 409,
        json: () => Promise.resolve({
          currentRevision: 2,
          currentDoc: fixtureProject({ name: 'Original', panelType: { ...serverDoc.panelType, wattPeak: 7 } }),
        }),
      })
      .mockResolvedValue({ status: 200, json: () => Promise.resolve({ newRevision: 3 }) });
    vi.stubGlobal('fetch', fetchSpy);

    useProjectStore.getState().setProjectName('Alice');
    vi.advanceTimersByTime(DEBOUNCE);
    await vi.runAllTimersAsync();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const bodies = postBodies(fetchSpy);
    expect(bodies[1].fromRevision).toBe(2);
    expect(bodies[1].ops).toEqual([{ op: 'replace', path: '/name', value: 'Alice' }]);
    expect(useProjectStore.getState().project.panelType.wattPeak).toBe(7);
    client.stop();
  });
});

describe('ADR-016 #6: page lifecycle + final flush', () => {
  it('pagehide flushes immediately with keepalive', async () => {
    const { client } = await startLoaded(fixtureProject(), 1);
    const fetchSpy = ackingFetch(2);
    vi.stubGlobal('fetch', fetchSpy);
    useProjectStore.getState().setProjectName('closing');
    window.dispatchEvent(new Event('pagehide'));
    expect(fetchSpy).toHaveBeenCalledTimes(1); // synchronous, no debounce
    expect((fetchSpy.mock.calls[0][1] as RequestInit).keepalive).toBe(true);
    client.stop();
  });

  it('beforeunload prompts when the pending patch is too large for keepalive', async () => {
    const { client } = await startLoaded(fixtureProject(), 1);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})));
    useProjectStore.getState().setProjectName('x'.repeat(70_000));
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    client.stop();
  });

  it('final flush after stop() rebases a 409 and re-sends', async () => {
    const serverDoc = fixtureProject({ name: 'Original' });
    const { client } = await startLoaded(serverDoc, 1);
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({
        status: 409,
        json: () => Promise.resolve({
          currentRevision: 4,
          currentDoc: fixtureProject({ name: 'Original', panelType: { ...serverDoc.panelType, wattPeak: 7 } }),
        }),
      })
      .mockResolvedValue({ status: 200, json: () => Promise.resolve({ newRevision: 5 }) });
    vi.stubGlobal('fetch', fetchSpy);
    useProjectStore.getState().setProjectName('Leaving');
    client.stop();
    useProjectStore.getState().resetProject(); // what ProjectEditor does
    await vi.runAllTimersAsync();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const bodies = postBodies(fetchSpy);
    expect(bodies[1].fromRevision).toBe(4);
    expect(bodies[1].ops).toEqual([{ op: 'replace', path: '/name', value: 'Leaving' }]);
  });

  it('final flush 409 with a real conflict reports unsaved changes', async () => {
    installPbFakes(serverRecord(fixtureProject({ name: 'Original' }), 1));
    const onUnsavedChanges = vi.fn();
    const client = createSyncClient('proj1', { onUnsavedChanges });
    await client.start({ onLoaded: (r) => useProjectStore.getState().loadProject(r.doc) });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 409,
      json: () => Promise.resolve({ currentRevision: 2, currentDoc: fixtureProject({ name: 'Bob' }) }),
    }));
    useProjectStore.getState().setProjectName('Alice');
    client.stop();
    await vi.runAllTimersAsync();
    expect(onUnsavedChanges).toHaveBeenCalledWith('conflict');
  });
});

describe('ADR-016 #7: deviceId', () => {
  it('is per page load, not copied from sessionStorage (Duplicate tab)', async () => {
    sessionStorage.setItem('solar-planner-device-id', 'duplicated-tab-id');
    const { client } = await startLoaded(fixtureProject(), 1);
    const fetchSpy = ackingFetch(2);
    vi.stubGlobal('fetch', fetchSpy);
    useProjectStore.getState().setProjectName('x');
    vi.advanceTimersByTime(DEBOUNCE);
    await vi.runAllTimersAsync();
    const [body] = postBodies(fetchSpy);
    expect(body.deviceId).toBe(getDeviceId());
    expect(body.deviceId).not.toBe('duplicated-tab-id');
    client.stop();
  });

  it('drops only our own echo', async () => {
    const { client, fakes } = await startLoaded(fixtureProject({ name: 'Original' }), 1);
    fakes.emitPatch({
      from_revision: 1, to_revision: 2, device_id: getDeviceId(),
      ops: [{ op: 'replace', path: '/name', value: 'echo' }],
    });
    expect(useProjectStore.getState().project.name).toBe('Original');
    fakes.emitPatch({
      from_revision: 1, to_revision: 2, device_id: 'other-tab-same-user', author: 'me',
      ops: [{ op: 'replace', path: '/name', value: 'other tab' }],
    });
    expect(useProjectStore.getState().project.name).toBe('other tab');
    client.stop();
  });
});

describe('ADR-016 #8: reconnect + load failures', () => {
  it('PB_CONNECT after start resyncs and keeps local edits', async () => {
    const serverDoc = fixtureProject({ name: 'Original' });
    const { client, fakes } = await startLoaded(serverDoc, 1);
    vi.stubGlobal('fetch', ackingFetch(3));
    useProjectStore.getState().setProjectName('Mine');
    fakes.getOne.mockResolvedValue(serverRecord(
      fixtureProject({ name: 'Original', panelType: { ...serverDoc.panelType, wattPeak: 321 } }), 2,
    ));
    fakes.emitConnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(fakes.getOne).toHaveBeenCalledTimes(2);
    expect(useProjectStore.getState().project.name).toBe('Mine');
    expect(useProjectStore.getState().project.panelType.wattPeak).toBe(321);
    client.stop();
  });

  it('initial load retries transient failures, then reports load-failed', async () => {
    const fakes = installPbFakes(serverRecord(fixtureProject(), 1));
    fakes.getOne.mockRejectedValue(Object.assign(new Error('down'), { status: 0 }));
    const client = createSyncClient('proj1');
    const seen: SyncStatus[] = [];
    client.subscribeStatus((st) => seen.push(st));
    const started = client.start();
    const assertion = expect(started).rejects.toThrow('down');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fakes.getOne).toHaveBeenCalledTimes(3);
    expect(seen.map((x) => x.kind)).toContain('offline');
    expect(seen[seen.length - 1]).toEqual({ kind: 'error', reason: 'load-failed' });
    client.stop();
  });

  it('initial load recovers after a transient failure', async () => {
    const fakes = installPbFakes(serverRecord(fixtureProject({ name: 'Server' }), 4));
    fakes.getOne.mockRejectedValueOnce(Object.assign(new Error('blip'), { status: 503 }));
    vi.stubGlobal('fetch', ackingFetch(5));
    const client = createSyncClient('proj1');
    const started = client.start({ onLoaded: (r) => useProjectStore.getState().loadProject(r.doc) });
    await vi.advanceTimersByTimeAsync(1500); // one backoff step
    const rec = await started;
    expect(rec?.revision).toBe(4);
    expect(useProjectStore.getState().project.name).toBe('Server');
    client.stop();
  });

  it('patches committed between subscribe and fetch are applied, older ones dropped', async () => {
    const serverDoc = fixtureProject({ name: 'Original' });
    const fakes = installPbFakes(serverRecord(serverDoc, 2));
    const load = deferredResponse();
    const client = createSyncClient('proj1');
    const started = client.start({
      load: () => load.promise as Promise<ProjectRecord>,
      onLoaded: (r) => useProjectStore.getState().loadProject(r.doc),
    });
    await vi.advanceTimersByTimeAsync(0);
    // Already contained in the fetched doc (rev 2) → must be dropped.
    fakes.emitPatch({ from_revision: 1, to_revision: 2, ops: [{ op: 'replace', path: '/name', value: 'stale' }] });
    // Committed after the fetch snapshot → must be applied.
    fakes.emitPatch({ from_revision: 2, to_revision: 3, ops: [{ op: 'replace', path: '/name', value: 'fresh' }] });
    load.resolve(serverRecord(serverDoc, 2));
    await started;
    expect(useProjectStore.getState().project.name).toBe('fresh');
    expect(fakes.getOne).not.toHaveBeenCalled();
    client.stop();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Referential repair after merges. rebaseProject merges by id without
// knowing the schema, so concurrent edits can leave refs dangling; the
// client must repair them before the store write and POST the repair.
// ────────────────────────────────────────────────────────────────────────

const ROOF = { id: 'r1', name: 'Roof 1', polygon: [], tiltDeg: 30, panelOrientation: 'portrait' as const };
const STRING = { id: 's1', label: 'String 1', inverterId: null, color: '#f00' };

describe('referential repair after merge', () => {
  it('inbound string delete + local panel assignment → panel unassigned and repair POSTed', async () => {
    const serverDoc = fixtureProject({ roofs: [ROOF], strings: [STRING] });
    const { client, fakes } = await startLoaded(serverDoc, 1);
    const fetchSpy = ackingFetch(3);
    vi.stubGlobal('fetch', fetchSpy);

    // Alice paints a panel into s1 (unsent)…
    localSetPanels([{ ...panel('p1'), stringId: 's1', indexInString: 1 }]);
    // …while Bob deletes s1. The id-wise merge keeps both edits, which
    // alone would leave p1.stringId dangling.
    fakes.emitPatch({ from_revision: 1, to_revision: 2, ops: [{ op: 'remove', path: '/strings/0' }] });

    const after = useProjectStore.getState().project;
    expect(after.strings).toEqual([]);
    expect(after.panels).toHaveLength(1);
    expect(after.panels[0]).toMatchObject({ id: 'p1', stringId: null, indexInString: null });

    vi.advanceTimersByTime(DEBOUNCE);
    await vi.runAllTimersAsync();
    const [body] = postBodies(fetchSpy);
    expect(body.fromRevision).toBe(2);
    // Server-side result: Bob's delete kept, Alice's panel present but
    // unassigned — no dangling stringId reaches the server.
    const serverAfter = applyProjectPatch(
      applyProjectPatch(serverDoc, [{ op: 'remove', path: '/strings/0' }]),
      body.ops,
    );
    expect(serverAfter.panels).toEqual([expect.objectContaining({ id: 'p1', stringId: null, indexInString: null })]);
    client.stop();
  });

  it('inbound roof delete drops a locally-added panel on that roof (nothing left to POST)', async () => {
    const serverDoc = fixtureProject({ roofs: [ROOF] });
    const { client, fakes } = await startLoaded(serverDoc, 1);
    const fetchSpy = ackingFetch(3);
    vi.stubGlobal('fetch', fetchSpy);

    localSetPanels([panel('p1')]);
    fakes.emitPatch({ from_revision: 1, to_revision: 2, ops: [{ op: 'remove', path: '/roofs/0' }] });

    expect(useProjectStore.getState().project.panels).toEqual([]);
    vi.advanceTimersByTime(DEBOUNCE);
    await vi.runAllTimersAsync();
    // The only local edit was the panel, which the repair removed → the
    // local doc equals the server baseline and no POST is needed.
    expect(fetchSpy).not.toHaveBeenCalled();
    client.stop();
  });

  it('keep-mine after a 409 clears a string → deleted-inverter ref', async () => {
    const serverDoc = fixtureProject({
      name: 'Original',
      inverters: [{ id: 'i1', name: 'Inv' }],
      strings: [STRING],
    });
    const { client } = await startLoaded(serverDoc, 1);
    // Bob renamed the project (→ same-field conflict with Alice) and
    // deleted the inverter Alice is about to wire s1 to.
    const conflictDoc = fixtureProject({ name: 'Theirs', inverters: [], strings: [STRING] });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ status: 409, json: () => Promise.resolve({ currentRevision: 5, currentDoc: conflictDoc }) })
      .mockResolvedValue({ status: 200, json: () => Promise.resolve({ newRevision: 6 }) });
    vi.stubGlobal('fetch', fetchSpy);

    useProjectStore.setState((s) => ({
      project: {
        ...s.project,
        name: 'Mine',
        strings: s.project.strings.map((x) => ({ ...x, inverterId: 'i1', mpptPort: 'A' })),
      },
    }));
    vi.advanceTimersByTime(DEBOUNCE);
    await vi.runAllTimersAsync();

    await client.resolveConflict('overwrite-theirs');
    await vi.runAllTimersAsync();

    const after = useProjectStore.getState().project;
    expect(after.name).toBe('Mine');
    expect(after.inverters).toEqual([]);
    expect(after.strings[0]).toMatchObject({ id: 's1', inverterId: null, mpptPort: null });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const second = postBodies(fetchSpy)[1];
    expect(second.fromRevision).toBe(5);
    const serverAfter = applyProjectPatch(conflictDoc, second.ops);
    expect(serverAfter.name).toBe('Mine');
    expect(serverAfter.strings[0].inverterId).toBeNull();
    client.stop();
  });
});

// Shared constant — `const DEBOUNCE_MS` lives inside syncClient.ts and
// isn't exported. Replicating it here keeps the tests' intent explicit
// ("advance by the debounce window") and decoupled from the module
// internals (if the production value changes, tests update in one place).
const DEBOUNCE = 1000;
