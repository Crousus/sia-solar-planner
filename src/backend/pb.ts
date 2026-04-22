// ────────────────────────────────────────────────────────────────────────
// PocketBase client singleton.
//
// One instance per browser tab. PocketBase SDK is stateless aside from
// its `authStore` which it persists to localStorage under its own key
// (`pocketbase_auth`). Sharing a singleton lets any file in the app read
// pb.authStore.record for "who is signed in" without threading the
// instance through props/context.
//
// The base URL is empty string in dev because Vite proxies /api/* to
// the PocketBase server (see vite.config.ts). In prod, the same origin
// assumption means empty string works there too (PocketBase sits behind
// the same reverse proxy). If we ever split origins, set via env var.
//
// API NOTE: PocketBase JS SDK v0.22 renamed `authStore.model` to
// `authStore.record` (the old name is still exported but soft-deprecated
// and emits a console warning). We use the new name throughout. The
// `onChange` callback's second arg is also typed as `AuthRecord` (the
// stored record), not the legacy `model`.
//
// VERSION COMPATIBILITY (verified 2026-04 against upstream changelogs):
// This project pins pocketbase (JS SDK) to ^0.26.x while the Go server
// in `server/go.mod` is pinned to github.com/pocketbase/pocketbase
// v0.23.0. That looks like a mismatch but is deliberate and safe:
//
//   - JS SDK v0.22.0 release notes state: "works only with PocketBase
//     v0.23.0+". No SDK release between v0.22 and v0.26.8 has raised
//     that minimum or changed the realtime/SSE wire protocol, the
//     Authorization header format, or the record JSON shape. The only
//     SDK-side note about server version in this range is v0.25's
//     `pb.crons` service — "available with PocketBase v0.24+" — which
//     we don't use.
//
//   - Server v0.24/v0.25/v0.26 release notes touch rule-engine
//     semantics, Google OAuth2 endpoints, AWS SDK internals, and
//     similar — none touch the /api/realtime SSE protocol or the auth
//     header contract the JS SDK depends on. The `PB_CONNECT` /
//     `clientId` initial SSE event has been part of the protocol since
//     long before v0.23.
//
// CAVEAT for future maintainers: do not bump either side in isolation
// without re-checking both changelogs for realtime, auth, and record-
// shape changes. The safe directions are (a) bump both together or
// (b) downgrade the JS SDK to match the Go server. Bumping the Go
// server alone would drag in unvetted hook/migration API changes that
// our `server/main.go` and `pb_migrations/` may rely on.
// ────────────────────────────────────────────────────────────────────────

import PocketBase from 'pocketbase';

// '/' base means "use the current origin, rooted at /" — i.e. all SDK
// requests go to /api/... at the page's origin regardless of the current
// route. Vite's dev proxy and the prod reverse-proxy both forward /api/*
// to the PB server, so a same-origin client works in both environments.
//
// Why not empty string: the SDK builds URLs relative to baseUrl. With ''
// the request path is resolved against the current location (e.g.
// /login), producing /login/api/... which the proxy never sees — you get
// a 404 from Vite. Leading slash pins the request to the origin root.
export const pb = new PocketBase('/');

/** Thin wrapper: resolves to the current auth record or null. */
export function currentUser() {
  return pb.authStore.record;
}

/**
 * Subscribe to auth changes. Returns an unsubscribe fn.
 *
 * The SDK fires this whenever the token, record, or both change
 * (login, logout, refresh, manual clear). We pass through `unknown`
 * because callers in different layers care about different shapes
 * (some want the raw record, some only the boolean "is signed in").
 */
export function onAuthChange(cb: (user: unknown) => void) {
  return pb.authStore.onChange((_token, record) => cb(record));
}
