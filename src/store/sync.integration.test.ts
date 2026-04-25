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

// ────────────────────────────────────────────────────────────────────────────
// sync.integration.test.ts (store level) — Zustand store + SyncClient
// against a real PocketBase subprocess.
//
// Gated on RUN_INTEGRATION=1. Same pattern as the wire-level test in
// src/backend/sync.integration.test.ts. See that file's header for the
// rationale for the gate.
//
// To run:
//   (cd server && go build -o pocketbase .)
//   RUN_INTEGRATION=1 npm run test:integration
//
// What it covers (complement to the wire-level test):
//   1. Local mutation propagates — store.setProjectName → SyncClient debounce
//      → POST /api/sp/patch → server stores new doc.name.
//   2. Remote patch applies via SSE — a second PB client POSTs a patch;
//      the SSE delivery drives store.applyRemotePatch so the store reflects
//      the remote change.
//   3. Stale fromRevision returns 409 — via the new harness so the response
//      shape is exercised from the same code path as the store tests.
//
// Architecture note — why this file is separate from the wire-level test:
//   The wire-level test validates the HTTP protocol. This file validates the
//   store integration: that `setProjectName` (or any record-policy action)
//   eventually causes a /api/sp/patch POST, and that an inbound SSE event
//   drives `applyRemotePatch` in the store. These concerns are orthogonal
//   enough to warrant separate files.
// ────────────────────────────────────────────────────────────────────────────

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootPocketBase, type PbHarness } from '../test/integration/pbHarness';
import { seedUser, seedTeam, seedProject } from '../test/integration/seed';
import { mountStoreClient, type StoreMountResult } from '../test/integration/storeHarness';
import { initialProject } from './projectStore';

const GATED = process.env.RUN_INTEGRATION === '1';

