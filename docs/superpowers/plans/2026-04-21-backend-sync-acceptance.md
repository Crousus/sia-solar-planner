# Backend Sync — Acceptance Checklist

Walk through each scenario against a running server (`cd server && ./pocketbase serve`). Check boxes as you verify. File gaps as follow-up issues or fix inline if small.

## Onboarding

- [ ] Fresh user signs up at `/login` → gets redirected to `/` → sees "no teams" empty state → can create a team
- [ ] After team creation, user lands on the team view with "no projects yet"
- [ ] Admin can invite an existing user by email on `/teams/:id/members` → row appears with role 'editor'
- [ ] Inviting a non-existent email shows an error, not a silent failure
- [ ] Admin can remove members; member-role users cannot access the members page (redirect or 403)

## Editing

- [ ] Project create → lands on `/p/:id` editor
- [ ] Lock map, draw roof, place panels → status indicator transitions blue ("Syncing…") → green ("Synced") within ~3 s
- [ ] Reload the page → roof and panels persist (server-side state authoritative)

## Two-tab realtime

- [ ] Tab A and Tab B on the same `/p/:id`, different users, both signed in
- [ ] Tab A's edits appear in Tab B within 3 s (via SSE)
- [ ] Tab A mid-drag: tab B makes concurrent edits that DO NOT interrupt Tab A's dragging roof (gesture queue buffers inbound until pointerup)
- [ ] On Tab A pointerup: Tab B's buffered ops apply AND Tab A's gesture re-asserts

## Offline / conflict

- [ ] In Tab A: disable network (DevTools offline) → edit → status goes amber "Offline — changes saved locally"
- [ ] Re-enable network → within 30 s changes POST and status goes green
- [ ] Force a 409: disable network in A, edit in B, re-enable A → conflict modal appears
- [ ] "Discard mine" → A's edits replaced with B's server state; status goes green
- [ ] Repeat forced 409; "Overwrite theirs" → A's values win; B sees them via SSE

## Undo

- [ ] Ctrl-Z in A after a local edit → change reverted locally AND propagates to B (a normal outbound POST is fired for the undo's resulting diff)
- [ ] Ctrl-Z does NOT undo remote patches (applyRemotePatch is bypass)

## localStorage import

- [ ] Sign out. In DevTools console, set `localStorage.setItem('solar-planner-project', JSON.stringify({ state: { project: { ...non-empty... } }, version: 0 }))`
- [ ] Sign in with a fresh account (no server projects yet) → auto-redirect to `/p/:new-id` with the imported roof visible
- [ ] Check `localStorage` → `'solar-planner-project'` key is cleared
- [ ] Sign out and back in → no re-import (key is gone and server project exists)

## Deletion

- [ ] Delete a project in Tab A → Tab B (on the same project) gets 404 on next interaction and bounces to `/` (or similar graceful handling)

## Cleanup / hygiene

- [ ] `npm run test:run` → all tests pass
- [ ] `npm run build` → builds cleanly
- [ ] `server/pb_data/` does not contain stale `_pb_superusers_auth_cache` or similar caches that would confuse a fresh deploy
