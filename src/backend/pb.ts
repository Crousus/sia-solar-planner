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
// API NOTE: PocketBase JS SDK ≥0.26 renamed `authStore.model` to
// `authStore.record` (the old name is still exported but deprecated and
// emits a console warning). We use the new name throughout. The
// `onChange` callback's second arg is also typed as `AuthRecord` (the
// stored record), not the legacy `model`.
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
