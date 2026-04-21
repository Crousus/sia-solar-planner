// ────────────────────────────────────────────────────────────────────────
// Round-trip tests for the JSON Patch wrapper.
//
// These tests pin the contract our sync client relies on:
//   1. diff(a, a) is the empty patch — no work means no ops.
//   2. apply(a, diff(a, b)) deep-equals b — the round trip is faithful.
//   3. Neither function mutates its inputs — important because the sync
//      client passes the live store state in.
//   4. Large fields (1 MB capturedImage base64) survive without choking;
//      this is our worst-case payload and the most likely place a future
//      library swap would silently regress.
//
// We deliberately do NOT test fast-json-patch's RFC 6902 conformance —
// that's the library's job. We test only the wrapper's invariants.
// ────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { diffProjects, applyProjectPatch } from './diff';
import type { Project } from '../types';

// Build a minimal project fixture for tests. Kept tiny to keep diffs
// readable when something fails — most tests mutate a shallow field
// rather than rebuilding the whole tree.
function fixture(): Project {
  return {
    name: 'Test',
    panelType: {
      id: 'pt1', name: 'x', widthM: 1, heightM: 1, wattPeak: 100,
    },
    roofs: [],
    panels: [],
    strings: [],
    inverters: [],
    // Use the unlocked variant as the baseline — it has no captured
    // image fields, making a fresh fixture cheap.
    mapState: {
      locked: false,
      centerLat: 0, centerLng: 0, zoom: 1, metersPerPixel: 0.1,
      mapProvider: 'esri',
    },
  };
}

describe('diff round-trip', () => {
  it('diff(a, a) is empty', () => {
    const a = fixture();
    expect(diffProjects(a, a)).toEqual([]);
  });

  it('apply(a, diff(a, b)) === b', () => {
    const a = fixture();
    const b = fixture();
    b.name = 'Renamed';
    b.roofs.push({
      id: 'r1',
      name: 'Roof 1',
      polygon: [{ x: 0, y: 0 }],
      tiltDeg: 30,
      panelOrientation: 'portrait',
    });
    const ops = diffProjects(a, b);
    const applied = applyProjectPatch(a, ops);
    expect(applied).toEqual(b);
  });

  it('does not mutate inputs', () => {
    const a = fixture();
    const b = fixture();
    b.name = 'X';
    // Snapshot via JSON so we catch any nested mutation, not just
    // top-level identity changes.
    const snapshot = JSON.stringify(a);
    diffProjects(a, b);
    applyProjectPatch(a, diffProjects(a, b));
    expect(JSON.stringify(a)).toEqual(snapshot);
  });

  it('handles large captured image field without blowing up', () => {
    const a = fixture();
    const b = fixture();
    // 1 MB of base64-like data — roughly the worst case we'd send to
    // PocketBase as a single doc field.
    const bigString = 'A'.repeat(1_000_000);
    // Switch b to the locked variant; the discriminated union requires
    // capturedImage / capturedWidth / capturedHeight when locked.
    b.mapState = {
      locked: true,
      centerLat: 0, centerLng: 0, zoom: 20, metersPerPixel: 0.05,
      mapProvider: 'esri',
      capturedImage: 'data:image/png;base64,' + bigString,
      capturedWidth: 1920,
      capturedHeight: 1080,
    };
    const ops = diffProjects(a, b);
    const applied = applyProjectPatch(a, ops);
    expect(applied).toEqual(b);
  });
});
