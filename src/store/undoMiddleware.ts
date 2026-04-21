// Undo/redo middleware for zustand. See spec:
//   docs/superpowers/specs/2026-04-21-undo-redo-design.md
//
// The middleware wraps `set` so that every `set(partial, replace, actionName)`
// call is classified via ACTION_POLICY into one of: record, bypass,
// clear-history, load-history. This file defines the types and a no-op
// shell; behavior is added task-by-task.
//
// To let callers pass an `actionName` as the 3rd argument to `set` (the
// same ergonomic you get with zustand's devtools middleware), this module
// declares a StoreMutator identifier 'undoable' that widens `setState`'s
// signature. The widening pattern is copied from zustand's built-in
// devtools middleware typings — see node_modules/zustand/middleware/devtools.d.ts.

import type { StateCreator, StoreApi, StoreMutatorIdentifier } from 'zustand';

// The fields we capture per history entry. Defined loosely here via an index
// signature so tests can use a simplified test state; the real store's slice
// conforms to this via structural compatibility. projectStore uses a stricter
// UndoableSlice alias defined next to its Project type once wired.
export type UndoableSlice = {
  name: string;
  panelType: { id: string } & Record<string, unknown>;
  roofs: unknown[];
  panels: unknown[];
  strings: unknown[];
  inverters: unknown[];
};

