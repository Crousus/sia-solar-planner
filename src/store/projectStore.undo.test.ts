import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectStore } from './projectStore';

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
