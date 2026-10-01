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

package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	jsonpatch "github.com/evanphx/json-patch/v5"
)

// ── Per-project serialization ──────────────────────────────────────────
//
// WHY THIS EXISTS:
// PocketBase's `app.RunInTransaction` uses `BEGIN DEFERRED` under the
// hood. Under SQLite WAL mode, DEFERRED transactions start with a SHARED
// lock and only upgrade to RESERVED/EXCLUSIVE at first write. That means
// two concurrent POST /api/sp/patch requests for the same project can
// both:
//
//  1. Enter their transactions holding only a SHARED lock,
//  2. Read `currentRevision = N` via FindRecordById,
//  3. Pass the OCC check `currentRevision == body.FromRevision` — both
//     see N, both think they're the unique writer racing from N→N+1,
//  4. Race at first write / commit — WAL may allow one through while
//     the other fails with SQLITE_BUSY after the busy_timeout expires,
//     OR (worse) the scheduler lets both writes serialize such that
//     the second commits on top of the first with a stale in-memory
//     `currentRevision`, inserting two patches rows with the same
//     `from_revision` and desynchronizing clients.
//
// The clean fix would be `BEGIN IMMEDIATE` (write-intent lock at txn
// start, serializing write-txns at the SQLite level). PocketBase (v0.23
// when this was written; re-checked on v0.40)
// doesn't expose a knob for this on `RunInTransaction`, and wrapping
// the write DB ourselves means building a `core.App` shim — invasive.
//
// Instead: serialize same-project patch handlers in-process via a
// per-project mutex. Different projects proceed in parallel; same
// project goes one-at-a-time through the critical section that spans
// read→OCC check→write. Same-project concurrency is dominated by the
// same user with multiple tabs plus teammates editing simultaneously;
// the mutex wait is short (a patch txn is O(10ms)) and well within
// the latency budget for an interactive collab tool.
//
// SCOPE LIMITATION:
// This mutex lives in ONE Go process. It does NOT protect against
// concurrent writes from a second instance of the binary. Acceptable
// today because solar-planner runs as a single-VPS single-binary
// deployment. If we ever horizontally scale (multiple PB instances
// behind a load balancer), this fix is insufficient and we must
// switch to SQLite-level `BEGIN IMMEDIATE` or a distributed lock
// (e.g., advisory locks in Postgres if we migrate off SQLite).
//
// MEMORY:
// Entries are reference-counted and removed when the last holder/waiter
// releases them, so the map only ever contains projects with an
// in-flight patch. (It used to grow forever, and because the lock was
// taken BEFORE the membership check, any signed-in user could inflate it
// without bound by POSTing random projectIds — an easy memory DoS. The
// handler now also authorizes before locking.)
type projectLock struct {
	mu   sync.Mutex
	refs int // guarded by projectLocksMu
}

var (
	projectLocksMu sync.Mutex
	projectLocks   = map[string]*projectLock{}
)

// lockProject returns an unlock function for the given projectId,
// blocking until the project-specific mutex is acquired. Callers do:
//
//	unlock := lockProject(id)
//	defer unlock()
//
// The outer `projectLocksMu` guards map reads/writes and refcounts only;
// we release it before acquiring the inner per-project mutex so a
// long-running patch for project A doesn't block map lookups for B.
func lockProject(projectID string) func() {
	projectLocksMu.Lock()
	l, ok := projectLocks[projectID]
	if !ok {
		l = &projectLock{}
		projectLocks[projectID] = l
	}
	l.refs++
	projectLocksMu.Unlock()

	l.mu.Lock()
	return func() {
		l.mu.Unlock()
		projectLocksMu.Lock()
		l.refs--
		if l.refs == 0 {
			delete(projectLocks, projectID)
		}
		projectLocksMu.Unlock()
	}
}

// projectLockCount is exposed for tests (lock-map leak regression).
func projectLockCount() int {
	projectLocksMu.Lock()
	defer projectLocksMu.Unlock()
	return len(projectLocks)
}

