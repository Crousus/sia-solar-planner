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

// Undo/redo middleware for zustand. See spec:
//   docs/superpowers/specs/2026-04-21-undo-redo-design.md
//   adr/ADR-014-undo-redo.md        (policy table, coalescing, mirrors)
//   adr/ADR-015-local-only-undo-and-server-source-of-truth.md
//                                   (delta history — supersedes ADR-014 §4)
//
// The middleware wraps `set` so that every `set(partial, replace, actionName)`
// call is classified via ACTION_POLICY into one of: record, bypass,
// clear-history, load-history.
//
// History model (ADR-015): every recorded step is stored as an id-keyed
// DELTA (`HistoryEntry`: which entities were added / removed / which
// fields of which entities changed), NOT as a snapshot of whole arrays.
// Undo applies the inverse delta to the CURRENT project. Why: the project
// is collaboratively edited — remote patches land via applyRemotePatch
// (bypass) between Alice's local steps. Restoring a snapshot array would
// silently delete Bob's roof that arrived after Alice's step (and the sync
// layer would then push that deletion to the server). A delta only touches
// what Alice's step touched; everything else stays as it is now.
//
// To let callers pass an `actionName` as the 3rd argument to `set` (the
// same ergonomic you get with zustand's devtools middleware), this module
// declares a StoreMutator identifier 'undoable' that widens `setState`'s
// signature. The widening pattern is copied from zustand's built-in
// devtools middleware typings — see node_modules/zustand/middleware/devtools.d.ts.

import type { StateCreator, StoreApi, StoreMutatorIdentifier } from 'zustand';
import type {
  UndoableSlice,
  UndoableCollectionKey,
  FieldChange,
  EntityChange,
  HistoryEntry,
  HistoryStacks,
} from '../types';

// Re-exported so existing `import { type UndoableSlice } from './undoMiddleware'`
// call sites keep compiling. The canonical definitions live in types/index.ts
// because utils/projectSerializer.ts needs them too and utils must not
// import from store (layering rule in AGENTS.md).
export type { UndoableSlice, UndoableCollectionKey, FieldChange, EntityChange, HistoryEntry, HistoryStacks };

export interface HistoryState {
  // Newest-at-tail stacks of DELTA entries (see HistoryEntry). `past[last]`
  // is the step the next undo reverts; `future[last]` the step the next
  // redo re-applies. The SAME entry object moves between the two stacks —
  // a delta is direction-agnostic (undo applies its inverse, redo applies
  // it forward), so nothing has to be recomputed on undo/redo and entries
  // stay valid no matter which remote patches landed in between.
  past: HistoryEntry[];
  future: HistoryEntry[];
  // `lastActionSig` — the signature of the most recently PUSHED history
  // entry. The middleware uses this to decide whether the next record-path
  // mutation should coalesce (same action + key, within 500ms). Reset to
  // null after undo/redo so the first post-undo edit always starts a new
  // history step.
  lastActionSig: {
    action: string;
    key: string | null;
    at: number;
  } | null;
  // `_pendingCoalesce` — the call-site's declared coalescing key for the
  // NEXT set() call. Written by `setCoalesceKey` immediately before the
  // record-path set(), read (and consumed) by the middleware during the
  // record branch. Kept as a separate field from `lastActionSig` because
  // they encode different things: `lastActionSig` is "what did we last
  // push" (comparison target), `_pendingCoalesce` is "what key does THIS
  // call claim" (key derivation). Conflating them broke coalescing for
  // the first push of a run (the helper's write looked identical to a
  // prior push of the same run, causing the very first set to suppress
  // itself). Prefixed with underscore to signal internal/transient — it's
  // cleared to null as soon as the middleware reads it.
  _pendingCoalesce?: {
    action: string;
    key: string | null;
  } | null;
}

/**
 * Per-action classification. Every store action must appear in ACTION_POLICY
 * below — TypeScript enforces coverage via `Record<ActionName, Policy>`.
 *
 * There is deliberately NO `keyFrom` field here. An earlier design sketched
 * per-policy key derivation from action arguments; it never got wired to
 * the runtime, which instead uses the `_pendingCoalesce` channel written by
 * `setCoalesceKey` at the call site. Keeping `keyFrom` as dead
 * documentation invited two kinds of confusion: readers assumed the key
 * flowed through it, and new actions copied a vestigial field that did
 * nothing. The coalescing key contract lives entirely with
 * setCoalesceKey + the middleware's record branch; see those call sites.
 */
export type Policy =
  | { kind: 'bypass' }
  | { kind: 'clear-history' }
  | { kind: 'load-history' }
  | { kind: 'record' };

/**
 * ActionName — exhaustive union of every name passed as the 3rd arg to set().
 *
 * Keeping this union in sync with the projectStore actions is enforced
 * indirectly: ACTION_POLICY below is typed as `Record<ActionName, Policy>`,
 * so forgetting an entry is a compile error; adding an entry under a name
 * not in the union is also a compile error. That makes this type the single
 * truth-source for "what labels may flow through the middleware" — any new
 * action must land here AND in ACTION_POLICY together.
 *
 * `__history__` is the internal marker the middleware uses for its own
 * past/future/coalesce-sig writes — included in the union so the helper
 * passes type-checks, even though no store action emits it directly.
 */
export type ActionName =
  // ── Record (undoable) ──────────────────────────────────────────────
  | 'setProjectName'
  | 'updatePanelType'
  | 'addRoof'
  | 'updateRoof'
  | 'deleteRoof'
  | 'splitRoof'
  | 'mergeRoofs'
  | 'addPanel'
  | 'updateGroupOrientation'
  | 'moveGroup'
  | 'deletePanel'
  | 'deletePanels'
  | 'addString'
  | 'deleteString'
  | 'assignPanelsToString'
  | 'unassignPanel'
  | 'setStringInverter'
  | 'updateString'
  | 'addInverter'
  | 'renameInverter'
  | 'deleteInverter'
  // `linkInverterModel` mutates doc.inverters[i].inverterModelId, which
  // lives inside the opaque project doc — the normal undo-able surface.
  // Recorded so Ctrl-Z reverts a mistaken catalog link to the previous
  // inverterModelId, including the null→id case.
  | 'linkInverterModel'
  // ── Bypass (UI + mapState) ─────────────────────────────────────────
  | 'lockMap'
  | 'unlockMap'
  | 'setMapProvider'
  | 'setToolMode'
  | 'setSelectedRoof'
  | 'setActiveString'
  | 'setSelectedInverter'
  | 'setActivePanelGroup'
  | 'setSplitCandidateRoof'
  | 'toggleBackground'
  // Catalog context setters — pure UI-state writes (activePbProjectId,
  // activePanelModelId, inverterModelCache). setPanelModelFromCatalog
  // also performs a PB PATCH but its store write is still a plain setter
  // for activePanelModelId; bypass because these never touch `project`.
  | 'setActivePbProjectId'
  | 'setActivePanelModelId'
  | 'setInverterModelCache'
  | 'setPanelModelFromCatalog'
  // ── Diagram (electrical block diagram view) ─────────────────────────
  // All diagram mutations are bypass — the diagram feature is a separate
  // view layer that doesn't participate in the project undo stack. The
  // meta table inputs coalesce per-keystroke which would be noisy for
  // the normal undo flow, and nodes/edges are manipulated through React
  // Flow's own interactions (drag, connect) that don't map cleanly to
  // the record-path coalescing model.
  | 'bootstrapDiagram'
  | 'setDiagramNodes'
  | 'setDiagramEdges'
  | 'updateDiagramMeta'
  | 'addDiagramNode'
  // ── Special (history management) ───────────────────────────────────
  | 'resetProject'
  | 'loadProject'
  | 'undo'
  | 'redo'
  // ── Backend-sync (remote-originated) ───────────────────────────────
  // Inbound SSE patches from the server, applied by syncClient. Classified
  // as 'bypass' below — see the ACTION_POLICY entry for the Q11 rationale
  // that remote-originated changes must not enter the local undo stack.
  | 'applyRemotePatch'
  // ── Middleware-internal ────────────────────────────────────────────
  | '__history__';

