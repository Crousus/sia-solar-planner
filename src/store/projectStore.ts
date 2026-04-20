// ────────────────────────────────────────────────────────────────────────────
// Zustand store — the single source of truth for all persisted state.
//
// Design choices:
//   - One big store, not several. The app is small enough that splitting it
//     adds more plumbing than it saves; selector-based subscription already
//     gives us fine-grained re-renders.
//   - `project` is persisted to localStorage via the `persist` middleware.
//     UI-only state (toolMode, selection) is intentionally NOT persisted:
//     we don't want a "half-drawn polygon" to survive a refresh, and these
//     fields would make the JSON export dirty.
//   - All mutations go through actions defined here. Components never mutate
//     the store directly — this keeps persistence, cascades, and renumbering
//     centralized and hard to forget.
// ────────────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  Project,
  Roof,
  Panel,
  PvString,
  Inverter,
  PanelType,
  ToolMode,
  Point,
} from '../types';
import { STRING_COLORS } from '../types';

/**
 * Short random-ish id. Good enough for a personal tool — we don't need
 * cryptographic uniqueness, just stable keys for React + references.
 * ~48 bits of entropy (base36, 8 chars) — plenty for a few thousand items.
 */
const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * Sensible default panel. These numbers roughly match a common 400W
 * monocrystalline module (~1.1 × 1.7 m). Users can edit this in the sidebar.
 */
const defaultPanelType: PanelType = {
  id: uid(),
  name: 'Generic 400W',
  widthM: 1.134,
  heightM: 1.722,
  wattPeak: 400,
};

/**
 * Initial project state. The lat/lng defaults to central Munich because we
 * had to pick somewhere and the user is German-speaking; the user will
 * navigate away on first use.
 */
const initialProject: Project = {
  name: 'Untitled Project',
  panelType: defaultPanelType,
  roofs: [],
  panels: [],
  strings: [],
  inverters: [],
  mapState: {
    locked: false,
    centerLat: 48.137,
    centerLng: 11.575,
    zoom: 19,
    metersPerPixel: 0.1, // placeholder; real value set on Lock Map
  },
};

/**
 * UI-only slice — intentionally excluded from persistence via `partialize`
 * (see bottom of file). Keeping this separate from `project` is important:
 *   - JSON export shouldn't include "what mode was I in when I hit save"
 *   - localStorage shouldn't restore a stuck tool mode on refresh
 */
interface UIState {
  toolMode: ToolMode;
  selectedRoofId: string | null;
  activeStringId: string | null;   // the string that lasso drags will target
}

/**
 * Full store interface. Each action is commented near its implementation
 * below where the logic lives.
 */
interface ProjectStore extends UIState {
  project: Project;
  setProjectName: (name: string) => void;
  updatePanelType: (changes: Partial<PanelType>) => void;
  lockMap: (centerLat: number, centerLng: number, zoom: number, mpp: number) => void;
  unlockMap: () => void;
  addRoof: (polygon: Point[]) => string;
  updateRoof: (id: string, changes: Partial<Roof>) => void;
  deleteRoof: (id: string) => void;
  addPanel: (roofId: string, cx: number, cy: number) => void;
  deletePanel: (id: string) => void;
  addString: () => string;
  deleteString: (id: string) => void;
  assignPanelsToString: (panelIds: string[], stringId: string) => void;
  unassignPanel: (panelId: string) => void;
  setStringInverter: (stringId: string, inverterId: string | null) => void;
  addInverter: () => string;
  renameInverter: (id: string, name: string) => void;
  deleteInverter: (id: string) => void;
  setToolMode: (mode: ToolMode) => void;
  setSelectedRoof: (id: string | null) => void;
  setActiveString: (id: string | null) => void;
  loadProject: (p: Project) => void;
  resetProject: () => void;
}