// ────────────────────────────────────────────────────────────────────────────
// waitFor — tiny polling helper.
//
// Keeps the test body clean ("wait until the store reflects X") without
// pulling in @testing-library/dom or another polling library. The default
// timeout is generous (8 s) to absorb the SyncClient's 2 s debounce plus
// the full SSE round-trip latency that we see on slow CI.
//
// Why 8 s? The SyncClient has a 2 s DEBOUNCE_MS + PB migration/startup
// adds up to 3-5 s on a cold tmpdir, so 8 s gives 3 s headroom. If this
// proves too slow under CI, reduce the debounce in syncClient.ts (the
// real improvement) rather than inflating the timeout here.
// ────────────────────────────────────────────────────────────────────────────
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts?: { timeout?: number; interval?: number },
): Promise<void> {
  const timeout = opts?.timeout ?? 8_000;
  const interval = opts?.interval ?? 100;
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await predicate();
    if (result) return;
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timed out after ${timeout}ms`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Module-scoped harness — one PB server for all tests in this file.
let h: PbHarness;

describe.runIf(GATED)('store + SyncClient integration', () => {
  beforeAll(async () => {
    h = await bootPocketBase();
  }, 30_000);

  afterAll(async () => {
    await h?.stop();
  });

  // Track mount result so afterEach can clean up even if the test throws.
  let mount: StoreMountResult | null = null;

  afterEach(async () => {
    await mount?.cleanup();
    mount = null;
    localStorage.clear();
  });

  // ── Test 1: local mutation propagates ──────────────────────────────────
  //
  // Dispatch store.setProjectName → SyncClient debounce → POST /api/sp/patch
  // → PocketBase stores updated doc.name.
  //
  // We verify by reading the project record directly from PB after the POST
  // completes, confirming the server's stored doc matches what the store wrote.
  it('local setProjectName propagates to the server', async () => {
    const { client: userPb } = await seedUser(h);
    const team = await seedTeam(userPb);
    const initialDoc = { ...initialProject, name: 'before' };
    const project = await seedProject(userPb, team.id, initialDoc);

    mount = await mountStoreClient({
      userPb,
      projectId: project.id,
      initialDoc: initialDoc as typeof initialProject,
    });
    const { store } = mount;

    // Dispatch the name change through the store. The action goes through
    // undoMiddleware (record policy) and schedules a 2 s debounce in
    // SyncClient's store subscription.
    store.getState().setProjectName('after');

    // Wait until the server's project doc reflects the change.
    // We poll the PB record directly (not via the store) so we know
    // the round-trip completed — not just that the store changed locally.
    await waitFor(async () => {
      const rec = await userPb.collection('projects').getOne<{ doc: { name: string } }>(
        project.id,
      );
      return rec.doc.name === 'after';
    }, { timeout: 10_000 });

    // Re-read for the final assertion.
    const rec = await userPb
      .collection('projects')
      .getOne<{ doc: { name: string }; revision: number }>(project.id);
    expect(rec.doc.name).toBe('after');
    // Revision must have advanced from 0 to 1.
    expect(rec.revision).toBe(1);
  }, 30_000);

  // ── Test 2: remote patch applies via SSE ───────────────────────────────
  //
  // We POST a patch from a DIFFERENT device using the SAME user's token.
  // The SyncClient's self-filter works like this:
  //   - If the patch record has a `device_id`, drop it only if it matches
  //     THIS tab's deviceId; otherwise apply it.
  //   - If no `device_id`, fall back to the author check (drop if author
  //     matches the current user).
  //
  // By sending a distinct `deviceId` in the POST body, the server stores
  // it on the patches row. The SyncClient sees it doesn't match its own
  // sessionStorage deviceId and applies the patch as a remote change.
  // This avoids needing a second user entirely (no addTeamMember needed).
  //
  // This exercises the entire inbound path: SSE delivery → applyInbound →
  // gap check (from_revision must match lastKnownRevision) → applyRemotePatch.
  it('remote patch via SSE reaches the store', async () => {
    // Single user owns the project. They're also the "remote" poster —
    // the self-filter is bypassed via a different deviceId.
    const { client: ownerPb } = await seedUser(h);
    const team = await seedTeam(ownerPb);
    const initialDoc = { ...initialProject, name: 'original' };
    const project = await seedProject(ownerPb, team.id, initialDoc);

    // Mount the store for the owner — this starts the SSE subscription.
    mount = await mountStoreClient({
      userPb: ownerPb,
      projectId: project.id,
      initialDoc: initialDoc as typeof initialProject,
    });
    const { store } = mount;

    // Verify initial state before the remote patch.
    expect(store.getState().project.name).toBe('original');

    // Small delay so the owner's SSE subscription is registered on the
    // server before the patch fires and broadcasts. Without this,
    // PocketBase might fan out the SSE event before the subscription is
    // active and the owner misses it — triggering a fullResync instead
    // of the direct applyInbound path we want to exercise.
    await new Promise((r) => setTimeout(r, 400));

    // POST from the same user but with a DIFFERENT deviceId. The server
    // stores `device_id` on the patches row. The SyncClient's self-filter
    // sees a non-matching device_id and applies the patch.
    //
    // We post to h.baseUrl (absolute), bypassing the fetch wrapper in
    // storeHarness (which only prefixes relative /api/... paths).
    const fakeDeviceId = 'test-remote-device-' + Math.random().toString(36).slice(2);
    const patchRes = await fetch(`${h.baseUrl}/api/sp/patch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerPb.authStore.token}`,
      },
      body: JSON.stringify({
        projectId: project.id,
        fromRevision: 0,
        deviceId: fakeDeviceId,
        ops: [{ op: 'replace', path: '/name', value: 'patched-by-remote-device' }],
      }),
    });
    expect(patchRes.status).toBe(200);

    // Wait until the owner's store reflects the remote change.
    await waitFor(() => store.getState().project.name === 'patched-by-remote-device', {
      timeout: 10_000,
    });

    expect(store.getState().project.name).toBe('patched-by-remote-device');
  }, 30_000);

  // ── Test 3: stale fromRevision returns 409 ─────────────────────────────
  //
  // POST with a wildly stale fromRevision and assert the response is 409
  // with the structured `currentRevision` + `currentDoc` payload. This is
  // the same assertion as the wire-level test but driven through the new
  // harness, exercising the harness code paths (seedUser, seedTeam,
  // seedProject) from the store-test side.
  it('stale fromRevision returns 409 with currentRevision + currentDoc', async () => {
    const { client: userPb } = await seedUser(h);
    const team = await seedTeam(userPb);
    const project = await seedProject(userPb, team.id, { name: 'occ-test' });

    const postRes = await fetch(`${h.baseUrl}/api/sp/patch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userPb.authStore.token}`,
      },
      body: JSON.stringify({
        projectId: project.id,
        fromRevision: 999, // wildly stale — server is at revision 0
        ops: [{ op: 'replace', path: '/name', value: 'stale' }],
      }),
    });

    expect(postRes.status).toBe(409);

    const body = (await postRes.json()) as {
      currentRevision: number;
      currentDoc: { name: string };
    };
    expect(body.currentRevision).toBe(0);
    expect(body.currentDoc.name).toBe('occ-test');
  }, 15_000);
});

// When gated off, emit a placeholder so vitest doesn't warn "no tests in file".
describe.skipIf(GATED)(
  'store + SyncClient integration (gated — set RUN_INTEGRATION=1 to run)',
  () => {
    it('skipped by default; run with RUN_INTEGRATION=1 npm run test:integration', () => {
      expect(true).toBe(true);
    });
  },
);
