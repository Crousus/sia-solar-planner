# Undo / Redo — Design Spec

**Date**: 2026-04-21
**Status**: Approved design, pending implementation plan
**Scope**: App-wide undo / redo for project-data mutations. UI-only state and
`mapState` (including the captured satellite image) are deliberately outside the
feature's scope.

---

## 1. Goals & non-goals

### Goals

- Every edit to project data (roofs, panels, strings, inverters, panel type,
  project name) is reversible via `Cmd/Ctrl+Z` and re-applicable via
  `Cmd/Ctrl+Shift+Z` (alias `Ctrl+Y`).
- "Foolproof": the user can never reach a state that references deleted ids,
  broken string numbering, or stale selection after an undo/redo.
- History survives inside the app's JSON save/load format, so a shared project
  file can carry its edit trail.
- Zero-impact on localStorage budget — history never touches it.
- One-gesture-equals-one-step feel: rapidly repeated same-kind mutations
  (painting a string, placing panels in a session, typing a name) collapse
  into a single undo step via a time-coalescing rule.

### Non-goals

- Undoing map navigation (pan, zoom, lock/unlock, map provider). Standard app
  convention: view state is not edit state.
- Undoing ephemeral UI (tool mode, selections, "active group", background
  toggle). These reset on refresh and are not data the user needs to reverse.
- Distributed / multi-user undo. This is a single-user local tool.
- Persisting history across browser refreshes. History is in-memory until
  explicitly exported as JSON.

---

## 2. Architectural overview

### 2.1 Middleware placement

A single custom middleware wraps the store setter:

```
useProjectStore = create(persist(undoable(storeImpl)))
```

`undoable` owns the history stacks and is the only place deciding whether a
given mutation counts as an undoable step. `persist` continues to round-trip
only the `project` slice to localStorage (`partialize` unchanged).

**How the middleware knows which action fired.** Zustand middleware wraps
`set`, not named dispatchers, so we rely on the same convention zustand's
own `devtools` middleware uses: every `set(...)` call in the store is given
an action name as its third argument —
`set(partial, /*replace=*/false, 'addRoof')`. The `undoable` middleware
reads that third argument and looks up `ACTION_POLICY[actionName]`.
Unclassified or missing action names default to `bypass` with a
`console.warn` in development — a soft fail so a forgotten label surfaces
immediately without silently corrupting history.

This means every existing `set(...)` call in `projectStore.ts` gains a
third-argument action name in the implementation pass. It's a mechanical
edit, not a logic change, and TypeScript enforces the name is a valid key
in `ACTION_POLICY`.

### 2.2 Why roll our own

`zundo` covers snapshot-based undo for zustand, but our requirements diverge
from its defaults in three places: a custom coalescing rule (per-action keys,
not just a global debounce), a scoped exclusion (`mapState`), and JSON export
that embeds history. The library would end up a thin shim around bespoke
config, so one focused file (~150 LOC) is clearer. Immer inverse-patches were
ruled out because the project is small (a few KB of data) — the memory win
over full snapshots is negligible.

### 2.3 Proven patterns used

- **Past / present / future triplet** — canonical Redux-undo shape.
- **Structural sharing** — snapshots reuse the existing array/object
  references the store already hands out on every `set`; only branches that
  actually diverged cost new memory.
- **Action-type labels** — each store action has a policy entry (record /
  bypass / clear-history / load-history), Redux-style.
- **Bounded ring buffer** — `past` capped at 100, oldest dropped on overflow.
- **Post-restore referential-cleanup pass** — defensive sweep that nulls
  dangling UI id references after any undo or redo.

---

## 3. Data model

### 3.1 `UndoableSlice`

The shape captured in each history entry:

```ts
type UndoableSlice = {
  name: Project['name'];
  panelType: Project['panelType'];
  roofs: Project['roofs'];
  panels: Project['panels'];
  strings: Project['strings'];
  inverters: Project['inverters'];
  // mapState deliberately omitted (see §3.4)
};
```

A slice is a plain object; its fields share references with the current or
prior project state. On an `addRoof`, for example, only `roofs` is a fresh
array; `panels`, `strings`, etc. are the same arrays that already existed —
so a history entry really is "one object + one new array reference."

### 3.2 Store shape additions

```ts
interface HistoryState {
  past: UndoableSlice[];         // oldest → newest; does not include present
  future: UndoableSlice[];       // newest → oldest of undone states
  lastActionSig: {               // coalescing bookkeeping
    action: keyof ProjectStore;
    key: string | null;
    at: number;                  // performance.now()
  } | null;
}

interface ProjectStore extends UIState, HistoryState {
  // ...existing fields...
  undo: () => void;
  redo: () => void;
  canUndo: boolean;              // derived mirror of past.length > 0
  canRedo: boolean;              // derived mirror of future.length > 0
}
```