export const useProjectStore = create<ProjectStore>()(
  persist(
    (set, get) => ({
      project: initialProject,
      toolMode: 'idle',
      selectedRoofId: null,
      activeStringId: null,

      // ── Project-level ───────────────────────────────────────────────────
      setProjectName: (name) => set((s) => ({ project: { ...s.project, name } })),

      updatePanelType: (changes) =>
        set((s) => ({
          project: { ...s.project, panelType: { ...s.project.panelType, ...changes } },
        })),

      // ── Map lock/unlock ─────────────────────────────────────────────────
      // `lockMap` stores the Web-Mercator-derived mpp. After this point the
      // app treats the viewport as frozen; all drawing happens in the
      // container's pixel space.
      lockMap: (centerLat, centerLng, zoom, mpp) =>
        set((s) => ({
          project: {
            ...s.project,
            mapState: {
              locked: true,
              centerLat,
              centerLng,
              zoom,
              metersPerPixel: mpp,
            },
          },
        })),

      // Unlock also resets the tool mode. Rationale: an active tool mode with
      // an unlocked (pannable) map is confusing — clicking to draw would
      // also pan the map. Forcing idle avoids that.
      unlockMap: () =>
        set((s) => ({
          project: { ...s.project, mapState: { ...s.project.mapState, locked: false } },
          toolMode: 'idle',
        })),

      // ── Roofs ───────────────────────────────────────────────────────────
      // Adds a roof and immediately selects it so the sidebar editor shows up
      // (reduces clicks for the common "draw roof → set tilt" workflow).
      addRoof: (polygon) => {
        const id = uid();
        const roof: Roof = {
          id,
          name: `Roof ${get().project.roofs.length + 1}`,
          polygon,
          tiltDeg: 30,                 // reasonable default pitch for typical homes
          panelOrientation: 'portrait',// most common; user can toggle
        };
        set((s) => ({
          project: { ...s.project, roofs: [...s.project.roofs, roof] },
          selectedRoofId: id,
        }));
        return id;
      },

      updateRoof: (id, changes) =>
        set((s) => ({
          project: {
            ...s.project,
            roofs: s.project.roofs.map((r) => (r.id === id ? { ...r, ...changes } : r)),
          },
        })),

      // Cascading delete: panels on this roof go with it. Any strings that
      // lose members need re-numbering (indexInString would otherwise have
      // holes in the sequence).
      deleteRoof: (id) =>
        set((s) => {
          const remainingPanels = s.project.panels.filter((p) => p.roofId !== id);
          const affectedStringIds = new Set(
            s.project.panels
              .filter((p) => p.roofId === id)
              .map((p) => p.stringId)
              .filter(Boolean) as string[]
          );
          const renumbered = renumberStrings(remainingPanels, affectedStringIds);
          return {
            project: {
              ...s.project,
              roofs: s.project.roofs.filter((r) => r.id !== id),
              panels: renumbered,
            },
            selectedRoofId: s.selectedRoofId === id ? null : s.selectedRoofId,
          };
        }),

      // ── Panels ──────────────────────────────────────────────────────────
      // Caller (PanelLayer) has already snapped + validated the position.
      // We just record it; string assignment happens later via lasso.
      addPanel: (roofId, cx, cy) =>
        set((s) => {
          const panel: Panel = {
            id: uid(),
            roofId,
            cx,
            cy,
            stringId: null,
            indexInString: null,
          };
          return { project: { ...s.project, panels: [...s.project.panels, panel] } };
        }),

      // If the deleted panel belonged to a string, renumber the remainder so
      // the indexInString sequence stays 1..N without gaps.
      deletePanel: (id) =>
        set((s) => {
          const panel = s.project.panels.find((p) => p.id === id);
          const remaining = s.project.panels.filter((p) => p.id !== id);
          const affectedStringIds = panel?.stringId
            ? new Set([panel.stringId])
            : new Set<string>();
          const renumbered = renumberStrings(remaining, affectedStringIds);
          return { project: { ...s.project, panels: renumbered } };
        }),

      // ── Strings ─────────────────────────────────────────────────────────
      // Creating a string immediately switches to assign-string mode and
      // flags it as active, so the user can drag a lasso right away —
      // matches the mental model "I want to make a new string of these panels".
      addString: () => {
        const id = uid();
        const idx = get().project.strings.length;
        const str: PvString = {
          id,
          label: `String ${idx + 1}`,
          inverterId: null,
          color: STRING_COLORS[idx % STRING_COLORS.length],
        };
        set((s) => ({
          project: { ...s.project, strings: [...s.project.strings, str] },
          activeStringId: id,
          toolMode: 'assign-string',
        }));
        return id;
      },

      // Deleting a string leaves its panels alive but unassigned. Rationale:
      // the user probably wants to re-group them into a different string,
      // not lose the panels entirely.
      deleteString: (id) =>
        set((s) => ({
          project: {
            ...s.project,
            strings: s.project.strings.filter((str) => str.id !== id),
            panels: s.project.panels.map((p) =>
              p.stringId === id ? { ...p, stringId: null, indexInString: null } : p
            ),
          },
          activeStringId: s.activeStringId === id ? null : s.activeStringId,
        })),

      // Assign a batch of panels to `stringId`. Panels previously in OTHER
      // strings get moved (their old string loses those panels); panels
      // with no prior string are simply added.
      //
      // We collect all affected string ids — target + every prior owner —
      // so renumberStrings rewrites indexInString everywhere it changed.
      assignPanelsToString: (panelIds, stringId) =>
        set((s) => {
          const updated = s.project.panels.map((p) =>
            panelIds.includes(p.id) ? { ...p, stringId } : p
          );
          const affected = new Set<string>([stringId]);
          for (const pid of panelIds) {
            const old = s.project.panels.find((p) => p.id === pid);
            if (old?.stringId) affected.add(old.stringId);
          }
          return { project: { ...s.project, panels: renumberStrings(updated, affected) } };
        }),

      unassignPanel: (panelId) =>
        set((s) => {
          const panel = s.project.panels.find((p) => p.id === panelId);
          if (!panel?.stringId) return s;
          const oldStringId = panel.stringId;
          const updated = s.project.panels.map((p) =>
            p.id === panelId ? { ...p, stringId: null, indexInString: null } : p
          );
          return {
            project: { ...s.project, panels: renumberStrings(updated, new Set([oldStringId])) },
          };
        }),

      setStringInverter: (stringId, inverterId) =>
        set((s) => ({
          project: {
            ...s.project,
            strings: s.project.strings.map((str) =>
              str.id === stringId ? { ...str, inverterId } : str
            ),
          },
        })),

      // ── Inverters ───────────────────────────────────────────────────────
      // Default-named "Inverter A", "Inverter B", … via ASCII offset 65.
      // If there are >26 inverters the naming breaks down (AA etc. not
      // handled) — not a realistic case for a personal tool.
      addInverter: () => {
        const id = uid();
        const idx = get().project.inverters.length;
        const inv: Inverter = { id, name: `Inverter ${String.fromCharCode(65 + idx)}` };
        set((s) => ({ project: { ...s.project, inverters: [...s.project.inverters, inv] } }));
        return id;
      },

      renameInverter: (id, name) =>
        set((s) => ({
          project: {
            ...s.project,
            inverters: s.project.inverters.map((i) => (i.id === id ? { ...i, name } : i)),
          },
        })),

      // Cascading: strings pointing at this inverter get their inverterId
      // cleared. We don't delete the strings themselves — they're still
      // valid, just orphaned, and the user can re-assign.
      deleteInverter: (id) =>
        set((s) => ({
          project: {
            ...s.project,
            inverters: s.project.inverters.filter((i) => i.id !== id),
            strings: s.project.strings.map((str) =>
              str.inverterId === id ? { ...str, inverterId: null } : str
            ),
          },
        })),

      // ── UI state (not persisted) ────────────────────────────────────────
      setToolMode: (mode) => set({ toolMode: mode }),
      setSelectedRoof: (id) => set({ selectedRoofId: id }),
      setActiveString: (id) => set({ activeStringId: id }),

      // ── Persistence entry points ────────────────────────────────────────
      // loadProject: replace everything. Resets ephemeral UI state because
      // the loaded project's ids may not match current selection/activeString.
      loadProject: (p) =>
        set({
          project: p,
          toolMode: 'idle',
          selectedRoofId: null,
          activeStringId: null,
        }),
      resetProject: () =>
        set({
          project: initialProject,
          toolMode: 'idle',
          selectedRoofId: null,
          activeStringId: null,
        }),
    }),
    {
      // localStorage key. Kept short and namespaced so it doesn't clash.
      name: 'solar-planner-project',
      // `partialize` strips out ephemeral fields before writing to storage,
      // so refresh doesn't persist (eg) an accidental tool mode.
      partialize: (s) => ({ project: s.project }),
    }
  )
);

