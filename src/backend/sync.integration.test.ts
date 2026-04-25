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
// sync.integration.test.ts — real PocketBase subprocess, two clients.
//
// Gated on RUN_INTEGRATION=1. Reason: the test spawns ./server/pocketbase,
// which requires a pre-built Go binary and a writable tempdir. Flaky on
// cold boots and under CI without setup. Default test runs skip it via
// `describe.runIf(GATED)` — the companion `describe.skipIf(GATED)` block
// below emits a placeholder so vitest doesn't warn "no tests in file"
// when the gate is off.
//
// To run locally:
//   (cd server && go build -o pocketbase .)
//   RUN_INTEGRATION=1 npm run test:integration
//
// What it covers:
//   - /api/sp/patch accepts a valid POST with Authorization bearer token
//     and returns 200 + newRevision.
//   - PocketBase SSE fans out the 'patches' record-create event so Bob's
//     client-side subscription receives Alice's patch within ~5s.
//   - Optimistic concurrency: Alice POSTing with a stale fromRevision
//     returns 409 with currentDoc/currentRevision.
//
// Why a real subprocess rather than stubs:
//   The chain under test (POST -> Go handler -> SSE broadcast -> JS SDK
//   subscribe callback) is almost entirely out-of-process from the Vitest
//   worker. Mocking any link severs the very seam we're trying to
//   exercise. The cost is boot latency + external dependency on a
//   compiled binary; the gate pushes both concerns out of CI's default
//   path while still leaving a runnable artifact.
//
// Refactored (2026-04) to use the shared harness in
// `src/test/integration/` — boot/teardown and seeding logic now lives
// there so the store-level integration tests can reuse it without
// duplicating the subprocess management.
// ────────────────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPocketBase, type PbHarness } from '../test/integration/pbHarness';
import { seedUser, seedTeam, addTeamMember, seedProject } from '../test/integration/seed';

// Single env-var switch. `=== '1'` (not truthy) so "0", "false", or an
// accidentally-exported empty string don't flip the gate. CI defaults to
// unset → GATED === false → only the skipIf placeholder runs.
const GATED = process.env.RUN_INTEGRATION === '1';

// Module-scoped harness. Initialized in beforeAll, stopped in afterAll.
let h: PbHarness;

