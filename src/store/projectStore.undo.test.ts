import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectStore } from './projectStore';
import type { UndoableSlice } from './undoMiddleware';

describe('projectStore undo/redo integration', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('addRoof → undo removes the roof and clears dangling selection', () => {
    const id = useProjectStore.getState().addRoof([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]);
    expect(useProjectStore.getState().project.roofs.length).toBe(1);
    expect(useProjectStore.getState().selectedRoofId).toBe(id);

    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.roofs.length).toBe(0);
    expect(useProjectStore.getState().selectedRoofId).toBeNull();
  });

  it('redo re-applies the undone mutation', () => {
    useProjectStore.getState().addRoof([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]);
    useProjectStore.getState().undo();
    expect(useProjectStore.getState().project.roofs.length).toBe(0);
    useProjectStore.getState().redo();
    expect(useProjectStore.getState().project.roofs.length).toBe(1);
  });

  it('setToolMode does not create a history entry', () => {
    useProjectStore.getState().setToolMode('draw-roof');
    expect(useProjectStore.getState().past.length).toBe(0);
  });

  it('lockMap is bypass — mapState preserved across undo', () => {
    useProjectStore.getState().addRoof([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]);
    useProjectStore.getState().lockMap({
      centerLat: 48, centerLng: 11, zoom: 19, mpp: 0.1,
      capturedImage: 'BASE64', capturedWidth: 100, capturedHeight: 100,
    });
    useProjectStore.getState().undo(); // undoes addRoof; lockMap bypass unaffected
    const { project } = useProjectStore.getState();
    expect(project.roofs.length).toBe(0);
    expect(project.mapState.locked).toBe(true);
    expect(project.mapState.capturedImage).toBe('BASE64');
  });

  it('coalesces rapid assignPanelsToString into one step', () => {
    // Set up: one roof, two panels, one string.
    const rid = useProjectStore.getState().addRoof([
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    ]);
    useProjectStore.getState().addPanel(rid, 10, 10, 'g1', 'portrait');
    useProjectStore.getState().addPanel(rid, 30, 10, 'g1', 'portrait');
    const sid = useProjectStore.getState().addString();
    const pastBefore = useProjectStore.getState().past.length;

    const [p1, p2] = useProjectStore.getState().project.panels.map((p) => p.id);
    useProjectStore.getState().assignPanelsToString([p1], sid);
    useProjectStore.getState().assignPanelsToString([p2], sid);

    const pastAfter = useProjectStore.getState().past.length;
    // Two calls within the 500ms window with the same stringId collapse into one step.
    expect(pastAfter - pastBefore).toBe(1);
  });
});

describe('loadProject/resetProject history behavior', () => {
  // Zustand's module-level state leaks across `it` blocks in the same worker.
  // Without this beforeEach, the first test below would start with history
  // contaminated by the previous describe block — and `addRoof` ... `past > 0`
  // would pass for the wrong reason. Reset gives every test a clean slate.
  beforeEach(() => {
    useProjectStore.getState().resetProject();
  });

  it('resetProject clears past and future', () => {
    useProjectStore.getState().addRoof([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]);
    expect(useProjectStore.getState().past.length).toBeGreaterThan(0);
    useProjectStore.getState().resetProject();
    expect(useProjectStore.getState().past).toEqual([]);
    expect(useProjectStore.getState().future).toEqual([]);
    // Mirror booleans must flip in lockstep with the stacks; otherwise the
    // toolbar Undo/Redo buttons would remain armed after a reset and firing
    // them would no-op (or worse, pop a cleared entry if mirrors drifted).
    expect(useProjectStore.getState().canUndo).toBe(false);
    expect(useProjectStore.getState().canRedo).toBe(false);
  });

  it('loadProject(project) leaves history empty when no history argument given', () => {
    const initial = useProjectStore.getState().project;
    useProjectStore.getState().addRoof([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]);
    useProjectStore.getState().loadProject(initial);
    expect(useProjectStore.getState().past).toEqual([]);
    expect(useProjectStore.getState().future).toEqual([]);
    expect(useProjectStore.getState().canUndo).toBe(false);
    expect(useProjectStore.getState().canRedo).toBe(false);
  });

  it('loadProject(project, {past, future}) restores both stacks', () => {
    const initial = useProjectStore.getState().project;
    // The strict `PanelType` interface doesn't structurally satisfy the
    // slice's looser `{ id: string } & Record<string, unknown>` constraint
    // (interfaces lack the implicit string index signature that type aliases
    // gain), so we cast through `unknown` to `UndoableSlice` — the runtime
    // shape matches exactly and the middleware treats slices as opaque
    // blobs anyway. This is a test-only concession, not a real-code code-smell.
    const fakeSlice = {
      name: 'old',
      panelType: initial.panelType,
      roofs: [],
      panels: [],
      strings: [],
      inverters: [],
    } as unknown as UndoableSlice;
    useProjectStore.getState().loadProject(initial, { past: [fakeSlice], future: [fakeSlice] });
    expect(useProjectStore.getState().past.length).toBe(1);
    expect(useProjectStore.getState().future.length).toBe(1);
    // Restoring non-empty history must also arm the mirrors — this is what
    // lets the UI open a JSON import with its Undo/Redo buttons already
    // in the right state for the restored stack depths.
    expect(useProjectStore.getState().canUndo).toBe(true);
    expect(useProjectStore.getState().canRedo).toBe(true);
  });
});