/**
 * Re-number `indexInString` for all panels belonging to the given strings.
 *
 * Sorting order (top-priority first):
 *   1. Descending cy (bottom-of-screen first; y grows downward in canvas)
 *   2. Ascending cx  (left-to-right within a horizontal band)
 *
 * This mimics the standard "snake" wiring convention for rooftop PV:
 * start at the lower-left panel, run right across the bottom row, then up
 * to the next row, etc. The resulting indexInString directly tells the
 * installer the physical order the panels should be wired in.
 *
 * CRITICAL: Every action that touches `panel.stringId` must call this
 * helper with the affected string ids. Forgetting leaves stale indices —
 * the silent failure mode is strings with a "missing #4" or duplicate #7.
 */
function renumberStrings(panels: Panel[], affectedStringIds: Set<string>): Panel[] {
  if (affectedStringIds.size === 0) return panels;
  const result = [...panels];
  for (const sid of affectedStringIds) {
    // Find (index-in-array, panel) pairs belonging to this string, sorted.
    const inString = result
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.stringId === sid)
      .sort((a, b) => b.p.cy - a.p.cy || a.p.cx - b.p.cx);
    // Write back 1-based index. Copy to avoid mutating the input.
    inString.forEach(({ i }, k) => {
      result[i] = { ...result[i], indexInString: k + 1 };
    });
  }
  return result;
}
