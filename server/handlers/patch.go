package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"

	"github.com/pocketbase/pocketbase"
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
//   1. Enter their transactions holding only a SHARED lock,
//   2. Read `currentRevision = N` via FindRecordById,
//   3. Pass the OCC check `currentRevision == body.FromRevision` — both
//      see N, both think they're the unique writer racing from N→N+1,
//   4. Race at first write / commit — WAL may allow one through while
//      the other fails with SQLITE_BUSY after the busy_timeout expires,
//      OR (worse) the scheduler lets both writes serialize such that
//      the second commits on top of the first with a stale in-memory
//      `currentRevision`, inserting two patches rows with the same
//      `from_revision` and desynchronizing clients.
//
// The clean fix would be `BEGIN IMMEDIATE` (write-intent lock at txn
// start, serializing write-txns at the SQLite level). PocketBase v0.23
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
// `projectLocks` grows unboundedly as new projectIds appear — one
// *sync.Mutex per distinct project seen since boot. At the expected
// scale (tens to hundreds of projects) this is trivial (~dozens of
// bytes per entry). At thousands of projects this map's memory
// footprint becomes noticeable; revisit then with LRU eviction or
// reference-counted cleanup tied to an idle timer. Not worth the
// complexity today.
var (
	projectLocksMu sync.Mutex
	projectLocks   = map[string]*sync.Mutex{}
)

// lockProject returns an unlock function for the given projectId,
// blocking until the project-specific mutex is acquired. Callers do:
//
//	unlock := lockProject(id)
//	defer unlock()
//
// The outer `projectLocksMu` guards map reads/writes only; we release
// it before acquiring the inner per-project mutex so a long-running
// patch for project A doesn't block map lookups for project B.
func lockProject(projectID string) func() {
	projectLocksMu.Lock()
	mu, ok := projectLocks[projectID]
	if !ok {
		mu = &sync.Mutex{}
		projectLocks[projectID] = mu
	}
	projectLocksMu.Unlock()

	mu.Lock()
	return mu.Unlock
}

