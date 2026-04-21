import { describe, it, expect } from 'vitest';
import { createStore } from 'zustand/vanilla';
import {
  undoable,
  buildSlice,
  cleanUiRefs,
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