describe.runIf(GATED)('two-client sync (integration)', () => {
  beforeAll(async () => {
    h = await bootPocketBase();
  }, 30_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('patch from Alice appears on Bob within 5 seconds', async () => {
    // ── Setup: create Alice, Bob, a team, and a project ───────────────
    //
    // We use the harness superuser for operations that regular users can't
    // perform (team_members insert). Alice owns the project; Bob is a member
    // who subscribes to SSE.
    const { client: aliceClient } = await seedUser(h, {
      email: 'alice@test.local',
      password: 'alice-password-123',
      name: 'Alice',
    });
    const { client: bobClient, record: bobRecord } = await seedUser(h, {
      email: 'bob@test.local',
      password: 'bob-password-123',
      name: 'Bob',
    });

    // Alice creates the team. The registerTeamAutoAdmin hook fires on
    // OnRecordCreateRequest and inserts an admin team_members row for
    // Alice — we rely on that here rather than manually seeding it.
    const team = await seedTeam(aliceClient, 'test-team');

    // Bob's membership must be inserted by the superuser: regular users
    // can't write team_members directly (see migration rules).
    await addTeamMember(h, team.id, bobRecord.id, 'member');

    // The project's `doc` is the canonical initial Project shape from
    // the store. We keep the name short so the replace-op assertion is
    // easy to read.
    const project = await seedProject(aliceClient, team.id, { name: 'p' });

    // ── Bob subscribes: promise resolves on the matching patch ───────
    //
    // We resolve on the FIRST patch whose project matches ours so the
    // promise isn't fooled by any unrelated SSE chatter.
    let bobReceivedOps: unknown = null;
    const bobGotPatch = new Promise<void>((resolve) => {
      bobClient
        .collection('patches')
        .subscribe('*', (e) => {
          if (e.action !== 'create') return;
          // Cast via `unknown` because PocketBase's generic RecordModel
          // doesn't expose our custom columns; we know the shape from
          // the `patches` collection migration.
          const rec = e.record as unknown as { project: string; ops: unknown };
          if (rec.project !== project.id) return;
          bobReceivedOps = rec.ops;
          resolve();
        })
        .catch(() => {
          // subscribe() returning a rejected promise means SSE couldn't
          // open at all — the 5s timeout below will surface the problem.
        });
    });

    // Small delay so the SSE subscription is definitely registered on
    // the server before Alice's POST fires and broadcasts. Without this,
    // the race window is narrow but non-zero on slow CI.
    await new Promise((r) => setTimeout(r, 300));

    // ── Alice POSTs a patch through the real /api/sp/patch route ─────
    const postRes = await fetch(`${h.baseUrl}/api/sp/patch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceClient.authStore.token}`,
      },
      body: JSON.stringify({
        projectId: project.id,
        fromRevision: 0,
        ops: [{ op: 'replace', path: '/name', value: 'updated' }],
      }),
    });
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as { newRevision: number };
    expect(postBody.newRevision).toBe(1);

    // ── Assert Bob's subscription fired with the expected ops ────────
    //
    // Promise.race against a 5s timeout — the spec budget for "feels
    // live" is well under this; we use the full 5s to absorb CI jitter.
    await Promise.race([
      bobGotPatch,
      new Promise<void>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Bob did not receive patch within 5s')), 5000),
      ),
    ]);

    expect(bobReceivedOps).toEqual([
      { op: 'replace', path: '/name', value: 'updated' },
    ]);

    // Clean up the SSE subscription so the afterAll SIGTERM doesn't
    // leave an orphaned socket pumping into a closed runner.
    bobClient.collection('patches').unsubscribe('*');
  }, 30_000);

  it('stale fromRevision returns 409 with currentDoc', async () => {
    // ── Fresh project, independent from the first test ───────────────
    //
    // Create a new user + team + project so this test's state is fully
    // isolated from the SSE test above. (The shared server instance is
    // fine; shared in-memory client bindings aren't.)
    const { client: aliceClient } = await seedUser(h, {
      name: 'Alice-409',
    });
    const team = await seedTeam(aliceClient);
    const project = await seedProject(aliceClient, team.id, {
      name: 'conflict-test',
    });

    // ── POST with a wildly stale fromRevision ─────────────────────────
    //
    // fromRevision: 7 against a fresh project (current revision 0) will
    // trip the OCC check in patch.go. We expect 409 with the structured
    // payload — not just any 4xx — because the client's ConflictModal
    // depends on `currentDoc` and `currentRevision`.
    const postRes = await fetch(`${h.baseUrl}/api/sp/patch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aliceClient.authStore.token}`,
      },
      body: JSON.stringify({
        projectId: project.id,
        fromRevision: 7,
        ops: [{ op: 'replace', path: '/name', value: 'stale' }],
      }),
    });
    expect(postRes.status).toBe(409);
    const body = (await postRes.json()) as {
      currentRevision: number;
      currentDoc: { name: string };
    };
    expect(body.currentRevision).toBe(0);
    expect(body.currentDoc.name).toBe('conflict-test');
  }, 15_000);
});

// When gated off, emit a placeholder so vitest doesn't report "no tests
// in file" (which some configs treat as an error). The assertion is
// deliberately trivial — the skip message in the describe name is what
// an engineer sees when they wonder why this file "passed" without
// doing anything.
describe.skipIf(GATED)('two-client sync (gated — set RUN_INTEGRATION=1 to run)', () => {
  it('skipped by default; run with RUN_INTEGRATION=1 npm run test:integration', () => {
    expect(true).toBe(true);
  });
});
