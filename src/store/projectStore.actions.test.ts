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
// projectStore action-semantics tests.
//
// projectStore.undo.test.ts covers the undo/redo machinery (history stack,
// coalescing, bypass classification). This sister file covers the WHAT —
// the actual data transformations each action makes:
//
//   - addRoof:            creates a roof, auto-numbers, selects it.
//   - splitRoof:          produces two polygons; survivor is the panel-
//                         heavy half; new roof inherits tilt/orientation.
//   - mergeRoofs:         survivor = larger area; absorbed roof's panels
//                         re-keyed; absorbed roof removed.
//   - assignPanelsToString: panels get sequential 1-based indexInString
//                         in paint order (renumberStrings invariant).
//   - addInverter / deleteInverter
//   - addString / deleteString: deleting a string leaves panels alive but
//                         unassigned (deliberately — the user typically
//                         wants to regroup, not lose panels).
//   - applyRemotePatch:   classified bypass — no undo stack entry.
//
// Tests reset the store via resetProject() in beforeEach so module
// singleton state from prior tests doesn't leak in.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectStore } from './projectStore';

// Convenience accessors so the test bodies stay terse.
const store = () => useProjectStore.getState();

const SQUARE = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

beforeEach(() => {
  store().resetProject();
});

// ── addRoof ───────────────────────────────────────────────────────────────

describe('addRoof', () => {
  it('appends a roof, auto-names it "Roof N", and selects it', () => {
    const id = store().addRoof(SQUARE);
    const project = store().project;
    expect(project.roofs).toHaveLength(1);
    expect(project.roofs[0].id).toBe(id);
    expect(project.roofs[0].name).toBe('Roof 1');
    expect(store().selectedRoofId).toBe(id);
  });

  it('numbers subsequent roofs sequentially', () => {
    store().addRoof(SQUARE);
    store().addRoof(SQUARE);
    expect(store().project.roofs.map((r) => r.name)).toEqual(['Roof 1', 'Roof 2']);
  });
});

// ── splitRoof ─────────────────────────────────────────────────────────────

describe('splitRoof', () => {
  it('returns false and leaves the store unchanged when the cut is invalid', () => {
    const id = store().addRoof(SQUARE);
    const before = store().project.roofs.length;
    // A cut whose endpoints don't touch the polygon boundary is rejected
    // by splitPolygon → store stays as-is.
    const ok = store().splitRoof(id, [
      { x: 50, y: 50 },
      { x: 60, y: 60 },
    ]);
    expect(ok).toBe(false);
    expect(store().project.roofs).toHaveLength(before);
  });

  it('produces two roofs from a valid cut and inherits tilt + orientation', () => {
    const id = store().addRoof(SQUARE);
    store().updateRoof(id, { tiltDeg: 35, panelOrientation: 'landscape' });
    // Vertical cut down the middle of the 100×100 square: endpoints sit
    // exactly on the top and bottom edges.
    const ok = store().splitRoof(id, [
      { x: 50, y: 0 },
      { x: 50, y: 100 },
    ]);
    expect(ok).toBe(true);
    const roofs = store().project.roofs;
    expect(roofs).toHaveLength(2);
    // Both halves keep the original tilt and orientation.
    for (const r of roofs) {
      expect(r.tiltDeg).toBe(35);
      expect(r.panelOrientation).toBe('landscape');
    }
  });
});

// ── mergeRoofs ────────────────────────────────────────────────────────────

