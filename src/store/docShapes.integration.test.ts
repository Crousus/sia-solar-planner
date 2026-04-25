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
// docShapes.integration.test.ts — round-trip tests that exercise realistic
// store mutations through the full sync stack (store → SyncClient debounce
// → JSON Patch → /api/sp/patch → server `doc` column) and verify the
// server-side doc has the expected SHAPE.
//
// Companion to sync.integration.test.ts (which only exercises the simplest
// scalar field, project.name). These tests cover:
//
//   A) addRoof — pushes a non-trivial nested object (Roof with polygon
//      array) into doc.roofs.
//
//   B) Multi-op patch flow: addRoof + addPanel*4 + addString +
//      assignPanelsToString. All five mutations land within the same
//      debounce window, coalescing into a single JSON Patch with a mix
//      of add and replace ops. Asserts the server doc reflects every
//      entity AND that renumberStrings produced 1..N indexInString.
//
//   C) lockMap with a sizable capturedImage (~50 KB base64). PB's `doc`
//      column has a 20 MB limit (see the projects migration) so this
//      should comfortably round-trip; the test exists to catch
//      regressions where a copy/normalisation step truncates the field.
//
// Gated on RUN_INTEGRATION=1 with the same describe.runIf/skipIf pattern.
// To run:
//   (cd server && go build -o pocketbase .)
//   RUN_INTEGRATION=1 npm run test:integration
// ────────────────────────────────────────────────────────────────────────────

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootPocketBase, type PbHarness } from '../test/integration/pbHarness';
import { seedUser, seedTeam, seedProject } from '../test/integration/seed';
import { mountStoreClient, type StoreMountResult } from '../test/integration/storeHarness';
import { initialProject } from './projectStore';
import { migrateProject } from '../utils/projectSerializer';
import type { Project, Roof, Panel, PvString, MapStateLocked } from '../types';

const GATED = process.env.RUN_INTEGRATION === '1';