// ── Limits ─────────────────────────────────────────────────────────────
//
// WHY each limit exists (audit finding H4):
//
//   - maxPatchBodyBytes: the raw request body, read under a hard cap so a
//     hostile client can't stream an unbounded body into memory. It must
//     still fit the LEGITIMATE worst case: locking the map adds the
//     captured satellite image (multi-MB base64) to the doc in a single
//     `replace /mapState` op, and projects.doc may be up to 20 MB. So the
//     cap is 25 MB — matching nginx's `client_max_body_size 25m` on /api/
//     and the patches.ops maxSize raised in migration 1712347100.
//   - maxPatchOps: bounds CPU; each op walks the document.
//   - allowedPatchOps: the client only ever emits what fast-json-patch's
//     compare() produces — add / remove / replace (plus `test`, which is
//     harmless and lets future clients add preconditions). `copy` was the
//     amplification primitive: evanphx/json-patch's default
//     AccumulatedCopySizeLimit is 0 = unlimited, so N `copy` ops doubling
//     a subtree each time turn a few KB of request into gigabytes of RAM.
//     `move` is rejected too: never emitted, and not worth the surface.
//   - maxCopyBytes: defense in depth should copy ever be re-enabled.
//   - maxDocBytes: mirrors projects.doc maxSize (20 MB) so oversize
//     results get a clean 413 instead of a 500 from the save validator.
const (
	maxPatchBodyBytes = 25 << 20
	maxPatchOps       = 20000
	maxCopyBytes      = 1 << 20
	maxDocBytes       = 20_000_000
	maxDeviceIDLen    = 64  // patches.device_id max
	maxProjectNameLen = 200 // projects.name max
)

var allowedPatchOps = map[string]bool{
	"add":     true,
	"remove":  true,
	"replace": true,
	"test":    true,
}

// ── Request/response DTOs ──────────────────────────────────────────────

type patchRequest struct {
	ProjectID    string          `json:"projectId"`
	FromRevision int             `json:"fromRevision"`
	Ops          json.RawMessage `json:"ops"` // RFC 6902 patch array, kept as raw JSON
	// DeviceID disambiguates tabs of the same signed-in user. Optional
	// (empty string stored as-is) — legacy clients that don't send it
	// fall back to the author-based self-filter. See the patches
	// collection's `device_id` field for the full rationale.
	DeviceID string `json:"deviceId"`
}

type patchConflictResponse struct {
	Error           string `json:"error"`
	CurrentRevision int    `json:"currentRevision"`
	CurrentDoc      any    `json:"currentDoc"`
}

type patchSuccessResponse struct {
	NewRevision int `json:"newRevision"`
}

// ── Handler ────────────────────────────────────────────────────────────

