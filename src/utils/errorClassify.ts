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

// ────────────────────────────────────────────────────────────────────────────
// errorClassify — turn an arbitrary thrown value into a user-grade
// (category, technicalDetail) pair.
//
// The naive "show err.message" approach falls apart in production for
// three reasons:
//   1. PocketBase's ClientResponseError sets `.message` to a vague
//      "Something went wrong while trying to process your request."
//      whenever the request never reached the server (status: 0, e.g.
//      backend down, DNS failure, CORS preflight blocked). The user
//      sees boilerplate; the *actionable* fact (server unreachable) is
//      buried in `.originalError` or `.status`.
//   2. The browser's native fetch failure surfaces as a TypeError with
//      message "Failed to fetch" — true, but not what the user wants
//      to read in a toast.
//   3. Server-side 401/403/404/5xx all reach the catch block as the
//      same Error shape. Without classifying them, every category
//      collapses to one generic toast.
//
// This util reads whatever fields are present on the error (status,
// originalError, message) and returns:
//   - `category`  → the user-grade bucket. Drives the i18n key for the
//                   toast headline.
//   - `detail`    → a concrete technical line for the smaller second
//                   row of the toast. Always populated.
//   - `dedupeKey` → suitable for pushToast's dedupeKey so the same
//                   classified failure doesn't stack.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Translation function shape — alias to i18next's exact type so callers
 * can pass `useTranslation().t` directly without a cast. Importing the
 * type (not a value) keeps the runtime cost of this util at zero.
 */
import type { TFunction } from 'i18next';
type TFn = TFunction;

export type ErrorCategory =
  | 'network'      // Could not reach the server at all (status 0, fetch failed, etc.)
  | 'auth'         // 401 — session expired / invalid token
  | 'permission'   // 403 — authenticated but not allowed
  | 'notFound'     // 404 — resource is gone or never existed
  | 'server'       // 5xx — server crashed / overloaded
  | 'validation'   // 400 / 422 — request shape rejected
  | 'unknown';     // anything we couldn't otherwise classify

export interface ClassifiedError {
  category: ErrorCategory;
  /**
   * Concrete technical line, intended for the toast's smaller detail
   * row. Always non-empty — falls back to the error class name if the
   * message itself is missing.
   */
  detail: string;
  /**
   * Dedupe key that's stable for "same kind of failure happening
   * repeatedly" (e.g. a render loop firing 60 Hz unhandled rejections
   * for a downed backend). Not unique per error instance.
   */
  dedupeKey: string;
}

/**
 * The PocketBase SDK's ClientResponseError shape. We don't import the
 * type directly because doing so pulls the whole SDK into every module
 * that wants to classify errors. Instead we duck-type on the small set
 * of fields we actually read.
 */
interface PbErrorShape {
  status?: number;
  url?: string;
  originalError?: unknown;
  data?: { message?: string; data?: Record<string, { message?: string }> };
  message?: string;
  name?: string;
}

function looksLikeNetworkFailure(err: PbErrorShape): boolean {
  // Status 0 is PocketBase's signal that the request never reached the
  // server (the SDK's `_sendRequest` catches before any HTTP status is
  // available and returns 0). The originalError is usually a TypeError
  // from native fetch in that case — "Failed to fetch", "NetworkError
  // when attempting to fetch resource", etc.
  if (err.status === 0) return true;
  const orig = err.originalError;
  if (orig instanceof TypeError) return true;
  const msg = (err.message ?? '').toLowerCase();
  if (msg.includes('failed to fetch')) return true;
  if (msg.includes('networkerror')) return true;
  if (msg.includes('load failed')) return true; // Safari's wording
  if (msg.includes('connection refused')) return true;
  return false;
}

/**
 * Convert a thrown value into a classified, user-presentable shape.
 *
 * Safe to call with anything — `unknown` from a catch block, a string,
 * a plain Error, a PocketBase ClientResponseError, even `undefined`.
 */
