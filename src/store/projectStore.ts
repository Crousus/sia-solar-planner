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
import { panelDisplaySize, roofPrimaryAngle, rotatePoint, polygonArea, isInsidePolygon, simplifyCollinear } from '../utils/geometry';
import { splitPolygon, findSharedEdge, mergePolygons } from '../utils/polygonCut';
import { migrateProject } from '../utils/projectSerializer';
// Backend-sync imports. `applyProjectPatch` is the RFC 6902 patcher that
// syncClient will feed with inbound SSE ops. Deliberately a top-of-file
// ESM import rather than the plan's `require('../backend/diff')` lazy
// shim — this project is ESM/Vite, CommonJS require() isn't available
// at runtime, and the bundle cost is negligible (fast-json-patch is
// small and already pulled in by syncClient anyway).
import { applyProjectPatch, type Op } from '../backend/diff';
import {
  undoable,
  ACTION_POLICY,
  applyUndo,
  applyRedo,
  assertReferentialIntegrity,
  setCoalesceKey,
  buildSlice,
  cleanUiRefs,
  type HistoryState,
  type UndoableSlice,
} from './undoMiddleware';

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
 *
 * Exported (Task 9) so the team-view "+ New project" path can seed a
 * brand-new server-side row with the same well-formed shape the editor
 * uses on first open. The store remains the single source of truth for
 * what a fresh project looks like — no inline duplicates.
 */
export const initialProject: Project = {
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
  /**
   * Ephemeral cut-target tracking. When the user is in `draw-roof` mode
   * and has placed their first vertex on the boundary of an existing
   * roof, we remember THAT roof's id here so subsequent clicks / Enter
   * can decide whether to fire a split vs. an `addRoof` close-path.
   *
   * Kept in the store (rather than KonvaOverlay local state) because
   * App.tsx's hint banner also needs to read it — and plumbing a prop
   * through would mean changing KonvaOverlay's interface unnecessarily.
   * Excluded from persistence via the existing `partialize` which
   * only persists `project`.
   */
  splitCandidateRoofId: string | null;
}

/**
 * Full store interface. Each action is commented near its implementation
 * below where the logic lives.
 */
interface ProjectStore extends UIState, HistoryState {
  project: Project;
  // Undo/redo actions — wired in Task 11. The `canUndo` / `canRedo` mirrors
  // are plain boolean fields (rather than derived getters) so React selectors
  // can subscribe to them with zustand's shallow-equality path and only
  // re-render when they actually flip. Keeping them in sync with the
  // `past`/`future` stack lengths is the responsibility of the undo/redo
  // actions (and, in later tasks, the record path of the middleware).
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
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
    /** Optional: initial stage rotation in degrees (clockwise). Used when
     *  the user rotated the Leaflet preview prior to locking, so the
     *  locked Konva view matches what they saw in the preview. Omitted
     *  or 0 → no rotation. See MapStateLocked.initialRotationDeg. */
    initialRotationDeg?: number;
  }) => void;
  unlockMap: () => void;
  addRoof: (polygon: Point[]) => string;
  updateRoof: (id: string, changes: Partial<Roof>) => void;
  deleteRoof: (id: string) => void;
  /** Split a roof along a polyline cut. Returns true if the split
   *  succeeded, false if the cut was invalid (and the store is
   *  unchanged). Callers (KonvaOverlay) read the return value to
   *  decide whether to clear their in-progress drawing state or
   *  let the user continue.
   *
   *  Panels all stay assigned to the original roofId; the half with
   *  MORE panel centers inside it becomes the survivor (keeps id,
   *  name, tilt, orientation). The other half becomes a new empty
   *  roof. See ADR / design doc for rationale. */
  splitRoof: (roofId: string, cutLine: Point[]) => boolean;
  /** Merge two adjacent roofs. No-op if they don't share an edge.
   *  The larger-area roof survives (keeps id/name/tilt/orientation);
   *  the smaller is absorbed — its panels are reassigned to the
   *  survivor's id and affected strings are renumbered. */
  mergeRoofs: (roofAId: string, roofBId: string) => void;
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
  setSplitCandidateRoof: (id: string | null) => void;
  setMapProvider: (provider: 'esri' | 'bayern' | 'bayern_alkis') => void;
  toggleBackground: () => void;
  loadProject: (p: Project, history?: { past: UndoableSlice[]; future: UndoableSlice[] }) => void;
  resetProject: () => void;
  /**
   * Apply a remote patch (RFC 6902 ops) to the current project.
   * Called by syncClient when an SSE patch arrives from the server.
   *
   * Registered as 'bypass' in ACTION_POLICY — does NOT push to the undo
   * stack. Rationale: the spec's Q11 decision is local-only undo; a
   * remote-originated change is authoritative and wouldn't make sense
   * as something Alice can Ctrl-Z away.
   *
   * If the patch fails to apply (malformed ops, `test` op mismatch),
   * this throws; syncClient's inbound handler catches and triggers a
   * full resync.
   */
  applyRemotePatch: (ops: Op[]) => void;
}

