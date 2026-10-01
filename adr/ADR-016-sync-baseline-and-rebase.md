# ADR-016: Server-Confirmed Sync Baseline and Id-Aware Rebase

- **Status:** Accepted. Complements ADR-015 (local-only undo, no localStorage persistence of `project`). Amended: every merge result now also passes through `repairReferences` (`src/utils/repairReferences.ts`), which resolves the dangling-reference and duplicate-`indexInString` consequences listed below.
- **Date:** 2026-10-01
- **Requirement:** No local edit may be lost or silently reverted by the realtime sync layer. This covers collaborator patches arriving mid-edit, gestures, view toggles, reconnects, a tab closing, and stop/start races. A user's data must also never leak to the next user of the same browser.

## Context

An audit of `src/backend/syncClient.ts` and its callers found several data-loss paths. They had one root cause: the client's "last synced doc" was assigned from the **store**, not from what the server had confirmed.

1. `applyInbound` applied a collaborator's ops to the store, which still held unsent debounced edits, and then set `lastSyncedDoc = store.project`. The unsent edits became part of the baseline and were never POSTed. The baseline also stopped matching the server. Later diffs from `fast-json-patch` address array elements by **index**, so they hit the wrong panels or failed with 400. A 400 was then retried forever with the same bad diff.
2. The gesture drain had the same flaw, and on top of it never advanced `lastKnownRevision`, so the next POST always got a 409. The re-applied local diff also duplicated `add /panels/N` and removed the wrong panels.
3. `/p/:id` and `/p/:id/diagram` were two separate routes, so a view toggle remounted `ProjectEditor`. That triggered stop, reset, refetch and lost undo history, and opened a race where the remount's GET returned an older revision than `start()`'s own GET.
4. `stop()` during `start()` leaked subscriptions, so a stale client could write project A's ops into project B's store. `ProjectEditor` could also create and start a client after its effect had already been cancelled.
5. Every revision gap ran `fullResync → loadProject`, which threw away unsent edits, tool mode, selection and undo history. A collaborator's SSE patch arriving before our own POST's 200 counted as a gap. While a conflict was open, any inbound patch "resolved" it as discard-mine.
6. A tab closing inside the 1 s debounce window lost the edit, because there was no pagehide flush and no `keepalive`.
7. The `deviceId` was kept in sessionStorage. Chrome's "Duplicate tab" copies sessionStorage, so two tabs dropped each other's patches as echoes.
8. There was no reconnect handling (PocketBase does not replay missed events), and a failed initial load was ignored.
9. Sign-out cleared only the token. The legacy `solar-planner-project` key, holding the last opened project, was then silently imported into the next user's team.

## Decision

1. **`base` is only ever server-confirmed state.** It is assigned from exactly one of four sources:
   - the fetched record;
   - `base` with an inbound patch applied, in strict `from_revision` order;
   - the doc we POSTed, once the server returns 200;
   - a 409 or resync `currentDoc`.

   It is JSON-normalised (`toJsonDoc`: no `undefined` or NaN), so it matches the server byte for byte. Index-addressed diffs `diff(base, local)` are therefore always valid on the server. At most one POST is in flight.

2. **One rebase primitive (`advanceBase`).** When `base` moves under unsent local work, the new store state is `rebaseProject(oldBase, newBase, local)`. This is a structural three-way merge in `diff.ts`:
   - Plain objects are merged key by key.
   - Arrays whose elements all carry a unique string `id` (roofs, panels, strings, inverters, diagram nodes and edges) are merged **by id**: adds and deletes from both sides are kept, and shared elements are merged recursively.
   - Other values are atomic.
   - A same-leaf change on both sides is a *conflict*. The merge keeps the local value and reports the path.

   The result is written to the store as `applyRemotePatch(diff(store, merged))`, which is bypass, so it adds no undo entry and leaves UI state untouched. Because the diff is computed against the same object it is applied to, index addressing is safe there too. We considered emitting id-aware JSON-Patch ops instead, but rejected it: the server is a generic RFC 6902 applier, so a structural merge on the client was simpler and keeps the wire format unchanged.

