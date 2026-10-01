# ADR-015: Delta-Based, Local-Only Undo and Server as Sole Source of Truth

- **Status:** Accepted. Supersedes ADR-014 §4 (snapshot past/future triplet), §8 (persist wraps undoable) and the localStorage parts of §1/§9. The rest of ADR-014 (policy table, coalescing handshake, mirror booleans, UI-ref cleanup, dev integrity check) still applies.
- **Date:** 2026-10-01
- **Requirement:** Undo must only ever revert the local user's own edits, even while collaborators' changes stream in over SSE. Project state must not be written to localStorage, since the PocketBase server is now the source of truth.

## Context

ADR-014 stored each history step as a full `UndoableSlice` snapshot: the whole `roofs`/`panels`/`strings`/`inverters` arrays as they were before the step. Undo put those arrays back. That was fine while the app was single-user, but it broke once realtime sync arrived (remote ops come in through `applyRemotePatch`, which bypasses history):

1. Alice adds roof R1. Bob's R2 arrives as a remote patch. Alice presses Ctrl-Z and `roofs` is set back to the snapshot `[]`. The sync client sees R2 missing and **deletes Bob's roof on the server**.
2. In the same way, undo would bring back entities that Bob had deleted, and roll back Bob's field edits to any entity that appeared in the snapshot.

There was a second, separate problem with zustand's `persist` middleware. It wrote the full doc, including the multi-MB base64 `capturedImage`, synchronously on **every** `set()`. That covered UI-only actions and every diagram-drag frame. Once the ~5 MB quota was exceeded, every `set()` threw after state had already changed: `loadProject` failed ("Failed to open project") and `applyRemotePatch` threw, which caused endless resyncs. All tabs shared one key, and the last project leaked to the next account that used the same browser. AGENTS.md already says there is no offline mode, so the persisted copy did nothing useful.

## Decision

1. **History entries are id-keyed deltas (`HistoryEntry`, types/index.ts).** The record path still takes `buildSlice` before and after each local `set()`, but now stores `diffSlices(before, after)`:
   - Per collection, a list of `add` (entity + predecessor anchor), `remove` (full pre-step entity + anchor) or `update` (only the changed fields, `{before, after}`). Equality is structural (`deepEqual`), so reducers that rebuild unchanged objects (`renumberStrings`) don't record phantom changes.
   - `name` is a scalar `{before, after}`. `panelType` is a field map.
   - A value-equal diff counts as a no-op and is not pushed.
   - `mapState`, `meta` and `diagram` stay outside the undo surface, as before.

2. **Undo applies the inverse delta to the current state. Redo applies the delta forward.** The same entry object moves between `past` and `future`. Nothing is recomputed, and entries stay valid no matter which remote patches land in between. The conflict policy is three-way and field-level, and the newer writer wins:
   - `update`: a field is written only if it still holds the step's starting value. A field a collaborator changed in the meantime is skipped, and fields the step never touched are never written. If the entity no longer exists, the update is skipped, so undo never brings back something a collaborator deleted.
   - `remove` (for example, undoing an add): the entity is removed if it is still present.
   - `add` (for example, undoing a delete): the entity is re-inserted after its anchor (or appended if the anchor is gone), unless that id already exists.
   - Scalars are reverted only if they still equal the step's value.

3. **Targeted referential repair after each apply.** The repair cascades only from entities this apply removed. A removed roof takes its panels with it, a removed string leaves its panels unassigned, and a removed inverter clears `inverterId`/`mpptPort` on its strings. It also validates only the entities this apply wrote: a written panel on a missing roof is dropped, and dangling string or inverter refs are nulled. Strings whose membership or indices changed are renumbered through an injected `renumberStrings` (`ApplyHistoryOptions`). `cleanUiRefs` runs afterwards as before. Inconsistencies that already existed elsewhere are left alone.

4. **Coalescing composes deltas per id.** Coalescing is still keyed on the same action and key within 500 ms. Each entity keeps its earliest `before` and latest `after`. Combinations net out: add then update is an add, add then remove cancels, update then remove is a remove of the rolled-back entity. Each part of the merge is diffed around its own local `set()`, so a remote patch that lands in the middle of a slider scrub can never end up inside the merged entry. A streak that ends where it started (slider scrubbed away and back) drops its entry entirely.

5. **No localStorage persistence.** The `persist` middleware is removed. The store is a plain in-memory working copy: `ProjectEditor` loads the doc from the server and `syncClient` keeps it in sync. History is in-memory, so a reload starts with a clean undo stack, which matches ADR-014's "refresh = fresh session" rule. The legacy key name is exported as `LEGACY_PROJECT_STORAGE_KEY` for the one-time pre-auth import in `backend/migrateLocalStorage.ts`.

6. **JSON export v3.** `serializeProject` writes `{ version: 3, project, history: { past: HistoryEntry[], future } }`. v2 files, which hold snapshot history, still load. `deserializeProject` tags their history `kind: 'snapshots'`, and `loadProject` turns it into deltas with `entriesFromSnapshots` by diffing consecutive snapshots against the loaded project.

7. **Layering fix.** `UndoableSlice` and the history types moved to `types/index.ts`, so `utils/projectSerializer.ts` no longer imports from `store/`. `undoMiddleware` re-exports them.

## Consequences

- **Pros:**
  - Ctrl-Z can no longer delete, bring back or overwrite a collaborator's work, apart from the explicit cascades in point 3.
  - History memory scales with the size of each edit, not the size of the project.
  - Remote patches stay out of history and never invalidate it. The sync agent can keep using `applyRemotePatch` without any history rebasing.
  - `set()` no longer serializes the doc, so UI actions and diagram drags are cheap, and no quota exceptions are possible.
  - No cross-account leak through the store.
- **Cons:**
  - The engine (`diffSlices`/`composeEntries`/`applyEntry`) is more complex than "put the array back". It is covered by dedicated unit tests.
  - Undo is now best-effort when there are conflicts: a field a collaborator changed after the local step stays at their value, with no UI to say so.
  - Undoing an add removes the entity even if a collaborator has edited it since, and a removed roof cascades to panels a collaborator placed on it. This is deliberate: "my add, gone".
  - Every `record` set now does an O(n) id-keyed diff of the changed arrays. Arrays with an unchanged reference are skipped, so in practice the cost is negligible.
  - With no local copy, a page reload while offline shows nothing. This is consistent with AGENTS.md's "no offline capability" non-goal.
  - Old `solar-planner-project` blobs written by earlier builds stay in users' browsers until `migrateLocalStorage` clears them.
