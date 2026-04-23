// ────────────────────────────────────────────────────────────────────────
// syncClient unit tests.
//
// Scope:
//   We do NOT exercise SSE here — stubbing pb.collection().subscribe()
//   adequately requires deeper fakes than M3 has time for. The inbound
//   path is covered by the manual two-client smoke test (plan Step 5)
//   and will be covered end-to-end in Task 16's integration test.
//
//   What we DO cover:
//     1. Debounced outbound flush (no POST before 2s, exactly one after).
//     2. 409 response transitions status to {kind:'conflict',...} with
//        the server's doc payload.
//     3. resolveConflict('discard-mine') loads the server doc into the
//        store and returns status to 'synced'.
//
// Design: stub the PocketBase collection ONLY enough to resolve
// `getOne` and `subscribe` — anything deeper (filtering, retry logic)
// is out of scope for unit tests. Fetch is stubbed globally per-test.
// ────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncClient, type SyncStatus } from './syncClient';
import { useProjectStore } from '../store/projectStore';
import { pb } from './pb';
import type { Project } from '../types';
import type { ProjectRecord } from './types';

// Build a minimal server-side project fixture. Keeping this shape in sync
// with the real Project type is the test's responsibility — if the type
// gains a required field, the fixture needs updating and tsc will flag it.
function fixtureProject(overrides: Partial<Project> = {}): Project {
  return {
    name: 'Server Project',
    panelType: { id: 'pt', name: 'x', widthM: 1, heightM: 1, wattPeak: 100 },
    roofs: [],
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
 * Build a fake PB collection surface that `createSyncClient` can call.
 * `getOneResult` is used for the initial fetch; `subscribe` resolves
 * to a noop unsub. We deliberately don't implement the realtime event
 * path — inbound SSE is covered elsewhere (see file header).
 */
function installPbFakes(getOneResult: ProjectRecord) {
  return vi.spyOn(pb, 'collection').mockImplementation(((_name: string) => {
    return {
      getOne: vi.fn().mockResolvedValue(getOneResult),
      subscribe: vi.fn().mockResolvedValue(() => {}),
    } as unknown as ReturnType<typeof pb.collection>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
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
  vi.useRealTimers();
});

describe('syncClient outbound flush', () => {
  it('debounces outbound POST to 2s after last change', async () => {
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
    // Mutate again at t~1s — should RESET the debounce timer.
    vi.advanceTimersByTime(1000);
    useProjectStore.getState().setProjectName('Edit 2');

    // At t=1999 (999ms after the most recent edit) the timer hasn't fired.
    vi.advanceTimersByTime(999);
    expect(fetchSpy).not.toHaveBeenCalled();

    // At t=2001 (1001ms after the most recent edit) the timer fires and
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

// Shared constant — `const DEBOUNCE_MS` lives inside syncClient.ts and
// isn't exported. Replicating it here keeps the tests' intent explicit
// ("advance by the debounce window") and decoupled from the module
// internals (if the production value changes, tests update in one place).
const DEBOUNCE = 2000;