// ────────────────────────────────────────────────────────────────────────────
// Tiny polling helper — mirrors the one in sync.integration.test.ts. The
// 12-second default leaves headroom for the 2 s SyncClient debounce + a
// patch round-trip on slow CI; multi-op tests bump it further.
// ────────────────────────────────────────────────────────────────────────────
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts?: { timeout?: number; interval?: number },
): Promise<void> {
  const timeout = opts?.timeout ?? 12_000;
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

describe.runIf(GATED)('doc shape round-trips through sync', () => {
  beforeAll(async () => {
    h = await bootPocketBase();
  }, 30_000);

  afterAll(async () => {
    await h?.stop();
  });

  let mount: StoreMountResult | null = null;

  afterEach(async () => {
    await mount?.cleanup();
    mount = null;
    localStorage.clear();
  });

  // Build a properly-shaped initial Project via migrateProject so the
  // server-side ops (which JSON-Patch into a fully-formed doc) never
  // hit "missing field" surprises. Defensive: addRoof, addPanel etc.
  // happen against the live store which seeds from this same shape.
  function makeInitialDoc(name: string): Project {
    return migrateProject({ ...initialProject, name });
  }

  // ── Test A: addRoof ────────────────────────────────────────────────────
  //
  // addRoof is a record-policy action that appends to project.roofs and
  // selects the new roof. Its diff against the pre-action doc is a single
  // add op at /roofs/N. After the SyncClient flushes, the server's doc.roofs
  // should contain the roof with the expected polygon, tilt, and
  // orientation defaults (tiltDeg: 30, panelOrientation: 'portrait' —
  // see addRoof's implementation for the rationale).
  it('addRoof through the store action shows up in server doc.roofs', async () => {
    const { client: userPb } = await seedUser(h);
    const team = await seedTeam(userPb);
    const initialDoc = makeInitialDoc('addRoof-doc-shape');
    const project = await seedProject(userPb, team.id, initialDoc);

    mount = await mountStoreClient({
      userPb,
      projectId: project.id,
      initialDoc,
    });
    const { store } = mount;

    // Realistic-ish polygon: a square 200×200 px in canvas coordinates,
    // offset from origin so it's not at (0,0). Numbers chosen so a
    // human reading the assertion can immediately see the shape.
    const polygon = [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 300 },
      { x: 100, y: 300 },
    ];
    const newRoofId = store.getState().addRoof(polygon);
    expect(newRoofId).toBeTruthy();

    // Wait for the server to reflect doc.roofs[0]. We poll the project
    // record (NOT the local store) so we know the round-trip completed.
    await waitFor(async () => {
      const rec = await userPb
        .collection('projects')
        .getOne<{ doc: { roofs: Roof[] } }>(project.id);
      return rec.doc.roofs.length === 1;
    });

    // Final read for the structural assertion.
    const rec = await userPb
      .collection('projects')
      .getOne<{ doc: { roofs: Roof[] }; revision: number }>(project.id);
    expect(rec.revision).toBe(1); // single record-action ⇒ single patch
    expect(rec.doc.roofs).toHaveLength(1);

    const persistedRoof = rec.doc.roofs[0];
    expect(persistedRoof.id).toBe(newRoofId);
    // addRoof's defaults — locking these in here means a future change
    // to the defaults will surface as a test failure rather than as
    // surprise data showing up on the server.
    expect(persistedRoof.tiltDeg).toBe(30);
    expect(persistedRoof.panelOrientation).toBe('portrait');
    expect(persistedRoof.polygon).toEqual(polygon);
    // name uses the "Roof N" auto-numbering convention (length+1 at the
    // moment of add — first roof on a project ⇒ "Roof 1").
    expect(persistedRoof.name).toBe('Roof 1');
  }, 30_000);

  // ── Test B: multi-action coalesced patch ──────────────────────────────
  //
  // Drive a typical user gesture sequence rapidly so they all land within
  // the SyncClient's 2-second debounce window:
  //
  //   1. addRoof          → doc.roofs[0]
  //   2. addPanel * 4     → doc.panels[0..3]  (same groupId)
  //   3. addString        → doc.strings[0]
  //   4. assignPanelsToString(panel-ids, string-id)
  //                       → doc.panels[*].stringId = string-id
  //                          renumberStrings rewrites indexInString to 1..4
  //
  // All five actions execute synchronously in the test body, so the
  // store's subscribe callback fires multiple times BUT the debounce
  // resets each time — net result is one POST after ~2 s of quiet,
  // carrying the full diff. We assert:
  //   - revision advances to 1 (one patch, not five).
  //   - doc.panels has 4 entries, each with stringId set to the new
  //     string and indexInString in [1..4] — proving renumberStrings
  //     ran on the server-stored doc as a consequence of the local
  //     mutations (not via a separate server-side computation).
  //
  // Insertion order matters: we paint panels in a deliberate order
  // (top→bottom of cy) and assign in that same order, so indexInString
  // 1..4 should follow the addPanel sequence (renumberStrings respects
  // the insertionOrder argument that assignPanelsToString supplies).
  it('multi-action gesture coalesces into a single patch with consistent string numbering', async () => {
    const { client: userPb } = await seedUser(h);
    const team = await seedTeam(userPb);
    const initialDoc = makeInitialDoc('multi-action-doc');
    const project = await seedProject(userPb, team.id, initialDoc);

    mount = await mountStoreClient({
      userPb,
      projectId: project.id,
      initialDoc,
    });
    const { store } = mount;

    // 1. roof
    const roofId = store.getState().addRoof([
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: 400 },
      { x: 0, y: 400 },
    ]);

    // 2. four panels in the same group, placed in a column. Real
    // placement would go through snapPanelToGrid; we bypass that here
    // because this test isn't about geometry — it's about doc round-trip.
    // Centers are well inside the polygon (which is 400×400) so even if
    // a future regression starts validating bounds inside addPanel,
    // these positions remain valid.
    const groupId = 'test-group-1';
    const panelPositions = [
      { cx: 100, cy: 100 },
      { cx: 100, cy: 200 },
      { cx: 100, cy: 300 },
      { cx: 200, cy: 100 },
    ];
    for (const { cx, cy } of panelPositions) {
      store.getState().addPanel(roofId, cx, cy, groupId, 'portrait');
    }

    // 3. string
    const stringId = store.getState().addString();

    // 4. snapshot the panel ids in placement order, then assign. The
    // panelIds order is the insertionOrder argument that
    // renumberStrings receives — so indexInString 1..4 should map to
    // the same order we list here.
    const panelIdsInOrder = store
      .getState()
      .project.panels.filter((p) => p.groupId === groupId)
      .map((p) => p.id);
    expect(panelIdsInOrder).toHaveLength(4);
    store.getState().assignPanelsToString(panelIdsInOrder, stringId);

    // Wait for the server's doc to reflect the full gesture. The flush
    // fires once, ~2 s after the last action — we wait until the panels
    // array reaches length 4 AND every entry has the correct stringId.
    await waitFor(async () => {
      const rec = await userPb
        .collection('projects')
        .getOne<{ doc: Project }>(project.id);
      const panels = rec.doc.panels;
      return (
        panels.length === 4 &&
        panels.every((p) => p.stringId === stringId)
      );
    }, { timeout: 15_000 });

    const rec = await userPb
      .collection('projects')
      .getOne<{ doc: Project; revision: number }>(project.id);

    // Coalescence assertion: 5 store actions → 1 patch → revision 1.
    // If the debounce broke and each action POSTed individually, this
    // would be 5. (Strict equality rather than .toBeLessThan(5) so the
    // assertion is unambiguous — we want exactly one patch.)
    expect(rec.revision).toBe(1);

    // Structural assertions on the round-tripped doc.
    expect(rec.doc.roofs).toHaveLength(1);
    expect(rec.doc.roofs[0].id).toBe(roofId);
    expect(rec.doc.strings).toHaveLength(1);
    expect(rec.doc.strings[0].id).toBe(stringId);
    expect(rec.doc.panels).toHaveLength(4);

    // Index-by-id so the indexInString assertions don't depend on
    // doc.panels being in any particular order (the patch flow
    // preserves insertion order, but asserting via id makes the test
    // robust to a future refactor that re-shuffles the array).
    const byId = new Map<string, Panel>(
      rec.doc.panels.map((p) => [p.id, p as Panel]),
    );
    panelIdsInOrder.forEach((pid, i) => {
      const p = byId.get(pid);
      expect(p, `panel ${pid} missing from server doc`).toBeDefined();
      expect(p!.stringId).toBe(stringId);
      // 1-based: first painted = index 1.
      expect(p!.indexInString).toBe(i + 1);
      // Every panel keeps its assigned roof and group.
      expect(p!.roofId).toBe(roofId);
      expect(p!.groupId).toBe(groupId);
    });

    // Sanity: the string entity is well-formed (label auto-numbered,
    // a color from STRING_COLORS palette, inverterId null because no
    // inverter was selected at addString time).
    const persistedString = rec.doc.strings[0] as PvString;
    expect(persistedString.label).toBe('String 1');
    expect(persistedString.inverterId).toBeNull();
    expect(persistedString.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  }, 40_000);

  // ── Test C: lockMap with a sizable capturedImage payload ──────────────
  //
  // The capturedImage field on a locked MapState is a base64 PNG
  // dataURL. Real captures from html2canvas at typical zoom levels run
  // 50-300 KB. The projects.doc column allows up to 20 MB (see
  // 1712345700_projects_patches.js), so this should round-trip without
  // truncation.
  //
  // We use 'A'.repeat(50_000) as a synthetic stand-in. The test isn't
  // about image content — it's about the WIRE LAYER: that
  // /api/sp/patch's body parser, fast-json-patch's apply, the
  // server-side json marshalling, and the SDK's getOne deserialisation
  // all preserve a long string field byte-for-byte.
  //
  // If PB's column limit ever shrinks below this size, the test
  // surfaces it as a real bug — production map captures would also be
  // truncated.
  it('lockMap persists a large capturedImage through the patch round-trip', async () => {
    const { client: userPb } = await seedUser(h);
    const team = await seedTeam(userPb);
    const initialDoc = makeInitialDoc('lockmap-doc');
    const project = await seedProject(userPb, team.id, initialDoc);

    mount = await mountStoreClient({
      userPb,
      projectId: project.id,
      initialDoc,
    });
    const { store } = mount;

    // ~50 KB synthetic payload. We use a non-degenerate string — a long
    // run of 'A's followed by a small distinguishing suffix — so the
    // assertion can verify both length and content (a length-only check
    // would miss a substring-truncation bug).
    const sentinelSuffix = 'TEST_SENTINEL_END';
    const capturedImage = 'A'.repeat(50_000) + sentinelSuffix;

    store.getState().lockMap({
      centerLat: 48.137,
      centerLng: 11.575,
      zoom: 19,
      mpp: 0.1,
      capturedImage,
      capturedWidth: 1024,
      capturedHeight: 768,
    });

    // Wait for the server to reflect the locked state. We poll for
    // mapState.locked === true rather than checking length first
    // because a serialisation bug that drops capturedImage entirely
    // would still flip locked=true — and we want to assert the FULL
    // shape, not just the boolean.
    await waitFor(async () => {
      const rec = await userPb
        .collection('projects')
        .getOne<{ doc: Project }>(project.id);
      return rec.doc.mapState.locked === true;
    }, { timeout: 15_000 });

    const rec = await userPb
      .collection('projects')
      .getOne<{ doc: Project; revision: number }>(project.id);
    expect(rec.revision).toBe(1);

    const ms = rec.doc.mapState;
    expect(ms.locked).toBe(true);
    // Narrow to the locked variant for the structural assertions. The
    // type guard is via the discriminated union — once `ms.locked` is
    // true, TS knows it's MapStateLocked.
    if (!ms.locked) throw new Error('expected locked map state'); // unreachable
    const locked = ms as MapStateLocked;

    // Byte-exact preservation: matches both length and content.
    expect(locked.capturedImage.length).toBe(capturedImage.length);
    expect(locked.capturedImage).toBe(capturedImage);
    // Sanity on the surrounding scalar fields — they all share the
    // same JSON column, so a truncation bug typically affects all of
    // them; checking these guards against a regression where the
    // limit is enforced per-field rather than per-doc.
    expect(locked.capturedWidth).toBe(1024);
    expect(locked.capturedHeight).toBe(768);
    expect(locked.metersPerPixel).toBe(0.1);
    expect(locked.centerLat).toBeCloseTo(48.137);
    expect(locked.centerLng).toBeCloseTo(11.575);
    expect(locked.zoom).toBe(19);
  }, 40_000);
});

// When gated off, emit a placeholder so vitest doesn't warn "no tests in file".
describe.skipIf(GATED)(
  'doc shape round-trips through sync (gated — set RUN_INTEGRATION=1 to run)',
  () => {
    it('skipped by default; run with RUN_INTEGRATION=1 npm run test:integration', () => {
      expect(true).toBe(true);
    });
  },
);
