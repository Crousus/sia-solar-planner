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
// projectSerializer tests.
//
// This module is the persistence boundary — every JSON file the user
// imports/exports flows through here, AND every Zustand rehydration on
// page load runs `migrateProject`. A regression here is the fastest path
// to silent data loss (a v1 file that mis-parses; a panel.orientation
// that defaults wrong; a v2 envelope whose history fails to round-trip).
//
// Coverage targets:
//   - Round-trip: serialize → deserialize → equality on the project.
//   - v1 fallback: bare Project at the document root still loads.
//   - v2 envelope: project + history are both reconstituted.
//   - Tolerance: a v2 envelope MISSING `history` still loads (truncated /
//     hand-edited file scenario, called out in the file's docstring).
//   - Errors: non-object input, missing `project`, unrecognised v1 shape.
//   - Migration: panel.orientation back-fill from owning roof; reference
//     identity preserved when nothing needed migrating (the persist-trigger
//     optimisation that prevents spurious selector re-renders).
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  serializeProject,
  deserializeProject,
  migrateProject,
  ProjectDeserializationError,
} from './projectSerializer';
import type { Project } from '../types';
import type { UndoableSlice } from '../store/undoMiddleware';

// ── Fixtures ──────────────────────────────────────────────────────────────

/** Minimal-but-valid Project. We give one roof + one panel so the
 *  panel.orientation back-fill paths have something to act on. */
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    name: 'Test',
    panelType: {
      id: 'pt1',
      name: 'Test Panel',
      widthM: 1,
      heightM: 2,
      wattPeak: 400,
    },
    roofs: [
      {
        id: 'r1',
        name: 'Roof 1',
        polygon: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
        tiltDeg: 30,
        panelOrientation: 'landscape',
      },
    ],
    panels: [
      {
        id: 'p1',
        roofId: 'r1',
        groupId: 'g1',
        cx: 5,
        cy: 5,
        stringId: null,
        indexInString: null,
        orientation: 'landscape',
      },
    ],
    strings: [],
    inverters: [],
    mapState: {
      locked: false,
      centerLat: 48.137,
      centerLng: 11.575,
      zoom: 19,
      metersPerPixel: 0.2,
    },
    ...overrides,
  };
}

/** Minimal UndoableSlice for history round-trip tests. Mirrors the shape
 *  buildSlice produces in the real store. */
function makeSlice(panelOrientation: 'portrait' | 'landscape' = 'landscape'): UndoableSlice {
  return {
    name: 'Test',
    panelType: { id: 'pt1' },
    roofs: [
      { id: 'r1', panelOrientation },
    ],
    panels: [
      // Intentionally omit `orientation` so migrateSlice has work to do.
      { id: 'p1', roofId: 'r1' },
    ],
    strings: [],
    inverters: [],
  };
}

// ── serializeProject + deserializeProject (round-trip) ────────────────────

describe('serialize → deserialize round-trip', () => {
  it('preserves the project verbatim through a v2 envelope', () => {
    const project = makeProject();
    const payload = serializeProject({ project, past: [], future: [] });
    expect(payload.version).toBe(2);

    const result = deserializeProject(JSON.parse(JSON.stringify(payload)));
    // Going through JSON.stringify/parse mirrors what file IO actually
    // does — strips reference identity, exercises the same code path
    // production hits.
    expect(result.project).toEqual(project);
    expect(result.history).toEqual({ past: [], future: [] });
  });

  it('round-trips non-empty undo history', () => {
    const project = makeProject();
    const past = [makeSlice('portrait')];
    const future = [makeSlice('landscape')];
    const payload = serializeProject({ project, past, future });

    const result = deserializeProject(JSON.parse(JSON.stringify(payload)));
    expect(result.history?.past).toHaveLength(1);
    expect(result.history?.future).toHaveLength(1);
    // Slice migration filled in panel.orientation from the slice's roof —
    // this is the migrateSlice path firing as a side effect.
    expect((result.history!.past[0].panels[0] as { orientation?: string }).orientation).toBe('portrait');
    expect((result.history!.future[0].panels[0] as { orientation?: string }).orientation).toBe('landscape');
  });
});

// ── v1 legacy format ──────────────────────────────────────────────────────

