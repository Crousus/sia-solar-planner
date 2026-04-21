import { describe, it, expect } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { undoable, type HistoryState } from './undoMiddleware';

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