// RegisterRoutes attaches our custom routes to the PocketBase HTTP server.
// Called once per ServeEvent (boot). The signature is dictated by how
// main.go invokes us from inside OnServe.
func RegisterRoutes(app *pocketbase.PocketBase, e *core.ServeEvent) {
	e.Router.POST("/api/sp/patch", func(re *core.RequestEvent) error {
		return handlePatch(app, re)
	})
	// /api/sp/set-customer owns the projects.customer relation field.
	// Kept separate from /api/sp/patch because it doesn't participate in
	// the doc+revision OCC protocol — linking a customer is a single-field
	// update with no conflict-detection requirement. See set_customer.go.
	e.Router.POST("/api/sp/set-customer", func(re *core.RequestEvent) error {
		return handleSetCustomer(app, re)
	})
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

func handlePatch(app *pocketbase.PocketBase, re *core.RequestEvent) error {
	// 1. Auth gate. We only accept signed-in user callers (not admins via
	//    the admin token, not anonymous). PB's `re.Auth` is populated by
	//    the auth middleware that runs ahead of this handler.
	if re.Auth == nil || re.Auth.Collection().Name != "users" {
		return re.UnauthorizedError("sign-in required", nil)
	}

	// 2. Parse body. BindBody rejects non-JSON early.
	body := patchRequest{}
	if err := re.BindBody(&body); err != nil {
		return re.BadRequestError("invalid JSON body", err)
	}
	if body.ProjectID == "" {
		return re.BadRequestError("projectId required", nil)
	}
	if len(body.Ops) == 0 {
		return re.BadRequestError("ops required", nil)
	}

	// 2.5. Serialize same-project patch handlers. See the top-of-file
	//      comment on `projectLocks` for the full rationale — in short,
	//      PB's RunInTransaction uses BEGIN DEFERRED which lets two
	//      concurrent same-project txns both pass the OCC revision
	//      check before either has written. An in-process mutex keyed
	//      by projectId closes that race without fighting PB's
	//      transaction wrapper. Different projects still proceed in
	//      parallel.
	unlock := lockProject(body.ProjectID)
	defer unlock()

	// 3. Transactional work: read project, validate revision, apply patch,
	//    save project, save patches record. All or nothing — we don't
	//    want a patches row without a matching project revision bump.
	var newRevision int
	err := app.RunInTransaction(func(txApp core.App) error {
		project, err := txApp.FindRecordById("projects", body.ProjectID)
		if err != nil {
			return notFound("project not found")
		}

		// 4. Team-membership check. The handler has a signed-in user (step
		//    1) but no automatic rule evaluation — we're a custom route,
		//    not a default collection endpoint. So we check membership
		//    by hand: find a team_members row binding this user to the
		//    project's team.
		teamID := project.GetString("team")
		members, err := txApp.FindRecordsByFilter(
			"team_members",
			"team = {:team} && user = {:user}",
			"", 1, 0,
			map[string]any{"team": teamID, "user": re.Auth.Id},
		)
		if err != nil || len(members) == 0 {
			return forbidden("not a member of this project's team")
		}

		// 5. Revision check. Mismatch → 409 with current state so the
		//    client can show the discard/overwrite modal without a
		//    second roundtrip.
		currentRevision := project.GetInt("revision")
		if currentRevision != body.FromRevision {
			return conflict{
				currentRevision: currentRevision,
				currentDoc:      project.Get("doc"),
			}
		}

		// 6. Apply patch.
		docBytes, err := json.Marshal(project.Get("doc"))
		if err != nil {
			return fmt.Errorf("marshal existing doc: %w", err)
		}
		patch, err := jsonpatch.DecodePatch(body.Ops)
		if err != nil {
			return re.BadRequestError("invalid JSON Patch", err)
		}
		patchedBytes, err := patch.Apply(docBytes)
		if err != nil {
			return re.BadRequestError("patch failed to apply", err)
		}
		var patchedDoc any
		if err := json.Unmarshal(patchedBytes, &patchedDoc); err != nil {
			return fmt.Errorf("patched doc not valid JSON: %w", err)
		}

		// 7. Save updated project. PocketBase's Save on an existing record
		//    does an UPDATE, bumps `updated`, and returns the same record
		//    instance with the new revision visible.
		project.Set("doc", patchedDoc)
		project.Set("revision", currentRevision+1)
		// If the patch touched the top-level name, mirror it to the
		// column so the project list view doesn't need to parse `doc`.
		if patchedMap, ok := patchedDoc.(map[string]any); ok {
			if name, ok := patchedMap["name"].(string); ok && name != "" {
				project.Set("name", name)
			}
		}
		if err := txApp.Save(project); err != nil {
			return fmt.Errorf("save project: %w", err)
		}

		// 8. Insert patches record — this is the SSE fanout. PocketBase's
		//    realtime broadcasts record-create events to anyone subscribed
		//    to the collection (client filters by project relation on its
		//    end).
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
		// device_id is the tab id the client self-assigned in
		// sessionStorage. Empty string for legacy clients — the SSE
		// receiver falls back to author-based filtering in that case.
		patchRec.Set("device_id", body.DeviceID)
		if err := txApp.Save(patchRec); err != nil {
			return fmt.Errorf("save patches record: %w", err)
		}

		newRevision = currentRevision + 1
		return nil
	})

	if err != nil {
		// Translate our sentinel error types into HTTP responses. Anything
		// unexpected falls through to a 500.
		var c conflict
		if errors.As(err, &c) {
			return re.JSON(http.StatusConflict, patchConflictResponse{
				Error:           "revision mismatch",
				CurrentRevision: c.currentRevision,
				CurrentDoc:      c.currentDoc,
			})
		}
		if nfErr, ok := err.(notFound); ok {
			return re.NotFoundError(string(nfErr), nil)
		}
		if fErr, ok := err.(forbidden); ok {
			return re.ForbiddenError(string(fErr), nil)
		}
		// router.ApiError already responds; the returned error is for
		// PB logging only.
		var apiErr *router.ApiError
		if errors.As(err, &apiErr) {
			return err
		}
		app.Logger().Error("handlePatch", "error", err)
		return re.InternalServerError("patch failed", err)
	}

	return re.JSON(http.StatusOK, patchSuccessResponse{NewRevision: newRevision})
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

type forbidden string

func (f forbidden) Error() string { return string(f) }