export interface HistoryState {
  past: UndoableSlice[];
  future: UndoableSlice[];
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
 * below. TypeScript enforces coverage via `Record<ActionName, Policy>` once
 * `ActionName` is tightened in Task 14.
 */
export type Policy =
  | { kind: 'bypass' }
  | { kind: 'clear-history' }
  | { kind: 'load-history' }
  | {
      kind: 'record';
      // Coalesce key derived from the action arguments. If undefined, the
      // action still coalesces on action-name + 500ms window but with no
      // per-instance discriminator. If the function returns null, same
      // effect (no key).
      keyFrom?: (...args: any[]) => string | null;
    };

/**
 * ACTION_POLICY — single source of truth for per-action behavior.
 *
 * Keys are action names, values are Policy entries. At runtime, the middleware
 * reads the third argument of `set(partial, replace, actionName)` and looks up
 * the policy here.
 *
 * Unknown / missing names default to "bypass" with a dev-only console.warn,
 * so a forgotten label surfaces early without corrupting history.
 */
export const ACTION_POLICY: Record<string, Policy> = {
  // ── Record (undoable) ──────────────────────────────────────────────
  setProjectName:          { kind: 'record', keyFrom: () => 'name' },
  updatePanelType:         { kind: 'record', keyFrom: () => 'panelType' },
  addRoof:                 { kind: 'record' },
  updateRoof:              { kind: 'record', keyFrom: (id) => id },
  deleteRoof:              { kind: 'record' },
  splitRoof:               { kind: 'record' },
  mergeRoofs:              { kind: 'record' },
  addPanel:                { kind: 'record', keyFrom: (_roofId, _cx, _cy, groupId) => groupId },
  updateGroupOrientation:  { kind: 'record' },
  moveGroup:               { kind: 'record' },
  deletePanel:             { kind: 'record' },
  deletePanels:            { kind: 'record' },
  addString:               { kind: 'record' },
  deleteString:            { kind: 'record' },
  assignPanelsToString:    { kind: 'record', keyFrom: (_panelIds, stringId) => stringId },
  unassignPanel:           { kind: 'record', keyFrom: () => 'unassign' },
  setStringInverter:       { kind: 'record', keyFrom: (stringId) => stringId },
  updateString:            { kind: 'record', keyFrom: (id) => id },
  addInverter:             { kind: 'record' },
  renameInverter:          { kind: 'record', keyFrom: (id) => id },
  deleteInverter:          { kind: 'record' },

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

  // ── Special ────────────────────────────────────────────────────────
  resetProject:            { kind: 'clear-history' },
  loadProject:             { kind: 'load-history' },

  // Undo/redo themselves bypass the record path (they manipulate stacks
  // directly); classified as 'bypass' so the middleware doesn't re-snapshot.
  undo:                    { kind: 'bypass' },
  redo:                    { kind: 'bypass' },

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

/**
 * Pure "apply undo" function. Computes the next (partial) state given the
 * current state; returns null when there is no undo to perform.
 *
 * Why split this out as a pure function rather than inlining inside the store
 * action: the store action will be a thin wrapper — `const next = applyUndo(get());
 * if (next) set(next, false, 'undo');` — and that wrapper is trivially correct
 * by inspection. All the real logic (stack manipulation, slice restoration,
 * UI-ref cleaning, signature reset) lives here, where we can exercise it in
 * isolation without spinning up a zustand store or worrying about the
 * middleware's coalescing/policy branches. Pure in → pure out → cheap tests.
 *
 * Returns `Partial<S>` because the caller (the store's `undo` action) will
 * pass it into `set(next, false, 'undo')`. Zustand's partial-merge semantics
 * apply the returned fields on top of current state; anything we omit (UI
 * fields we're not touching, middleware-internal fields like `_pendingCoalesce`)
 * stays as-is.
 *
 * Classified as 'bypass' in ACTION_POLICY — the middleware therefore does NOT
 * re-snapshot this set(), which is exactly what we want: undo directly
 * manipulates past/future, it must not push an entry about itself.
 */
export function applyUndo<
  S extends HistoryState & {
    project: any;
  } & UiRefs,
>(state: S): Partial<S> | null {
  // Nothing to undo — signal "no-op" to the caller via null so it can skip
  // the set() entirely (no listener notification for a non-event).
  if (state.past.length === 0) return null;

  // Pop the tail of `past` — that's the most recent "state we can return to".
  // Slice-copy rather than mutating in place so the pre-undo array reference
  // is still intact for any consumer that captured it (React selectors, etc.).
  const prev = state.past[state.past.length - 1];
  const newPast = state.past.slice(0, -1);

  // Capture the CURRENT project into a slice so redo can restore it. This is
  // symmetric with the record path: pushing onto `future` is the mirror image
  // of pushing the "before" snapshot onto `past` during a normal mutation.
  const currentSlice = buildSlice(state.project);

  // Clean any UI refs that would dangle against the restored slice. Same
  // defensive sweep used elsewhere — a selectedRoofId pointing to a roof
  // that doesn't exist in the pre-undo slice must be nulled, otherwise the
  // UI would render "selection" highlights against an id no selector can
  // resolve.
  const cleaned = cleanUiRefs(
    {
      selectedRoofId: state.selectedRoofId,
      activeStringId: state.activeStringId,
      selectedInverterId: state.selectedInverterId,
      activePanelGroupId: state.activePanelGroupId,
      splitCandidateRoofId: state.splitCandidateRoofId,
    },
    prev,
  );

  return {
    past: newPast,
    // Pushing onto `future` (not prepending) keeps "newest-at-tail" ordering
    // consistent with `past`; applyRedo pops from the tail, which is the
    // mirror of how we pop past here.
    future: [...state.future, currentSlice],
    // Reset lastActionSig so the first mutation AFTER an undo always starts
    // a fresh history step — users expect "type, undo, type" to produce
    // three independent history positions. If we left `lastActionSig`
    // pointing at whatever the pre-undo signature was, a post-undo edit
    // of the same action+key within 500ms would silently coalesce into the
    // restored snapshot, making the two edits indistinguishable on a later
    // undo. Nulling here forces the next record-path call through the
    // "no previous sig → push" branch.
    lastActionSig: null,
    // Critical subtlety: spread `state.project` first, then overlay `prev`.
    // `prev` is an UndoableSlice — by construction it has NO `mapState` key
    // (see buildSlice's spec §3.4 exclusion). So the spread order means:
    //   1. `...state.project` brings in EVERY current field, including
    //      `mapState` (captured image, lock flag, …).
    //   2. `...prev` overwrites only the undoable fields (name, panelType,
    //      roofs, panels, strings, inverters).
    //   → `mapState` survives untouched.
    // This is load-bearing for the spec: undoing a panel edit must NOT
    // resurrect a previous captured-image or flip the map lock.
    project: { ...state.project, ...prev },
    ...cleaned,
  } as Partial<S>;
}

/**
 * Pure "apply redo" — symmetric to applyUndo. Pops `future`, pushes the
 * current slice onto `past`, restores the project, cleans dangling UI refs,
 * resets `lastActionSig` for the same reason as applyUndo.
 *
 * Returns null when there's nothing to redo (e.g., the user never undid, or
 * a new mutation since the last undo cleared `future`).
 */
export function applyRedo<
  S extends HistoryState & {
    project: any;
  } & UiRefs,
>(state: S): Partial<S> | null {
  if (state.future.length === 0) return null;

  const next = state.future[state.future.length - 1];
  const newFuture = state.future.slice(0, -1);
  // Snapshot the CURRENT project onto past — mirror of how applyUndo pushes
  // the current slice onto future. After redo, a subsequent undo will pop
  // this snapshot back, restoring the pre-redo state.
  const currentSlice = buildSlice(state.project);

  const cleaned = cleanUiRefs(
    {
      selectedRoofId: state.selectedRoofId,
      activeStringId: state.activeStringId,
      selectedInverterId: state.selectedInverterId,
      activePanelGroupId: state.activePanelGroupId,
      splitCandidateRoofId: state.splitCandidateRoofId,
    },
    next,
  );

  return {
    past: [...state.past, currentSlice],
    future: newFuture,
    // Same rationale as applyUndo: a post-redo edit must begin a fresh
    // coalesce window, not silently merge into the restored snapshot.
    lastActionSig: null,
    // Same spread-order subtlety as applyUndo: `state.project` first
    // (keeps mapState), then `next` overlays the undoable slice fields.
    project: { ...state.project, ...next },
    ...cleaned,
  } as Partial<S>;
}

/**
 * Dev-mode-only referential-integrity sweep. Reports (via a caller-supplied
 * emitter — defaults to console.error) any id in the slice that would be
 * dangling: a panel's roofId/stringId, or a string's inverterId. Called
 * after undo/redo restores so snapshot bugs surface immediately.
 *
 * Why this exists at all: applyUndo/applyRedo restore whole slices by
 * reference, and buildSlice performs structural sharing rather than deep
 * validation. If a reducer elsewhere in the store ever forgets to null out
 * a cross-reference when deleting an entity (e.g. deleting a roof without
 * also clearing panels' roofId, or deleting an inverter without clearing
 * strings' inverterId), that broken reference gets faithfully snapshotted
 * into history and then faithfully restored later — the bug becomes
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
 * MAX_PAST caps the number of retained snapshots. Chosen as 100 to balance
 * "enough headroom that users practically never hit the ceiling mid-session"
 * against memory growth. Because snapshots share references with the live
 * project tree (structural sharing via buildSlice), the marginal cost of each
 * entry is small — essentially six pointer-sized fields plus whatever
 * sub-trees have since been replaced by newer edits.
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
 *   - record: call buildSlice before + after; if anything changed, push the
 *             "before" snapshot onto `past`, reset `future`, and cap at
 *             MAX_PAST. If nothing changed (no-op), don't push.
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
      const policy: Policy = name
        ? ACTION_POLICY[name] ?? { kind: 'bypass' }
        : { kind: 'bypass' };

      // Dev-only signal that a store action forgot to register a policy.
      // Intentionally warn — not throw — so a new action under development
      // doesn't hard-crash the app before its policy is wired up. Task 14
      // will make this a compile-time error via a stricter ActionName type.
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
        if (slicesEqual(before, after)) {
          // No-op: the mutation didn't change any top-level slice field
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
        const shouldCoalesce =
          sig !== null &&
          sig.action === name &&
          sig.key === key &&
          now - sig.at <= COALESCE_MS;

        if (shouldCoalesce) {
          // Suppress push; slide the timestamp forward so a chain of rapid
          // edits keeps extending the window. If we DIDN'T advance `at`,
          // a long streak of mutations 400ms apart would eventually break
          // coalescing once the original `at` aged past 500ms relative to
          // the latest mutation, even though no individual gap exceeded
          // the window. Sliding `at` makes the window "last edit + 500ms",
          // which better matches user intent for continuous activity.
          // Also clear `_pendingCoalesce` so a subsequent keyless record
          // doesn't accidentally inherit this call's key.
          (set as any)(
            {
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
        const newPast = [...get().past, before];
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
            future: [] as UndoableSlice[],
            lastActionSig: { action: name!, key, at: now },
            _pendingCoalesce: null,
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
