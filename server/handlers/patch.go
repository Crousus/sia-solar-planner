// Package handlers — custom PocketBase route handlers for Solar Planner.
// This file stubs RegisterRoutes; implementation lands in a later task.
package handlers

import (
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

// RegisterRoutes wires custom HTTP routes onto the PocketBase serve event.
// Currently empty; Task 5 adds POST /api/sp/patch here.
func RegisterRoutes(_ *pocketbase.PocketBase, _ *core.ServeEvent) {
	// Intentionally empty; kept to preserve the call site in main.go so
	// future tasks add handlers without touching main.go again.
}