func handlePatch(re *core.RequestEvent) error {
	// 1. Auth gate. We only accept signed-in user callers (not superusers
	//    via the admin token, not anonymous). PB's `re.Auth` is populated
	//    by the auth middleware that runs ahead of this handler (and is
	//    cleared for unapproved users by the approval gate).
	if !isUserCaller(re) {
		return re.UnauthorizedError("sign-in required", nil)
	}

	// 2. Parse body under a hard size cap. We read it ourselves (instead
	//    of re.BindBody) so we can tell "too large" (413) apart from
	//    "malformed" (400).
	re.Request.Body = http.MaxBytesReader(re.Response, re.Request.Body, maxPatchBodyBytes)
	raw, err := io.ReadAll(re.Request.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return re.Error(http.StatusRequestEntityTooLarge, "patch too large", nil)
		}
		return re.BadRequestError("could not read body", nil)
	}
	body := patchRequest{}
	if err := json.Unmarshal(raw, &body); err != nil {
		return re.BadRequestError("invalid JSON body", nil)
	}
	if body.ProjectID == "" {
		return re.BadRequestError("projectId required", nil)
	}
	if len(body.DeviceID) > maxDeviceIDLen {
		return re.BadRequestError("deviceId too long", nil)
	}
	patch, err := decodeAndValidatePatch(body.Ops)
	if err != nil {
		return re.BadRequestError(err.Error(), nil)
	}

	// 3. Authorize BEFORE taking the per-project lock. Unknown project and
	//    "exists but you're not a member" return the SAME 404 so the
	//    endpoint can't be used as an existence oracle for project ids.
	if !canAccessProject(re.App, body.ProjectID, re.Auth.Id) {
		return re.NotFoundError("project not found", nil)
	}

	// 4. Serialize same-project patch handlers. See the top-of-file
	//    comment on `projectLocks` for the full rationale — in short,
	//    PB's RunInTransaction uses BEGIN DEFERRED which lets two
	//    concurrent same-project txns both pass the OCC revision
	//    check before either has written. An in-process mutex keyed
	//    by projectId closes that race without fighting PB's
	//    transaction wrapper. Different projects still proceed in
	//    parallel.
	unlock := lockProject(body.ProjectID)
	defer unlock()

	// 5. Transactional work: read project, validate revision, apply patch,
	//    save project, save patches record. All or nothing — we don't
	//    want a patches row without a matching project revision bump.
	var newRevision int
	err = re.App.RunInTransaction(func(txApp core.App) error {
		// Re-read inside the lock: the project (or the caller's membership)
		// may have changed while we were waiting.
		project, err := txApp.FindRecordById("projects", body.ProjectID)
		if err != nil || !isTeamMember(txApp, project.GetString("team"), re.Auth.Id) {
			return notFound("project not found")
		}

		// Revision check. Mismatch → 409 with current state so the client
		// can show the discard/overwrite modal without a second roundtrip.
		currentRevision := project.GetInt("revision")
		if currentRevision != body.FromRevision {
			return conflict{
				currentRevision: currentRevision,
				currentDoc:      project.Get("doc"),
			}
		}

		// Apply patch with explicit, bounded options (see Limits above).
		docBytes, err := json.Marshal(project.Get("doc"))
		if err != nil {
			return fmt.Errorf("marshal existing doc: %w", err)
		}
		patchedBytes, err := applyBounded(patch, docBytes)
		if err != nil {
			return re.BadRequestError("patch failed to apply", nil)
		}
		if len(patchedBytes) > maxDocBytes {
			return re.Error(http.StatusRequestEntityTooLarge, "resulting project too large", nil)
		}
		var patchedDoc any
		if err := json.Unmarshal(patchedBytes, &patchedDoc); err != nil {
			return fmt.Errorf("patched doc not valid JSON: %w", err)
		}

		// Save updated project. PocketBase's Save on an existing record
		// does an UPDATE, bumps `updated`, and returns the same record
		// instance with the new revision visible.
		project.Set("doc", patchedDoc)
		project.Set("revision", currentRevision+1)
		// If the patch touched the top-level name, mirror it to the
		// column so the project list view doesn't need to parse `doc`.
		// Truncated to the column's max so a long name can't 500 the save.
		if patchedMap, ok := patchedDoc.(map[string]any); ok {
			if name, ok := patchedMap["name"].(string); ok && name != "" {
				project.Set("name", truncateRunes(name, maxProjectNameLen))
			}
		}
		if err := txApp.Save(project); err != nil {
			return fmt.Errorf("save project: %w", err)
		}

		// Insert patches record — this is the SSE fanout. PocketBase's
		// realtime broadcasts record-create events to subscribers that
		// pass the patches list/view rule (team members only).
		patchesCollection, err := txApp.FindCollectionByNameOrId("patches")
		if err != nil {
			return fmt.Errorf("patches collection missing: %w", err)
		}
		patchRec := core.NewRecord(patchesCollection)
		patchRec.Set("project", body.ProjectID)
		patchRec.Set("author", re.Auth.Id)
		patchRec.Set("from_revision", body.FromRevision)
		patchRec.Set("to_revision", currentRevision+1)
		// Store the ops as-is. json.RawMessage preserves the original bytes,
		// avoiding a round-trip through a Go map that could reorder object
		// keys or normalize number representation.
		patchRec.Set("ops", body.Ops)
		patchRec.Set("device_id", body.DeviceID)
		if err := txApp.Save(patchRec); err != nil {
			return fmt.Errorf("save patches record: %w", err)
		}

		newRevision = currentRevision + 1
		return nil
	})

	if err != nil {
		// Translate our sentinel error types into HTTP responses. Anything
		// unexpected falls through to a 500 (details logged, not returned).
		var c conflict
		if errors.As(err, &c) {
			return re.JSON(http.StatusConflict, patchConflictResponse{
				Error:           "revision mismatch",
				CurrentRevision: c.currentRevision,
				CurrentDoc:      c.currentDoc,
			})
		}
		var nf notFound
		if errors.As(err, &nf) {
			return re.NotFoundError(string(nf), nil)
		}
		var apiErr *router.ApiError
		if errors.As(err, &apiErr) {
			return apiErr
		}
		re.App.Logger().Error("handlePatch", "error", err)
		return re.InternalServerError("patch failed", nil)
	}

	return re.JSON(http.StatusOK, patchSuccessResponse{NewRevision: newRevision})
}

