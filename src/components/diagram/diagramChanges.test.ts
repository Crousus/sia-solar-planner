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

// Routing rules for React Flow changes: which ones are document edits
// (persisted + synced) and which are per-viewer state (local only).

import { describe, it, expect } from 'vitest';
import type { NodeChange, EdgeChange } from '@xyflow/react';
import {
  reduceNodeChanges,
  reduceEdgeChanges,
  stripNodeTransient,
  stripEdgeTransient,
  snapCenter,
  EMPTY_NODE_EPHEMERAL,
} from './diagramChanges';
import type { DiagramNode, DiagramEdge } from '../../types';

const node = (id: string, x = 0, y = 0): DiagramNode => ({
  id,
  type: 'fuse',
  position: { x, y },
  data: { label: id },
});
const edge = (id: string): DiagramEdge => ({
  id,
  source: 'a',
  sourceHandle: 'out',
  target: 'b',
  targetHandle: 'in',
});

describe('reduceNodeChanges', () => {
  it('keeps selection local and does not produce a store write', () => {
    const nodes = [node('a')];
    const r = reduceNodeChanges(nodes, EMPTY_NODE_EPHEMERAL, [
      { type: 'select', id: 'a', selected: true },
    ], 11);
    expect(r.nodes).toBeNull();
    expect(r.eph.selected.has('a')).toBe(true);
  });

  it('keeps measured dimensions local', () => {
    const r = reduceNodeChanges([node('a')], EMPTY_NODE_EPHEMERAL, [
      { type: 'dimensions', id: 'a', dimensions: { width: 40, height: 20 } },
    ], 11);
    expect(r.nodes).toBeNull();
    expect(r.eph.measured.get('a')).toEqual({ width: 40, height: 20 });
  });

  it('tracks mid-drag positions locally and commits once on drag end (center-snapped)', () => {
    const nodes = [node('a', 0, 0)];
    let eph = reduceNodeChanges(nodes, EMPTY_NODE_EPHEMERAL, [
      { type: 'dimensions', id: 'a', dimensions: { width: 22, height: 22 } },
    ], 11).eph;

    const mid = reduceNodeChanges(nodes, eph, [
      { type: 'position', id: 'a', position: { x: 30, y: 4 }, dragging: true },
    ], 11);
    expect(mid.nodes).toBeNull(); // no store write per frame
    expect(mid.eph.dragging.get('a')).toBeDefined();
    eph = mid.eph;

    const end = reduceNodeChanges(nodes, eph, [
      { type: 'position', id: 'a', position: { x: 30, y: 4 }, dragging: false },
    ], 11);
    expect(end.nodes).not.toBeNull();
    // Center (41, 15) snaps to (44, 11) → top-left (33, 0).
    expect(end.nodes![0].position).toEqual({ x: 33, y: 0 });
    expect(end.eph.dragging.has('a')).toBe(false);
    // Committed node carries no runtime fields.
    expect('dragging' in end.nodes![0]).toBe(false);
    expect('measured' in end.nodes![0]).toBe(false);
  });

  it('falls back to the last local drag position when drag end has no position', () => {
    const nodes = [node('a', 0, 0)];
    const mid = reduceNodeChanges(nodes, EMPTY_NODE_EPHEMERAL, [
      { type: 'position', id: 'a', position: { x: 22, y: 11 }, dragging: true },
    ], 11);
    const end = reduceNodeChanges(nodes, mid.eph, [
      { type: 'position', id: 'a', dragging: false },
    ], 11);
    expect(end.nodes![0].position).toEqual({ x: 22, y: 11 });
  });

  it('strips selected/measured/dragging from replace items (updateNodeData)', () => {
    const nodes = [node('a'), node('b')];
    const replaced = {
      ...node('a'),
      data: { label: 'renamed' },
      selected: true,
      dragging: false,
      measured: { width: 10, height: 10 },
    };
    const r = reduceNodeChanges(nodes, EMPTY_NODE_EPHEMERAL, [
      { type: 'replace', id: 'a', item: replaced } as NodeChange,
    ], 11);
    expect(r.nodes).not.toBeNull();
    const a = r.nodes!.find((n) => n.id === 'a')!;
    expect(a.data.label).toBe('renamed');
    expect(Object.keys(a).sort()).toEqual(['data', 'id', 'position', 'type']);
    // Untouched node keeps identity.
    expect(r.nodes![1]).toBe(nodes[1]);
  });

  it('removes nodes from the store and forgets their local state', () => {
    const nodes = [node('a'), node('b')];
    const eph = reduceNodeChanges(nodes, EMPTY_NODE_EPHEMERAL, [
      { type: 'select', id: 'a', selected: true },
    ], 11).eph;
    const r = reduceNodeChanges(nodes, eph, [{ type: 'remove', id: 'a' }], 11);
    expect(r.nodes!.map((n) => n.id)).toEqual(['b']);
    expect(r.eph.selected.has('a')).toBe(false);
  });

  it('returns the same ephemeral object when nothing local changed', () => {
    const nodes = [node('a')];
    const r = reduceNodeChanges(nodes, EMPTY_NODE_EPHEMERAL, [{ type: 'remove', id: 'a' }], 11);
    expect(r.eph).toBe(EMPTY_NODE_EPHEMERAL);
  });
});

describe('reduceEdgeChanges', () => {
  it('keeps edge selection local', () => {
    const r = reduceEdgeChanges([edge('e')], new Set(), [
      { type: 'select', id: 'e', selected: true },
    ]);
    expect(r.edges).toBeNull();
    expect(r.selected.has('e')).toBe(true);
  });

  it('persists label edits (replace) without the selected flag', () => {
    const r = reduceEdgeChanges([edge('e')], new Set(['e']), [
      { type: 'replace', id: 'e', item: { ...edge('e'), label: '6 mm²', selected: true } } as EdgeChange,
    ]);
    expect(r.edges![0].label).toBe('6 mm²');
    expect('selected' in r.edges![0]).toBe(false);
  });
});

describe('strip helpers + snapCenter', () => {
  it('return the same reference when there is nothing to strip', () => {
    const n = node('a');
    expect(stripNodeTransient(n)).toBe(n);
    const e = edge('e');
    expect(stripEdgeTransient(e)).toBe(e);
  });

  it('snapCenter aligns centres of differently sized nodes', () => {
    const a = snapCenter({ x: 3, y: 3 }, { width: 40, height: 20 }, 11);
    const b = snapCenter({ x: 12, y: 1 }, { width: 22, height: 22 }, 11);
    expect(a.y + 10).toBeCloseTo(b.y + 11); // same centre row
  });
});