describe('mergeRoofs', () => {
  it('is a no-op when the two roofs do not share an edge', () => {
    const a = store().addRoof([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    const b = store().addRoof([
      { x: 100, y: 100 },
      { x: 110, y: 100 },
      { x: 110, y: 110 },
      { x: 100, y: 110 },
    ]);
    const before = store().project.roofs.length;
    store().mergeRoofs(a, b);
    expect(store().project.roofs).toHaveLength(before);
  });

  it('merges two adjacent roofs — survivor is the larger area', () => {
    // Roof A is 10×10 at the origin; roof B is a smaller 10×4 sitting
    // directly above it (sharing the (0,10)→(10,10) edge). After merge
    // we expect ONE roof remaining (the larger A) and the absorbed B's
    // id to be gone.
    const a = store().addRoof([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    const b = store().addRoof([
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 14 },
      { x: 0, y: 14 },
    ]);
    store().mergeRoofs(a, b);
    const roofs = store().project.roofs;
    expect(roofs).toHaveLength(1);
    expect(roofs[0].id).toBe(a); // larger-area survivor
  });

  it("re-keys the absorbed roof's panels onto the survivor", () => {
    const a = store().addRoof([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    const b = store().addRoof([
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 14 },
      { x: 0, y: 14 },
    ]);
    // Place a panel on B; after merge its roofId must point to A.
    store().addPanel(b, 5, 12, 'g1', 'portrait');
    store().mergeRoofs(a, b);
    const panels = store().project.panels;
    expect(panels).toHaveLength(1);
    expect(panels[0].roofId).toBe(a);
  });
});

// ── assignPanelsToString + renumberStrings ───────────────────────────────

describe('assignPanelsToString + renumberStrings', () => {
  it('numbers panels 1..N in paint order (the panelIds argument order)', () => {
    // Place three panels on one roof, in arbitrary geometric positions.
    // Then assign them to a single string in a SPECIFIC order via
    // panelIds — that order must drive indexInString, not (cx, cy).
    const r = store().addRoof(SQUARE);
    store().addPanel(r, 50, 50, 'g1', 'portrait');
    store().addPanel(r, 10, 10, 'g1', 'portrait');
    store().addPanel(r, 30, 30, 'g1', 'portrait');
    const [p1, p2, p3] = store().project.panels;
    const sid = store().addString();

    // Assign in order p2, p3, p1 — first painted should win index 1.
    store().assignPanelsToString([p2.id, p3.id, p1.id], sid);

    const panelById = (id: string) => store().project.panels.find((p) => p.id === id)!;
    expect(panelById(p2.id).indexInString).toBe(1);
    expect(panelById(p3.id).indexInString).toBe(2);
    expect(panelById(p1.id).indexInString).toBe(3);
    // All three are now members of the target string.
    for (const p of store().project.panels) {
      expect(p.stringId).toBe(sid);
    }
  });

  it('moving a panel from string A to string B clears its old index and appends to B', () => {
    // Two strings, one roof, two panels — assign both to A in order, then
    // move panel #2 to B. Panel #1 in A should renumber to #1 (gap-fill);
    // the moved panel should appear as #1 in B.
    const r = store().addRoof(SQUARE);
    store().addPanel(r, 10, 10, 'g1', 'portrait');
    store().addPanel(r, 20, 20, 'g1', 'portrait');
    const [p1, p2] = store().project.panels;
    const sa = store().addString();
    store().assignPanelsToString([p1.id, p2.id], sa);
    const sb = store().addString();
    store().assignPanelsToString([p2.id], sb);

    const panelById = (id: string) => store().project.panels.find((p) => p.id === id)!;
    expect(panelById(p1.id).stringId).toBe(sa);
    expect(panelById(p1.id).indexInString).toBe(1);
    expect(panelById(p2.id).stringId).toBe(sb);
    expect(panelById(p2.id).indexInString).toBe(1);
  });
});

// ── addString / deleteString ──────────────────────────────────────────────

describe('addString / deleteString', () => {
  it('addString appends a labelled string with a palette color', () => {
    const id = store().addString();
    const strings = store().project.strings;
    expect(strings).toHaveLength(1);
    expect(strings[0].id).toBe(id);
    expect(strings[0].label).toBe('String 1');
    expect(strings[0].color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('deleteString unassigns its panels but does NOT delete them', () => {
    // Documented intent: the user usually wants to regroup, not lose the
    // panels. Verify the panels survive with stringId/indexInString
    // reset to null.
    const r = store().addRoof(SQUARE);
    store().addPanel(r, 10, 10, 'g1', 'portrait');
    const [p1] = store().project.panels;
    const sid = store().addString();
    store().assignPanelsToString([p1.id], sid);
    expect(store().project.panels[0].stringId).toBe(sid);

    store().deleteString(sid);
    expect(store().project.strings).toHaveLength(0);
    expect(store().project.panels).toHaveLength(1);
    expect(store().project.panels[0].stringId).toBeNull();
    expect(store().project.panels[0].indexInString).toBeNull();
  });
});

// ── addInverter / deleteInverter ──────────────────────────────────────────

describe('addInverter / deleteInverter', () => {
  it('addInverter appends a fresh inverter with an auto-generated name', () => {
    const id = store().addInverter();
    const inv = store().project.inverters;
    expect(inv).toHaveLength(1);
    expect(inv[0].id).toBe(id);
    expect(inv[0].name).toMatch(/Inverter/i);
  });

  it('deleteInverter unlinks any string that pointed at it (sets inverterId=null)', () => {
    // We don't want a string to dangle pointing at a deleted inverter id —
    // every consumer downstream would have to null-check. The store
    // proactively unlinks on delete.
    const iid = store().addInverter();
    const sid = store().addString();
    store().setStringInverter(sid, iid);
    expect(store().project.strings[0].inverterId).toBe(iid);

    store().deleteInverter(iid);
    expect(store().project.inverters).toHaveLength(0);
    expect(store().project.strings[0].inverterId).toBeNull();
  });
});

// ── applyRemotePatch ──────────────────────────────────────────────────────

describe('applyRemotePatch', () => {
  it('mutates the project per the JSON-Patch ops', () => {
    // Add a roof so we have something patchable, then apply a remote
    // op that renames it. Verifies the action wires through to
    // applyProjectPatch correctly.
    const id = store().addRoof(SQUARE);
    store().applyRemotePatch([
      { op: 'replace', path: `/roofs/0/name`, value: 'Renamed by remote' },
    ]);
    const r = store().project.roofs.find((x) => x.id === id);
    expect(r?.name).toBe('Renamed by remote');
  });

  it('does NOT push a history entry (classified as bypass)', () => {
    // The action header explicitly notes: a remote-originated change is
    // authoritative and must not be undoable, otherwise Ctrl-Z in tab A
    // could clobber tab B's work. Verify by checking past stack length.
    store().addRoof(SQUARE); // → 1 history entry
    const before = store().past.length;
    store().applyRemotePatch([
      { op: 'replace', path: '/roofs/0/name', value: 'Remote' },
    ]);
    expect(store().past.length).toBe(before); // unchanged → bypass
  });
});
