// ────────────────────────────────────────────────────────────────────────
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
// ────────────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PocketBase from 'pocketbase';

// Single env-var switch. `=== '1'` (not truthy) so "0", "false", or an
// accidentally-exported empty string don't flip the gate. CI defaults to
// unset → GATED === false → only the skipIf placeholder runs.
const GATED = process.env.RUN_INTEGRATION === '1';

// Superuser credentials used only for this test run — the tempdir holding
// the PB data is wiped in afterAll, so leaked credentials don't persist.
const SUPERUSER_EMAIL = 'super@test.local';
const SUPERUSER_PASSWORD = 'super-test-password-123';

const ALICE_EMAIL = 'alice@test.local';
const ALICE_PASSWORD = 'alice-password-123';

const BOB_EMAIL = 'bob@test.local';
const BOB_PASSWORD = 'bob-password-123';

// Module-scoped so afterAll can clean them up even if beforeAll throws
// partway through. Initialised to undefined and guarded with `?.` on
// teardown to stay safe when the spawn never succeeded.
let pbProcess: ChildProcess | undefined;
let pbBaseUrl = '';
let tempDir = '';

/**
 * Poll /api/health until PocketBase answers 200 or we time out. The PB
 * serve cycle is: bind port → open DB → run migrations → accept HTTP.
 * We don't know a priori how long migrations take on a fresh dir, so a
 * generous 10s ceiling with 200ms polling is a pragmatic compromise.
 */
async function waitForReady(url: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // ECONNREFUSED while the server is still starting — keep polling.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`PocketBase not ready at ${url} after ${timeoutMs}ms`);
}

