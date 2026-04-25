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
// toastStore tests.
//
// The store is a hand-rolled module-level singleton (per its docstring's
// "use useSyncExternalStore over zustand for ephemerals" rationale). Three
// behaviours we lock down here:
//
//   1. Push/dismiss lifecycle and listener notification.
//   2. dedupeKey suppresses duplicates AND is freed on dismiss (the docstring
//      calls out that leaving a stale entry in the dedupe index would
//      suppress fresh occurrences of the same signal).
//   3. Auto-dismiss policy: errors persist; info/success self-expire after
//      AUTO_DISMISS_MS. We use vi.useFakeTimers so the test runs in a few
//      ms instead of waiting 6 s for the real timer.
//
// We use the test-only `_getToastsSnapshot` / `_subscribeToasts` accessors
// to read the live state without dragging in @testing-library/react just
// to render a useSyncExternalStore consumer. The snapshot getter mirrors
// what the hook reads from the same module-level array, so behaviour
// tested here matches what subscribers see in production.
//
// `clearToasts` exists explicitly to give tests a clean slate — call it in
// beforeEach so this file's tests don't bleed into each other (the store
// is a module singleton, so state survives between `it` blocks).
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  pushToast,
  dismissToast,
  clearToasts,
  _getToastsSnapshot,
  _subscribeToasts,
} from './toastStore';

beforeEach(() => {
  // Module singleton — wipe state so each test starts clean.
  clearToasts();
});

// ── Push / dismiss lifecycle ──────────────────────────────────────────────

describe('pushToast / dismissToast', () => {
  it('adds an entry and assigns a unique id', () => {
    const id = pushToast('info', 'hello');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(_getToastsSnapshot()).toHaveLength(1);
  });

  it('preserves message + level + detail on the stored toast', () => {
    pushToast('error', 'boom', { detail: 'stack trace here' });
    const snap = _getToastsSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].message).toBe('boom');
    expect(snap[0].level).toBe('error');
    expect(snap[0].detail).toBe('stack trace here');
  });

  it('dismissToast removes the matching entry and is a no-op for unknown ids', () => {
    const id = pushToast('info', 'a');
    pushToast('info', 'b');
    expect(_getToastsSnapshot()).toHaveLength(2);

    dismissToast(id);
    expect(_getToastsSnapshot()).toHaveLength(1);

    // Second call with the same (now-gone) id must not crash or affect state.
    dismissToast(id);
    expect(_getToastsSnapshot()).toHaveLength(1);
  });
});

// ── Listener notification ────────────────────────────────────────────────

describe('subscribe', () => {
  it('notifies subscribed listeners when state changes', () => {
    const listener = vi.fn();
    const unsub = _subscribeToasts(listener);
    pushToast('info', 'hi');
    expect(listener).toHaveBeenCalled();
    unsub();
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const unsub = _subscribeToasts(listener);
    unsub();
    pushToast('info', 'hi');
    expect(listener).not.toHaveBeenCalled();
  });
});

// ── Dedupe ────────────────────────────────────────────────────────────────

describe('pushToast — dedupeKey', () => {
  it('suppresses a second push with the same dedupeKey while the first is live', () => {
    // Use case from the docstring: a render loop firing 60 Hz unhandled
    // rejections shouldn't stack 50 identical toasts.
    const first = pushToast('error', 'network down', { dedupeKey: 'net' });
    const second = pushToast('error', 'network down', { dedupeKey: 'net' });
    expect(second).toBe(first); // returns the live id, doesn't make a new one
    expect(_getToastsSnapshot()).toHaveLength(1);
  });

  it('frees the dedupe slot on dismiss so a fresh occurrence shows again', () => {
    // The docstring on dismissToast explicitly calls out the dedupe-sweep
    // behaviour: "leaving the index pinned to a dismissed id would
    // suppress a fresh occurrence of the same signal".
    const first = pushToast('error', 'net', { dedupeKey: 'net' });
    dismissToast(first);
    const second = pushToast('error', 'net', { dedupeKey: 'net' });
    expect(second).not.toBe(first);
    expect(_getToastsSnapshot()).toHaveLength(1);
  });
});

// ── Auto-dismiss policy ───────────────────────────────────────────────────

describe('pushToast — auto-dismiss policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps error toasts alive past the auto-dismiss window', () => {
    pushToast('error', 'permanent');
    vi.advanceTimersByTime(60_000); // a minute — well past AUTO_DISMISS_MS=6s
    expect(_getToastsSnapshot()).toHaveLength(1);
  });

  it('auto-dismisses info toasts after the timer elapses', () => {
    pushToast('info', 'transient');
    expect(_getToastsSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(6_000); // matches AUTO_DISMISS_MS
    expect(_getToastsSnapshot()).toHaveLength(0);
  });

  it('auto-dismisses success toasts after the timer elapses', () => {
    pushToast('success', 'saved');
    expect(_getToastsSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(6_000);
    expect(_getToastsSnapshot()).toHaveLength(0);
  });
});

// ── clearToasts ───────────────────────────────────────────────────────────

describe('clearToasts', () => {
  it('removes every live toast and clears pending timers', () => {
    pushToast('info', 'a');
    pushToast('error', 'b');
    pushToast('success', 'c');
    clearToasts();
    expect(_getToastsSnapshot()).toHaveLength(0);
  });

  it('clears the dedupe index so a previously-suppressed key is reusable', () => {
    pushToast('error', 'x', { dedupeKey: 'x' });
    clearToasts();
    // After clear the dedupe slot is free; a fresh push under the same
    // key creates a new entry rather than being suppressed.
    pushToast('error', 'x', { dedupeKey: 'x' });
    expect(_getToastsSnapshot()).toHaveLength(1);
  });
});

// ── Snapshot reference stability ──────────────────────────────────────────

describe('snapshot reference stability', () => {
  it('returns the same array reference between mutations (no spurious re-renders)', () => {
    // The docstring promises the array is reference-stable until the next
    // mutation. useSyncExternalStore's correctness depends on this — if
    // getSnapshot returned a new array on every call, every subscriber
    // would re-render on every render.
    pushToast('info', 'a');
    const first = _getToastsSnapshot();
    const second = _getToastsSnapshot();
    expect(second).toBe(first);
  });

  it('returns a new array reference after a mutation', () => {
    pushToast('info', 'a');
    const before = _getToastsSnapshot();
    pushToast('info', 'b');
    const after = _getToastsSnapshot();
    expect(after).not.toBe(before);
  });
});
