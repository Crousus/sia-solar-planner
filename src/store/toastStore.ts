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
// Toast store — global, ephemeral message channel.
//
// Why a hand-rolled `useSyncExternalStore` module instead of zustand:
//   - Toasts are purely ephemeral. Nothing here needs to survive a
//     reload, integrate with the persist middleware, or interact with
//     the undo system. Zustand would buy us a familiar API at the cost
//     of pulling another store-shaped dependency into a path that is
//     read by ~3 components.
//   - Every public surface (push from inside React, push from outside,
//     subscribe with selector) collapses to a few lines on top of
//     `useSyncExternalStore`. Less indirection = less to read when
//     debugging a stuck toast.
//
// Why a separate channel (not part of useProjectStore):
//   - Toast state is global, not per-project. It must survive
//     resetProject / loadProject calls and route changes (a network
//     failure on the team list page should still be visible after the
//     user navigates to the editor mid-flight).
//   - The project store is `persist`-wrapped to localStorage; persisting
//     stale toasts across reloads would be confusing.
//
// Why imperative push from outside React:
//   - Window error listeners, syncClient onError, the PocketBase auth
//     onChange handler — all live outside the React tree and can't call
//     hooks. The bare `pushToast()` accessor handles those callers.
// ────────────────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from 'react';

/**
 * Severity level. Drives both the visual treatment (color band on the
 * left edge of the toast) and the auto-dismiss policy:
 *   - error  → persistent. Stays until the user clicks X. We don't want
 *              a network failure or unexpected exception to vanish
 *              before the user's eyes hit it.
 *   - info   → auto-dismiss after AUTO_DISMISS_MS. Used for benign
 *              status updates.
 *   - success→ auto-dismiss after AUTO_DISMISS_MS. Used for confirmations.
 *
 * Warnings are intentionally folded into `error` for now — the UI we're
 * targeting ("nothing too fancy") doesn't need a separate yellow tier.
 */
export type ToastLevel = 'error' | 'info' | 'success';

/** A single live toast. `id` is the React key plus the dismiss handle. */
export interface Toast {
  id: string;
  level: ToastLevel;
  message: string;
  /**
   * Smaller secondary line shown under the main message — used for
   * technical detail (e.g. an error class name) that's useful for
   * diagnostics but shouldn't dominate the visual.
   */
  detail?: string;
}

/**
 * Auto-dismiss delay for non-error toasts, in milliseconds. Long enough
 * to read a sentence, short enough that idle chrome doesn't pile up.
 */
const AUTO_DISMISS_MS = 6000;

// ── Internal state ───────────────────────────────────────────────────────
//
// `toasts` is the live array; everything else is bookkeeping. We keep
// the array reference-stable across no-op operations so `useSyncExternalStore`
// doesn't trigger spurious re-renders. Any mutating action replaces it
// with a new array (immutable update pattern, same as zustand would do).

let toasts: Toast[] = [];
const listeners = new Set<() => void>();
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();
const dedupeIndex = new Map<string, string>();

function emit(): void {
  for (const listener of listeners) listener();
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── Public imperative API ────────────────────────────────────────────────

/**
 * Push a new toast. Safe to call from anywhere — inside or outside React.
 *
 * If `dedupeKey` is given and a toast with the same key is already
 * showing, the existing toast is left in place and the new one dropped.
 * This prevents the same window error firing on every render from
 * stacking 50 identical messages. The function still returns the live
 * id so callers can dismiss programmatically.
 */
export function pushToast(
  level: ToastLevel,
  message: string,
  options?: { detail?: string; dedupeKey?: string }
): string {
  if (options?.dedupeKey) {
    const existingId = dedupeIndex.get(options.dedupeKey);
    if (existingId && toasts.some((t) => t.id === existingId)) {
      return existingId;
    }
  }

  const id = uid();
  const toast: Toast = { id, level, message, detail: options?.detail };
  toasts = [...toasts, toast];
  if (options?.dedupeKey) dedupeIndex.set(options.dedupeKey, id);

  // Errors stay until manually dismissed; everything else self-expires.
  if (level !== 'error') {
    const handle = setTimeout(() => dismissToast(id), AUTO_DISMISS_MS);
    dismissTimers.set(id, handle);
  }

  emit();
  return id;
}

/** Dismiss by id. No-op if the toast was already removed. */
export function dismissToast(id: string): void {
  const handle = dismissTimers.get(id);
  if (handle) {
    clearTimeout(handle);
    dismissTimers.delete(id);
  }
  // Sweep any matching dedupe entry — leaving the index pinned to a
  // dismissed id would suppress a fresh occurrence of the same signal.
  for (const [key, value] of dedupeIndex.entries()) {
    if (value === id) dedupeIndex.delete(key);
  }
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return; // unknown id, no-op
  toasts = next;
  emit();
}

/** Clear all live toasts. Currently only used by tests. */
export function clearToasts(): void {
  for (const handle of dismissTimers.values()) clearTimeout(handle);
  dismissTimers.clear();
  dedupeIndex.clear();
  toasts = [];
  emit();
}

// ── React subscription ───────────────────────────────────────────────────

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Toast[] {
  return toasts;
}

/**
 * React hook — returns the current toast list and re-renders on
 * pushToast / dismissToast. The returned array is reference-stable until
 * the next mutation, so it's safe to use directly in render output
 * without memoization.
 */
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
