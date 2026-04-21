// ────────────────────────────────────────────────────────────────────────────
// stringRouting tests.
//
// `computeStringPath` is the visual wiring algorithm behind every PV string
// line drawn on the canvas — skipping off-string panels via perpendicular
// detours (ADR-006). The refactor review flagged this module as having
// zero test coverage despite being the interpretation layer for a
// subtle-to-read user signal ("is that panel skipped, or is the line
// just running over it?"). These tests pin the detour-insertion policy,
// the T-window and near-line thresholds, and the side-selection
// tiebreak — any future restructuring (e.g. unifying the projection
// helper with drawingSnap's equivalent) must preserve them.
//
// Fixtures: we use a single flat roof (tilt=0) with square panels
// (widthM=1, heightM=1) so panelDisplaySize returns 10×10 canvas
// pixels per panel at mpp=0.1. That makes the detour threshold
// trivially computable: nearThreshold = min(w,h) × 0.35 = 3.5 px, and
// detour offset = min(w,h) × 0.42 = 4.2 px.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { computeStringPath } from './stringRouting';
import type { Panel, Roof, PanelType } from '../types';

// Factory helpers. Defaults match "fresh flat roof, portrait panels" so the
// pixel-space geometry above holds without per-test restatement.
const makeRoof = (id: string, overrides: Partial<Roof> = {}): Roof => ({
  id,
  name: `Roof ${id}`,
  // A large enough polygon that panel centers fall comfortably inside it.
  // The routing algorithm doesn't actually hit-test the polygon — it only
  // uses roof for tilt + panel orientation — so the exact shape doesn't
  // matter, but a plausible one keeps type assertions honest.
  polygon: [
    { x: 0, y: -50 },
    { x: 200, y: -50 },
    { x: 200, y: 50 },
    { x: 0, y: 50 },
  ],
  tiltDeg: 0,
  panelOrientation: 'portrait',
  ...overrides,
});

const makePanel = (
  id: string,
  cx: number,
  cy: number,
  overrides: Partial<Panel> = {},
): Panel => ({
  id,
  roofId: 'r1',
  groupId: 'g1',
  cx,
  cy,
  stringId: null,
  indexInString: null,
  orientation: 'portrait',
  ...overrides,
});

const PANEL_TYPE: PanelType = {
  id: 'pt',
  name: 'test 400W',
  widthM: 1,
  heightM: 1,
  wattPeak: 400,
};

const MPP = 0.1; // 10 canvas pixels per meter → panels render as 10×10 px.

describe('computeStringPath — trivial shapes', () => {
  it('returns [] when the string has no panels', () => {
    const roofs = new Map<string, Roof>([['r1', makeRoof('r1')]]);
    expect(computeStringPath([], [], roofs, PANEL_TYPE, MPP)).toEqual([]);
  });

  it('returns a single-point path for a single-panel string', () => {
    const roofs = new Map<string, Roof>([['r1', makeRoof('r1')]]);
    const path = computeStringPath(
      [makePanel('p1', 5, 0)],
      [],
      roofs,
      PANEL_TYPE,
      MPP,
    );
    expect(path).toEqual([{ x: 5, y: 0 }]);
  });

  it('falls back to plain centers when mpp <= 0 (pre-lock defensive path)', () => {
    // Without a valid calibration, panelDisplaySize would return absurd
    // values. The module explicitly guards against this by returning
    // panel centers verbatim — important because loaded JSON from a
    // session that was never locked could, in principle, hit this
    // branch before lockMap fixes mpp.
    const roofs = new Map<string, Roof>([['r1', makeRoof('r1')]]);
    const panels = [makePanel('p1', 0, 0), makePanel('p2', 30, 0)];
    const path = computeStringPath(panels, [], roofs, PANEL_TYPE, 0);
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 30, y: 0 },
    ]);
  });
});

describe('computeStringPath — straight segments without obstructions', () => {
  it('connects panels with no intermediate waypoints when no off-string panels interfere', () => {
    const roofs = new Map<string, Roof>([['r1', makeRoof('r1')]]);
    const stringPanels = [
      makePanel('p1', 0, 0),
      makePanel('p2', 30, 0),
    ];
    // An off-string panel far from the segment — shouldn't trigger a detour.
    const other = [makePanel('po', 15, 100)];
    const path = computeStringPath(stringPanels, other, roofs, PANEL_TYPE, MPP);
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 30, y: 0 },
    ]);
  });

  it('chains a three-panel string into a 3-point polyline when nothing interferes', () => {
    const roofs = new Map<string, Roof>([['r1', makeRoof('r1')]]);
    const panels = [
      makePanel('p1', 0, 0),
      makePanel('p2', 50, 0),
      makePanel('p3', 100, 0),
    ];
    const path = computeStringPath(panels, [], roofs, PANEL_TYPE, MPP);
    expect(path.length).toBe(3);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[2]).toEqual({ x: 100, y: 0 });
  });
});