describe('deserializeProject — v1 (bare Project)', () => {
  it('loads a v1 raw Project at the document root', () => {
    const project = makeProject();
    // v1 files have NO `version` envelope; the document root IS the Project.
    const result = deserializeProject(JSON.parse(JSON.stringify(project)));
    expect(result.project).toEqual(project);
    // No history block in v1 — caller treats undefined as empty stacks.
    expect(result.history).toBeUndefined();
  });

  it('throws ProjectDeserializationError for objects missing roofs/panels/mapState', () => {
    // The v1 minimal-shape guard exists so a random JSON file (e.g. the
    // user picked the wrong file in the open-dialog) fails loudly instead
    // of being cast to Project and crashing the editor on first read.
    expect(() => deserializeProject({ foo: 'bar' })).toThrow(ProjectDeserializationError);
  });
});

// ── v2 envelope ───────────────────────────────────────────────────────────

describe('deserializeProject — v2 (envelope)', () => {
  it('loads a v2 envelope with history', () => {
    const project = makeProject();
    const envelope = {
      version: 2,
      project,
      history: { past: [], future: [] },
    };
    const result = deserializeProject(envelope);
    expect(result.project).toEqual(project);
    expect(result.history).toEqual({ past: [], future: [] });
  });

  it('loads a v2 envelope WITHOUT history (tolerance for truncated files)', () => {
    // The docstring promises tolerance for "truncated or older v2 file
    // with the envelope but no history key". Verify the guard.
    const project = makeProject();
    const result = deserializeProject({ version: 2, project });
    expect(result.project).toEqual(project);
    expect(result.history).toBeUndefined();
  });

  it('throws when the v2 envelope has no `project` field', () => {
    expect(() => deserializeProject({ version: 2 })).toThrow(ProjectDeserializationError);
  });

  it('throws when input is not an object at all', () => {
    expect(() => deserializeProject(null)).toThrow(ProjectDeserializationError);
    expect(() => deserializeProject('hello')).toThrow(ProjectDeserializationError);
    expect(() => deserializeProject(42)).toThrow(ProjectDeserializationError);
  });
});

// ── migrateProject ────────────────────────────────────────────────────────

describe('migrateProject', () => {
  it('back-fills panel.orientation from the owning roof when absent', () => {
    // Construct a doc where the panel lacks `orientation` — pre-migration
    // shape. The migration should fill it in from the roof.
    const project = makeProject({
      roofs: [
        {
          id: 'r1',
          name: 'Roof 1',
          polygon: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
          ],
          tiltDeg: 0,
          panelOrientation: 'landscape',
        },
      ],
      panels: [
        // Omit orientation via cast — TypeScript would otherwise reject
        // since the field is now required.
        {
          id: 'p1',
          roofId: 'r1',
          groupId: 'g1',
          cx: 5,
          cy: 5,
          stringId: null,
          indexInString: null,
        } as unknown as Project['panels'][number],
      ],
    });
    const migrated = migrateProject(project);
    expect(migrated.panels[0].orientation).toBe('landscape');
  });

  it("falls back to 'portrait' when the panel's roof is unknown (orphan panel)", () => {
    // Cascaded-deleted-roof scenario — the panel survived in the doc but
    // its `roofId` no longer resolves. The fallback default keeps the
    // field non-optional rather than crashing the renderer.
    const project = makeProject({
      panels: [
        {
          id: 'p1',
          roofId: 'nonexistent-roof',
          groupId: 'g1',
          cx: 5,
          cy: 5,
          stringId: null,
          indexInString: null,
        } as unknown as Project['panels'][number],
      ],
    });
    const migrated = migrateProject(project);
    expect(migrated.panels[0].orientation).toBe('portrait');
  });

  it('preserves reference identity when nothing needs migrating', () => {
    // The optimisation called out in the docstring: returning a new top-
    // level object on every rehydrate would invalidate every Zustand
    // selector subscription. The function must return the SAME reference
    // when no panels needed back-fill.
    const project = makeProject(); // panel already has orientation set
    const migrated = migrateProject(project);
    expect(migrated).toBe(project);
  });

  it('returns a NEW object reference when at least one panel was migrated', () => {
    // The flip side of the optimisation — the returned reference must
    // differ when migration ran, so subscribers that DO depend on the
    // changed value re-render.
    const project = makeProject({
      panels: [
        {
          id: 'p1',
          roofId: 'r1',
          groupId: 'g1',
          cx: 5,
          cy: 5,
          stringId: null,
          indexInString: null,
        } as unknown as Project['panels'][number],
      ],
    });
    const migrated = migrateProject(project);
    expect(migrated).not.toBe(project);
  });
});
