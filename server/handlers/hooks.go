package handlers

import "github.com/pocketbase/pocketbase"

// RegisterHooks wires lifecycle hooks (record create/update, cron jobs).
// Currently empty; Task 4 adds create-team-admin hook and patch TTL cron.
func RegisterHooks(_ *pocketbase.PocketBase) {
	// Intentionally empty; see comment in patch.go.
}
