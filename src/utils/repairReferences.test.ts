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
// repairReferences tests.
//
// Each dangling-reference shape a three-way merge can produce gets its own
// case, plus the two contract properties the sync client depends on:
// identity when nothing is broken (no spurious diffs) and idempotence.
// ────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { repairReferences } from './repairReferences';
import type { Panel, Project, PvString } from '../types';

function panel(id: string, over: Partial<Panel> = {}): Panel {
  return {
    id, roofId: 'r1', groupId: 'g1', cx: 0, cy: 0,
    stringId: null, indexInString: null, orientation: 'portrait', ...over,
  };
}

function str(id: string, over: Partial<PvString> = {}): PvString {
  return { id, label: id, inverterId: null, color: '#000', ...over };
}

function project(over: Partial<Project> = {}): Project {
  return {
    name: 'p',
    panelType: { id: 'pt', name: 'x', widthM: 1, heightM: 1, wattPeak: 100 },
    roofs: [{ id: 'r1', name: 'Roof 1', polygon: [], tiltDeg: 30, panelOrientation: 'portrait' }],
    panels: [],
    strings: [],
    inverters: [{ id: 'i1', name: 'Inv' }],
    mapState: { locked: false, centerLat: 0, centerLng: 0, zoom: 1, metersPerPixel: 0.1 },
    ...over,
  };
}

describe('repairReferences', () => {
  it('returns the same object when the project is consistent', () => {
    const p = project({
      strings: [str('s1', { inverterId: 'i1', mpptPort: 'A' })],
      panels: [
        panel('a', { stringId: 's1', indexInString: 2 }),
        panel('b', { stringId: 's1', indexInString: 1 }),
        panel('c'),
      ],
      diagram: {
        nodes: [
          { id: 'n1', type: 'inverter', position: { x: 0, y: 0 }, data: { label: 'x' } },
          { id: 'n2', type: 'fuse', position: { x: 0, y: 0 }, data: { label: 'y' } },
        ],
        edges: [{ id: 'e1', source: 'n1', sourceHandle: 'out', target: 'n2', targetHandle: 'in' }],
        meta: {},
      },
    });
    expect(repairReferences(p)).toBe(p);
  });

  it('drops panels on a missing roof', () => {
    const p = project({ panels: [panel('a'), panel('b', { roofId: 'gone' })] });
    const out = repairReferences(p);
    expect(out.panels.map((x) => x.id)).toEqual(['a']);
    // Untouched panel kept by reference (cheap downstream diff).
    expect(out.panels[0]).toBe(p.panels[0]);
  });

  it('unassigns panels from a missing string and clears stray indices', () => {
    const p = project({
      panels: [
        panel('a', { stringId: 'gone', indexInString: 1 }),
        panel('b', { stringId: null, indexInString: 4 }),
      ],
    });
    const out = repairReferences(p);
    expect(out.panels.map((x) => [x.stringId, x.indexInString])).toEqual([[null, null], [null, null]]);
  });

  it('clears inverterId and mpptPort on strings with a missing inverter', () => {
    const p = project({
      strings: [str('s1', { inverterId: 'gone', mpptPort: 'B' }), str('s2', { inverterId: 'i1', mpptPort: 'A' })],
    });
    const out = repairReferences(p);
    expect(out.strings[0]).toMatchObject({ inverterId: null, mpptPort: null });
    expect(out.strings[1]).toBe(p.strings[1]);
  });

  it('drops diagram edges to missing nodes', () => {
    const p = project({
      diagram: {
        nodes: [{ id: 'n1', type: 'inverter', position: { x: 0, y: 0 }, data: { label: 'x' } }],
        edges: [
          { id: 'e1', source: 'n1', sourceHandle: 'out', target: 'gone', targetHandle: 'in' },
          { id: 'e2', source: 'gone', sourceHandle: 'out', target: 'n1', targetHandle: 'in' },
        ],
        meta: {},
      },
    });
    const out = repairReferences(p);
    expect(out.diagram?.edges).toEqual([]);
    expect(out.diagram?.nodes).toBe(p.diagram?.nodes);
  });

  it('does not add a diagram key to a project without one', () => {
    const out = repairReferences(project({ panels: [panel('a', { roofId: 'gone' })] }));
    expect('diagram' in out).toBe(false);
  });

  it('renumbers duplicate / gappy indices densely, ties broken by array order', () => {
    // Concurrent additions: both sides appended "#3"; plus a gap at #2.
    const p = project({
      strings: [str('s1')],
      panels: [
        panel('theirs3', { stringId: 's1', indexInString: 3 }),
        panel('one', { stringId: 's1', indexInString: 1 }),
        panel('mine3', { stringId: 's1', indexInString: 3 }),
        panel('newcomer', { stringId: 's1', indexInString: null }),
      ],
    });
    const out = repairReferences(p);
    const idx = Object.fromEntries(out.panels.map((x) => [x.id, x.indexInString]));
    expect(idx).toEqual({ one: 1, theirs3: 2, mine3: 3, newcomer: 4 });
    // Array order is preserved (rewrite is in place).
    expect(out.panels.map((x) => x.id)).toEqual(['theirs3', 'one', 'mine3', 'newcomer']);
    // `one` already had the right number → same object.
    expect(out.panels[1]).toBe(p.panels[1]);
  });

  it('renumbers the remaining members after a dangling-roof drop', () => {
    const p = project({
      strings: [str('s1')],
      panels: [
        panel('a', { stringId: 's1', indexInString: 1 }),
        panel('b', { stringId: 's1', indexInString: 2, roofId: 'gone' }),
        panel('c', { stringId: 's1', indexInString: 3 }),
      ],
    });
    const out = repairReferences(p);
    expect(out.panels.map((x) => [x.id, x.indexInString])).toEqual([['a', 1], ['c', 2]]);
  });

  it('is idempotent', () => {
    const p = project({
      strings: [str('s1', { inverterId: 'gone' })],
      panels: [
        panel('a', { stringId: 's1', indexInString: 5 }),
        panel('b', { stringId: 's1', indexInString: 5 }),
        panel('c', { roofId: 'gone' }),
        panel('d', { stringId: 'gone', indexInString: 1 }),
      ],
    });
    const once = repairReferences(p);
    expect(once).not.toBe(p);
    expect(repairReferences(once)).toBe(once);
  });
});