export const useProjectStore = create<ProjectStore>()(
  persist(
    // `undoable` wraps INSIDE `persist` on purpose: the persistence layer's
    // `partialize` below narrows the saved state to `{ project }`, which
    // means the history stacks (past/future) intentionally do NOT survive
    // a page reload. That matches user intent — undo history beyond the
    // current session would be surprising — and also keeps the captured
    // satellite image (which can be multi-MB base64) from being duplicated
    // into every history entry on disk.
    undoable((set, get) => ({
      project: initialProject,
      toolMode: 'idle',
      selectedRoofId: null,
      activeStringId: null,
      selectedInverterId: null,
      activePanelGroupId: null,
      splitCandidateRoofId: null,
      // Background is visible by default — hiding it is the less common
      // workflow (mainly for clean screenshots and cluttered layouts).
      showBackground: true,

      // ── Undo/redo history state ─────────────────────────────────────────
      // These fields are owned by the `undoable` middleware, but they live
      // on the store's state (rather than in closure) so (a) React can
      // subscribe to them for a live-updating "Undo" button enabled-state
      // and (b) devtools / JSON inspection can see the stack depth. Typed
      // as `UndoableSlice[]` explicitly because the empty-array literal
      // would otherwise widen to `never[]` and break future pushes.
      past: [] as UndoableSlice[],
      future: [] as UndoableSlice[],
      // `lastActionSig` — see undoMiddleware.ts for the full design; in
      // short: signature of the most-recently-pushed history entry, used
      // to decide whether the next record-path mutation coalesces into it.
      // Starts null so the first ever edit always pushes a fresh step.
      lastActionSig: null,
      // Mirror booleans for the stack lengths. Maintained by hand in the
      // undo/redo actions below (and in later tasks by the record path of
      // the middleware). Kept as real state rather than a selector-derived
      // boolean so components depending on "can I undo right now" don't
      // need a custom equality function to avoid spurious re-renders.
      canUndo: false,
      canRedo: false,
      // `_pendingCoalesce` is intentionally NOT initialized here. The field
      // is optional on HistoryState and transient (the middleware sets it
      // at the top of each record-path mutation, reads it at the bottom,
      // and nulls it). Starting as `undefined` vs `null` is equivalent for
      // the middleware's `== null` check — omitting it avoids giving the
      // impression that the initial value has any meaning.

      // ── Project-level ───────────────────────────────────────────────────
      setProjectName: (name) => {
        // Coalesce by the stable literal 'name' — rapid keystrokes into the
        // project-name field collapse into a single undo step within the
        // 500ms window (instead of one step per character).
        setCoalesceKey(set as any, 'setProjectName', 'name');
        set(
          (s) => ({ project: { ...s.project, name } }),
          false,
          'setProjectName',
        );
      },

      updatePanelType: (changes) => {
        // Coalesce by the literal 'panelType' — scrubbing a wattage slider or
        // retyping dimensions should collapse into a single history step.
        setCoalesceKey(set as any, 'updatePanelType', 'panelType');
        set(
          (s) => ({
            project: { ...s.project, panelType: { ...s.project.panelType, ...changes } },
          }),
          false,
          'updatePanelType',
        );
      },

      // ── Map lock/unlock ─────────────────────────────────────────────────
      // `lockMap` stores the Web-Mercator-derived mpp AND a rasterized
      // snapshot of the current satellite view. After this point the
      // Leaflet map is no longer rendered — Konva shows the captured
      // image as a static background and owns pan/zoom natively.
      //
      // Why a single args object? The signature grew past 4 scalars once
      // we added the image triple, and positional calls were becoming
      // error-prone (easy to swap width/height). See ADR-007.
      lockMap: ({ centerLat, centerLng, zoom, mpp, capturedImage, capturedWidth, capturedHeight, initialRotationDeg }) =>
        set(
          (s) => ({
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
                // Only write when non-zero: keeps saved projects clean for the
                // common case (no pre-lock rotation). Absent ↔ 0 at read time
                // via the `?? 0` in useViewport.
                ...(initialRotationDeg ? { initialRotationDeg } : {}),
              },
            },
          }),
          false,
          'lockMap',
        ),

      // Unlock also resets the tool mode. Rationale: an active tool mode with
      // an unlocked (pannable) map is confusing — clicking to draw would
      // also pan the map. Forcing idle avoids that.
      //
      // We also drop the captured image: it's stale the moment the user
      // starts panning Leaflet again, and carrying a ~1-3 MB base64 blob
      // forward for no reason bloats localStorage (which is capped ~5 MB).
      // Re-locking will re-capture.
      //
      // Because MapState is now a discriminated union (MapStateUnlocked |
      // MapStateLocked), we construct the unlocked variant explicitly
      // instead of spreading the prior state — a spread of the locked
      // variant would carry capturedImage/Width/Height into the result
      // and TypeScript would (correctly) reject the union transition.
      // Pulling out the shared fields by name makes the conversion
      // compile-time safe and documents exactly which fields survive
      // a lock→unlock transition.
      unlockMap: () =>
        set(
          (s) => {
            const { centerLat, centerLng, zoom, metersPerPixel, mapProvider } = s.project.mapState;
            return {
              project: {
                ...s.project,
                mapState: {
                  locked: false,
                  centerLat,
                  centerLng,
                  zoom,
                  metersPerPixel,
                  mapProvider,
                },
              },
              toolMode: 'idle',
            };
          },
          false,
          'unlockMap',
        ),

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
        set(
          (s) => ({
            project: { ...s.project, roofs: [...s.project.roofs, roof] },
            selectedRoofId: id,
          }),
          false,
          'addRoof',
        );
        return id;
      },

      updateRoof: (id, changes) => {
        // Coalesce by roof id — rapid drags of the same roof (vertex
        // handles, name retype, tilt scrub) collapse into one step.
        setCoalesceKey(set as any, 'updateRoof', id);
        set(
          (s) => ({
            project: {
              ...s.project,
              roofs: s.project.roofs.map((r) => (r.id === id ? { ...r, ...changes } : r)),
            },
          }),
          false,
          'updateRoof',
        );
      },

      // Cascading delete: panels on this roof go with it. Any strings that
      // lose members need re-numbering (indexInString would otherwise have
      // holes in the sequence).
      deleteRoof: (id) =>
        set(
          (s) => {
          const remainingPanels = s.project.panels.filter((p) => p.roofId !== id);
          const affectedStringIds = new Set(
            s.project.panels
              .filter((p) => p.roofId === id)
              .map((p) => p.stringId)
              .filter(Boolean) as string[]
          );
          const renumbered = renumberStrings(remainingPanels, affectedStringIds);
          const newRoofs = s.project.roofs.filter((r) => r.id !== id);
          return {
            project: {
              ...s.project,
              roofs: newRoofs,
              panels: renumbered,
            },
            // cleanUiRefs against a slice built from the POST-delete project:
            // catches not only `selectedRoofId === id` (the obvious clear)
            // but also `splitCandidateRoofId` if the user was mid-cut on the
            // deleted roof, and `activePanelGroupId` if that group's panels
            // all lived on this roof (their groupId disappears from the new
            // panels array). Previously these fields leaked stale ids past
            // the delete — the centralised sweep fixes it.
            ...cleanUiRefs(
              {
                selectedRoofId: s.selectedRoofId,
                activeStringId: s.activeStringId,
                selectedInverterId: s.selectedInverterId,
                activePanelGroupId: s.activePanelGroupId,
                splitCandidateRoofId: s.splitCandidateRoofId,
              },
              buildSlice({
                ...s.project,
                roofs: newRoofs,
                panels: renumbered,
              }),
            ),
          };
          },
          false,
          'deleteRoof',
        ),

      // ── Split a roof into two by a polyline cut ────────────────────
      // All panels stay on the original roofId (grouped). The half with
      // MORE panel centers inside it becomes the original (keeps id,
      // name, tilt, orientation). The other half is a brand-new empty
      // roof. If `splitPolygon` rejects the cut (same-edge endpoints,
      // interior vertex outside the polygon, degenerate result), this
      // action is a no-op — callers in KonvaOverlay treat that the
      // same as "polyline not committable yet".
      //
      // Edge-case: panels that geometrically fall inside the NEW half
      // still keep `roofId = original`. They'll visually overlap the
      // new roof's polygon. This is intentional per the design doc
      // (Q3b); the user can move them manually if desired.
      splitRoof: (roofId, cutLine) => {
        // Pre-validate OUTSIDE `set` so we can return boolean success
        // to the caller. A `set((s) => s)` no-op works internally but
        // there's no way to surface that to KonvaOverlay, which needs
        // to know whether to clear its in-progress drawing state or
        // let the user continue drawing. Returning false on rejected
        // cuts lets the UI treat the click as a normal vertex append.
        const s = get();
        const roof = s.project.roofs.find((r) => r.id === roofId);
        if (!roof) return false;
        const result = splitPolygon(roof.polygon, cutLine);
        if (!result) return false;
        const [polyA, polyB] = result;

        // Count panels in each half. Panels belong to this roofId
        // (we filter first), and for each we test which half its
        // center (cx, cy) falls into. Centers exactly on the cut
        // line are rare and resolved by isInsidePolygon's
        // unspecified-boundary behavior — good enough here.
        const roofPanels = s.project.panels.filter((p) => p.roofId === roofId);
        let countA = 0;
        let countB = 0;
        for (const p of roofPanels) {
          if (isInsidePolygon({ x: p.cx, y: p.cy }, polyA)) countA++;
          else if (isInsidePolygon({ x: p.cx, y: p.cy }, polyB)) countB++;
        }

        // Survivor selection: majority panel count wins. Ties broken
        // by greater area so the "dominant" half visually keeps the
        // id. If both have 0 panels AND equal area (essentially
        // impossible in practice), A wins by default.
        const areaA = polygonArea(polyA);
        const areaB = polygonArea(polyB);
        const aWins =
          countA > countB ||
          (countA === countB && areaA >= areaB);
        const survivorPoly = aWins ? polyA : polyB;
        const newPoly = aWins ? polyB : polyA;

        // New roof inherits tilt + orientation, gets a fresh id and
        // an auto-numbered name using the same pattern as `addRoof`.
        const newRoof: Roof = {
          id: uid(),
          name: `Roof ${s.project.roofs.length + 1}`,
          polygon: newPoly,
          tiltDeg: roof.tiltDeg,
          panelOrientation: roof.panelOrientation,
        };

        set(
          (prev) => ({
            project: {
              ...prev.project,
              roofs: prev.project.roofs
                .map((r) => (r.id === roofId ? { ...r, polygon: survivorPoly } : r))
                .concat(newRoof),
            },
            // Clear the cut-candidate marker on commit — the draw flow
            // that created it is done with.
            splitCandidateRoofId: null,
          }),
          false,
          'splitRoof',
        );
        return true;
      },

      // ── Merge two adjacent roofs ────────────────────────────────────
      // Triggered by right-click on a shared edge (see RoofLayer.tsx).
      // Survivor = larger-area roof (keeps id, name, tilt, orientation);
      // absorbed roof's polygon is stitched into the survivor and the
      // absorbed roof is deleted. Panels with absorbed.roofId get
      // reassigned to survivor.id — their positions stay exactly where
      // they were. Strings can span roofs, but their index-in-string
      // snake ordering is relative to panel positions on the (possibly
      // differently-shaped) merged roof, so we renumber every string
      // that had members on either side.
      //
      // If the two roofs don't share an edge (caller passed the wrong
      // pair, or the user right-clicked an edge that happens to only
      // belong to one roof), this is a no-op.
      mergeRoofs: (roofAId, roofBId) =>
        set(
          (s) => {
          if (roofAId === roofBId) return s;
          const roofA = s.project.roofs.find((r) => r.id === roofAId);
          const roofB = s.project.roofs.find((r) => r.id === roofBId);
          if (!roofA || !roofB) return s;

          const shared = findSharedEdge(roofA.polygon, roofB.polygon);
          if (!shared) return s;

          // Larger-area roof survives. Ties broken by id sort (stable).
          const areaA = polygonArea(roofA.polygon);
          const areaB = polygonArea(roofB.polygon);
          const aSurvives =
            areaA > areaB || (areaA === areaB && roofAId < roofBId);
          const survivor = aSurvives ? roofA : roofB;
          const absorbed = aSurvives ? roofB : roofA;

          // When survivor is B, we need to swap `shared`'s A/B roles
          // so mergePolygons is called with (survivor, absorbed, ...).
          // findSharedEdge returns indices relative to its input order,
          // so we invert the mapping here.
          const sharedForSurvivor = aSurvives
            ? shared
            : {
                aEdgeIndex: shared.bEdgeIndex,
                bEdgeIndex: shared.aEdgeIndex,
                reversed: shared.reversed,
              };

          const rawMerged = mergePolygons(
            survivor.polygon,
            absorbed.polygon,
            sharedForSurvivor,
          );
          // Collinearity cleanup on the stitched boundary.
          //
          // mergePolygons walks both polygons' rings and concatenates
          // them at the shared edge without deduping — its own comment
          // notes "cleanup can be added later if needed". The shared
          // edge's two endpoints almost always end up as redundant
          // corners on an otherwise-straight merged boundary (they
          // were only interesting as corners because of the OTHER
          // polygon's seam, which is gone now). Without this pass,
          // the merged roof shows ghost length labels and extra edge
          // hit-areas where the user sees a single clean line. Same
          // fix rationale as the edge-delete path in RoofLayer.
          const mergedPolygon = simplifyCollinear(rawMerged);

          // Reassign absorbed's panels to survivor. Track which
          // stringIds were touched so we can renumber them after the
          // reassignment is in place.
          const affectedStringIds = new Set<string>();
          const updatedPanels = s.project.panels.map((p) => {
            if (p.roofId === absorbed.id) {
              if (p.stringId) affectedStringIds.add(p.stringId);
              return { ...p, roofId: survivor.id };
            }
            // Panels already on the survivor are also part of strings
            // that may need renumbering if the survivor itself had
            // strings spanning the shared edge. Collect those ids too.
            if (p.roofId === survivor.id && p.stringId) {
              affectedStringIds.add(p.stringId);
            }
            return p;
          });

          const renumbered = renumberStrings(updatedPanels, affectedStringIds);

          return {
            project: {
              ...s.project,
              roofs: s.project.roofs
                .filter((r) => r.id !== absorbed.id)
                .map((r) =>
                  r.id === survivor.id ? { ...r, polygon: mergedPolygon } : r,
                ),
              panels: renumbered,
            },
            // If the absorbed roof was selected, move selection to
            // survivor so the sidebar doesn't jump to "nothing selected".
            selectedRoofId:
              s.selectedRoofId === absorbed.id
                ? survivor.id
                : s.selectedRoofId,
          };
          },
          false,
          'mergeRoofs',
        ),

      // ── Panels ──────────────────────────────────────────────────────────
      // Caller (PanelLayer) has already snapped + validated the position.
      // We just record it; string assignment happens later via lasso.
      addPanel: (roofId, cx, cy, groupId, orientation) => {
        // Coalesce by groupId — placing several panels in the same group
        // during a paint-drag collapses into a single undo step, so one
        // Ctrl-Z removes the whole run rather than N individual cells.
        setCoalesceKey(set as any, 'addPanel', groupId);
        set(
          (s) => {
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
          },
          false,
          'addPanel',
        );
      },

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
        set(
          (s) => {
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

          // anchor.orientation is always set — addPanel writes it at creation
          // and migrateProject backfills any legacy panel on rehydrate/import.
          const oldOrientation = anchor.orientation;
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
          },
          false,
          'updateGroupOrientation',
        ),

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
      //
      // NOT coalesced (no `setCoalesceKey` call). A `moveGroup` call
      // represents a SETTLED drag — KonvaOverlay sums pointer deltas in
      // component-local state during the pointermove stream and fires
      // exactly one `moveGroup(dx_total, dy_total)` on pointerup. So we
      // already get one history entry per gesture without needing the
      // middleware's 500ms coalescing. Adding a key here would wrongly
      // collapse TWO deliberate, separated drags of the same group into
      // one undo step if they happened within 500ms — worse behavior
      // than the current one-entry-per-settled-drag.
      moveGroup: (groupId, dx, dy) =>
        set(
          (s) => {
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
          },
          false,
          'moveGroup',
        ),

      // If the deleted panel belonged to a string, renumber the remainder so
      // the indexInString sequence stays 1..N without gaps.
      deletePanel: (id) =>
        set(
          (s) => {
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
          },
          false,
          'deletePanel',
        ),

      // Batch delete. Used by panel-type-edit validation: when the user
      // shrinks or reshapes the panel so that existing placements no
      // longer fit, we can remove all of the offenders in one pass (and
      // renumber affected strings exactly once) rather than N separate
      // store updates.
      deletePanels: (ids) =>
        set(
          (s) => {
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
          },
          false,
          'deletePanels',
        ),

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
        set(
          (s) => ({
            project: { ...s.project, strings: [...s.project.strings, str] },
            activeStringId: id,
            toolMode: 'assign-string',
          }),
          false,
          'addString',
        );
        return id;
      },

      // Deleting a string leaves its panels alive but unassigned. Rationale:
      // the user probably wants to re-group them into a different string,
      // not lose the panels entirely.
      deleteString: (id) =>
        set(
          (s) => {
            const newStrings = s.project.strings.filter((str) => str.id !== id);
            const newPanels = s.project.panels.map((p) =>
              p.stringId === id ? { ...p, stringId: null, indexInString: null } : p
            );
            return {
              project: {
                ...s.project,
                strings: newStrings,
                panels: newPanels,
              },
              // See deleteRoof for the rationale. Here cleanUiRefs covers
              // `activeStringId === id` (the explicit clear) plus any other
              // UI ref that happened to dangle on the new slice — cheap
              // insurance without duplicating the clear logic.
              ...cleanUiRefs(
                {
                  selectedRoofId: s.selectedRoofId,
                  activeStringId: s.activeStringId,
                  selectedInverterId: s.selectedInverterId,
                  activePanelGroupId: s.activePanelGroupId,
                  splitCandidateRoofId: s.splitCandidateRoofId,
                },
                buildSlice({
                  ...s.project,
                  strings: newStrings,
                  panels: newPanels,
                }),
              ),
            };
          },
          false,
          'deleteString',
        ),

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
      assignPanelsToString: (panelIds, stringId) => {
        // Coalesce by target stringId — a paint-drag that assigns panels
        // one-at-a-time to the same string collapses into a single undo
        // step, so one Ctrl-Z clears the whole lasso rather than popping
        // panels off the string one by one in reverse paint order.
        setCoalesceKey(set as any, 'assignPanelsToString', stringId);
        set(
          (s) => {
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
          },
          false,
          'assignPanelsToString',
        );
      },

      unassignPanel: (panelId) =>
        set(
          (s) => {
            const panel = s.project.panels.find((p) => p.id === panelId);
            if (!panel?.stringId) return s;
            const oldStringId = panel.stringId;
            const updated = s.project.panels.map((p) =>
              p.id === panelId ? { ...p, stringId: null, indexInString: null } : p
            );
            return {
              project: { ...s.project, panels: renumberStrings(updated, new Set([oldStringId])) },
            };
          },
          false,
          'unassignPanel',
        ),

      setStringInverter: (stringId, inverterId) => {
        // Coalesce by stringId — quickly re-picking inverter in a dropdown
        // for the same string collapses into one undo step.
        setCoalesceKey(set as any, 'setStringInverter', stringId);
        set(
          (s) => ({
            project: {
              ...s.project,
              strings: s.project.strings.map((str) =>
                str.id === stringId ? { ...str, inverterId } : str
              ),
            },
          }),
          false,
          'setStringInverter',
        );
      },

      updateString: (id, changes) => {
        // Coalesce by string id — typing into the string's label field or
        // picking a new color collapses rapid edits into one step.
        setCoalesceKey(set as any, 'updateString', id);
        set(
          (s) => ({
            project: {
              ...s.project,
              strings: s.project.strings.map((str) =>
                str.id === id ? { ...str, ...changes } : str
              ),
            },
          }),
          false,
          'updateString',
        );
      },

      // ── Inverters ───────────────────────────────────────────────────────
      // Default-named "Inverter A", "Inverter B", … via ASCII offset 65.
      // If there are >26 inverters the naming breaks down (AA etc. not
      // handled) — not a realistic case for a personal tool.
      addInverter: () => {
        const id = uid();
        const idx = get().project.inverters.length;
        const inv: Inverter = { id, name: `Inverter ${String.fromCharCode(65 + idx)}` };
        set(
          (s) => ({
            project: { ...s.project, inverters: [...s.project.inverters, inv] },
            // Immediately select the new inverter to streamline the common
            // "add inverter -> create strings" workflow.
            selectedInverterId: id,
          }),
          false,
          'addInverter',
        );
        return id;
      },

      renameInverter: (id, name) => {
        // Coalesce by inverter id — typing into the rename field collapses
        // per-keystroke writes into a single undo step.
        setCoalesceKey(set as any, 'renameInverter', id);
        set(
          (s) => ({
            project: {
              ...s.project,
              inverters: s.project.inverters.map((i) => (i.id === id ? { ...i, name } : i)),
            },
          }),
          false,
          'renameInverter',
        );
      },

      // Cascading: strings pointing at this inverter get their inverterId
      // cleared. We don't delete the strings themselves — they're still
      // valid, just orphaned, and the user can re-assign.
      deleteInverter: (id) =>
        set(
          (s) => {
            const newInverters = s.project.inverters.filter((i) => i.id !== id);
            const newStrings = s.project.strings.map((str) =>
              str.inverterId === id ? { ...str, inverterId: null } : str
            );
            return {
              project: {
                ...s.project,
                inverters: newInverters,
                strings: newStrings,
              },
              // See deleteRoof. The explicit `selectedInverterId === id`
              // clear is now subsumed by cleanUiRefs' inverter-id sweep
              // against the post-delete slice.
              ...cleanUiRefs(
                {
                  selectedRoofId: s.selectedRoofId,
                  activeStringId: s.activeStringId,
                  selectedInverterId: s.selectedInverterId,
                  activePanelGroupId: s.activePanelGroupId,
                  splitCandidateRoofId: s.splitCandidateRoofId,
                },
                buildSlice({
                  ...s.project,
                  inverters: newInverters,
                  strings: newStrings,
                }),
              ),
            };
          },
          false,
          'deleteInverter',
        ),

      // ── UI state (not persisted) ────────────────────────────────────────
      setToolMode: (mode) => set(
        (s) => ({
          toolMode: mode,
          // Optional: clear active panel group when leaving place-panels mode
          // so entering it again starts a new group.
          activePanelGroupId: mode === 'place-panels' ? s.activePanelGroupId : null
        }),
        false,
        'setToolMode',
      ),
      setSelectedRoof: (id) => set({ selectedRoofId: id }, false, 'setSelectedRoof'),
      setActiveString: (id) => set({ activeStringId: id }, false, 'setActiveString'),
      setSelectedInverter: (id) => set({ selectedInverterId: id }, false, 'setSelectedInverter'),
      setActivePanelGroup: (id) => set({ activePanelGroupId: id }, false, 'setActivePanelGroup'),
      setSplitCandidateRoof: (id) => set({ splitCandidateRoofId: id }, false, 'setSplitCandidateRoof'),
      setMapProvider: (provider) =>
        set(
          (s) => ({
            project: {
              ...s.project,
              mapState: { ...s.project.mapState, mapProvider: provider },
            },
          }),
          false,
          'setMapProvider',
        ),
      // Flip the captured-background visibility. Intentionally does NOT
      // clear `capturedImage` — hiding is purely a render-layer concern,
      // so the user can toggle it back on without having to re-lock.
      toggleBackground: () => set(
        (s) => ({ showBackground: !s.showBackground }),
        false,
        'toggleBackground',
      ),

      // ── Persistence entry points ────────────────────────────────────────
      // loadProject: replace everything. Resets ephemeral UI state because
      // the loaded project's ids may not match current selection/activeString.
      //
      // `history` is OPTIONAL because the JSON import format is versioned:
      // legacy (v1) exports — written before Task 11 added undo/redo —
      // carry no history, so callers omit the argument and we start fresh
      // with empty stacks. Newer (v2) exports, produced by the upcoming
      // Task 17 serialization work, will round-trip the past/future
      // slices so loading a project preserves the user's undo history
      // across a save-and-reopen cycle. Either way we ALSO explicitly
      // reset `lastActionSig` and recompute the `canUndo`/`canRedo`
      // mirrors here: zustand's partial-merge semantics mean any field
      // we don't mention would keep its pre-load value, which for a
      // fresh project would leave an armed "Undo" button pointing at
      // stale history — exactly the clear-history-policy bug that Task
      // 13 fixes for `resetProject` below.
      loadProject: (p, history) => {
        // Defense in depth: deserializeProject in utils/projectSerializer.ts
        // already migrates incoming JSON before calling this action, but
        // other call sites (tests, internal loadProject users) may hand us
        // a raw Project. Running migrateProject here keeps the field-required
        // invariant on Panel.orientation true regardless of who called us.
        // Migration is a no-op (returns the same reference) when every
        // panel already has an orientation, so there's no cost for the
        // common path.
        const migrated = migrateProject(p);
        set(
          {
            project: migrated,
            toolMode: 'idle',
            selectedRoofId: null,
            activeStringId: null,
            selectedInverterId: null,
            activePanelGroupId: null,
            past: history?.past ?? [],
            future: history?.future ?? [],
            lastActionSig: null,
            // Spelling note: `history?.past.length` (single `?.`), not
            // `history?.past?.length`. The type says `past` is non-optional
            // inside `history`, so once `history` is defined `past` is an
            // array and `.length` is safe. The `?? 0` handles the outer
            // `history === undefined` case. This derivation reads differently
            // from `undo`/`redo`'s `next.past!.length > 0` because those
            // operate on a `Partial<S>` return from `applyUndo`/`applyRedo`,
            // whereas here we're reading the caller-supplied history object.
            canUndo: (history?.past.length ?? 0) > 0,
            canRedo: (history?.future.length ?? 0) > 0,
          },
          false,
          'loadProject',
        );
      },
      // resetProject is semantically a "clear-history" action: the entire
      // project goes back to its initial blank state, so any history
      // entries referring to the prior project become nonsense (their
      // slices quote roofs/panels/strings/inverters that no longer
      // exist). We MUST include `past: []` / `future: []` (and the
      // matching `lastActionSig` / canUndo / canRedo resets) in the
      // set() payload explicitly — the `undoable` middleware's
      // clear-history policy is a pass-through that does NOT inject
      // these fields itself; without them zustand's partial-merge would
      // keep the old stacks alive and beforeEach-style test isolation
      // (plus the "New Project" button in the UI) would leak history
      // from the previous session into the fresh one.
      resetProject: () =>
        set(
          {
            project: initialProject,
            toolMode: 'idle',
            selectedRoofId: null,
            activeStringId: null,
            selectedInverterId: null,
            activePanelGroupId: null,
            past: [],
            future: [],
            lastActionSig: null,
            canUndo: false,
            canRedo: false,
          },
          false,
          'resetProject',
        ),

      // ── Remote sync ─────────────────────────────────────────────────────
      // Apply an RFC 6902 patch arriving from the server (SSE inbound).
      // Thin wrapper around `applyProjectPatch` from backend/diff.ts —
      // the real work is the library call; this action exists purely so
      // the mutation flows through the store's middleware with a named
      // policy ('applyRemotePatch' → bypass), keeping remote updates out
      // of the undo stack while still driving React re-renders.
      //
      // Contract: if `applyProjectPatch` throws (malformed ops, failed
      // `test` op), we let the throw propagate. syncClient's inbound
      // handler catches it and triggers a full resync — which is the
      // correct recovery because a failed patch means our local state
      // has diverged from the server's assumed baseline, and replaying
      // subsequent ops on top would compound the divergence.
      //
      // We only touch `project` here: UI state (selection, toolMode)
      // stays as-is because the remote edit is happening to the
      // underlying data, not to Alice's cursor. If a remote delete
      // removes a roof Alice has selected, the next interaction will
      // surface the dangling id — we deliberately don't pre-emptively
      // null it out, since doing so would flicker the sidebar during
      // every incoming patch and usually the remote change doesn't
      // affect Alice's selection at all.
      applyRemotePatch: (ops) =>
        set(
          (s) => ({ project: applyProjectPatch(s.project, ops) }),
          false,
          'applyRemotePatch',
        ),

      // ── Undo / Redo ─────────────────────────────────────────────────────
      // Thin wrappers around the pure `applyUndo` / `applyRedo` helpers in
      // undoMiddleware.ts. All the real logic (stack manipulation, slice
      // restore, UI-ref cleaning, signature reset) lives in those pure
      // functions so the store action is trivially correct by inspection.
      //
      // Why we maintain `canUndo` / `canRedo` mirrors INSIDE each action
      // rather than recomputing them in a middleware hook: zustand's
      // partial-merge semantics mean any field we don't set stays at its
      // previous value. After an undo that empties `past`, if we didn't
      // explicitly flip `canUndo` to false here, the stale `true` would
      // persist until the next mutation — giving the UI a visually-armed
      // "Undo" button that does nothing when clicked. Setting these
      // mirrors alongside the stack update keeps them in lockstep.
      //
      // Action name 'undo'/'redo' is registered as 'bypass' in
      // ACTION_POLICY: the middleware must NOT re-snapshot these set()
      // calls, because that would push a history entry ABOUT the undo
      // itself, producing infinite undo loops.
      //
      // The referential-integrity assertion is gated on `import.meta.env.DEV`:
      //   - Vite statically replaces this token with a literal boolean at
      //     build time, so in production the whole branch (including the
      //     call and its string-building) is dead-code eliminated. A
      //     useful sanity check during development costs zero bytes in
      //     shipped code.
      //   - Vitest sets DEV=true by default, so tests still run the
      //     integrity sweep and will flag any snapshot-restore bug before
      //     it reaches users.
      //   - A prior task established this pattern (in the middleware's
      //     own dev-warn); using it here keeps the dev-gate spelling
      //     consistent across the module. The plan's reference to
      //     `process.env.NODE_ENV` would NOT work in the browser bundle
      //     because Vite doesn't inject a `process` global — only
      //     rewrites specific `process.env.NODE_ENV` references, which
      //     is fragile compared to the first-class DEV flag.
      undo: () => {
        const state = get();
        const next = applyUndo(state);
        // `applyUndo` returns null when there is nothing to undo (empty
        // `past` stack). Early-return so we don't fire a listener
        // notification for a non-event — React consumers wouldn't re-
        // render for identical state, but the set() call itself plus
        // any middleware-level bookkeeping is pure waste.
        if (!next) return;
        // Maintain canUndo/canRedo mirrors alongside the restore. See the
        // comment block above for why these are tracked as real state.
        //
        // `next.past!` / `next.future!` — the return type of `applyUndo` is
        // `Partial<S>` which marks both fields optional, but the implementation
        // always includes them in the returned partial. A non-null assertion
        // here is cheaper-to-read than casting to `UndoableSlice[]` and conveys
        // the same intent: "this field is guaranteed present, trust the
        // function's contract."
        set(
          {
            ...next,
            canUndo: next.past!.length > 0,
            canRedo: next.future!.length > 0,
          },
          false,
          'undo',
        );
        if (import.meta.env.DEV) {
          // Verify after restore: if a reducer anywhere in the store ever
          // forgot to null out a cross-reference when deleting an entity,
          // that dangling id would have been snapshotted into history and
          // now restored. This sweep surfaces the bug the moment it
          // resurfaces, so regressions get caught in dev rather than
          // manifesting later as "panels mysteriously disappear" or
          // selectors returning undefined for still-referenced ids.
          assertReferentialIntegrity(buildSlice(get().project));
        }
      },
      redo: () => {
        const state = get();
        const next = applyRedo(state);
        // Symmetric with `undo`: `applyRedo` returns null when the `future`
        // stack is empty (nothing was undone yet, or we already ran out of
        // redo steps). Early-return so we don't fire a no-op notification.
        if (!next) return;
        set(
          {
            ...next,
            // See the parallel comment in `undo` for why `!.` is safe here.
            canUndo: next.past!.length > 0,
            canRedo: next.future!.length > 0,
          },
          false,
          'redo',
        );
        if (import.meta.env.DEV) {
          // Same rationale as the post-undo sweep: catch dangling refs the
          // moment they re-enter live state from the history stack.
          assertReferentialIntegrity(buildSlice(get().project));
        }
      },
    })),
    {
      // localStorage key. Kept short and namespaced so it doesn't clash.
      name: 'solar-planner-project',
      // `partialize` strips out ephemeral fields before writing to storage,
      // so refresh doesn't persist (eg) an accidental tool mode. Note that
      // history (past/future/lastActionSig) is also excluded by virtue of
      // not being listed here — see the comment at the `undoable(...)`
      // wrapper above.
      partialize: (s) => ({ project: s.project }),
      // Run the Panel.orientation migration when rehydrating from
      // localStorage. Users whose last session predates the migration
      // have panels without an `orientation` field on disk; without
      // this step they'd rehydrate into a project that violates the
      // (now required) Panel.orientation type and downstream code would
      // silently render with `undefined`. migrateProject is idempotent:
      // it returns the same object when every panel already has an
      // orientation, so the steady-state cost is one Map construction.
      onRehydrateStorage: () => (state) => {
        if (state?.project) {
          state.project = migrateProject(state.project);
        }
      },
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
