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
import { panelDisplaySize, roofPrimaryAngle, rotatePoint } from '../utils/geometry';

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
    mapProvider: 'esri',
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
  selectedInverterId: string | null; // the inverter that new strings will default to
  activePanelGroupId: string | null; // the group ID for placing new panels
  // Whether the captured satellite backdrop (capturedImage) is rendered
  // inside the Konva stage while the map is locked. Exposed as a toolbar
  // toggle so the user can hide busy imagery for a cleaner view while
  // tweaking string layouts or taking screenshots. Lives in UIState —
  // not persisted to localStorage or JSON exports — because it's a view
  // preference, not part of the saved project.
  showBackground: boolean;
}

/**
 * Full store interface. Each action is commented near its implementation
 * below where the logic lives.
 */
interface ProjectStore extends UIState {
  project: Project;
  setProjectName: (name: string) => void;
  updatePanelType: (changes: Partial<PanelType>) => void;
  lockMap: (args: {
    centerLat: number;
    centerLng: number;
    zoom: number;
    mpp: number;
    capturedImage: string;
    capturedWidth: number;
    capturedHeight: number;
  }) => void;
  unlockMap: () => void;
  addRoof: (polygon: Point[]) => string;
  updateRoof: (id: string, changes: Partial<Roof>) => void;
  deleteRoof: (id: string) => void;
  addPanel: (
    roofId: string,
    cx: number,
    cy: number,
    groupId: string,
    orientation: 'portrait' | 'landscape'
  ) => void;
  updateGroupOrientation: (groupId: string, orientation: 'portrait' | 'landscape') => void;
  moveGroup: (groupId: string, dx: number, dy: number) => void;
  deletePanel: (id: string) => void;
  deletePanels: (ids: string[]) => void;
  addString: () => string;
  deleteString: (id: string) => void;
  assignPanelsToString: (panelIds: string[], stringId: string) => void;
  unassignPanel: (panelId: string) => void;
  setStringInverter: (stringId: string, inverterId: string | null) => void;
  updateString: (id: string, changes: Partial<PvString>) => void;
  addInverter: () => string;
  renameInverter: (id: string, name: string) => void;
  deleteInverter: (id: string) => void;
  setToolMode: (mode: ToolMode) => void;
  setSelectedRoof: (id: string | null) => void;
  setActiveString: (id: string | null) => void;
  setSelectedInverter: (id: string | null) => void;
  setActivePanelGroup: (id: string | null) => void;
  setMapProvider: (provider: 'esri' | 'bayern' | 'bayern_alkis') => void;
  toggleBackground: () => void;
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
      selectedInverterId: null,
      activePanelGroupId: null,
      // Background is visible by default — hiding it is the less common
      // workflow (mainly for clean screenshots and cluttered layouts).
      showBackground: true,

      // ── Project-level ───────────────────────────────────────────────────
      setProjectName: (name) => set((s) => ({ project: { ...s.project, name } })),

      updatePanelType: (changes) =>
        set((s) => ({
          project: { ...s.project, panelType: { ...s.project.panelType, ...changes } },
        })),

      // ── Map lock/unlock ─────────────────────────────────────────────────
      // `lockMap` stores the Web-Mercator-derived mpp AND a rasterized
      // snapshot of the current satellite view. After this point the
      // Leaflet map is no longer rendered — Konva shows the captured
      // image as a static background and owns pan/zoom natively.
      //
      // Why a single args object? The signature grew past 4 scalars once
      // we added the image triple, and positional calls were becoming
      // error-prone (easy to swap width/height). See ADR-007.
      lockMap: ({ centerLat, centerLng, zoom, mpp, capturedImage, capturedWidth, capturedHeight }) =>
        set((s) => ({
          project: {
            ...s.project,
            mapState: {
              locked: true,
              centerLat,
              centerLng,
              zoom,
              metersPerPixel: mpp,
              capturedImage,
              capturedWidth,
              capturedHeight,
            },
          },
        })),

