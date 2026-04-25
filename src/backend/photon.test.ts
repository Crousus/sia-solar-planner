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
// photon tests.
//
// `searchAddresses` is a thin fetch wrapper but it carries non-trivial
// invariants the UI depends on:
//
//   - Empty / whitespace-only query short-circuits to [] (no request fired).
//   - Aborted requests re-throw AbortError so the caller's standard
//     supersede-cancel idiom works (the UI uses `if (e.name !== 'AbortError')`
//     to decide whether to clear the dropdown or keep waiting).
//   - HTTP errors return [] (the caller treats "no results" and "service
//     down" the same way — the comment block on the function says so).
//   - Malformed JSON / missing features array return [].
//   - Features missing coordinates are skipped (ProjectAddress's contract
//     promises lat/lon are always present — we cannot fake them).
//   - Language clamp: only en/de/fr/it are passed through; anything else
//     falls back to 'en'.
//   - Each suggestion gets a `key` derived from osm_type+osm_id so React
//     list keys are stable.
//
// We mock the global fetch with `vi.stubGlobal` so the network is never
// actually touched, and reset between tests so one test's mock doesn't
// bleed into the next.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { searchAddresses } from './photon';

// A minimal Photon feature for fixtures. The function reads only the
// fields we put here; anything else can be omitted.
function makeFeature(overrides: Partial<{
  osm_id: number;
  osm_type: string;
  street: string;
  housenumber: string;
  city: string;
  postcode: string;
  country: string;
  name: string;
  state: string;
  lat: number;
  lon: number;
}> = {}) {
  const {
    osm_id = 1,
    osm_type = 'N',
    street,
    housenumber,
    city,
    postcode,
    country,
    name,
    state,
    lat = 48.137,
    lon = 11.575,
  } = overrides;
  return {
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates: [lon, lat] },
    properties: { osm_id, osm_type, street, housenumber, city, postcode, country, name, state },
  };
}

// Wraps a body in the shape `Response` would have — we only care about
// `ok` and `json()`. Photon returns FeatureCollection.
function mockOkResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as unknown as Response;
}

function mockErrorResponse(status = 500) {
  return {
    ok: false,
    status,
    json: async () => ({ error: 'boom' }),
  } as unknown as Response;
}

// We capture each fetch call so URL-shape assertions can run on it.
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// A throwaway AbortSignal — the function only uses it as a fetch arg
// unless we explicitly abort it in a test.
const noopSignal = new AbortController().signal;

// ── Empty / short-circuit cases ───────────────────────────────────────────

