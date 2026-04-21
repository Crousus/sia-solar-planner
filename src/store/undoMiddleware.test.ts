import { describe, it, expect, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import {
  undoable,
  buildSlice,
  cleanUiRefs,
  setCoalesceKey,
  applyUndo,
  applyRedo,
  assertReferentialIntegrity,
  type HistoryState,
  type UndoableSlice,
} from './undoMiddleware';

// A minimal test store shape used throughout these tests. Shape chosen
// to mirror projectStore's essentials (a "project"-like object plus UI
// fields) without pulling in the real project types.
type TestState = HistoryState & {
  project: { name: string; roofs: string[]; panels: string[]; strings: string[]; inverters: string[]; panelType: { id: string } };
  selectedRoofId: string | null;
  setName: (n: string) => void;
};

function makeStore() {
  return createStore<TestState>()(
    undoable((set) => ({
      past: [],
      future: [],
      lastActionSig: null,
      project: { name: 'p', roofs: [], panels: [], strings: [], inverters: [], panelType: { id: 'pt1' } },
      selectedRoofId: null,
      setName: (n) => set((s) => ({ project: { ...s.project, name: n } }), false, 'setProjectName'),
    }))
  );
}

describe('undoable middleware (shell)', () => {
  it('exports HistoryState and undoable', () => {
    const s = makeStore();
    expect(s.getState().past).toEqual([]);
    expect(s.getState().future).toEqual([]);
    expect(s.getState().lastActionSig).toBeNull();
  });
});

describe('ACTION_POLICY', () => {
  it('classifies known bypass, record, and special action names', async () => {
    const mod = await import('./undoMiddleware');
    expect(mod.ACTION_POLICY.setSelectedRoof.kind).toBe('bypass');
    expect(mod.ACTION_POLICY.setProjectName.kind).toBe('record');
    expect(mod.ACTION_POLICY.assignPanelsToString.kind).toBe('record');
    expect(mod.ACTION_POLICY.resetProject.kind).toBe('clear-history');
    expect(mod.ACTION_POLICY.loadProject.kind).toBe('load-history');
  });
});

describe('buildSlice', () => {
  it('extracts only the undoable fields from a project', () => {
    const project = {
      name: 'proj',
      panelType: { id: 'pt', widthM: 1 },
      roofs: [{ id: 'r1' }],
      panels: [{ id: 'p1' }],
      strings: [{ id: 's1' }],
      inverters: [{ id: 'i1' }],
      mapState: { locked: true, capturedImage: 'BIG_BASE64' },
    };
    const slice = buildSlice(project as any);
    expect(slice).toEqual({
      name: 'proj',
      panelType: project.panelType,
      roofs: project.roofs,
      panels: project.panels,
      strings: project.strings,
      inverters: project.inverters,
    });
    // mapState is deliberately excluded to keep captured image out of history.
    expect('mapState' in slice).toBe(false);
  });

  it('shares references (structural sharing)', () => {
    const roofs = [{ id: 'r1' }];
    const project = { name: 'p', panelType: { id: 'pt' }, roofs, panels: [], strings: [], inverters: [], mapState: {} };
    const slice = buildSlice(project as any);
    expect(slice.roofs).toBe(roofs);
  });
});

describe('cleanUiRefs', () => {
  const slice = {
    name: 'p',
    panelType: { id: 'pt' },
    roofs: [{ id: 'r1' }],
    panels: [{ id: 'pa1', groupId: 'g1' }],
    strings: [{ id: 's1' }],
    inverters: [{ id: 'i1' }],
  } as unknown as UndoableSlice;

  it('preserves references that exist in the slice', () => {
    const ui = {
      selectedRoofId: 'r1',
      activeStringId: 's1',
      selectedInverterId: 'i1',
      activePanelGroupId: 'g1',
      splitCandidateRoofId: 'r1',
    };
    expect(cleanUiRefs(ui, slice)).toEqual(ui);
  });

  it('nulls dangling references', () => {
    const ui = {
      selectedRoofId: 'GONE',
      activeStringId: 'GONE',
      selectedInverterId: 'GONE',
      activePanelGroupId: 'GONE',
      splitCandidateRoofId: 'GONE',
    };
    expect(cleanUiRefs(ui, slice)).toEqual({
      selectedRoofId: null,
      activeStringId: null,
      selectedInverterId: null,
      activePanelGroupId: null,
      splitCandidateRoofId: null,
    });
  });

  it('keeps null inputs as null', () => {
    const ui = {
      selectedRoofId: null,
      activeStringId: null,
      selectedInverterId: null,
      activePanelGroupId: null,
      splitCandidateRoofId: null,
    };
    expect(cleanUiRefs(ui, slice)).toEqual(ui);
  });
});

describe('record policy', () => {
  it('pushes a snapshot before applying a record-path mutation', () => {
    const store = makeStore();
    store.getState().setName('new-name');
    const state = store.getState();
    expect(state.past.length).toBe(1);
    expect(state.past[0].name).toBe('p'); // pre-mutation name
    expect(state.project.name).toBe('new-name');
    expect(state.future).toEqual([]);
  });

  it('ignores actions whose set() produces no reference change (no-op)', () => {
    const store = createStore<TestState>()(
      undoable((set) => ({
        past: [],
        future: [],
        lastActionSig: null,
        project: { name: 'p', roofs: [], panels: [], strings: [], inverters: [], panelType: { id: 'pt1' } },
        selectedRoofId: null,
        setName: (n) => set((s) => ({ project: { ...s.project, name: n } }), false, 'setProjectName'),
      }))
    );
    // No-op: same name. Set still runs, but buildSlice returns
    // reference-equal fields → no push.
    store.getState().setName('p');
    expect(store.getState().past.length).toBe(0);
  });
});

describe('coalescing', () => {
  it('collapses same action+key within 500ms into one step', () => {
    const nowRef = { t: 1000 };
    vi.stubGlobal('performance', { now: () => nowRef.t });
    try {
      const store = createStore<TestState & { setRoofName: (id: string, n: string) => void }>()(
        undoable((set) => ({
          past: [],
          future: [],
          lastActionSig: null,
          project: { name: 'p', roofs: [{ id: 'r1', name: 'a' }] as any, panels: [], strings: [], inverters: [], panelType: { id: 'pt1' } },
          selectedRoofId: null,
          setName: (n) => set((s) => ({ project: { ...s.project, name: n } }), false, 'setProjectName'),
          setRoofName: (id, n) => {
            setCoalesceKey(set as any, 'updateRoof', id);
            set(
              (s: any) => ({
                project: {
                  ...s.project,
                  roofs: s.project.roofs.map((r: any) => (r.id === id ? { ...r, name: n } : r)),
                },
              }),
              false,
              'updateRoof',
            );
          },
        }))
      );
      store.getState().setRoofName('r1', 'b');
      nowRef.t += 100;
      store.getState().setRoofName('r1', 'c');
      nowRef.t += 100;
      store.getState().setRoofName('r1', 'd');
      expect(store.getState().past.length).toBe(1);
      expect((store.getState().past[0].roofs[0] as any).name).toBe('a'); // original
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not coalesce when the window expires', () => {
    const nowRef = { t: 2000 };
    vi.stubGlobal('performance', { now: () => nowRef.t });
    try {
      const store = makeStore();
      store.getState().setName('b');
      nowRef.t += 600; // > 500ms
      store.getState().setName('c');
      expect(store.getState().past.length).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('clears _pendingCoalesce on the no-op record path so it does not leak', () => {
    // Regression for a bug where setCoalesceKey wrote _pendingCoalesce,
    // the subsequent set() produced a no-op (reference-equal slice → early
    // return), and the pending key was left dangling. A later DIFFERENT
    // action's record-path set() would then see the stale pending (though
    // the action-name guard prevented it from being applied, the invariant
    // that pending is consumed unconditionally is load-bearing for future
    // changes and reasoning clarity).
    const nowRef = { t: 4000 };
    vi.stubGlobal('performance', { now: () => nowRef.t });
    try {
      const store = createStore<
        TestState & { setRoofName: (id: string, n: string) => void }
      >()(
        undoable((set) => ({
          past: [],
          future: [],
          lastActionSig: null,
          project: {
            name: 'p',
            roofs: [{ id: 'r1', name: 'a' }] as any,
            panels: [],
            strings: [],
            inverters: [],
            panelType: { id: 'pt1' },
          },
          selectedRoofId: null,
          // setName intentionally uses action 'setProjectName' — a DIFFERENT
          // action from updateRoof used below. We want to assert that after
          // a no-op updateRoof, a subsequent setProjectName call does not
          // observe any stale pending coalesce state.
          setName: (n) =>
            set(
              (s) => ({ project: { ...s.project, name: n } }),
              false,
              'setProjectName',
            ),
          // A no-op updateRoof: the mapper returns the SAME roof object
          // reference when the name is already `n`, so `roofs.map(...)`
          // produces a new array but buildSlice's field-level reference
          // check still sees roofs as a different ref. To make this a real
          // no-op at the slice level, we return the project unchanged when
          // the roof already has the target name.
          setRoofName: (id, n) => {
            setCoalesceKey(set as any, 'updateRoof', id);
            set(
              (s: any) => {
                const roof = s.project.roofs.find((r: any) => r.id === id);
                if (roof && roof.name === n) return s; // true no-op
                return {
                  project: {
                    ...s.project,
                    roofs: s.project.roofs.map((r: any) =>
                      r.id === id ? { ...r, name: n } : r,
                    ),
                  },
                };
              },
              false,
              'updateRoof',
            );
          },
        })),
      );
      // Trigger the no-op record path: updateRoof with the existing name.
      // setCoalesceKey writes _pendingCoalesce, the set() is a no-op, and
      // the middleware's no-op branch must now clear the pending key.
      store.getState().setRoofName('r1', 'a');
      expect(store.getState()._pendingCoalesce ?? null).toBeNull();
      expect(store.getState().past.length).toBe(0);

      // Now a DIFFERENT action's record-path set() — it must push normally,
      // unaffected by any lingering pending state.
      nowRef.t += 10;
      store.getState().setName('new-name');
      expect(store.getState().past.length).toBe(1);
      expect(store.getState().project.name).toBe('new-name');
      // lastActionSig reflects the setProjectName push, not updateRoof.
      expect(store.getState().lastActionSig?.action).toBe('setProjectName');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not coalesce across different keys', () => {
    const nowRef = { t: 3000 };
    vi.stubGlobal('performance', { now: () => nowRef.t });
    try {
      const store = createStore<TestState & { setRoofName: (id: string, n: string) => void }>()(
        undoable((set) => ({
          past: [],
          future: [],
          lastActionSig: null,
          project: { name: 'p', roofs: [{ id: 'r1', name: 'a' }, { id: 'r2', name: 'x' }] as any, panels: [], strings: [], inverters: [], panelType: { id: 'pt1' } },
          selectedRoofId: null,
          setName: (n) => set((s) => ({ project: { ...s.project, name: n } }), false, 'setProjectName'),
          setRoofName: (id, n) => {
            setCoalesceKey(set as any, 'updateRoof', id);
            set(
              (s: any) => ({
                project: {
                  ...s.project,
                  roofs: s.project.roofs.map((r: any) => (r.id === id ? { ...r, name: n } : r)),
                },
              }),
              false,
              'updateRoof',
            );
          },
        }))
      );
      store.getState().setRoofName('r1', 'b');
      store.getState().setRoofName('r2', 'y');
      expect(store.getState().past.length).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('applyUndo / applyRedo', () => {
  const baseSlice = (name: string): UndoableSlice => ({
    name,
    panelType: { id: 'pt' },
    roofs: [],
    panels: [],
    strings: [],
    inverters: [],
  });

  it('applyUndo pops past → pushes current onto future → returns restored slice', () => {
    const state = {
      past: [baseSlice('v1'), baseSlice('v2')],
      future: [] as UndoableSlice[],
      lastActionSig: { action: 'x', key: null, at: 0 },
      project: {
        name: 'current',
        panelType: { id: 'pt' },
        roofs: [],
        panels: [],
        strings: [],
        inverters: [],
        mapState: { locked: true },
      },
      selectedRoofId: null,
      activeStringId: null,
      selectedInverterId: null,
      activePanelGroupId: null,
      splitCandidateRoofId: null,
    };
    const next = applyUndo(state as any);
    expect(next).not.toBeNull();
    expect(next!.project.name).toBe('v2');
    expect(next!.project.mapState).toEqual({ locked: true }); // mapState preserved
    expect(next!.past.length).toBe(1);
    expect(next!.future.length).toBe(1);
    expect(next!.future[0].name).toBe('current');
    expect(next!.lastActionSig).toBeNull();
  });

  it('applyUndo returns null when past is empty', () => {
    const state = {
      past: [] as UndoableSlice[],
      future: [] as UndoableSlice[],
      lastActionSig: null,
      project: { name: 'x', panelType: { id: 'pt' }, roofs: [], panels: [], strings: [], inverters: [], mapState: {} },
      selectedRoofId: null, activeStringId: null, selectedInverterId: null, activePanelGroupId: null, splitCandidateRoofId: null,
    };
    expect(applyUndo(state as any)).toBeNull();
  });

  it('applyRedo pops future → pushes current onto past → returns restored slice', () => {
    const state = {
      past: [] as UndoableSlice[],
      future: [baseSlice('redo-target')],
      lastActionSig: null,
      project: { name: 'current', panelType: { id: 'pt' }, roofs: [], panels: [], strings: [], inverters: [], mapState: {} },
      selectedRoofId: null, activeStringId: null, selectedInverterId: null, activePanelGroupId: null, splitCandidateRoofId: null,
    };
    const next = applyRedo(state as any);
    expect(next).not.toBeNull();
    expect(next!.project.name).toBe('redo-target');
    expect(next!.past.length).toBe(1);
    expect(next!.future.length).toBe(0);
  });
});

describe('assertReferentialIntegrity', () => {
  it('reports a panel with an unknown roofId', () => {
    const errors: string[] = [];
    const slice: UndoableSlice = {
      name: 'p',
      panelType: { id: 'pt' },
      roofs: [{ id: 'r1' }] as any,
      panels: [{ id: 'pa1', roofId: 'GONE', stringId: null }] as any,
      strings: [],
      inverters: [],
    };
    assertReferentialIntegrity(slice, (msg) => errors.push(msg));
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/pa1/);
    expect(errors[0]).toMatch(/GONE/);
  });

  it('reports a string with an unknown inverterId', () => {
    const errors: string[] = [];
    const slice: UndoableSlice = {
      name: 'p',
      panelType: { id: 'pt' },
      roofs: [],
      panels: [],
      strings: [{ id: 's1', inverterId: 'GONE' }] as any,
      inverters: [],
    };
    assertReferentialIntegrity(slice, (msg) => errors.push(msg));
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/s1/);
  });

  it('passes on a consistent slice', () => {
    const errors: string[] = [];
    const slice: UndoableSlice = {
      name: 'p',
      panelType: { id: 'pt' },
      roofs: [{ id: 'r1' }] as any,
      panels: [{ id: 'pa1', roofId: 'r1', stringId: 's1' }] as any,
      strings: [{ id: 's1', inverterId: 'i1' }] as any,
      inverters: [{ id: 'i1' }] as any,
    };
    assertReferentialIntegrity(slice, (msg) => errors.push(msg));
    expect(errors).toEqual([]);
  });
});

describe('depth cap', () => {
  it('caps past at MAX_PAST and drops the oldest entry', async () => {
    const { MAX_PAST } = await import('./undoMiddleware');
    const store = makeStore();
    // Ensure coalescing does NOT collapse these. Space them with unique times + distinct keys.
    const nowRef = { t: 10_000 };
    vi.stubGlobal('performance', { now: () => (nowRef.t += 600) });
    try {
      for (let i = 0; i < MAX_PAST + 1; i++) {
        store.getState().setName(`n-${i}`);
      }
      expect(store.getState().past.length).toBe(MAX_PAST);
      // The oldest snapshot captured the original name 'p' — with one
      // overflow, that one was dropped.
      expect(store.getState().past[0].name).not.toBe('p');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
