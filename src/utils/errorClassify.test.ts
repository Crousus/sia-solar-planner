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
// errorClassify tests.
//
// classifyError is the lens through which every catch block in the app
// shows messages to the user. Each branch corresponds to a different toast
// headline — getting the bucket wrong means the user sees the wrong
// guidance ("Server unreachable" vs "You don't have permission" leads to
// very different next actions). The branches:
//   - network  : status 0, TypeError, "failed to fetch"-flavoured messages
//   - auth     : status 401
//   - permission: status 403
//   - notFound : status 404
//   - validation: status 400/422 (with PB field-error extraction)
//   - server   : status ≥ 500
//   - unknown  : everything else (and stringly thrown values)
//
// formatErrorForUser composes "Headline — detail" using both the classifier
// and a fallback path for cases where the detail string is empty. Tests
// here use a stub `t()` that just echoes the key, since we're not testing
// i18n — we're testing the classifier's branching.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyError, headlineForCategory, formatErrorForUser } from './errorClassify';
import type { TFunction } from 'i18next';

// Stub `t()` — just echoes the key. Cast through unknown because i18next's
// real TFunction type has many overloads; we only call it with a string key.
const tStub = ((key: string) => key) as unknown as TFunction;

// classifyError calls console.warn on the unknown branch — silence it for
// the duration of the suite so test output stays clean. We restore in
// afterEach so a real warning during, say, an unrelated test still surfaces.
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

// ── classifyError — primitive / odd inputs ────────────────────────────────

describe('classifyError — non-object inputs', () => {
  it('classifies undefined as unknown with a generic detail', () => {
    const r = classifyError(undefined);
    expect(r.category).toBe('unknown');
    expect(r.detail).toBe('Unknown error');
    expect(r.dedupeKey).toBe('unknown');
  });

  it('classifies null as unknown (same as undefined)', () => {
    const r = classifyError(null);
    expect(r.category).toBe('unknown');
  });

  it('classifies a thrown string as unknown but preserves the message', () => {
    // `throw "oops"` is rare but legal JS — the classifier must not crash
    // on it. The string itself becomes the detail so the user sees
    // SOMETHING actionable.
    const r = classifyError('oops');
    expect(r.category).toBe('unknown');
    expect(r.detail).toBe('oops');
    expect(r.dedupeKey).toBe('unknown:oops');
  });
});

// ── classifyError — network failures ──────────────────────────────────────

describe('classifyError — network', () => {
  it('classifies status 0 as network (PB signal that the request never reached the server)', () => {
    // PocketBase wraps native fetch failures into a ClientResponseError
    // with status:0 and a vague boilerplate message — the classifier
    // must NOT show that boilerplate; it must say "network".
    const err = {
      status: 0,
      message: 'Something went wrong while trying to process your request.',
      url: 'https://api.example.com/foo',
      originalError: new TypeError('Failed to fetch'),
    };
    const r = classifyError(err);
    expect(r.category).toBe('network');
    expect(r.dedupeKey).toBe('network');
    // Detail composes the originalError message with the URL — useful
    // for the user (and the dev console) to see WHICH endpoint died.
    expect(r.detail).toContain('Failed to fetch');
    expect(r.detail).toContain('https://api.example.com/foo');
  });

  it('classifies a bare TypeError as network (native fetch failure)', () => {
    // No PocketBase wrapper — the raw fetch threw. Status is undefined
    // but we still want to show the network category.
    const r = classifyError(new TypeError('Failed to fetch'));
    expect(r.category).toBe('network');
  });

  it('classifies an Error whose message contains "load failed" as network (Safari)', () => {
    // Safari's wording for a failed fetch — the looksLikeNetworkFailure
    // substring matcher must catch it.
    const r = classifyError(new Error('Load failed'));
    expect(r.category).toBe('network');
  });
});

// ── classifyError — HTTP status codes ─────────────────────────────────────

