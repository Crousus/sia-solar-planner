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
// storeHarness — mounts `useProjectStore` + `SyncClient` against a real
// PocketBase instance for store-level integration tests.
//
// The central challenge: `createSyncClient` imports the app-global `pb`
// singleton from `backend/pb.ts` (which defaults to base URL '/') and calls
// `fetch('/api/sp/patch', ...)` with a relative URL. Both of these are
// designed for a browser context (same-origin, Vite proxy). In the Vitest
// jsdom environment there's no origin, so we need to:
//
//   1. Redirect the global `pb` singleton to the test PB base URL and
//      copy the test user's auth token into it. This is done by directly
//      setting `pb.baseUrl` and calling `pb.authStore.save(token, record)`.
//      After this, `pb.collection(…).getOne(…)` calls from `syncClient`
//      land on the test server.
//
//   2. Wrap `globalThis.fetch` to prefix relative URLs that start with
//      `/api/` with the test PB base URL. This makes the `fetch('/api/sp/patch')`
//      call in `syncClient.flush()` reach the correct test server.
//      We restore the original fetch in `cleanup()`.
//
// Why we mutate the global singleton instead of passing a PB instance:
//   `createSyncClient` is a factory function with no dependency-injection
//   seam for the PB client — it's a module-level import of the singleton.
//   Changing that signature would be a non-trivial refactor touching the
//   production code path and is out of scope here. Mutating the singleton
//   is safe in tests because:
//     - The integration config uses pool:'forks' + fileParallel:false,
//       so each test FILE runs in its own Node process with its own module
//       registry — no cross-file clobbering.
//     - `cleanup()` restores the singleton's state after each test case.
// ────────────────────────────────────────────────────────────────────────────

import type PocketBase from 'pocketbase';
import type { Project } from '../../types';
import { useProjectStore } from '../../store/projectStore';
import { createSyncClient, type SyncClient } from '../../backend/syncClient';
// Import the app's global pb singleton — we'll redirect it to the test server.
import { pb } from '../../backend/pb';

/** What `mountStoreClient` returns. */
export interface StoreMountResult {
  /** The store singleton — already loaded with `initialDoc`. */
  store: typeof useProjectStore;
  /** The running SyncClient. */
  syncClient: SyncClient;
  /** Stop the SyncClient, clear localStorage, and restore the global pb
   *  singleton and fetch to their pre-test state. */
  cleanup(): Promise<void>;
}

/**
 * Mount `useProjectStore` + `SyncClient` wired to the given PocketBase
 * client and project.
 *
 * Call this inside `beforeEach` (or at the top of a test) and call
 * `cleanup()` in `afterEach`. Do not share a mount result across tests —
 * the store is a singleton and the SyncClient holds live SSE connections.
 */
export async function mountStoreClient(opts: {
  /** Authenticated PocketBase client for the test user. Used to copy
   *  base URL and auth token into the global `pb` singleton. */
  userPb: PocketBase;
  projectId: string;
  initialDoc: Project;
}): Promise<StoreMountResult> {
  const { userPb, projectId, initialDoc } = opts;

  // ── Step 1: redirect the global pb singleton ──────────────────────────
  //
  // We snapshot the old values so cleanup() can restore them exactly.
  // `pb.baseUrl` is a read/write string property on the PocketBase class.
  // `pb.authStore.token` is the current raw JWT (may be '' before auth).
  const prevBaseUrl = pb.baseUrl;
  const prevToken = pb.authStore.token;
  // The authStore record (user shape). Cast to `unknown` because the SDK
  // types differ slightly between the app's declaration and the actual
  // runtime shape — we just need to save/restore it verbatim.
  const prevRecord = pb.authStore.record;

  // Point the global singleton at the test server and inject the test
  // user's credentials. After this, every `pb.collection(…)` call in
  // syncClient reaches the test PB.
  pb.baseUrl = userPb.baseUrl;
  pb.authStore.save(userPb.authStore.token, userPb.authStore.record);

  // ── Step 2: wrap globalThis.fetch to make relative URLs absolute ──────
  //
  // `syncClient.flush()` calls `fetch('/api/sp/patch', …)` with a
  // relative URL. In jsdom there's no "current origin" to resolve it
  // against, so the request would fail with a TypeError. We intercept
  // fetch and prefix `/api/` paths with the test base URL.
  //
  // We only prefix truly-relative paths (starting with '/') — absolute
  // URLs from other code paths pass through unchanged.
  const originalFetch = globalThis.fetch;
  const testBaseUrl = userPb.baseUrl;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return originalFetch(testBaseUrl + input, init);
    }
    return originalFetch(input, init);
  };

  // ── Step 3: seed the store with the initial document ──────────────────
  //
  // `loadProject` is the store's authoritative entry point for hydrating
  // a project — it runs migrateProject and resets all ephemeral UI state.
  // We do NOT call `resetProject` here because that would clobber the
  // project we're about to load.
  useProjectStore.getState().loadProject(initialDoc);

  // ── Step 4: start the SyncClient ─────────────────────────────────────
  //
  // `start()` performs an initial `getOne` fetch (to establish lastSyncedDoc
  // and lastKnownRevision) and subscribes to the SSE channel. We await it
  // so the harness is fully ready before any test assertion runs.
  const syncClient: SyncClient = createSyncClient(projectId);
  await syncClient.start();

  return {
    store: useProjectStore,
    syncClient,
    async cleanup() {
      // Stop the SyncClient (kills the SSE subscription and debounce timer).
      syncClient.stop();
      // Wait a tick so any in-flight async work (e.g., a delayed retry
      // timer that fires synchronously) settles before we restore state.
      await new Promise((r) => setTimeout(r, 0));
      // Clear localStorage so the persist middleware doesn't bleed
      // project state from one test into the next.
      localStorage.clear();
      // Reset the store back to its blank initial state.
      useProjectStore.getState().resetProject();
      // Restore the global pb singleton.
      pb.baseUrl = prevBaseUrl;
      pb.authStore.save(prevToken, prevRecord);
      // Restore the original fetch.
      globalThis.fetch = originalFetch;
    },
  };
}