describe.runIf(GATED)('two-client sync (integration)', () => {
  beforeAll(async () => {
    // A fresh tempdir per test run guarantees the PB data (including
    // migrations, superuser, and collections) is pristine. The random
    // port avoids collisions with a dev PB that a developer might have
    // running on the default 8090.
    tempDir = mkdtempSync(join(tmpdir(), 'sp-it-'));
    const port = 18000 + Math.floor(Math.random() * 1000);
    pbBaseUrl = `http://127.0.0.1:${port}`;

    // Bootstrap the superuser BEFORE `serve` so the first HTTP request
    // can authenticate as an admin. `pocketbase superuser create` is
    // idempotent — it creates the row on a cold dir and errors with
    // "already exists" on warm ones, either of which is fine here.
    const create = spawnSync(
      './pocketbase',
      ['superuser', 'upsert', SUPERUSER_EMAIL, SUPERUSER_PASSWORD, `--dir=${tempDir}`],
      { cwd: 'server', encoding: 'utf-8' },
    );
    if (create.status !== 0) {
      throw new Error(
        `superuser create failed (exit ${create.status}):\n${create.stderr}\n${create.stdout}`,
      );
    }

    pbProcess = spawn(
      './pocketbase',
      ['serve', `--http=127.0.0.1:${port}`, `--dir=${tempDir}`],
      { cwd: 'server', stdio: 'pipe' },
    );
    // Surface PB stderr to the test runner for debuggability — without
    // this, a startup crash would just look like a timeout on waitForReady.
    pbProcess.stderr?.on('data', (d) => console.error(`[pb] ${d}`));
    pbProcess.stdout?.on('data', (d) => console.log(`[pb] ${d}`));

    await waitForReady(pbBaseUrl);
  }, 30_000);

  afterAll(() => {
    pbProcess?.kill('SIGTERM');
    // Best-effort tempdir cleanup; PocketBase may hold a file lock
    // briefly after SIGTERM so ignore failures rather than fail teardown.
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // intentional: transient lock, cleared on OS temp sweep.
    }
  });

  it('patch from Alice appears on Bob within 5 seconds', async () => {
    // ── Setup: superuser creates users + a team + seeds a project ────
    //
    // We drive setup via the superuser client because the default rules
    // for some of these collections are strict (e.g., `team_members`
    // deliberately has no createRule so clients can't mint memberships
    // directly; it's seeded server-side via hook or, here, via admin).
    const superuser = new PocketBase(pbBaseUrl);
    await superuser.collection('_superusers').authWithPassword(
      SUPERUSER_EMAIL,
      SUPERUSER_PASSWORD,
    );

    // Create the two user records. `passwordConfirm` is required by
    // PocketBase's password validator — it matches the field name
    // defined on the auth collection's default password field.
    const alice = await superuser.collection('users').create({
      email: ALICE_EMAIL,
      password: ALICE_PASSWORD,
      passwordConfirm: ALICE_PASSWORD,
      name: 'Alice',
    });
    const bob = await superuser.collection('users').create({
      email: BOB_EMAIL,
      password: BOB_PASSWORD,
      passwordConfirm: BOB_PASSWORD,
      name: 'Bob',
    });

    // Two separate client instances so each keeps its own authStore —
    // mixing them into the same PocketBase instance would clobber the
    // bearer token on every authWithPassword call.
    const aliceClient = new PocketBase(pbBaseUrl);
    await aliceClient.collection('users').authWithPassword(ALICE_EMAIL, ALICE_PASSWORD);
    const bobClient = new PocketBase(pbBaseUrl);
    await bobClient.collection('users').authWithPassword(BOB_EMAIL, BOB_PASSWORD);

    // Alice creates the team. The registerTeamAutoAdmin hook fires on
    // OnRecordCreateRequest and inserts an admin team_members row for
    // Alice — we rely on that here rather than manually seeding it.
    const team = await aliceClient.collection('teams').create({
      name: 'test-team',
    });

    // Bob's membership must be inserted by the superuser: regular users
    // can't write team_members directly (see migration rules).
    await superuser.collection('team_members').create({
      user: bob.id,
      team: team.id,
      role: 'member',
    });

    // The project's `doc` is the canonical initial Project shape from
    // the local client. We keep it minimal — just enough to exercise a
    // replace op on `name`.
    const initialDoc = {
      name: 'p',
      buildings: [],
      panels: [],
      selection: null,
    };
    const project = await aliceClient.collection('projects').create({
      team: team.id,
      name: 'p',
      doc: initialDoc,
      revision: 0,
    });

    // ── Bob subscribes: promise resolves on the matching patch ───────
    //
    // We resolve on the FIRST patch whose project matches ours so the
    // promise isn't fooled by any unrelated SSE chatter (e.g., if two
    // tests shared state — not the case here, but defensive).
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
    const postRes = await fetch(`${pbBaseUrl}/api/sp/patch`, {
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
    // ── Fresh project, separate from the first test's state ─────────
    //
    // We re-bootstrap the superuser + Alice client to keep this test
    // independent of the first one's bindings. (The shared server
    // instance is fine; shared in-memory client state isn't, and
    // re-building clients is cheap relative to the network round-trips.)
    const superuser = new PocketBase(pbBaseUrl);
    await superuser.collection('_superusers').authWithPassword(
      SUPERUSER_EMAIL,
      SUPERUSER_PASSWORD,
    );
    const aliceClient = new PocketBase(pbBaseUrl);
    await aliceClient.collection('users').authWithPassword(ALICE_EMAIL, ALICE_PASSWORD);

    // Reuse Alice's team_members row from the first test (same user,
    // same server). But create a brand-new project so revision is 0.
    const teams = await aliceClient.collection('teams').getFullList();
    const team = teams[0];
    expect(team).toBeDefined();

    const initialDoc = {
      name: 'conflict-test',
      buildings: [],
      panels: [],
      selection: null,
    };
    const project = await aliceClient.collection('projects').create({
      team: team.id,
      name: 'conflict-test',
      doc: initialDoc,
      revision: 0,
    });

    // ── POST with a wildly stale fromRevision ─────────────────────────
    //
    // fromRevision: 7 against a fresh project (current revision 0) will
    // trip the OCC check in patch.go. We expect 409 with the structured
    // payload — not just any 4xx — because the client's ConflictModal
    // depends on `currentDoc` and `currentRevision`.
    const postRes = await fetch(`${pbBaseUrl}/api/sp/patch`, {
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