`canUndo` / `canRedo` are stored as booleans — not selectors — so toolbar
buttons that subscribe via `useProjectStore(s => s.canUndo)` get cheap,
equality-based re-render gates.

### 3.3 Bounds

- `past`: capped at 100. On push beyond cap, shift the oldest entry off the
  head. 100 is the smallest number that comfortably outlasts a long drawing
  session (it's a personal tool, not a source control system).
- `future`: not explicitly capped; it only grows during redo chains and any
  new mutation wipes it, so in practice it never exceeds 100.

### 3.4 The `mapState` carve-out

`mapState` is deliberately **not** part of `UndoableSlice`. Three reasons:

1. `capturedImage` is a 1–3 MB base64 blob. Including it in history snapshots
   would turn 100 steps into 100–300 MB of memory.
2. Map navigation (pan, zoom, provider) is view state, not edit state —
   users don't reach for Cmd+Z after panning.
3. Keeping `mapState` out of history means lock/unlock can be marked
   **bypass** (§4 policy) without needing special handling — the undoable
   slice simply doesn't see it.

Apply path: `project = { ...project, ...restoredSlice }`. Because
`restoredSlice` has no `mapState` key, the current `mapState` is preserved
verbatim across undo/redo.

---

## 4. Action policy

Every store action is classified in a single `ACTION_POLICY` map, typed as
`Record<keyof ProjectStore, Policy>`. TypeScript forces every action to be
classified — adding a new action to the store without a policy entry fails
compilation, which is the audit safety-net.

```ts
type Policy =
  | { kind: 'bypass' }
  | { kind: 'clear-history' }
  | { kind: 'load-history' }
  | { kind: 'record'; coalesce?: { keyFrom?: (...args: any[]) => string | null } };
```

### 4.1 Classification

| Action                         | Policy          | Coalesce key                |
| ------------------------------ | --------------- | --------------------------- |
| `addRoof`                      | record          | (none — discrete step)      |
| `updateRoof`                   | record          | `roofId`                    |
| `deleteRoof`                   | record          | (none)                      |
| `splitRoof`                    | record          | (none)                      |
| `mergeRoofs`                   | record          | (none)                      |
| `addPanel`                     | record          | `groupId`                   |
| `deletePanel`                  | record          | (none)                      |
| `deletePanels`                 | record          | (none)                      |
| `moveGroup`                    | record          | (none — one drag = one step) |
| `updateGroupOrientation`       | record          | (none)                      |
| `addString`                    | record          | (none)                      |
| `deleteString`                 | record          | (none)                      |
| `assignPanelsToString`         | record          | `stringId` (lasso-paint)    |
| `unassignPanel`                | record          | `'unassign'` (time-only)    |
| `setStringInverter`            | record          | `stringId`                  |
| `updateString`                 | record          | `stringId`                  |
| `addInverter`                  | record          | (none)                      |
| `renameInverter`               | record          | `inverterId`                |
| `deleteInverter`               | record          | (none)                      |
| `setProjectName`               | record          | `'name'`                    |
| `updatePanelType`              | record          | `'panelType'`               |
| `lockMap`                      | bypass          | —                           |
| `unlockMap`                    | bypass          | —                           |
| `setMapProvider`               | bypass          | —                           |
| `setToolMode`                  | bypass          | —                           |
| `setSelectedRoof`              | bypass          | —                           |
| `setActiveString`              | bypass          | —                           |
| `setSelectedInverter`          | bypass          | —                           |
| `setActivePanelGroup`          | bypass          | —                           |
| `setSplitCandidateRoof`        | bypass          | —                           |
| `toggleBackground`             | bypass          | —                           |
| `loadProject`                  | load-history    | —                           |
| `resetProject`                 | clear-history   | —                           |
| `undo` / `redo`                | (internal; bypass record path) | —            |

### 4.2 Coalescing rule

Window: **500 ms**. The middleware keeps `lastActionSig = { action, key, at }`.

For a record-path mutation:

- If `action + key === lastActionSig` AND `now - lastActionSig.at <= 500`:
  suppress the push. Apply the mutation. Slide `at` forward to `now` so a
  continuous stream keeps coalescing rather than resetting on a 500 ms cap
  from the first call.
- Otherwise: push the pre-mutation slice onto `past`, clear `future`, apply
  the mutation, set `lastActionSig = { action, key, now }`.

The snapshot pushed at the *start* of a coalesced run is exactly the state
the user wants undo to restore ("before the run began"). No end-of-run flush
is needed.

Post-undo or post-redo, `lastActionSig` is reset to `null` so the first
mutation after an undo always creates a fresh step (never coalesces with
state on the other side of the undo).

---

## 5. `undo()` / `redo()` mechanics

### 5.1 `undo()`

1. If `past.length === 0`, no-op.
2. `prev = past.pop()`.
3. `currentSlice = buildSlice(state.project)`.
4. `future.push(currentSlice)`.
5. Apply: `state.project = { ...state.project, ...prev }` (note
   `mapState` is untouched because `prev` has no `mapState` key).
6. Run the UI-cleanup pass (§5.3).
7. `lastActionSig = null`.
8. Run the referential-integrity assertion (dev only, §5.4).

### 5.2 `redo()`

Symmetric: pop from `future`, push current slice onto `past`, apply, clean,
assert.

### 5.3 UI-cleanup pass

After any restore, UI fields may reference ids the restored slice does not
contain (e.g., `addRoof` auto-selects the new roof; undoing the roof leaves
`selectedRoofId` dangling). One sweep fixes this:

```ts
function cleanUiRefs(state, slice) {
  const roofIds     = new Set(slice.roofs.map(r => r.id));
  const stringIds   = new Set(slice.strings.map(s => s.id));
  const inverterIds = new Set(slice.inverters.map(i => i.id));
  const groupIds    = new Set(slice.panels.map(p => p.groupId));
  return {
    selectedRoofId:       roofIds.has(state.selectedRoofId)          ? state.selectedRoofId       : null,
    activeStringId:       stringIds.has(state.activeStringId)        ? state.activeStringId       : null,
    selectedInverterId:   inverterIds.has(state.selectedInverterId)  ? state.selectedInverterId   : null,
    activePanelGroupId:   groupIds.has(state.activePanelGroupId)     ? state.activePanelGroupId   : null,
    splitCandidateRoofId: roofIds.has(state.splitCandidateRoofId)    ? state.splitCandidateRoofId : null,
    // toolMode, showBackground: not id-referential, left alone.
  };
}
```

The existing `deleteRoof`/`deleteString`/`deleteInverter` actions inline
similar checks; we lift `cleanUiRefs` to a shared helper and call it from
those actions too. Narrow refactor, same behavior.

### 5.4 Referential-integrity assertion (dev only)

Wrapped in `if (process.env.NODE_ENV !== 'production')`. After applying a
restored slice, assert:

- Every `panel.roofId` is present in `roofs`.
- Every non-null `panel.stringId` is present in `strings`.
- Every non-null `string.inverterId` is present in `inverters`.

On violation, `console.error` with the offending ids. Zero cost in
production; early warning during development.

---

## 6. Integration points

### 6.1 Keyboard shortcuts (`src/App.tsx`)

Added to the existing `onKey` handler:

```ts
const mod = e.metaKey || e.ctrlKey;
if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
if (mod &&  e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); redo(); return; }
if (mod && !e.shiftKey && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
```

Input/textarea guard: the existing early return on `HTMLInputElement |
HTMLTextAreaElement` applies (we want the browser's native text-field undo to
take over when focus is in a field). **Unlike `r`/`p`/`s`/`d`, undo/redo
shortcuts are NOT gated on `locked`** — editing the project name or panel
type pre-lock is legitimately undoable.

### 6.2 Toolbar buttons (`src/components/Toolbar.tsx`)

Two icon buttons (Undo, Redo) beside the mode buttons. Each `disabled` when
its stack is empty. `title` attribute shows the platform-appropriate chord
(detect once: `/Mac|iPhone|iPad/.test(navigator.platform)` ⇒ `⌘Z` / `⇧⌘Z`,
else `Ctrl+Z` / `Ctrl+Shift+Z`).

### 6.3 JSON export (Toolbar save action)

```jsonc
{
  "version": 2,
  "project": { /* Project exactly as before */ },
  "history": { "past": [...slices...], "future": [...slices...] }
}
```

### 6.4 JSON import

Dispatches on `version`:

```ts
if (parsed && typeof parsed === 'object' && parsed.version === 2) {
  loadProject(parsed.project, parsed.history ?? { past: [], future: [] });
} else {
  // v1 (raw Project) — older files pre-feature
  loadProject(parsed as Project, { past: [], future: [] });
}
```

### 6.5 `loadProject` / `resetProject`

- `loadProject` gets a second argument `history: { past, future }`. It
  replaces the project AND the history stacks, then resets UI state
  (matching current behavior).
- `resetProject` empties both stacks in addition to resetting the project.

### 6.6 localStorage persistence

Unchanged: `partialize: (s) => ({ project: s.project })`. History is **not**
written to localStorage. On page refresh: history empty, project restored.
This is a deliberate choice — persisting history to localStorage would
compete with the ~5 MB quota the captured image already strains.

---

## 7. Testing strategy

### 7.1 Unit tests

Focused on the middleware — the store's existing actions are unchanged in
shape and are tested by their existing behavior. New test file:
`src/store/projectStore.undo.test.ts`.

1. **Round-trip per action category** — addRoof → undo → roofs empty →
   redo → roof back. Repeat for panel CRUD, string CRUD, inverter CRUD,
   `splitRoof`, `mergeRoofs`.
2. **Bypass actions don't pollute history** — 10× `setToolMode` then 1×
   `addRoof`; one undo restores pre-`addRoof` state, not a tool-mode change.
   `lockMap`/`unlockMap` same.
3. **Coalescing**
   - Two `assignPanelsToString(..., s1)` calls within 500 ms → one undo step
     reverses both.
   - Two `assignPanelsToString` calls with different `stringId` → two steps.
   - Same action + key but >500 ms apart (inject a clock) → two steps.
4. **`future` clears on new mutation** — mutate, undo, mutate, redo is
   no-op.
5. **Depth cap** — 101× `addRoof` ⇒ `past.length === 100`, oldest dropped.
6. **UI-cleanup** — `addRoof` (auto-selects), undo, expect
   `selectedRoofId === null`. Same for `addString`/`activeStringId`,
   `addInverter`/`selectedInverterId`, `setActivePanelGroup` dangling after
   `deletePanels`-then-undo pattern, etc.
7. **Referential-integrity assertion fires** — manually corrupt a slice,
   trigger undo, expect console.error.
8. **JSON round-trip** — build project, edit, export → clear store → import
   → `past`, `future`, `project` match. v1 import (no `version` field) loads
   cleanly with empty history.
9. **Post-undo coalescing reset** — mutate A, mutate A within 500 ms
   (coalesced), undo, mutate A within 500 ms of the undo → must start a new
   step (never coalesce across an undo boundary).
10. **mapState isolation** — `addRoof`, `lockMap` (bypass), undo →
    roof removed, `mapState.locked` still true.

### 7.2 Manual smoke checklist

Documented in the implementation plan, run at the end:

- Draw roof → place panels → paint string → Cmd+Z repeatedly to zero →
  Cmd+Shift+Z all the way back → visually identical.
- Lock map, edit, undo, unlock, edit, undo — confirm lock boundary is
  transparent to history.
- Refresh page: history empty, project intact.
- Save to JSON, reload page, import JSON: history restored.

---

## 8. Risks and open questions

### 8.1 Captured image reference

`mapState` is excluded from `UndoableSlice`, so the captured image blob
never enters history. Memory is safe by construction.

### 8.2 Action policy drift

New actions must be added to `ACTION_POLICY`. This is enforced at the type
level — the map's key type is `keyof ProjectStore` filtered to function
fields — so an unclassified new action fails `tsc`. If a future developer
adds an action in a commit that also loosens the type, the safety net
weakens; mitigated by a code-review note and by the one-file centralization
that makes drift visible.

### 8.3 Coalescing window tuning

500 ms is a starting point. If lasso-paint is particularly quick on fast
hardware, coalescing will still bind sequential strokes. If it's slow on
weaker hardware and a stroke takes >500 ms between panels, a stroke could
split across undo steps. Tunable via a single constant in the middleware.

### 8.4 Exported JSON files grow

A long session ending in export produces a file with up to 100 past-slice
snapshots. Even with structural sharing inside memory, JSON serialization
materializes each slice's arrays independently — no reference sharing on
disk. For a 400-panel project at ~100 steps, the file can easily reach
several MB. Acceptable for a power-user tool; noted for awareness.

### 8.5 `splitRoof` rejection path

`splitRoof` returns `false` when the cut is geometrically invalid and the
store is unchanged. The middleware must NOT push a snapshot in this case,
otherwise undo history gets phantom no-op steps. Middleware contract:
actions signal "nothing recorded" by not actually changing
`project`. Implementation detail: the middleware compares the slice's field
references before/after; if all six fields are reference-equal, no push.
This is a one-line `Object.is` sweep and happens to correctly drop no-op
calls across the board.

---

## 9. File-level change inventory

New:

- `src/store/undoMiddleware.ts` — the middleware, `ACTION_POLICY` map,
  `cleanUiRefs`, referential-integrity assertion, coalescing logic.
- `src/store/projectStore.undo.test.ts` — tests enumerated in §7.1.

Modified:

- `src/store/projectStore.ts` — wire the middleware into the `create` call;
  add `undo`, `redo`, `canUndo`, `canRedo`, `past`, `future`,
  `lastActionSig` fields; extend `loadProject` to accept optional history;
  **add an action-name third argument to every `set(...)` call** so the
  middleware can classify mutations (mechanical edit, ~25 call sites).
- `src/App.tsx` — keyboard shortcuts for undo/redo.
- `src/components/Toolbar.tsx` — undo/redo buttons; wrap save/load to
  round-trip history.

Deleted:

- None.

Non-code:

- Bump exported JSON schema to `version: 2`. v1 imports still work.