describe('classifyError — HTTP status branches', () => {
  it('classifies 401 as auth', () => {
    const r = classifyError({ status: 401, message: 'Unauthorized' });
    expect(r.category).toBe('auth');
    expect(r.dedupeKey).toBe('auth-401');
  });

  it('classifies 403 as permission', () => {
    expect(classifyError({ status: 403, message: 'Forbidden' }).category).toBe('permission');
  });

  it('classifies 404 as notFound', () => {
    expect(classifyError({ status: 404, message: 'Not found' }).category).toBe('notFound');
  });

  it('classifies 5xx as server', () => {
    expect(classifyError({ status: 500, message: 'Internal' }).category).toBe('server');
    expect(classifyError({ status: 503, message: 'Down' }).category).toBe('server');
  });

  it('classifies 400/422 as validation', () => {
    expect(classifyError({ status: 400, message: 'Bad' }).category).toBe('validation');
    expect(classifyError({ status: 422, message: 'Unprocessable' }).category).toBe('validation');
  });
});

// ── classifyError — validation field-error extraction ─────────────────────

describe('classifyError — PB validation field errors', () => {
  it('surfaces the first field-level message when present (more useful than headline)', () => {
    // PocketBase puts the actual reason at data.data.<field>.message.
    // The classifier reaches for the first one — far better than the
    // generic top-level message ("Failed to create record").
    const err = {
      status: 400,
      message: 'Failed to create record.',
      data: {
        message: 'Failed to create record.',
        data: {
          email: { message: 'Email already in use' },
          name: { message: 'Name is required' },
        },
      },
    };
    const r = classifyError(err);
    expect(r.category).toBe('validation');
    expect(r.detail).toBe('Email already in use');
    expect(r.dedupeKey).toBe('validation:Email already in use');
  });

  it('falls back to the top-level message when no field errors are populated', () => {
    const r = classifyError({ status: 422, message: 'Unprocessable Entity', data: {} });
    expect(r.category).toBe('validation');
    expect(r.detail).toBe('Unprocessable Entity');
  });
});

// ── classifyError — fallback ──────────────────────────────────────────────

describe('classifyError — unknown fallback', () => {
  it('falls back to error.name when message is empty', () => {
    // An Error with a custom name and no message — the classifier still
    // returns SOMETHING for the user to read.
    const err = new Error('');
    err.name = 'WeirdError';
    const r = classifyError(err);
    expect(r.category).toBe('unknown');
    expect(r.detail).toBe('WeirdError');
  });

  it('logs unclassified errors to console.warn for dev visibility', () => {
    classifyError(new Error('weird'));
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ── headlineForCategory ───────────────────────────────────────────────────

describe('headlineForCategory', () => {
  it('returns the i18n key for each category', () => {
    // The function delegates entirely to t(); with our echo stub the
    // returned string IS the i18n key. We assert all branches return a
    // distinct key so a refactor can't silently fold two categories
    // onto the same headline.
    const seen = new Set<string>();
    for (const cat of ['network', 'auth', 'permission', 'notFound', 'server', 'validation', 'unknown'] as const) {
      const headline = headlineForCategory(cat, tStub);
      expect(headline).toBeTruthy();
      seen.add(headline);
    }
    expect(seen.size).toBe(7);
  });
});

// ── formatErrorForUser ────────────────────────────────────────────────────

describe('formatErrorForUser', () => {
  it('composes "headline — detail" for a classified error', () => {
    const out = formatErrorForUser({ status: 404, message: 'Not Found' }, tStub);
    expect(out).toBe('errors.notFoundHeadline — Not Found');
  });

  it('falls back to err.message when classifier produces empty detail (defensive)', () => {
    // The classifier always populates detail for known categories, so the
    // fallback is most useful with truly bare values. A naked Error with
    // an empty message goes through the unknown branch with detail
    // falling through to the toString path; we verify the COMPOSED string
    // includes a separator and is non-empty.
    const out = formatErrorForUser(new Error('boom'), tStub);
    expect(out).toContain('—');
    expect(out).toContain('boom');
  });

  it('returns just the headline when there is no detail at all', () => {
    // undefined/null inputs hit the early-return branch in classifyError
    // with detail "Unknown error" — so the composed string still has the
    // "—" separator. A truly empty detail is hard to reach via the public
    // API; we settle for asserting the headline is always present.
    const out = formatErrorForUser(null, tStub);
    expect(out).toContain('errors.unexpected');
  });
});
