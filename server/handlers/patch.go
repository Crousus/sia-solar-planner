package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	jsonpatch "github.com/evanphx/json-patch/v5"
)

// RegisterRoutes attaches our custom routes to the PocketBase HTTP server.
// Called once per ServeEvent (boot). The signature is dictated by how
// main.go invokes us from inside OnServe.
func RegisterRoutes(app *pocketbase.PocketBase, e *core.ServeEvent) {
	e.Router.POST("/api/sp/patch", func(re *core.RequestEvent) error {
		return handlePatch(app, re)
	})
}

// ── Request/response DTOs ──────────────────────────────────────────────

type patchRequest struct {
	ProjectID    string          `json:"projectId"`
	FromRevision int             `json:"fromRevision"`
	Ops          json.RawMessage `json:"ops"` // RFC 6902 patch array, kept as raw JSON
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
