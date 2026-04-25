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
// vitest.integration.config.ts — Vitest config for integration tests.
//
// Separate from the main vitest.config.ts so that:
//   - `npm run test:run` (unit tests) never picks up *.integration.test.ts.
//   - `npm run test:integration` can set longer timeouts, pool isolation,
//     and a setup file that installs the EventSource polyfill — none of which
//     are appropriate for fast unit runs.
//
// Key choices:
//   - environment: 'jsdom'  — PocketBase SDK uses DOM APIs (EventSource,
//     localStorage). Matches the unit test config for consistency.
//   - setupFiles: eventsource-polyfill is listed BEFORE test-setup.ts so
//     `globalThis.EventSource` is installed before any module-level import
//     of `pocketbase` fires its SSE machinery.
//   - pool: 'forks' — each test file runs in its own Node process so
//     module-level singletons (pb, useProjectStore) are isolated between
//     files. 'threads' would share the module registry across files, which
//     breaks the global-pb-mutation approach in storeHarness.
//   - fileParallelism: false — each file boots its own PocketBase subprocess
//     on a random port; running files in parallel is safe but wastes memory
//     and makes test output harder to read. Keeping it sequential is the
//     pragmatic default; flip to true if the file count grows.
//   - testTimeout / hookTimeout: 30s each. PocketBase startup + migrations
//     + SSE round-trip can take 5-15 s; the generous budget absorbs CI jitter
//     without hanging indefinitely on real failures.
// ────────────────────────────────────────────────────────────────────────────

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: [
      // Install EventSource polyfill FIRST — before pocketbase is imported.
      './src/test/integration/eventsource-polyfill.ts',
      // Then the shared test setup (currently a no-op shim, but kept for
      // parity with unit tests in case it gains content later).
      './src/test-setup.ts',
    ],
    include: ['**/*.integration.test.ts'],
    // Exclude worktree directories — those are separate git worktrees with
    // their own dependencies and test configurations. Including them here
    // would boot extra PocketBase subprocesses and likely fail because the
    // worktree may have different migration states or source files.
    exclude: ['.worktrees/**', 'node_modules/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