// decodeAndValidatePatch parses the RFC 6902 array and enforces the op
// whitelist and count cap described under Limits.
func decodeAndValidatePatch(rawOps json.RawMessage) (jsonpatch.Patch, error) {
	if len(rawOps) == 0 {
		return nil, errors.New("ops required")
	}
	patch, err := jsonpatch.DecodePatch(rawOps)
	if err != nil {
		return nil, errors.New("invalid JSON Patch")
	}
	if len(patch) == 0 {
		return nil, errors.New("ops required")
	}
	if len(patch) > maxPatchOps {
		return nil, fmt.Errorf("too many ops (max %d)", maxPatchOps)
	}
	for i, op := range patch {
		if !allowedPatchOps[op.Kind()] {
			return nil, fmt.Errorf("op %d: unsupported operation %q", i, op.Kind())
		}
		if _, err := op.Path(); err != nil {
			return nil, fmt.Errorf("op %d: missing path", i)
		}
	}
	return patch, nil
}

// applyBounded applies the patch with explicit options instead of the
// package-level defaults (whose copy limit is "unlimited").
func applyBounded(patch jsonpatch.Patch, doc []byte) ([]byte, error) {
	opts := jsonpatch.NewApplyOptions()
	opts.AccumulatedCopySizeLimit = maxCopyBytes
	opts.SupportNegativeIndices = false // fast-json-patch never emits them
	return patch.ApplyWithOptions(doc, opts)
}

// isTeamMember reports whether userID has a team_members row for teamID.
// Custom routes don't get automatic API-rule evaluation, so every handler
// that touches a team-scoped record checks this by hand.
func isTeamMember(app core.App, teamID, userID string) bool {
	if teamID == "" || userID == "" {
		return false
	}
	_, err := app.FindFirstRecordByFilter(
		"team_members",
		"team = {:team} && user = {:user}",
		dbx.Params{"team": teamID, "user": userID},
	)
	return err == nil
}

// canAccessProject = project exists AND caller is a member of its team.
// Callers must map false to the same 404 regardless of which half failed.
func canAccessProject(app core.App, projectID, userID string) bool {
	project, err := app.FindRecordById("projects", projectID)
	if err != nil {
		return false
	}
	return isTeamMember(app, project.GetString("team"), userID)
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// ── Sentinel error types — let us carry typed failure data out of the
// RunInTransaction closure without forcing everything through http.Error
// plumbing (which would foreclose the 409's structured body). ────────

type conflict struct {
	currentRevision int
	currentDoc      any
}

func (conflict) Error() string { return "revision mismatch" }

type notFound string

func (n notFound) Error() string { return string(n) }