3. **Conflicts ask the user. They are never resolved by inbound traffic.** If a rebase reports conflicts, the conflict modal opens. Neither the store nor `base` changes, and outbound flushes pause. Inbound patches update the modal's server doc only.
   - **Discard mine:** the store takes the server doc through `applyRemotePatch`, not `loadProject`, so UI state survives.
   - **Keep mine:** conflicting fields take the local value, and the collaborator's non-conflicting changes are kept.

   A 409 with no overlapping edits is rebased and re-sent automatically.

4. **Inbound ordering instead of gap panics.** Patches are buffered by `from_revision` and applied when they chain from the head. A gap while our POST is in flight waits for the response, because the gap may be our own revision. Only a gap that persists, or a patch that fails to apply, triggers `requestResync`. That is a GET plus `integrateSnapshot`, which uses the same rebase and never calls `loadProject`. Every PB_CONNECT after the initial load counts as a reconnect and also resyncs.

5. **A 400 is not retried blindly.** The first 400 rebuilds the baseline with a resync (an equal revision still replaces the doc) and flushes a fresh diff. A second consecutive 400 sets the status to `{ kind: 'error', reason: 'rejected' }`. Local edits are kept, and the next edit tries again.

6. **Lifecycle.**
   - `start({ load, onLoaded })` subscribes to `patches` and PB_CONNECT **before** loading, so every event in the fetch window is buffered and reconciled by revision. `ProjectEditor` passes its own `expand` loader, so a single fetch feeds both the editor and the baseline.
   - Every await and every callback checks `stopped`. Subscriptions that resolve after `stop()` are torn down immediately (`addCleanup`).
   - A transient initial-load failure is retried three times, then the status becomes `error/load-failed` and `start()` rejects, which shows the editor's error page.
   - `stop()` snapshots the store's project, then the final flush drains that snapshot. A final 409 is rebased and re-sent, up to three attempts. A real conflict or a network error is reported through `onUnsavedChanges`, which surfaces as a toast.
   - On `visibilitychange→hidden` and `pagehide` we flush immediately. POSTs at or under 60 KB use `fetch(..., { keepalive: true })`. `beforeunload` prompts only when edits can't be guaranteed: a non-keepalive body, edits queued behind an in-flight POST, or an open conflict.

7. **Single editor route.** `/p/:projectId` is a layout route with element-less `index` and `diagram` children. The editor stays mounted across view toggles, and `App.tsx` still picks the view from the pathname. The `ProjectEditor` effect depends on `projectId` only; `t` and `navigate` are read through refs.

8. **Page-scoped deviceId.** The id is a module-level random value. A reload no longer needs to keep it: the reloaded page loads from the server after subscribing, so an echo of the old page's last POST is either stale (dropped by revision) or correctly applied.

9. **Local data hygiene.**
   - `signOutUser()` in `pb.ts` is the only sign-out path. It clears every `solar-planner-*` key, then the auth.
   - `installAuthUserGuard()`, mounted in AppShell, wipes app data when a *different* user authenticates than the last one seen. This covers expired sessions.
   - `maybeImportLocalStorage` discards the blob when the server-era marker is set (the server-backed editor has run in this browser). Otherwise it asks the user to confirm, showing the project's name. Declining deletes the blob.

## Consequences

- Concurrent edits to different fields or entities merge without a modal. The modal appears only for true same-field conflicts.
- After a "keep mine" merge, the doc can contain dangling references, for example a panel kept by us on a roof the collaborator deleted. Store-side referential repair (ADR-015) covers this only for undo, not for merges.
- Ordering-only changes to an entity array are lost if both sides changed that array concurrently, because the collaborator's order wins. Nothing in the data model currently depends on array order for semantics.
- Concurrently added panels on the same string can get duplicate `indexInString` values until the next renumbering mutation.
- Each inbound patch costs a structural merge plus two diffs over the doc. Identity short-circuits keep unchanged subtrees, including the base64 capture, cheap.
- A blob written by an older post-auth version, on a browser where the new editor never ran, can still reach the confirm prompt. The prompt names the project, so the user can decline.