export function classifyError(err: unknown): ClassifiedError {
  // Non-object reasons (string throws, undefined, etc.) — lose nothing
  // by stringifying.
  if (err == null || (typeof err !== 'object' && typeof err !== 'string')) {
    return {
      category: 'unknown',
      detail: typeof err === 'string' ? err : 'Unknown error',
      dedupeKey: 'unknown',
    };
  }
  if (typeof err === 'string') {
    return { category: 'unknown', detail: err, dedupeKey: `unknown:${err}` };
  }

  const e = err as PbErrorShape & Error;
  const status = typeof e.status === 'number' ? e.status : undefined;

  // Network: do this BEFORE status-based branches because PocketBase
  // returns status 0 alongside a misleading "request" message.
  if (looksLikeNetworkFailure(e)) {
    const orig = e.originalError;
    const origMsg =
      orig instanceof Error
        ? orig.message
        : typeof orig === 'string'
          ? orig
          : '';
    return {
      category: 'network',
      // Compose the URL into the detail when present — tells the dev
      // (and an attentive user) which endpoint is unreachable. PB
      // populates this on the request shape; native fetch errors don't.
      detail:
        (origMsg || e.message || 'Failed to fetch') +
        (e.url ? ` · ${e.url}` : ''),
      dedupeKey: 'network',
    };
  }

  if (status === 401) {
    return {
      category: 'auth',
      detail: e.message || 'HTTP 401',
      dedupeKey: 'auth-401',
    };
  }
  if (status === 403) {
    return {
      category: 'permission',
      detail: e.message || 'HTTP 403',
      dedupeKey: 'permission-403',
    };
  }
  if (status === 404) {
    return {
      category: 'notFound',
      detail: e.message || 'HTTP 404',
      dedupeKey: 'notFound-404',
    };
  }
  if (status === 400 || status === 422) {
    // PocketBase puts the field-level reason inside data.data.<field>.message;
    // surface the first one we find — far more useful than the generic
    // "Failed to create record" headline message.
    const fieldErrors = e.data?.data;
    if (fieldErrors) {
      const first = Object.values(fieldErrors).find((v) => v?.message);
      if (first?.message) {
        return {
          category: 'validation',
          detail: first.message,
          dedupeKey: `validation:${first.message}`,
        };
      }
    }
    return {
      category: 'validation',
      detail: e.message || `HTTP ${status}`,
      dedupeKey: `validation-${status}`,
    };
  }
  if (status && status >= 500) {
    return {
      category: 'server',
      detail: e.message || `HTTP ${status}`,
      dedupeKey: `server-${status}`,
    };
  }

  // Fallback: unclassified. Prefer the message; fall back to the class
  // name so an inscrutable Error{} still gives the user *something*.
  // Last-ditch toString() so even an Error with no own message prints
  // its constructor + the inherited Error.prototype.toString output
  // (e.g. "TypeError" instead of an empty string).
  let toStringDetail = '';
  try {
    toStringDetail = String(e);
  } catch {
    /* best-effort only */
  }
  const detail =
    e.message || e.name || toStringDetail || 'Unknown error';
  // Surface unclassified errors to the dev console so we can spot any
  // shape we missed without the user having to copy-paste from a tiny
  // toast detail line. Wrapped in a try in case the error is some
  // exotic proxy that throws on property access.
  try {
    // eslint-disable-next-line no-console
    console.warn('[classifyError] unclassified error', e);
  } catch { /* noop */ }
  return {
    category: 'unknown',
    detail,
    dedupeKey: `unknown:${detail}`,
  };
}

/**
 * Map an `ErrorCategory` to its localised user-grade headline. Used by
 * both the global window error handler (in AppShell) and per-page
 * catch blocks that want a consistent message for the same kind of
 * failure. Returning a plain string keeps the call site cheap — no JSX,
 * no React types.
 */
export function headlineForCategory(category: ErrorCategory, t: TFn): string {
  switch (category) {
    case 'network':    return t('errors.networkHeadline');
    case 'auth':       return t('errors.authHeadline');
    case 'permission': return t('errors.permissionHeadline');
    case 'notFound':   return t('errors.notFoundHeadline');
    case 'server':     return t('errors.serverHeadline');
    case 'validation': return t('errors.validationHeadline');
    case 'unknown':    return t('errors.unexpected');
  }
}

/**
 * One-shot helper for inline error banners on list/picker pages.
 *
 * Composes a "Headline — detail" string from any thrown value:
 *   - Headline always present (per category).
 *   - Detail prefers the classifier output, then a raw fallback
 *     (err.message → err.toString() → coerced string), so the user
 *     never sees an empty alert even when PocketBase swallows the
 *     reason.
 *
 * Use this from `.catch((err) => setError(formatErrorForUser(err, t)))`.
 */
export function formatErrorForUser(err: unknown, t: TFn): string {
  const { category, detail } = classifyError(err);
  const headline = headlineForCategory(category, t);
  const rawFallback =
    err instanceof Error
      ? err.message || err.toString()
      : typeof err === 'string'
        ? err
        : '';
  const tail = detail || rawFallback;
  return tail ? `${headline} — ${tail}` : headline;
}
