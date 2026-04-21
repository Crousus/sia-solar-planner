import { describe, it, expect, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import {
  undoable,
  buildSlice,
  cleanUiRefs,
  setCoalesceKey,
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
