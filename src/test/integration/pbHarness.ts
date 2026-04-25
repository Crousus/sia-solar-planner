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
// pbHarness — bootstrap and teardown helpers for integration tests.
//
// Extracts the boot/teardown logic that was previously duplicated inside
// `src/backend/sync.integration.test.ts` into a reusable module. Every
// integration test file that needs a real PocketBase instance calls
// `bootPocketBase()` in its `beforeAll` and stores the returned `PbHarness`.
//
// Design notes:
//   - Each test FILE gets its own PB subprocess on a random port. This
//     prevents cross-file state pollution even when tests run in parallel
//     (though vitest.integration.config.ts sets fileParallel:false for
//     simplicity; the isolation is still good practice for correctness).
//   - A fresh tempdir per invocation means migrations are always run from
//     scratch, which catches any migration regressions automatically.
//   - Superuser credentials are local to the tempdir and discarded when
//     the tempdir is cleaned up — they never touch production data.
//
// ── Tempdir layout and the migrations path problem ────────────────────────
//
// The jsvm plugin (which loads our JS migrations) resolves `MigrationsDir`
// as `filepath.Join(app.DataDir(), "../pb_migrations")`. When the server
// runs in production (`./pocketbase serve`), DataDir defaults to
// `./pb_data/`, so migrations are found at `./pb_migrations/` — the
// sibling directory in `server/`.
//
// When running with `--dir=/tmp/sp-it-xxx`, DataDir returns the absolute
// tempdir path and migrations would be expected at `/tmp/pb_migrations/`,
// which doesn't exist. Migrations never run, all custom collections are
// absent, and every test call that touches `teams`, `projects`, etc. gets
// 404.
//
// Fix: structure the tempdir as:
//   /tmp/sp-it-xxx/
//     pb_data/         ← pass as --dir (becomes DataDir)
//     pb_migrations/   ← symlink to the real server/pb_migrations
//
// With this layout, `../pb_migrations` relative to `pb_data/` resolves to
// the symlinked migrations directory, and all JS migrations run on boot.
// ────────────────────────────────────────────────────────────────────────────

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import PocketBase from 'pocketbase';

/** Path to the PocketBase binary. Resolved relative to the project root
 *  (process.cwd() in a Vitest worker is the project root). */
const PB_BINARY = join(process.cwd(), 'server', 'pocketbase');

/** The real migrations directory (server/pb_migrations next to the binary). */
const PB_MIGRATIONS_REAL = resolve(process.cwd(), 'server', 'pb_migrations');

/** Superuser credentials used for the test run.
 *  They live inside a tempdir that's wiped in stop(), so there's no leak. */
const SUPERUSER_EMAIL = 'super@test.local';
const SUPERUSER_PASSWORD = 'super-test-password-123';

/** The public surface of a running test PocketBase instance. */
export interface PbHarness {
  /** HTTP base URL, e.g. "http://127.0.0.1:18234". */
  baseUrl: string;
  /** An authenticated PocketBase client with full superuser access.
   *  Use this for seeding data that regular user rules block. */
  superuser: PocketBase;
  /** Kill the PB subprocess and clean up the tempdir. */
  stop(): Promise<void>;
}

/**
 * Poll /api/health until PocketBase answers 200 or we time out.
 *
 * The PB serve cycle is: bind port → open DB → run migrations → accept HTTP.
 * We don't know a priori how long migrations take on a fresh dir, so a
 * generous 15s ceiling with 200ms polling is a pragmatic compromise. 15s
 * is more generous than 10s because the jsvm migration runner parses all
 * 15 JS files on a cold dir.
 */