/**
 * ACTION_POLICY — single source of truth for per-action behavior.
 *
 * Keys are ActionName union members, values are Policy entries. At runtime,
 * the middleware reads the third argument of `set(partial, replace, actionName)`
 * and looks up the policy here.
 *
 * Unknown / missing names default to "bypass" with a dev-only console.warn,
 * so a forgotten label surfaces early without corrupting history. (Because
 * ACTION_POLICY is typed as `Record<ActionName, Policy>`, a typo at a
 * set() call-site won't match the union and won't compile — but the runtime
 * fallback remains for defensive coverage, e.g. if an ActionName literal
 * is constructed dynamically.)
 */
export const ACTION_POLICY: Record<ActionName, Policy> = {
  // ── Record (undoable) ──────────────────────────────────────────────
  setProjectName:          { kind: 'record' },
  updatePanelType:         { kind: 'record' },
  addRoof:                 { kind: 'record' },
  updateRoof:              { kind: 'record' },
  deleteRoof:              { kind: 'record' },
  splitRoof:               { kind: 'record' },
  mergeRoofs:              { kind: 'record' },
  addPanel:                { kind: 'record' },
  updateGroupOrientation:  { kind: 'record' },
  moveGroup:               { kind: 'record' },
  deletePanel:             { kind: 'record' },
  deletePanels:            { kind: 'record' },
  addString:               { kind: 'record' },
  deleteString:            { kind: 'record' },
  assignPanelsToString:    { kind: 'record' },
  unassignPanel:           { kind: 'record' },
  setStringInverter:       { kind: 'record' },
  updateString:            { kind: 'record' },
  addInverter:             { kind: 'record' },
  renameInverter:          { kind: 'record' },
  deleteInverter:          { kind: 'record' },
  linkInverterModel:       { kind: 'record' },

  // ── Bypass (UI + mapState) ─────────────────────────────────────────
  lockMap:                 { kind: 'bypass' },
  unlockMap:               { kind: 'bypass' },
  setMapProvider:          { kind: 'bypass' },
  setToolMode:             { kind: 'bypass' },
  setSelectedRoof:         { kind: 'bypass' },
  setActiveString:         { kind: 'bypass' },
  setSelectedInverter:     { kind: 'bypass' },
  setActivePanelGroup:     { kind: 'bypass' },
  setSplitCandidateRoof:   { kind: 'bypass' },
  toggleBackground:        { kind: 'bypass' },
  setActivePbProjectId:    { kind: 'bypass' },
  setActivePanelModelId:   { kind: 'bypass' },
  setInverterModelCache:   { kind: 'bypass' },
  setPanelModelFromCatalog: { kind: 'bypass' },

  // Diagram actions — bypass for the reasons described at the ActionName
  // union above (separate view layer, not part of project undo stack).
  bootstrapDiagram:        { kind: 'bypass' },
  setDiagramNodes:         { kind: 'bypass' },
  setDiagramEdges:         { kind: 'bypass' },
  updateDiagramMeta:       { kind: 'bypass' },
  addDiagramNode:          { kind: 'bypass' },

  // ── Special ────────────────────────────────────────────────────────
  resetProject:            { kind: 'clear-history' },
  loadProject:             { kind: 'load-history' },

  // Undo/redo themselves bypass the record path (they manipulate stacks
  // directly); classified as 'bypass' so the middleware doesn't re-snapshot.
  undo:                    { kind: 'bypass' },
  redo:                    { kind: 'bypass' },

  // Remote patches are applied verbatim to `project` from an SSE stream
  // originated by another user. Per spec Q11 ("undo is local-only"), these
  // must NOT enter the history stack: Alice undoing her own edit is one
  // thing, but Ctrl-Z silently rolling back Bob's latest change would be
  // both confusing ("who moved my panel?") AND incorrect as a sync model
  // (the server would immediately push the state back, creating a fight).
  // Bypass also prevents coalescing — we don't want a rapid burst of
  // remote ops from one collaborator's drag gesture to accidentally
  // suppress history entries for a local edit that happened to share
  // an action-name string.
  applyRemotePatch:        { kind: 'bypass' },

  // Internal marker for the middleware's own set() calls that update
  // past/future after a recorded mutation. Bypass prevents infinite
  // recursion (pushing history about the push itself) and keeps the
  // history-maintenance step out of the "unclassified" dev warning.
  __history__:             { kind: 'bypass' },
};

/**
 * Build an UndoableSlice from a project-like object. Shallow copy by
 * reference for every sub-field — structural sharing is what keeps
 * memory usage bounded when we push a new slice on every edit. Because
 * reducers in projectStore already produce fresh arrays/objects for the
 * parts they mutate (spread-based updates), copying references here is
 * safe: mutating past slices can't happen without first replacing the
 * reference at the top of the tree, which is exactly what an undo
 * restores.
 *
 * `mapState` is deliberately excluded (see spec §3.4): it contains the
 * captured map image (base64, potentially multi-MB) and UI lock flags
 * that we don't want to resurrect on undo — rewinding a panel edit
 * shouldn't unlock the map or replace the background image.
 *
 * The parameter type is loose (`any` for sub-fields) on purpose: this
 * helper is called from projectStore.ts where TypeScript has already
 * narrowed the Project shape, so over-specifying here would force us
 * to either duplicate the Project type or create a circular import.
 * Task 14 will tighten UndoableSlice itself; the parameter stays
 * permissive.
 */
export function buildSlice(project: {
  name: string;
  panelType: any;
  roofs: any[];
  panels: any[];
  strings: any[];
  inverters: any[];
}): UndoableSlice {
  return {
    name: project.name,
    panelType: project.panelType,
    roofs: project.roofs,
    panels: project.panels,
    strings: project.strings,
    inverters: project.inverters,
  };
}

/**
 * After an undo or redo restores a slice, any UI reference that names an
 * id no longer present in the slice is replaced with null. Same defensive
 * sweep that inline-lives in deleteRoof/deleteString/deleteInverter today
 * — centralising it here means a future undo that pops to a "before this
 * roof existed" snapshot can't leave `selectedRoofId` pointing at a ghost
 * that no selector/renderer will find.
 *
 * Why the truthy-check (`ui.selectedRoofId && ...`) in addition to the
 * Set membership test: if the id is already null, we short-circuit and
 * return null without ever calling `.has(null)`. `Set.has(null)` is
 * technically fine (returns false) but the short-circuit keeps intent
 * clearer and matches the behavior described in the "keeps null inputs
 * as null" test.
 *
 * The `splitCandidateRoofId` sweep is deliberately grouped with roofs
 * (not a separate id space) because it names a roof mid-interaction;
 * if that roof is gone after an undo, the in-progress cut is moot.
 */
export interface UiRefs {
  selectedRoofId: string | null;
  activeStringId: string | null;
  selectedInverterId: string | null;
  activePanelGroupId: string | null;
  splitCandidateRoofId: string | null;
}