describe('computeStringPath — detours around skipped panels', () => {
  it('inserts a detour waypoint when an off-string panel sits on the line', () => {
    // String: panel at (0,0) wired to panel at (30,0).
    // Off-string panel at (10, 0) is directly on the line — t = 1/3,
    // which is safely inside (T_MIN=0.1, T_MAX=0.9) and has
    // perpendicular distance 0 (< nearThreshold=3.5). Algorithm should
    // emit one detour waypoint offset perpendicular to the segment.
    const roofs = new Map<string, Roof>([['r1', makeRoof('r1')]]);
    const stringPanels = [makePanel('p1', 0, 0), makePanel('p2', 30, 0)];
    const other = [makePanel('po', 10, 0)];
    const path = computeStringPath(stringPanels, other, roofs, PANEL_TYPE, MPP);
    // Expect [p1, waypoint, p2]. The waypoint has x=10 (same as the
    // skipped panel's center) and y offset by the detour magnitude
    // along the perpendicular direction.
    expect(path.length).toBe(3);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[2]).toEqual({ x: 30, y: 0 });
    const wp = path[1];
    expect(wp.x).toBeCloseTo(10);
    // |wp.y| should equal the detour magnitude (4.2 px for 10×10 panels).
    expect(Math.abs(wp.y)).toBeCloseTo(10 * 0.42);
  });

  it('does NOT detour around a panel whose projection falls near the endpoints', () => {
    // Place the off-string panel at t = 0.05 (outside T_MIN=0.1). The
    // algorithm skips it — detouring too close to an endpoint looks
    // jagged, so the design explicitly excludes the outer 10% at each
    // end of the segment.
    const roofs = new Map<string, Roof>([['r1', makeRoof('r1')]]);
    const stringPanels = [makePanel('p1', 0, 0), makePanel('p2', 100, 0)];
    // At x=5 (t=0.05) — too close to the start, algorithm should ignore.
    const other = [makePanel('po', 5, 0)];
    const path = computeStringPath(stringPanels, other, roofs, PANEL_TYPE, MPP);
    expect(path.length).toBe(2);
  });

  it('does NOT detour around an off-string panel far from the line', () => {
    // Perpendicular distance = 10 px, much greater than nearThreshold=3.5.
    const roofs = new Map<string, Roof>([['r1', makeRoof('r1')]]);
    const stringPanels = [makePanel('p1', 0, 0), makePanel('p2', 30, 0)];
    const other = [makePanel('po', 15, 10)];
    const path = computeStringPath(stringPanels, other, roofs, PANEL_TYPE, MPP);
    expect(path.length).toBe(2);
  });

  it('emits detour waypoints in order (sorted by projection t along the segment)', () => {
    // Two obstructions at x=10 (t≈0.25) and x=30 (t≈0.75). The algorithm
    // sorts candidates by t so waypoints appear in the same order as
    // the obstructions along the segment. This keeps the wire visually
    // monotonic along A→B — a hidden invariant the reader assumes when
    // scanning the string.
    const roofs = new Map<string, Roof>([['r1', makeRoof('r1')]]);
    const stringPanels = [makePanel('p1', 0, 0), makePanel('p2', 40, 0)];
    const other = [
      makePanel('po1', 10, 0),
      makePanel('po2', 30, 0),
    ];
    const path = computeStringPath(stringPanels, other, roofs, PANEL_TYPE, MPP);
    // [p1, wp@10, wp@30, p2]
    expect(path.length).toBe(4);
    expect(path[1].x).toBeCloseTo(10);
    expect(path[2].x).toBeCloseTo(30);
  });

  it('detours all obstructions on the SAME perpendicular side', () => {
    // Once a segment commits to side +1 or −1, every detour in that
    // segment uses the same side — mixing would create a zigzag worse
    // than either consistent choice. Verify this invariant by checking
    // that the sign of (waypoint.y − segment.y) matches across all
    // waypoints for the same segment.
    const roofs = new Map<string, Roof>([['r1', makeRoof('r1')]]);
    const stringPanels = [makePanel('p1', 0, 0), makePanel('p2', 40, 0)];
    const other = [
      makePanel('po1', 10, 0),
      makePanel('po2', 30, 0),
    ];
    const path = computeStringPath(stringPanels, other, roofs, PANEL_TYPE, MPP);
    const wp1y = path[1].y;
    const wp2y = path[2].y;
    // Both waypoints on the same side ⇒ same sign.
    expect(Math.sign(wp1y)).toBe(Math.sign(wp2y));
    expect(wp1y).not.toBe(0);
  });
});

describe('computeStringPath — degenerate input shapes', () => {
  it('handles two consecutive panels at the same point without adding waypoints', () => {
    // Two panels with identical centers — segLen < 1e-6 → detour logic
    // skipped, path just pushes `to`. A valid configuration only in
    // pathological/imported data; we defend against it rather than
    // throw.
    const roofs = new Map<string, Roof>([['r1', makeRoof('r1')]]);
    const stringPanels = [makePanel('p1', 5, 5), makePanel('p2', 5, 5)];
    // Off-string panel that would have caused a detour if segLen > 0.
    const other = [makePanel('po', 5, 5)];
    const path = computeStringPath(stringPanels, other, roofs, PANEL_TYPE, MPP);
    expect(path.length).toBe(2);
  });

  it('skips off-string panels whose roof is missing from the lookup map', () => {
    // An orphaned panel (roofId pointing at a deleted roof) shouldn't
    // crash the router — the module explicitly `continue`s past these.
    // Without this guard, a dangling panel post-cascading-delete would
    // break every path computation on the canvas.
    const roofs = new Map<string, Roof>([['r1', makeRoof('r1')]]);
    const stringPanels = [makePanel('p1', 0, 0), makePanel('p2', 30, 0)];
    const orphan = makePanel('orphan', 15, 0, { roofId: 'deleted-roof' });
    const path = computeStringPath(stringPanels, [orphan], roofs, PANEL_TYPE, MPP);
    // Orphan should be ignored → straight path, no detour.
    expect(path.length).toBe(2);
  });
});