      // Unlock also resets the tool mode. Rationale: an active tool mode with
      // an unlocked (pannable) map is confusing — clicking to draw would
      // also pan the map. Forcing idle avoids that.
      //
      // We also drop the captured image: it's stale the moment the user
      // starts panning Leaflet again, and carrying a ~1-3 MB base64 blob
      // forward for no reason bloats localStorage (which is capped ~5 MB).
      // Re-locking will re-capture.
      unlockMap: () =>
        set((s) => ({
          project: {
            ...s.project,
            mapState: {
              ...s.project.mapState,
              locked: false,
              capturedImage: undefined,
              capturedWidth: undefined,
              capturedHeight: undefined,
            },
          },
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
      addPanel: (roofId, cx, cy, groupId, orientation) =>
        set((s) => {
          const panel: Panel = {
            id: uid(),
            roofId,
            groupId,
            cx,
            cy,
            stringId: null,
            indexInString: null,
            orientation,
          };
          return {
            project: { ...s.project, panels: [...s.project.panels, panel] },
            // Auto-activate this group so subsequent panels snap to it
            activePanelGroupId: groupId
          };
        }),

      // Flip every panel in a group between portrait and landscape AND
      // re-pack the panels so the new grid is tight (no overlap, no gaps).
      //
      // Why re-pack: the cell (w, h) dimensions swap between orientations
      // — portrait narrow-cell-wide/tall becomes landscape wide-cell/short.
      // If we only toggled the flag, every panel's stored center (cx, cy)
      // would still be spaced for the OLD cell, producing overlapping
      // neighbours in one axis and gaps in the other. Re-packing preserves
      // each panel's (column, row) identity in the grid — we compute the
      // integer (gx, gy) under the old cell, then re-emit world coords
      // under the new cell, anchored to the first panel so the group
      // stays in roughly the same place.
      //
      // Trade-off: re-packing can push some cells off the polygon edge or
      // into occupied space on the same roof (different group). We don't
      // auto-clip — keeping invalid panels visible (corners outside the
      // roof stroke) is less surprising than silent deletions. The user
      // can nudge or remove them after seeing the result.
      //
      // cy values change → affected strings need renumbering because the
      // wiring order sort is (−cy, cx).
      updateGroupOrientation: (groupId, orientation) =>
        set((s) => {
          const groupPanels = s.project.panels.filter((p) => p.groupId === groupId);
          if (groupPanels.length === 0) return s;

          // Anchor on the first panel so its world position is preserved
          // (matches the placement-time convention where the first panel
          // establishes the grid origin — see PanelLayer's ghost logic).
          const anchor = groupPanels[0];
          const roof = s.project.roofs.find((r) => r.id === anchor.roofId);
          const mpp = s.project.mapState.metersPerPixel;
          if (!roof || mpp <= 0) {
            // Defensive: shouldn't happen in normal use (group only
            // exists if a roof was selected and the map locked). Fall
            // back to a flag-only flip rather than doing nothing — at
            // least future placements inherit the intended orientation.
            return {
              project: {
                ...s.project,
                panels: s.project.panels.map((p) =>
                  p.groupId === groupId ? { ...p, orientation } : p
                ),
              },
            };
          }

          const oldOrientation = anchor.orientation ?? roof.panelOrientation;
          if (oldOrientation === orientation) return s; // no-op

          const oldSize = panelDisplaySize(s.project.panelType, oldOrientation, roof.tiltDeg, mpp);
          const newSize = panelDisplaySize(s.project.panelType, orientation, roof.tiltDeg, mpp);
          const angle = roofPrimaryAngle(roof.polygon);
          const origin = { x: anchor.cx, y: anchor.cy };

          // For each panel: rotate into the roof's local frame, compute
          // integer grid coords under the OLD cell, then project back out
          // under the NEW cell. Rounding absorbs floating-point drift
          // accumulated from prior placements.
          const repositioned = new Map<string, { cx: number; cy: number }>();
          for (const p of groupPanels) {
            const local = rotatePoint({ x: p.cx, y: p.cy }, -angle, origin);
            const gx = Math.round((local.x - origin.x) / oldSize.w);
            const gy = Math.round((local.y - origin.y) / oldSize.h);
            const newLocal = {
              x: origin.x + gx * newSize.w,
              y: origin.y + gy * newSize.h,
            };
            const newWorld = rotatePoint(newLocal, angle, origin);
            repositioned.set(p.id, { cx: newWorld.x, cy: newWorld.y });
          }

          const updated = s.project.panels.map((p) => {
            if (p.groupId !== groupId) return p;
            const np = repositioned.get(p.id);
            return {
              ...p,
              orientation,
              cx: np ? np.cx : p.cx,
              cy: np ? np.cy : p.cy,
            };
          });

          // Renumber any strings whose member panels moved — cy changes
          // reshuffle the bottom-to-top wiring order.
          const affected = new Set<string>();
          for (const p of groupPanels) {
            if (p.stringId) affected.add(p.stringId);
          }
          return {
            project: { ...s.project, panels: renumberStrings(updated, affected) },
          };
        }),

      // Translate every panel in a group by (dx, dy) in canvas pixels.
      //
      // This is the commit step of the "drag a whole group around the
      // canvas" interaction (see PanelLayer's per-group draggable Konva
      // Group). Dragging is free-form: we do NOT validate the new
      // positions against the roof polygon or against other groups —
      // matching the project's existing "invalid states are visible,
      // not silently corrected" convention (same rationale as in
      // updateGroupOrientation, where re-packing can push cells off
      // the polygon). If the user drops the group somewhere invalid,
      // they can nudge or delete individual panels afterwards.
      //
      // The snap grid moves with the group automatically because both
      // snapPanelToGrid (for the ghost during placement) and
      // getPanelGroupDimensions (for the length labels) derive their
      // grid origin from the group's first panel — so shifting every
      // panel by the same delta shifts the effective grid origin by
      // that same delta.
      //
      // cy changes → string wiring order depends on cy (see
      // renumberStrings), so we renumber every string that had a
      // member in this group.
      moveGroup: (groupId, dx, dy) =>
        set((s) => {
          if (dx === 0 && dy === 0) return s;
          const updated = s.project.panels.map((p) =>
            p.groupId === groupId
              ? { ...p, cx: p.cx + dx, cy: p.cy + dy }
              : p
          );
          const affected = new Set<string>();
          for (const p of s.project.panels) {
            if (p.groupId === groupId && p.stringId) affected.add(p.stringId);
          }
          return {
            project: { ...s.project, panels: renumberStrings(updated, affected) },
          };
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

          // If this was the last panel in the active group, we might want to clear it,
          // but letting the user explicitly clear it or start a new one is fine.
          const isLastInGroup = panel && !remaining.some(p => p.groupId === panel.groupId);
          const newActiveGroup = (isLastInGroup && s.activePanelGroupId === panel?.groupId) ? null : s.activePanelGroupId;

          return {
            project: { ...s.project, panels: renumbered },
            activePanelGroupId: newActiveGroup
          };
        }),

      // Batch delete. Used by panel-type-edit validation: when the user
      // shrinks or reshapes the panel so that existing placements no
      // longer fit, we can remove all of the offenders in one pass (and
      // renumber affected strings exactly once) rather than N separate
      // store updates.
      deletePanels: (ids) =>
        set((s) => {
          if (ids.length === 0) return s;
          const idSet = new Set(ids);
          const removed = s.project.panels.filter((p) => idSet.has(p.id));
          const remaining = s.project.panels.filter((p) => !idSet.has(p.id));
          const affected = new Set<string>();
          for (const p of removed) if (p.stringId) affected.add(p.stringId);
          const renumbered = renumberStrings(remaining, affected);
          // Clear activePanelGroupId if its group has no survivors.
          const activeGid = s.activePanelGroupId;
          const groupSurvives = activeGid
            ? remaining.some((p) => p.groupId === activeGid)
            : true;
          return {
            project: { ...s.project, panels: renumbered },
            activePanelGroupId: groupSurvives ? activeGid : null,
          };
        }),

      // ── Strings ─────────────────────────────────────────────────────────
      // Creating a string immediately switches to assign-string mode and
      // flags it as active, so the user can drag a lasso right away —
      // matches the mental model "I want to make a new string of these panels".
      addString: () => {
        const id = uid();
        const currentStrings = get().project.strings;
        const usedColors = new Set(currentStrings.map((s) => s.color.toLowerCase()));

        // Try to find a color in our palette that isn't used yet.
        // This ensures distinct colors even if the user has manually changed some.
        let color = STRING_COLORS.find((c) => !usedColors.has(c.toLowerCase()));

        // Fallback to simple modulo if all palette colors are taken.
        if (!color) {
          color = STRING_COLORS[currentStrings.length % STRING_COLORS.length];
        }

        const str: PvString = {
          id,
          label: `String ${currentStrings.length + 1}`,
          // New strings default to the currently selected inverter (if any).
          // This allows batch-creating strings for a specific inverter.
          inverterId: get().selectedInverterId,
          color,
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
      //
      // Wiring order: panels joining `stringId` get their `indexInString`
      // cleared to null here so renumberStrings treats them as "newly
      // added" and appends them at the end of the target string in
      // `panelIds` order (= paint-stroke order for the interactive lasso,
      // which calls this one panel at a time). Without the reset a panel
      // moving from string A (where it was #3) to string B would keep
      // index 3 and jump into the middle of B's sequence.
      assignPanelsToString: (panelIds, stringId) =>
        set((s) => {
          const idSet = new Set(panelIds);
          const updated = s.project.panels.map((p) =>
            idSet.has(p.id) ? { ...p, stringId, indexInString: null } : p
          );
          const affected = new Set<string>([stringId]);
          for (const pid of panelIds) {
            const old = s.project.panels.find((p) => p.id === pid);
            if (old?.stringId) affected.add(old.stringId);
          }
          return {
            project: {
              ...s.project,
              panels: renumberStrings(updated, affected, panelIds),
            },
          };
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

      updateString: (id, changes) =>
        set((s) => ({
          project: {
            ...s.project,
            strings: s.project.strings.map((str) =>
              str.id === id ? { ...str, ...changes } : str
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
        set((s) => ({
          project: { ...s.project, inverters: [...s.project.inverters, inv] },
          // Immediately select the new inverter to streamline the common 
          // "add inverter -> create strings" workflow.
          selectedInverterId: id,
        }));
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
          // Clear the selection if the inverter being deleted was the one 
          // selected (prevents stale selection IDs in UIState).
          selectedInverterId: s.selectedInverterId === id ? null : s.selectedInverterId,
        })),

      // ── UI state (not persisted) ────────────────────────────────────────
      setToolMode: (mode) => set((s) => ({ 
        toolMode: mode,
        // Optional: clear active panel group when leaving place-panels mode
        // so entering it again starts a new group.
        activePanelGroupId: mode === 'place-panels' ? s.activePanelGroupId : null 
      })),
      setSelectedRoof: (id) => set({ selectedRoofId: id }),
      setActiveString: (id) => set({ activeStringId: id }),
      setSelectedInverter: (id) => set({ selectedInverterId: id }),
      setActivePanelGroup: (id) => set({ activePanelGroupId: id }),
      setMapProvider: (provider) =>
        set((s) => ({
          project: {
            ...s.project,
            mapState: { ...s.project.mapState, mapProvider: provider },
          },
        })),
      // Flip the captured-background visibility. Intentionally does NOT
      // clear `capturedImage` — hiding is purely a render-layer concern,
      // so the user can toggle it back on without having to re-lock.
      toggleBackground: () => set((s) => ({ showBackground: !s.showBackground })),

      // ── Persistence entry points ────────────────────────────────────────
      // loadProject: replace everything. Resets ephemeral UI state because
      // the loaded project's ids may not match current selection/activeString.
      loadProject: (p) =>
        set({
          project: p,
          toolMode: 'idle',
          selectedRoofId: null,
          activeStringId: null,
          selectedInverterId: null,
          activePanelGroupId: null,
        }),
      resetProject: () =>
        set({
          project: initialProject,
          toolMode: 'idle',
          selectedRoofId: null,
          activeStringId: null,
          selectedInverterId: null,
          activePanelGroupId: null,
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
 * Ordering policy — "preserve the sequence the user added them":
 *   - Panels that already have an `indexInString` keep their relative
 *     order (we sort by the existing index ascending, then compact to
 *     1..N so deletes/cascades don't leave gaps).
 *   - Panels with `indexInString == null` are the newcomers — they get
 *     appended at the end in the order supplied by `insertionOrder`
 *     (typically the `panelIds` argument of `assignPanelsToString`,
 *     which for the paint-based lasso is one panel per stroke, giving
 *     a natural "first-painted = #1" sequence).
 *   - Any newcomer not in `insertionOrder` falls back to its position
 *     in the `panels` array (creation order), so legacy / imported
 *     data without a recorded index still gets a stable numbering.
 *
 * Why this matters — installers wire panels in the order the designer
 * drew them, not in a geometric snake. The previous implementation
 * sorted by (−cy, +cx) which imposed bottom-left → top-right order
 * regardless of intent; that made it impossible to plan wiring that
 * followed roof obstacles (chimneys, hips) without renumbering every
 * time a panel was added. By preserving user-input order we let the
 * paint interaction itself be the numbering UI.
 *
 * CRITICAL: Every action that touches `panel.stringId` must call this
 * helper with the affected string ids. Forgetting leaves stale indices —
 * the silent failure mode is strings with a "missing #4" or duplicate #7.
 *
 * Geometric changes (moveGroup, updateGroupOrientation) intentionally
 * pass no `insertionOrder`: every panel already has a non-null index,
 * so the sort preserves prior order and the move doesn't re-shuffle
 * the wiring sequence.
 */
function renumberStrings(
  panels: Panel[],
  affectedStringIds: Set<string>,
  insertionOrder: string[] = [],
): Panel[] {
  if (affectedStringIds.size === 0) return panels;
  // Map panel-id → position in insertionOrder. Used as the tiebreak
  // for newcomers only (panels with null indexInString). Earlier
  // positions win, matching "first painted gets the low number".
  const insertPos = new Map<string, number>();
  insertionOrder.forEach((id, i) => insertPos.set(id, i));

  const result = [...panels];
  for (const sid of affectedStringIds) {
    // Gather (panel, array-index) pairs for this string. We need the
    // array index to write the renumbered panel back in place without
    // shuffling the parent array (other consumers rely on that order
    // being stable — notably the React keying in PanelLayer).
    const inString = result
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.stringId === sid);

    // Two-tier sort:
    //   tier 1: already-numbered panels, ascending by existing index
    //   tier 2: newcomers (index == null), by insertionOrder then by
    //           array position as a last-resort tiebreak
    // Keeping the two groups strictly separated (existing before new)
    // means a newly-added panel ALWAYS lands at the end of the
    // sequence — never interleaved with the already-wired panels.
    inString.sort((a, b) => {
      const ai = a.p.indexInString;
      const bi = b.p.indexInString;
      if (ai != null && bi != null) return ai - bi;
      if (ai != null) return -1;
      if (bi != null) return 1;
      const ao = insertPos.has(a.p.id)
        ? insertPos.get(a.p.id)!
        : Number.MAX_SAFE_INTEGER;
      const bo = insertPos.has(b.p.id)
        ? insertPos.get(b.p.id)!
        : Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return a.i - b.i;
    });

    // Write back 1-based index, compacting any gaps from prior deletes.
    inString.forEach(({ i }, k) => {
      result[i] = { ...result[i], indexInString: k + 1 };
    });
  }
  return result;
}