export function cleanUiRefs(ui: UiRefs, slice: UndoableSlice): UiRefs {
  // Build lookup sets once per call — O(n) to construct but then O(1)
  // per membership test, which matters if UiRefs ever grows or if this
  // ends up called on every undo in a large project.
  const roofIds = new Set((slice.roofs as { id: string }[]).map((r) => r.id));
  const stringIds = new Set((slice.strings as { id: string }[]).map((s) => s.id));
  const inverterIds = new Set((slice.inverters as { id: string }[]).map((i) => i.id));
  // Panel groups are not first-class entities — a "group" is just the set
  // of panels that share a groupId. So we derive the valid-group id space
  // from the panels array itself; a group with zero panels effectively
  // doesn't exist and its id should be treated as dangling.
  const groupIds = new Set(
    (slice.panels as { groupId: string }[]).map((p) => p.groupId),
  );
  return {
    selectedRoofId:       ui.selectedRoofId && roofIds.has(ui.selectedRoofId)           ? ui.selectedRoofId       : null,
    activeStringId:       ui.activeStringId && stringIds.has(ui.activeStringId)         ? ui.activeStringId       : null,
    selectedInverterId:   ui.selectedInverterId && inverterIds.has(ui.selectedInverterId) ? ui.selectedInverterId : null,
    activePanelGroupId:   ui.activePanelGroupId && groupIds.has(ui.activePanelGroupId)  ? ui.activePanelGroupId   : null,
    splitCandidateRoofId: ui.splitCandidateRoofId && roofIds.has(ui.splitCandidateRoofId) ? ui.splitCandidateRoofId : null,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Delta history engine (ADR-015)
//
// Four pure building blocks, all exported for direct unit testing:
//   diffSlices(before, after)    → HistoryEntry | null   (record path)
//   composeEntries(older, newer) → HistoryEntry | null   (coalescing)
//   invertEntry(entry)           → HistoryEntry          (undo = inverse)
//   applyEntry(current, entry)   → UndoableSlice         (undo/redo)
//
// Conflict policy when applying a delta to a current state that has moved
// on (because remote patches landed in between) — "three-way, field-level,
// the newer writer wins":
//   - update: for each field the step changed, write the target value only
//     if the field currently still holds the value the step started from.
//     If a collaborator has since written a different value to that field,
//     their value stays (we skip that field). Fields the step didn't touch
//     are never written. If the entity no longer exists (deleted remotely),
//     the update is skipped — undo never resurrects an entity a
//     collaborator deleted just because Alice once edited it.
//   - remove (e.g. undoing an add): removed if still present, regardless of
//     later remote edits to it — the user asked for "my add, gone".
//   - add (e.g. undoing a delete): re-inserted after its recorded
//     predecessor (anchor) unless an entity with that id already exists.
//     References are then validated: a re-inserted panel whose roof is
//     gone is dropped again; a dangling stringId / inverterId is nulled.
//   - scalars (name): reverted only if still equal to the step's value.
// ────────────────────────────────────────────────────────────────────────────

/** Entity arrays in the order deltas are applied: referenced collections
 *  first (roofs, inverters), then the ones that reference them (strings →
 *  inverter, panels → roof + string), so reference validation after the
 *  apply sees the final id sets. */
const APPLY_ORDER: UndoableCollectionKey[] = ['roofs', 'inverters', 'strings', 'panels'];

type Obj = Record<string, unknown>;

/**
 * Structural equality for JSON-shaped values. A key whose value is
 * `undefined` is treated as absent — matching JSON semantics, so an entry
 * that went through an export/import round-trip compares the same as one
 * that didn't.
 *
 * Needed (rather than reference equality) because reducers routinely
 * re-create unchanged entities — renumberStrings, for instance, rebuilds
 * every panel object of an affected string even when its index stays the
 * same. Without a value check those would be recorded as no-op "updates"
 * and, worse, become conflict candidates on undo.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) if (!deepEqual(aa[i], bb[i])) return false;
    return true;
  }
  const ao = a as Obj;
  const bo = b as Obj;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!deepEqual(ao[k], bo[k])) return false;
  return true;
}

/** Entities are keyed by a string `id`. Elements without one (only ever
 *  seen in simplified unit-test shapes) are invisible to the delta engine. */
function idOf(e: unknown): string | undefined {
  if (e && typeof e === 'object') {
    const id = (e as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

/** Field-level diff of two entity objects. null = no difference. */
function diffFields(a: Obj, b: Obj): Record<string, FieldChange> | null {
  const out: Record<string, FieldChange> = {};
  let any = false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!deepEqual(a[k], b[k])) {
      out[k] = { before: a[k], after: b[k] };
      any = true;
    }
  }
  return any ? out : null;
}

/** Write one side of a field-change map onto an entity (copy). An
 *  `undefined` value deletes the key, restoring "optional field absent". */
function writeFieldSide(entity: unknown, fields: Record<string, FieldChange>, side: 'before' | 'after'): Obj {
  const out: Obj = { ...(entity as Obj) };
  for (const k of Object.keys(fields)) {
    const v = fields[k][side];
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

/**
 * Forward-apply field changes to the CURRENT entity using the conflict
 * policy described above: a field is written only if it still holds
 * `before`. Returns null when nothing was written (all fields either
 * already at `after` or overwritten by someone else since).
 */
function mergeFieldsForward(current: unknown, fields: Record<string, FieldChange>): Obj | null {
  const cur = current as Obj;
  let out: Obj | null = null;
  for (const k of Object.keys(fields)) {
    const fc = fields[k];
    if (deepEqual(cur[k], fc.after)) continue; // already there (idempotent)
    if (!deepEqual(cur[k], fc.before)) continue; // collaborator wrote since → theirs wins
    if (!out) out = { ...cur };
    if (fc.after === undefined) delete out[k];
    else out[k] = fc.after;
  }
  return out;
}

/**
 * Id-keyed diff of one entity array. Order of the result matters for the
 * anchor chain: removals/updates are emitted in BEFORE-array order and
 * additions in AFTER-array order, so when a batch of entities is
 * re-inserted (e.g. undoing deleteRoof brings back 40 panels) each one's
 * predecessor has already been re-inserted by the time it is placed.
 */
function diffCollection(before: unknown[], after: unknown[]): EntityChange[] {
  if (before === after) return [];
  const afterById = new Map<string, unknown>();
  for (const e of after) {
    const id = idOf(e);
    if (id !== undefined) afterById.set(id, e);
  }
  const beforeIds = new Set<string>();
  const out: EntityChange[] = [];
  let prev: string | null = null;
  for (const b of before) {
    const id = idOf(b);
    if (id === undefined) continue;
    beforeIds.add(id);
    const a = afterById.get(id);
    if (a === undefined) {
      out.push({ op: 'remove', id, entity: b, anchor: prev });
    } else if (a !== b) {
      const fields = diffFields(b as Obj, a as Obj);
      if (fields) out.push({ op: 'update', id, fields });
    }
    prev = id;
  }
  prev = null;
  for (const a of after) {
    const id = idOf(a);
    if (id === undefined) continue;
    if (!beforeIds.has(id)) out.push({ op: 'add', id, entity: a, anchor: prev });
    prev = id;
  }
  return out;
}

const COLLECTION_KEYS: UndoableCollectionKey[] = ['roofs', 'panels', 'strings', 'inverters'];

/** True when an entry records no change at all. */
export function isEmptyEntry(e: HistoryEntry): boolean {
  return (
    !e.name &&
    !(e.panelType && Object.keys(e.panelType).length > 0) &&
    COLLECTION_KEYS.every((k) => !(e[k] && e[k]!.length > 0))
  );
}

/**
 * Record-path diff: the delta that turns `before` into `after`. Called
 * immediately around ONE local set(), so it can only ever contain what that
 * local action changed — remote patches are applied through their own
 * (bypass) set() calls and never fall inside a before/after pair.
 *
 * Returns null when the two slices are value-equal (e.g. a reducer that
 * rebuilt arrays without changing content), which the record path treats
 * as a no-op.
 */
export function diffSlices(before: UndoableSlice, after: UndoableSlice): HistoryEntry | null {
  const e: HistoryEntry = {};
  if (!Object.is(before.name, after.name)) e.name = { before: before.name, after: after.name };
  if (before.panelType !== after.panelType) {
    const f = diffFields(before.panelType as Obj, after.panelType as Obj);
    if (f) e.panelType = f;
  }
  for (const k of COLLECTION_KEYS) {
    const changes = diffCollection(before[k], after[k]);
    if (changes.length > 0) e[k] = changes;
  }
  return isEmptyEntry(e) ? null : e;
}

/** Compose two field maps: earliest `before`, latest `after`; fields that
 *  end up back at their starting value drop out. */
function composeFields(
  older: Record<string, FieldChange> | undefined,
  newer: Record<string, FieldChange> | undefined,
): Record<string, FieldChange> | undefined {
  if (!older) return newer;
  if (!newer) return older;
  const out: Record<string, FieldChange> = { ...older };
  for (const k of Object.keys(newer)) {
    const before = k in older ? older[k].before : newer[k].before;
    const after = newer[k].after;
    if (deepEqual(before, after)) delete out[k];
    else out[k] = { before, after };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Compose two changes to the SAME entity id (older happened first). */
function composeChange(o: EntityChange, n: EntityChange): EntityChange | null {
  if (o.op === 'add') {
    // add → update: still an add, of the updated entity.
    if (n.op === 'update') {
      return { op: 'add', id: o.id, entity: writeFieldSide(o.entity, n.fields, 'after'), anchor: o.anchor };
    }
    // add → remove: the entity never existed from the step's point of view.
    if (n.op === 'remove') return null;
    return n; // add → add can't happen (id already existed); keep latest
  }
  if (o.op === 'update') {
    if (n.op === 'update') {
      const fields = composeFields(o.fields, n.fields);
      return fields ? { op: 'update', id: o.id, fields } : null;
    }
    if (n.op === 'remove') {
      // update → remove: undo must restore the PRE-step entity, i.e. the
      // removed value with the earlier update's fields rolled back.
      return { op: 'remove', id: o.id, entity: writeFieldSide(n.entity, o.fields, 'before'), anchor: n.anchor };
    }
    return n;
  }
  // o.op === 'remove'
  if (n.op === 'add') {
    // remove → add (same id re-created): net effect is a field update.
    const fields = diffFields(o.entity as Obj, n.entity as Obj);
    return fields ? { op: 'update', id: o.id, fields } : null;
  }
  return o; // remove → update/remove can't happen (entity was gone)
}

function composeChanges(older: EntityChange[] | undefined, newer: EntityChange[] | undefined): EntityChange[] | undefined {
  if (!older || older.length === 0) return newer;
  if (!newer || newer.length === 0) return older;
  const result: (EntityChange | null)[] = [...older];
  const pos = new Map<string, number>();
  result.forEach((c, i) => pos.set(c!.id, i));
  for (const n of newer) {
    const i = pos.get(n.id);
    if (i === undefined) {
      pos.set(n.id, result.length);
      result.push(n);
      continue;
    }
    const prev = result[i];
    result[i] = prev ? composeChange(prev, n) : n;
  }
  const out = result.filter((c): c is EntityChange => c !== null);
  return out.length > 0 ? out : undefined;
}

/**
 * Coalescing: fold `newer` into `older` so the merged entry has the
 * earliest `before` and the latest `after` of every touched field/entity.
 * Per-id composition (instead of keeping "first before slice + last after
 * slice") is what keeps coalescing correct when a remote patch lands in
 * the middle of a slider scrub: the remote change was never part of either
 * local delta, so it can't sneak into the merged one.
 *
 * Returns null when the composition cancels out completely (scrubbed a
 * slider away and back) — the caller then drops the entry.
 */
export function composeEntries(older: HistoryEntry, newer: HistoryEntry): HistoryEntry | null {
  const e: HistoryEntry = {};
  if (older.name || newer.name) {
    const before = older.name ? older.name.before : newer.name!.before;
    const after = newer.name ? newer.name.after : older.name!.after;
    if (!deepEqual(before, after)) e.name = { before, after };
  }
  const pt = composeFields(older.panelType, newer.panelType);
  if (pt) e.panelType = pt;
  for (const k of COLLECTION_KEYS) {
    const c = composeChanges(older[k], newer[k]);
    if (c) e[k] = c;
  }
  return isEmptyEntry(e) ? null : e;
}

function invertFields(f: Record<string, FieldChange>): Record<string, FieldChange> {
  const out: Record<string, FieldChange> = {};
  for (const k of Object.keys(f)) out[k] = { before: f[k].after, after: f[k].before };
  return out;
}

/** The delta that undoes `e`. add ↔ remove (same entity + anchor),
 *  update/scalars swap before/after. */
export function invertEntry(e: HistoryEntry): HistoryEntry {
  const out: HistoryEntry = {};
  if (e.name) out.name = { before: e.name.after, after: e.name.before };
  if (e.panelType) out.panelType = invertFields(e.panelType);
  for (const k of COLLECTION_KEYS) {
    const list = e[k];
    if (!list) continue;
    out[k] = list.map((c): EntityChange => {
      if (c.op === 'add') return { op: 'remove', id: c.id, entity: c.entity, anchor: c.anchor };
      if (c.op === 'remove') return { op: 'add', id: c.id, entity: c.entity, anchor: c.anchor };
      return { op: 'update', id: c.id, fields: invertFields(c.fields) };
    });
  }
  return out;
}

/** Result of applying one collection's changes: the new array (same
 *  reference if nothing happened), plus what was removed / written so the
 *  reference-repair pass can stay targeted. */
interface CollectionApply {
  items: unknown[];
  removed: Map<string, unknown>;
  /** id → { prev: entity before this apply (undefined for inserts), next } */
  touched: Map<string, { prev: unknown; next: unknown }>;
}

function applyCollection(items: unknown[], changes: EntityChange[] | undefined): CollectionApply {
  const removed = new Map<string, unknown>();
  const touched = new Map<string, { prev: unknown; next: unknown }>();
  if (!changes || changes.length === 0) return { items, removed, touched };
  let work = items;
  // Copy-on-write so an apply that ends up skipping everything (all
  // conflicts) returns the original array reference — keeps selectors and
  // the sync diff quiet.
  const cow = () => {
    if (work === items) work = items.slice();
  };
  let index: Map<string, number> | null = null;
  const idx = (): Map<string, number> => {
    if (!index) {
      index = new Map();
      work.forEach((e, i) => {
        const id = idOf(e);
        if (id !== undefined) index!.set(id, i);
      });
    }
    return index;
  };
  for (const c of changes) {
    const at = idx().get(c.id);
    if (c.op === 'update') {
      if (at === undefined) continue; // deleted meanwhile → don't resurrect
      const merged = mergeFieldsForward(work[at], c.fields);
      if (!merged) continue;
      cow();
      touched.set(c.id, { prev: work[at], next: merged });
      work[at] = merged;
    } else if (c.op === 'remove') {
      if (at === undefined) continue; // already gone
      cow();
      const [gone] = work.splice(at, 1);
      removed.set(c.id, gone);
      index = null;
    } else {
      if (at !== undefined) continue; // id exists again → never duplicate
      cow();
      let insertAt: number;
      if (c.anchor === null) insertAt = 0;
      else {
        const a = idx().get(c.anchor);
        // Anchor gone (deleted remotely, or itself not restored) → append.
        insertAt = a === undefined ? work.length : a + 1;
      }
      work.splice(insertAt, 0, c.entity);
      touched.set(c.id, { prev: undefined, next: c.entity });
      index = null;
    }
  }
  return { items: work, removed, touched };
}

/**
 * Options for applyEntry / applyUndo / applyRedo. The middleware is
 * Project-agnostic about string NUMBERING policy, so the store injects its
 * `renumberStrings` here (it lives in projectStore.ts with the rest of the
 * wiring-order logic). Omitted in unit tests → numbering left as restored.
 */
export interface ApplyHistoryOptions {
  renumberStrings?: (panels: unknown[], affectedStringIds: Set<string>) => unknown[];
}

type PanelRefs = { id: string; roofId?: string; stringId?: string | null; indexInString?: number | null };
type StringRefs = { id: string; inverterId?: string | null };

/**
 * Forward-apply `entry` to `current` (redo semantics; undo passes
 * `invertEntry(entry)`), then restore referential integrity for whatever
 * this apply touched, then renumber strings whose membership changed.
 *
 * Reference repair is TARGETED, not a whole-project sweep: it only
 * cascades from entities removed by this apply and only validates entities
 * this apply wrote. A pre-existing inconsistency elsewhere (e.g. from a
 * malformed remote doc) is not this undo's business and is left alone, so
 * "entities untouched by the step stay exactly as they are" holds except
 * for the unavoidable cascades:
 *   - roof removed     → its panels are removed (like deleteRoof)
 *   - string removed   → its panels become unassigned (like deleteString)
 *   - inverter removed → its strings lose inverterId/mpptPort (like deleteInverter)
 *   - written panel whose roof doesn't exist → dropped
 *   - written panel / string with a dangling string / inverter ref → nulled
 */
export function applyEntry(
  current: UndoableSlice,
  entry: HistoryEntry,
  opts: ApplyHistoryOptions = {},
): UndoableSlice {
  let name = current.name;
  if (entry.name && deepEqual(current.name, entry.name.before) && typeof entry.name.after === 'string') {
    name = entry.name.after;
  }
  let panelType = current.panelType;
  if (entry.panelType) {
    const merged = mergeFieldsForward(panelType, entry.panelType);
    if (merged) panelType = merged as UndoableSlice['panelType'];
  }

  const out: UndoableSlice = { ...current, name, panelType };
  const res = {} as Record<UndoableCollectionKey, CollectionApply>;
  for (const k of APPLY_ORDER) {
    res[k] = applyCollection(current[k], entry[k]);
    out[k] = res[k].items;
  }

  // ── Reference repair ────────────────────────────────────────────────
  const inverterIds = new Set(out.inverters.map(idOf));
  const stringIds = new Set(out.strings.map(idOf));
  const roofIds = new Set(out.roofs.map(idOf));

  const removedInv = res.inverters.removed;
  const touchedStrings = res.strings.touched;
  let stringsChanged = false;
  const strings = out.strings.map((raw) => {
    const s = raw as StringRefs;
    const ref = s.inverterId;
    if (ref == null || inverterIds.has(ref)) return raw;
    if (!removedInv.has(ref) && !touchedStrings.has(s.id)) return raw;
    stringsChanged = true;
    return { ...s, inverterId: null, mpptPort: null };
  });
  if (stringsChanged) out.strings = strings;

  const removedRoofs = res.roofs.removed;
  const removedStrings = res.strings.removed;
  const touchedPanels = res.panels.touched;
  const affectedStrings = new Set<string>();
  // Membership bookkeeping for renumbering: any panel this apply removed,
  // inserted, or whose stringId/indexInString it wrote.
  for (const gone of res.panels.removed.values()) {
    const sid = (gone as PanelRefs).stringId;
    if (sid) affectedStrings.add(sid);
  }
  for (const { prev, next } of touchedPanels.values()) {
    const p = prev as PanelRefs | undefined;
    const n = next as PanelRefs;
    if (!p || p.stringId !== n.stringId || p.indexInString !== n.indexInString) {
      if (p?.stringId) affectedStrings.add(p.stringId);
      if (n.stringId) affectedStrings.add(n.stringId);
    }
  }
  let panelsChanged = false;
  const panels: unknown[] = [];
  for (const raw of out.panels) {
    const p = raw as PanelRefs;
    const written = touchedPanels.has(p.id);
    if (p.roofId !== undefined && !roofIds.has(p.roofId) && (removedRoofs.has(p.roofId) || written)) {
      panelsChanged = true;
      if (p.stringId) affectedStrings.add(p.stringId);
      continue;
    }
    const sid = p.stringId;
    if (sid != null && !stringIds.has(sid) && (removedStrings.has(sid) || written)) {
      panelsChanged = true;
      panels.push({ ...p, stringId: null, indexInString: null });
      continue;
    }
    panels.push(raw);
  }
  if (panelsChanged) out.panels = panels;

  if (opts.renumberStrings) {
    const live = new Set([...affectedStrings].filter((sid) => stringIds.has(sid)));
    if (live.size > 0) out.panels = opts.renumberStrings(out.panels, live);
  }
  return out;
}

/**
 * Convert legacy snapshot stacks (v2 JSON exports, ADR-014 format) into
 * delta entries. `past[i]` was the state before step i, so step i's delta
 * is diff(past[i], past[i+1]) — with `current` closing the chain. Future
 * entries are diffed outward from `current` (future's tail is the first
 * redo). Empty diffs are dropped.
 */
export function entriesFromSnapshots(
  past: UndoableSlice[],
  future: UndoableSlice[],
  current: UndoableSlice,
): HistoryStacks {
  const pastEntries: HistoryEntry[] = [];
  for (let i = 0; i < past.length; i++) {
    const e = diffSlices(past[i], i + 1 < past.length ? past[i + 1] : current);
    if (e) pastEntries.push(e);
  }
  const redoOrder: HistoryEntry[] = [];
  let prev = current;
  for (let i = future.length - 1; i >= 0; i--) {
    const e = diffSlices(prev, future[i]);
    if (e) redoOrder.push(e);
    prev = future[i];
  }
  return { past: pastEntries, future: redoOrder.reverse() };
}

/** Apply a delta to a full project object, keeping `mapState`, `meta`,
 *  `diagram` (everything outside UndoableSlice) untouched, and returning
 *  the SAME reference when the apply changed nothing. */
function applyEntryToProject<P extends UndoableSlice>(project: P, entry: HistoryEntry, opts?: ApplyHistoryOptions): P {
  const cur = buildSlice(project);
  const next = applyEntry(cur, entry, opts);
  if (slicesEqual(cur, next)) return project;
  // Spread order: current project first (keeps mapState — spec §3.4: undo
  // must never resurrect a captured image or flip the map lock), then the
  // patched undoable fields.
  return { ...project, ...next };
}

function uiRefsOf(s: UiRefs): UiRefs {
  return {
    selectedRoofId: s.selectedRoofId,
    activeStringId: s.activeStringId,
    selectedInverterId: s.selectedInverterId,
    activePanelGroupId: s.activePanelGroupId,
    splitCandidateRoofId: s.splitCandidateRoofId,
  };
}

/**
 * Pure "apply undo" function. Computes the next (partial) state given the
 * current state; returns null when there is no undo to perform.
 *
 * Pops the newest entry from `past`, applies its INVERSE to the current
 * project (see the conflict policy at the top of this section), moves the
 * same entry onto `future`, and cleans UI refs that now dangle.
 *
 * Why split this out as a pure function rather than inlining inside the
 * store action: the store action is a thin wrapper — `const next =
 * applyUndo(get(), opts); if (next) set(next, false, 'undo');` — and all
 * the real logic lives here, testable without a zustand store.
 *
 * Classified as 'bypass' in ACTION_POLICY — the middleware therefore does
 * NOT record this set(): undo must not push an entry about itself.
 */
export function applyUndo<
  S extends HistoryState & {
    project: any;
  } & UiRefs,
>(state: S, opts?: ApplyHistoryOptions): Partial<S> | null {
  if (state.past.length === 0) return null;
  const entry = state.past[state.past.length - 1];
  const project = applyEntryToProject(state.project, invertEntry(entry), opts);
  return {
    past: state.past.slice(0, -1),
    future: [...state.future, entry],
    // Reset lastActionSig so the first mutation AFTER an undo always starts
    // a fresh history step — "type, undo, type" must produce independent
    // positions rather than coalescing the post-undo edit into the entry
    // we just moved to `future`.
    lastActionSig: null,
    project,
    ...cleanUiRefs(uiRefsOf(state), buildSlice(project)),
  } as Partial<S>;
}

/**
 * Pure "apply redo" — symmetric to applyUndo: pops `future`, applies the
 * entry FORWARD to the current project, pushes it back onto `past`.
 * Returns null when there's nothing to redo.
 */
export function applyRedo<
  S extends HistoryState & {
    project: any;
  } & UiRefs,
>(state: S, opts?: ApplyHistoryOptions): Partial<S> | null {
  if (state.future.length === 0) return null;
  const entry = state.future[state.future.length - 1];
  const project = applyEntryToProject(state.project, entry, opts);
  return {
    past: [...state.past, entry],
    future: state.future.slice(0, -1),
    lastActionSig: null,
    project,
    ...cleanUiRefs(uiRefsOf(state), buildSlice(project)),
  } as Partial<S>;
}

/**
 * Dev-mode-only referential-integrity sweep. Reports (via a caller-supplied
 * emitter — defaults to console.error) any id in the slice that would be
 * dangling: a panel's roofId/stringId, or a string's inverterId. Called
 * after undo/redo restores so snapshot bugs surface immediately.
 *
 * Why this exists at all: applyEntry repairs the references IT touches
 * (targeted repair, see applyEntry), but it deliberately does not sweep
 * the whole project. If a reducer elsewhere in the store ever forgets to
 * null out a cross-reference when deleting an entity (e.g. deleting a
 * roof without also clearing panels' roofId, or deleting an inverter
 * without clearing strings' inverterId), that broken reference gets
 * faithfully recorded into a delta and later re-applied — the bug becomes
 * silent, because selectors typically tolerate missing lookups by
 * returning undefined, and the UI just renders nothing for that panel.
 * This sweep surfaces the bug the moment we restore a compromised slice,
 * so regressions get caught in dev rather than manifesting as "panels
 * mysteriously disappear after undo".
 *
 * Why the emitter indirection rather than calling console.error directly:
 * it keeps this function pure (no side effects on the global console) so
 * tests can assert on the exact set of messages produced without stubbing
 * globals. The default is console.error so production / dev callers don't
 * need to wire anything up — passing an emitter is an opt-in for testing
 * or for plumbing the messages into a different logger later.
 *
 * Why this isn't called from the record path: record only snapshots the
 * BEFORE state and trusts that whatever reducer is about to run is
 * well-behaved. Verifying after every mutation would double the cost of
 * every action for very little incremental coverage — bugs in the
 * reducers' ref-cleanup logic would already be caught on the NEXT undo
 * that touches them, which is when this sweep runs at the store-wrapper
 * level in Task 12+.
 *
 * Deliberate non-checks:
 *   - We don't verify that a panel's groupId corresponds to an existing
 *     group, because groups are derived from panels (a group with one
 *     panel IS that panel's groupId by construction). There's no separate
 *     entity to dangle against.
 *   - We don't verify stringId → string assignments symmetrically with
 *     panel.stringId here; strings don't reference panels, panels
 *     reference strings, and that direction is covered.
 *   - We don't look inside roofs for nested ids. Roofs are self-contained
 *     geometry; cross-entity refs all flow panel → {roof, string} and
 *     string → inverter.
 */
export function assertReferentialIntegrity(
  slice: UndoableSlice,
  emit: (msg: string) => void = (m) => console.error(m),
): void {
  // Build id lookup sets up-front — same pattern as cleanUiRefs. We
  // deliberately DON'T extract a shared helper for this construction:
  // the duplication is three lines, and inlining keeps each function
  // readable on its own without a jump-to-definition. If a fourth
  // consumer ever needs the same sets we can revisit.
  const roofIds = new Set((slice.roofs as { id: string }[]).map((r) => r.id));
  const stringIds = new Set((slice.strings as { id: string }[]).map((s) => s.id));
  const inverterIds = new Set(
    (slice.inverters as { id: string }[]).map((i) => i.id),
  );

  // Panels: every panel MUST have a roofId (a panel without a roof is
  // nonsensical — there's no place to render it), so we always check
  // roofId membership. stringId, by contrast, is optional (an unassigned
  // panel has stringId === null), so we only flag it when non-null AND
  // unknown. The `!= null` check intentionally uses loose equality to
  // catch both null and undefined — the type annotates `string | null`
  // but a future refactor or a bug-produced undefined shouldn't trip a
  // false positive here.
  for (const p of slice.panels as {
    id: string;
    roofId: string;
    stringId: string | null;
  }[]) {
    if (!roofIds.has(p.roofId)) {
      emit(`[undoable] panel ${p.id} references unknown roofId ${p.roofId}`);
    }
    if (p.stringId != null && !stringIds.has(p.stringId)) {
      emit(`[undoable] panel ${p.id} references unknown stringId ${p.stringId}`);
    }
  }

  // Strings: inverterId is optional (a freshly-created string has no
  // inverter until the user assigns one), so same null-guard pattern as
  // panel.stringId above.
  for (const s of slice.strings as {
    id: string;
    inverterId: string | null;
  }[]) {
    if (s.inverterId != null && !inverterIds.has(s.inverterId)) {
      emit(
        `[undoable] string ${s.id} references unknown inverterId ${s.inverterId}`,
      );
    }
  }
}

// --- Type plumbing to widen set() to accept an action-name 3rd arg ---
// Mirror of zustand/middleware/devtools.d.ts internal helpers. These are
// local (not re-exported) because they're implementation detail of the
// mutator declaration below. The key transformation is: take the store's
// original setState(...a) signature, keep the first two params, and append
// an optional `action?: string | { type: string }` — exactly what the
// devtools middleware does. This lets callers write set(partial, false, 'actionName')
// without TS errors at compile time, while at runtime the extra arg is
// just consumed (in later tasks) by the classification wrapper.
type Cast<T, U> = T extends U ? T : U;
type Write<T, U> = Omit<T, keyof U> & U;
type TakeTwo<T> = T extends { length: 0 }
  ? [undefined, undefined]
  : T extends { length: 1 }
    ? [...a0: Cast<T, unknown[]>, a1: undefined]
    : T extends { length: 0 | 1 }
      ? [...a0: Cast<T, unknown[]>, a1: undefined]
      : T extends { length: 2 }
        ? T
        : T extends { length: 1 | 2 }
          ? T
          : T extends { length: 0 | 1 | 2 }
            ? T
            : T extends [infer A0, infer A1, ...unknown[]]
              ? [A0, A1]
              : T extends [infer A0, (infer A1)?, ...unknown[]]
                ? [A0, A1?]
                : T extends [(infer A0)?, (infer A1)?, ...unknown[]]
                  ? [A0?, A1?]
                  : never;
type WithUndoable<S> = Write<S, StoreUndoable<S>>;
type StoreUndoable<S> = S extends { setState: (...a: infer Sa) => infer Sr }
  ? {
      setState<A extends string | { type: string }>(
        ...a: [...a: TakeTwo<Sa>, action?: A]
      ): Sr;
    }
  : never;

declare module 'zustand' {
  // StoreMutators<S, A> — A must match zustand's own declaration exactly for
  // interface merging (TS 2428 otherwise). We don't consume A ourselves (our
  // mutator widens setState based on S alone), so the unused-parameter warning
  // for A is intentional and suppressed.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface StoreMutators<S, A> {
    'undoable': WithUndoable<S>;
  }
}

// Public alias so downstream code can type a set() that accepts the named
// action argument — analogous to devtools' NamedSet.
export type NamedSet<T> = WithUndoable<StoreApi<T>>['setState'];

/**
 * Record-path constants. Exposed for tests.
 *
 * MAX_PAST caps the number of retained entries. Chosen as 100 to balance
 * "enough headroom that users practically never hit the ceiling mid-session"
 * against memory growth. Since ADR-015 each entry is a delta holding only
 * the entities the step touched (by reference — shared with whatever
 * project tree produced them), so the marginal cost of an entry is
 * proportional to the size of the edit, not the size of the project.
 */
export const MAX_PAST = 100;

/**
 * Coalescing window in milliseconds. Two consecutive record-path mutations
 * with the same action name AND the same per-instance key that arrive within
 * this window collapse into a single history step — the SECOND (and third,
 * fourth, …) mutation suppresses its history push, while still applying the
 * project change. An undo therefore jumps back past the whole streak to the
 * pre-streak state, matching user intent for rapid-fire edits like dragging
 * a slider, typing into a name field, or repeatedly clicking +1.
 *
 * 500ms is slow enough to catch human-paced repeats (typical keypress cadence
 * is 100–300ms, slider drags emit events at 60fps = 16ms) but fast enough
 * that genuinely distinct logical actions separated by a visible pause stay
 * as separate steps.
 */
export const COALESCE_MS = 500;

/**
 * Helper for store actions to set the coalescing key BEFORE calling set()
 * with a record-path action name. The middleware reads `_pendingCoalesce`
 * (which this helper sets) when deciding whether the next set() call
 * coalesces with the previous one.
 *
 * IMPORTANT: Must be called IMMEDIATELY before — and for the SAME action
 * name as — the record-path set() that follows. Two failure modes:
 *   1. Forgetting this call entirely: the action coalesces only by action
 *      name with key=null, meaning two rapid edits to DIFFERENT entity ids
 *      collapse into a single undo step within the 500ms window (silent
 *      data loss from the user's perspective — undoing one roof rename
 *      would also undo an unrelated second-roof rename that happened to
 *      come right after).
 *   2. Calling this helper but not issuing the matching set() next (or
 *      issuing a set() under a different action name): the pending key
 *      leaks into the next record-path call. The action-name guard in the
 *      middleware (`pending.action === name`) provides a partial defense —
 *      a stale pending from action A won't be picked up by action B — but
 *      the INVARIANT is that this helper and its matching set() are paired.
 *      The middleware also clears `_pendingCoalesce` on the no-op early-
 *      return path (where a record-path set() produces no reference change
 *      and drops the phantom push) to uphold this invariant even when the
 *      mutation is a no-op.
 *
 * Why a separate helper rather than deriving the key inside the middleware:
 * the per-instance discriminator (e.g. a roofId for `updateRoof`) lives in
 * the action's arguments, not in the set() partial. The middleware only sees
 * the partial + the action name string; it has no access to the caller's
 * arguments. Rather than thread a keyFrom function through every set() call
 * (which would force every action signature to change), the call-site writes
 * the key into `_pendingCoalesce` via this helper, and the middleware picks
 * it back up on the immediately-following set().
 *
 * Why a SEPARATE field from `lastActionSig`: `lastActionSig` is the
 * signature of the last PUSHED history entry (the comparison target for
 * coalescing). `_pendingCoalesce` is the CURRENT call's declared key (the
 * comparison source). If we conflated them, the helper's pre-set write
 * would look identical to a push sig of the same action+key run, causing
 * the very first mutation of a run to compare against itself and falsely
 * coalesce — suppressing the initial history push entirely. Keeping them
 * separate lets the middleware compare "this call's intent" against
 * "last real push" correctly.
 *
 * The `__history__` action name routes through the bypass branch, so this
 * write doesn't itself get recorded.
 *
 * Usage inside a store action:
 *   setCoalesceKey(set, 'assignPanelsToString', stringId);
 *   set((s) => ..., false, 'assignPanelsToString');
 */
export function setCoalesceKey<T extends HistoryState>(
  set: (partial: Partial<T>, replace?: boolean, actionName?: string) => void,
  action: string,
  key: string | null,
) {
  set(
    { _pendingCoalesce: { action, key } } as Partial<T>,
    false,
    '__history__',
  );
}

/**
 * Detects a no-op mutation: every field in `next` is reference-equal to
 * `prev`. Zustand actions that call set(...) but don't actually change any
 * branch of the undoable slice (e.g., splitRoof rejecting an invalid cut and
 * returning false, or setProjectName called with the already-current name
 * where the reducer spreads a new project wrapper but all leaf refs stay the
 * same) would otherwise push a phantom step. This sweep drops them.
 *
 * We compare at the slice field level (not deep-equal) because every reducer
 * in projectStore uses immutable spread updates: any real change produces a
 * new reference for at least one top-level field. Reference equality is
 * therefore both necessary and sufficient for no-op detection, and it's O(1).
 */
function slicesEqual(a: UndoableSlice, b: UndoableSlice): boolean {
  return (
    Object.is(a.name, b.name) &&
    Object.is(a.panelType, b.panelType) &&
    Object.is(a.roofs, b.roofs) &&
    Object.is(a.panels, b.panels) &&
    Object.is(a.strings, b.strings) &&
    Object.is(a.inverters, b.inverters)
  );
}

/**
 * The middleware signature. Keeps the mutator-chain generic form established
 * in Task 3 so the 'undoable' mutator is stamped onto the resulting store
 * type — this is what lets callers write `set(partial, replace, actionName)`
 * with full 3-arg TypeScript support (via the `declare module 'zustand'`
 * widening above). The runtime body is generic-free and operates on the
 * erased shape; all generic gymnastics here are purely to preserve call-site
 * types, not to constrain behavior.
 */
type Undoable = <
  T extends HistoryState & { project: any },
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
>(
  initializer: StateCreator<T, [...Mps, ['undoable', never]], Mcs>
) => StateCreator<T, Mps, [['undoable', never], ...Mcs]>;

/**
 * Runtime implementation.
 *
 * Behavior per action:
 *   - bypass / unknown: pass through untouched.
 *   - record: call buildSlice before + after, diff them into an id-keyed
 *             HistoryEntry (diffSlices); if anything changed, push the
 *             entry onto `past` (or fold it into the newest entry when
 *             coalescing), reset `future`, and cap at MAX_PAST. If nothing
 *             changed (no-op), don't push.
 *   - clear-history / load-history: pass through for now; Tasks 9+ fill in.
 *
 * Why build the slice twice (before + after) rather than inspecting the
 * `partial` argument directly: `partial` can be a function, a partial object,
 * or involve replace-semantics, and we'd have to re-implement zustand's merge
 * rules to know what the state looks like after. Reading get().project
 * before and after the real set() is trivially correct and costs one extra
 * shallow object construction per action.
 *
 * We re-use zustand's own `set` for the mutation itself, then issue a second
 * `set` to update past/future. Two listener notifications fire per recorded
 * action — acceptable for Task 6; Task 7's coalescing window will merge most
 * adjacent record steps and a later task can batch the history write into
 * the same set() if the extra render proves costly in practice.
 *
 * The `as unknown as` cast bridge through the mutator-chain generics is the
 * same pattern zustand's own devtools middleware uses: runtime types are
 * erased, so we assert to the caller-visible shape at the boundary.
 */
const undoableImpl = (
  config: StateCreator<HistoryState & { project: any }, [], []>,
): StateCreator<HistoryState & { project: any }, [], []> =>
  (set, get, api) => {
    const wrappedSet = ((partial: any, replace?: any, actionName?: string) => {
      const name = typeof actionName === 'string' ? actionName : undefined;
      // Runtime lookup against the typed Record. The cast to ActionName is
      // the escape hatch the typed union requires: at compile-time, every
      // in-tree set() call-site gets narrowed via NamedSet's typing, but
      // this wrapper receives the string after type erasure. The runtime
      // fallback + dev warning below cover the "typo or dynamically-built
      // name" case that the compile-time check can't.
      const policy: Policy = name
        ? ACTION_POLICY[name as ActionName] ?? { kind: 'bypass' }
        : { kind: 'bypass' };

      // Dev-only signal that a store action forgot to register a policy.
      // With the tightened ActionName union this is now mostly a defense
      // against dynamically-constructed action names (none exist today);
      // a typo'd literal at a set() call-site fails at compile-time.
      //
      // Guard uses `import.meta.env.DEV` because Vite statically replaces
      // that token with a literal boolean at build time (true in `vite dev`,
      // false in production bundles — the warn and its branch are dead-code
      // eliminated from the prod build). Crucially, vitest also populates
      // `import.meta.env.DEV` (defaults to true under `vitest run`), so the
      // warn fires in both the browser dev server AND the test runner.
      //
      // The previous `typeof process !== 'undefined'` check was a Node-ism
      // that silently failed in the browser: Vite does not inject a `process`
      // global into the browser runtime (it only rewrites `process.env.NODE_ENV`
      // string references), so the guard short-circuited to false and the warn
      // never fired during actual dev work — defeating its purpose of
      // surfacing forgotten policy entries early.
      //
      // Ordering matters: `import.meta.env.DEV` is first so the whole check
      // compiles away in production after DCE, regardless of `name`.
      if (
        import.meta.env.DEV &&
        name &&
        !(name in ACTION_POLICY)
      ) {
        // eslint-disable-next-line no-console
        console.warn(`[undoable] Unclassified action name: ${name}`);
      }

      if (policy.kind === 'bypass') {
        (set as any)(partial, replace, name);
        return;
      }

      if (policy.kind === 'record') {
        // Snapshot BEFORE the mutation so an undo can restore the
        // pre-action state. This matches the "past = states we can go
        // back to" mental model: at the moment of a new edit, the most
        // recent `past` entry is the state we just left.
        const before = buildSlice(get().project);
        (set as any)(partial, replace, name);
        const after = buildSlice(get().project);
        // Reference check first (O(1), the common no-op), then the id-keyed
        // delta. A null delta means the reducer produced new references
        // but identical content — also a no-op for history purposes.
        const entry = slicesEqual(before, after) ? null : diffSlices(before, after);
        if (entry === null) {
          // No-op: the mutation didn't change any undoable content
          // (e.g. splitRoof rejecting an invalid cut, or setProjectName
          // called with the already-current name). Drop the phantom push.
          //
          // Invariant: a `_pendingCoalesce` written by setCoalesceKey for
          // THIS call must be consumed here, even though we're not pushing.
          // Otherwise a stale pending key could leak into the next record-
          // path call — the action-name guard at the consume site is a
          // partial defense, but the design contract is that helper writes
          // are consumed immediately by the next record-path set()
          // UNCONDITIONALLY. The `!= null` guard avoids redundant
          // `__history__` writes (and the listener notification they
          // trigger) when there was no pending key to clear.
          if (get()._pendingCoalesce != null) {
            (set as any)(
              { _pendingCoalesce: null } as Partial<HistoryState>,
              false,
              '__history__',
            );
          }
          return;
        }

        // Time source: prefer performance.now because it's monotonic and
        // unaffected by wall-clock adjustments. Feature-detect both the
        // global and the method so vitest's vi.stubGlobal('performance', …)
        // and non-DOM runtimes (some older Node paths) still work. The
        // 500ms window dwarfs any precision concern with Date.now fallback.
        const now =
          typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();

        // Two distinct pieces of coalescing state are in play here:
        //   - `lastActionSig`: the PUSH signature of the previous record-path
        //     mutation (the one most-recently added to `past`). This is our
        //     comparison target.
        //   - `_pendingCoalesce`: the CURRENT call's claimed key, written by
        //     `setCoalesceKey(set, name, key)` immediately before this
        //     mutation's set() fired. Consumed (and cleared) here.
        //
        // Why separate fields: if the helper wrote into `lastActionSig`
        // directly, the very first mutation of a run would see sig === the
        // helper's write, action matches, key matches, window matches → it
        // would suppress its OWN push as though coalescing with itself. By
        // keeping the pending key separate from the push signature, the
        // first mutation correctly sees `lastActionSig === null` (or an
        // older, different sig) and pushes; subsequent mutations of the
        // same run see `lastActionSig` set to the first push's sig, their
        // own `_pendingCoalesce` carrying the same key, and coalesce.
        const pending = get()._pendingCoalesce ?? null;
        // If `_pendingCoalesce` was set for this same action, use its key;
        // otherwise this action wasn't explicitly keyed, so the key is null
        // (coalescing still works on action-name + time alone for keyless
        // actions like `addRoof`). Guarding on `pending.action === name`
        // protects against a stale pending write from a different action
        // leaking into this call — shouldn't happen under correct usage
        // (helper writes are always immediately followed by a matching
        // set()), but defensive.
        const key: string | null =
          pending !== null && pending.action === name ? pending.key : null;

        const sig = get().lastActionSig;
        // Coalesce criteria:
        //   - there's a previous PUSH signature (first-ever record has none)
        //   - same action name (sig.action === name). This is the primary
        //     discriminator — different actions never coalesce.
        //   - same key (sig.key === key). For keyed actions (updateRoof
        //     with per-roofId key) this prevents editing roof A then roof B
        //     in quick succession from collapsing into one step; the
        //     'does not coalesce across different keys' test locks this in.
        //   - within the 500ms window (now - sig.at <= COALESCE_MS).
        const pastNow = get().past;
        const shouldCoalesce =
          sig !== null &&
          sig.action === name &&
          sig.key === key &&
          now - sig.at <= COALESCE_MS &&
          // Defensive: nothing to fold into (can't happen after a push,
          // but a load/reset that left a stale sig must not crash).
          pastNow.length > 0;

        if (shouldCoalesce) {
          // Fold this delta into the newest entry: earliest `before`,
          // latest `after`, composed PER ENTITY ID (see composeEntries) so
          // a remote patch that landed mid-streak can never leak into the
          // merged entry. Slide the timestamp forward so a chain of rapid
          // edits keeps extending the window ("last edit + 500ms"). Also
          // clear `_pendingCoalesce` so a subsequent keyless record
          // doesn't accidentally inherit this call's key.
          const merged = composeEntries(pastNow[pastNow.length - 1], entry);
          if (merged === null) {
            // The streak cancelled itself out (slider scrubbed away and
            // back). Drop the entry entirely — an undo that visibly does
            // nothing is confusing — and null the sig so the next edit of
            // the streak starts a fresh entry whose `before` is the
            // (unchanged) original state.
            const shrunk = pastNow.slice(0, -1);
            (set as any)(
              {
                past: shrunk,
                lastActionSig: null,
                _pendingCoalesce: null,
                canUndo: shrunk.length > 0,
              },
              false,
              '__history__',
            );
            return;
          }
          (set as any)(
            {
              past: [...pastNow.slice(0, -1), merged],
              lastActionSig: { action: name!, key, at: now },
              _pendingCoalesce: null,
            },
            false,
            '__history__',
          );
          return;
        }

        // Spread-create a fresh past array, then shift() its head if we
        // blew the cap. Mutating after-spread is safe because `newPast`
        // is our local copy; no React/zustand consumer has seen it yet.
        const newPast = [...pastNow, entry];
        if (newPast.length > MAX_PAST) newPast.shift();

        // Replace=false (partial merge): we only want to overwrite the
        // past/future fields plus the freshly-recorded signature; everything
        // else (project, UI, etc.) must stay untouched. Action name
        // '__history__' is classified as bypass so this call doesn't
        // recurse into the record branch. Clear `_pendingCoalesce` — it's
        // been consumed for this set().
        (set as any)(
          {
            past: newPast,
            future: [] as HistoryEntry[],
            lastActionSig: { action: name!, key, at: now },
            _pendingCoalesce: null,
            // Mirror `past.length > 0` onto the flat `canUndo` boolean that
            // toolbar buttons subscribe to. Expressed as a derivation rather
            // than the constant `true` for two reasons: (a) self-documenting
            // — the field always tracks past depth, and future edge cases
            // (e.g. a depth-cap that could hypothetically leave an empty
            // past after a shift) stay correct by construction; (b) a reader
            // grepping for where the mirror is computed finds the single
            // truth-source `newPast.length > 0` at both this push site and
            // in undo/redo/reset. After a push, newPast always has ≥1 entry,
            // so this is effectively always true here — but writing the
            // derivation is the robust choice.
            canUndo: newPast.length > 0,
            // Any new mutation invalidates the redo stack (you can't "redo"
            // something when a branching edit has replaced the future), which
            // is why `future` above is cleared to []. Mirror that on canRedo
            // so subscribers see the two flip together in the same set() —
            // selectors watching only canRedo would otherwise render a stale
            // "redo armed" button for one frame until the next mutation.
            canRedo: false,
          },
          false,
          '__history__',
        );
        return;
      }

      // clear-history / load-history: pass through for now. These paths
      // get dedicated handling in later tasks (9 and 10 respectively);
      // pass-through is the same behavior the no-op shell had, so no
      // existing tests regress.
      (set as any)(partial, replace, name);
    }) as typeof set;

    return config(wrappedSet, get, api);
  };

export const undoable: Undoable = undoableImpl as unknown as Undoable;