async function waitForReady(url: string, timeoutMs = 15_000): Promise<void> {
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

/**
 * Spawn a fresh PocketBase instance and wait until it is ready to accept
 * requests. Returns a `PbHarness` with the base URL, an authenticated
 * superuser client, and a `stop()` function for teardown.
 *
 * Pre-flight: throws immediately if `server/pocketbase` binary doesn't exist.
 * Build it with: `(cd server && go build -o pocketbase .)`
 */
export async function bootPocketBase(): Promise<PbHarness> {
  // Pre-flight check — give a clear error message before any subprocess
  // spawn. Without this, the spawn itself would fail with ENOENT, which
  // is much harder to diagnose.
  if (!existsSync(PB_BINARY)) {
    throw new Error(
      'Run (cd server && go build -o pocketbase .) before integration tests',
    );
  }

  // ── Tempdir layout ──────────────────────────────────────────────────────
  //
  // Structure: rootDir/pb_data (DataDir) + rootDir/pb_migrations (symlink).
  // See the module header for why this layout is required.
  const rootDir = mkdtempSync(join(tmpdir(), 'sp-it-'));
  const dataDir = join(rootDir, 'pb_data');
  mkdirSync(dataDir, { recursive: true });

  // Symlink the real migrations into the layout position expected by the
  // jsvm plugin. A symlink (not a copy) ensures the test always runs the
  // current migrations from the working tree — no stale copy risk.
  symlinkSync(PB_MIGRATIONS_REAL, join(rootDir, 'pb_migrations'));

  const port = 18000 + Math.floor(Math.random() * 2000);
  const baseUrl = `http://127.0.0.1:${port}`;

  // Bootstrap the superuser BEFORE `serve` so the first HTTP request
  // can authenticate as an admin. `pocketbase superuser upsert` is
  // idempotent — it creates the row on a cold dir and errors with
  // "already exists" on warm ones, either of which is fine here.
  //
  // We pass `--dir=<dataDir>` (the pb_data subdirectory). The binary's
  // cwd is `server/` so relative path resolution for the binary itself
  // works. The `--dir` path is absolute so there's no ambiguity.
  const create = spawnSync(
    './pocketbase',
    ['superuser', 'upsert', SUPERUSER_EMAIL, SUPERUSER_PASSWORD, `--dir=${dataDir}`],
    { cwd: 'server', encoding: 'utf-8' },
  );
  if (create.status !== 0) {
    // Clean up the tempdir we just created before throwing, so we don't
    // leave stray temp directories behind on every failing beforeAll.
    try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(
      `superuser create failed (exit ${create.status}):\n${create.stderr}\n${create.stdout}`,
    );
  }

  const pbProcess: ChildProcess = spawn(
    './pocketbase',
    ['serve', `--http=127.0.0.1:${port}`, `--dir=${dataDir}`],
    { cwd: 'server', stdio: 'pipe' },
  );
  // Surface PB stderr/stdout to the test runner. Without this, a startup
  // crash (e.g. port conflict, migration error) would just look like a
  // timeout on waitForReady.
  pbProcess.stderr?.on('data', (d: Buffer) => process.stderr.write(`[pb] ${d}`));
  pbProcess.stdout?.on('data', (d: Buffer) => process.stdout.write(`[pb] ${d}`));

  await waitForReady(baseUrl);

  // Authenticate the superuser client. We construct a fresh PocketBase
  // client (not the app's global singleton) so there's no risk of the
  // test harness clobbering the app's auth state.
  const superuser = new PocketBase(baseUrl);
  await superuser.collection('_superusers').authWithPassword(
    SUPERUSER_EMAIL,
    SUPERUSER_PASSWORD,
  );

  return {
    baseUrl,
    superuser,
    async stop() {
      pbProcess.kill('SIGTERM');
      // Best-effort tempdir cleanup; PocketBase may hold a file lock
      // briefly after SIGTERM so we ignore failures rather than fail
      // the afterAll hook and prevent subsequent test output.
      try {
        rmSync(rootDir, { recursive: true, force: true });
      } catch {
        // intentional: transient lock, cleared on OS temp sweep.
      }
    },
  };
}
