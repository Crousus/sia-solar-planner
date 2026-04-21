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
  lastActionSig: {
    action: string;
    key: string | null;
    at: number;
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
};

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

// The middleware signature: it introduces the 'undoable' mutator at the
// outside of the mutator chain, exactly like `devtools` introduces
// 'zustand/devtools'. Phase 1 is a no-op pass-through; classification and
// history logic are added in later tasks so each step stays reviewable.
type Undoable = <
  T extends HistoryState,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
>(
  initializer: StateCreator<T, [...Mps, ['undoable', never]], Mcs>
) => StateCreator<T, Mps, [['undoable', never], ...Mcs]>;

// Runtime implementation: for now, just forward set/get/api unchanged.
// Cast via `unknown` because the mutator types are erased at runtime —
// the wrapper just passes arguments through.
export const undoable: Undoable = ((config) =>
  (set, get, api) =>
    (config as unknown as StateCreator<HistoryState, [], []>)(
      set as never,
      get as never,
      api as never
    )) as Undoable;