describe('searchAddresses — short-circuit', () => {
  it('returns [] for an empty query without firing fetch', async () => {
    const out = await searchAddresses('', noopSignal);
    expect(out).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns [] for a whitespace-only query', async () => {
    const out = await searchAddresses('   ', noopSignal);
    expect(out).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Happy path ────────────────────────────────────────────────────────────

describe('searchAddresses — happy path', () => {
  it('parses a Photon FeatureCollection into AddressSuggestion[]', async () => {
    fetchSpy.mockResolvedValue(
      mockOkResponse({
        type: 'FeatureCollection',
        features: [
          makeFeature({
            osm_id: 42,
            osm_type: 'W',
            street: 'Marienplatz',
            housenumber: '8',
            city: 'Munich',
            postcode: '80331',
            country: 'Germany',
            lat: 48.137,
            lon: 11.575,
          }),
        ],
      }),
    );
    const out = await searchAddresses('Marienplatz', noopSignal);
    expect(out).toHaveLength(1);
    const s = out[0];
    expect(s.street).toBe('Marienplatz');
    expect(s.housenumber).toBe('8');
    expect(s.city).toBe('Munich');
    expect(s.postcode).toBe('80331');
    expect(s.country).toBe('Germany');
    expect(s.lat).toBe(48.137);
    expect(s.lon).toBe(11.575);
    // formatted label uses "street housenumber, postcode city, country"
    expect(s.formatted).toBe('Marienplatz 8, 80331 Munich, Germany');
    // key derives from osm_type:osm_id for stable React list keys
    expect(s.key).toBe('W:42');
  });

  it('falls back to `name` for the street when Photon omits `street`', () => {
    // Street-level results put the road name in `properties.name` rather
    // than `properties.street`. The function maps it through.
    fetchSpy.mockResolvedValue(
      mockOkResponse({
        type: 'FeatureCollection',
        features: [
          makeFeature({
            osm_id: 99,
            osm_type: 'W',
            name: 'Am Brunnenbühl',
            city: 'Augsburg',
          }),
        ],
      }),
    );
    return searchAddresses('Brunnen', noopSignal).then((out) => {
      expect(out).toHaveLength(1);
      expect(out[0].street).toBe('Am Brunnenbühl');
    });
  });
});

// ── Defensive parse paths ─────────────────────────────────────────────────

describe('searchAddresses — defensive', () => {
  it('returns [] when the server responds with a non-2xx status', async () => {
    fetchSpy.mockResolvedValue(mockErrorResponse(503));
    const out = await searchAddresses('Marienplatz', noopSignal);
    expect(out).toEqual([]);
  });

  it('returns [] when the JSON body fails to parse', async () => {
    // Some hiccups produce a 200 with a non-JSON body. The catch around
    // res.json() must absorb the parse error.
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    const out = await searchAddresses('x', noopSignal);
    expect(out).toEqual([]);
  });

  it('returns [] when the body is missing the features array', async () => {
    fetchSpy.mockResolvedValue(mockOkResponse({ type: 'FeatureCollection' }));
    const out = await searchAddresses('x', noopSignal);
    expect(out).toEqual([]);
  });

  it('skips features with no coordinates (cannot fabricate lat/lon)', async () => {
    fetchSpy.mockResolvedValue(
      mockOkResponse({
        type: 'FeatureCollection',
        features: [
          // Bad: no geometry at all.
          { type: 'Feature', properties: { name: 'No Coords' } },
          // Good.
          makeFeature({ osm_id: 1, name: 'Has Coords' }),
        ],
      }),
    );
    const out = await searchAddresses('x', noopSignal);
    expect(out).toHaveLength(1);
  });

  it('skips features whose label collapses to an empty string', async () => {
    // No street / name / city / country → formatLabel returns ''. The
    // function explicitly drops those rather than emit a blank dropdown
    // row.
    fetchSpy.mockResolvedValue(
      mockOkResponse({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [0, 0] },
            properties: {}, // empty
          },
        ],
      }),
    );
    const out = await searchAddresses('x', noopSignal);
    expect(out).toEqual([]);
  });
});

// ── URL construction ─────────────────────────────────────────────────────

describe('searchAddresses — URL', () => {
  it('passes the trimmed query, limit=6, and a clamped lang to the URL', async () => {
    fetchSpy.mockResolvedValue(mockOkResponse({ type: 'FeatureCollection', features: [] }));
    await searchAddresses('  Marienplatz  ', noopSignal, 'de');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.host).toBe('photon.komoot.io');
    expect(url.searchParams.get('q')).toBe('Marienplatz');
    expect(url.searchParams.get('limit')).toBe('6');
    expect(url.searchParams.get('lang')).toBe('de');
  });

  it("clamps unknown lang values to 'en' (Photon only supports en/de/fr/it)", async () => {
    fetchSpy.mockResolvedValue(mockOkResponse({ type: 'FeatureCollection', features: [] }));
    await searchAddresses('x', noopSignal, 'xx-LOL' as string);
    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.searchParams.get('lang')).toBe('en');
  });
});

// ── Abort behaviour ──────────────────────────────────────────────────────

describe('searchAddresses — abort', () => {
  it('re-throws AbortError when the signal fires (caller distinguishes from real errors)', async () => {
    // Standard caller idiom is `try {} catch (e) { if (e.name !== "AbortError") {...} }`.
    // If we swallowed AbortError, a stale-supersede-cancel would look
    // identical to "service unreachable" and the dropdown would stay
    // empty when the next query's response arrives.
    const ctrl = new AbortController();
    fetchSpy.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => {
      // Simulate fetch's documented behaviour: throw on already-aborted signal.
      if (init.signal.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      // Otherwise wait until the signal fires; for this test we abort
      // immediately and propagate.
      throw new Error('not reached');
    });
    ctrl.abort();
    await expect(searchAddresses('x', ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
