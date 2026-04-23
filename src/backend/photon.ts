// ────────────────────────────────────────────────────────────────────────
// Photon — address autocomplete via Komoot's public Photon geocoder
// (https://photon.komoot.io). Free, no API key, OSM-backed.
//
// Why Photon and not Nominatim:
//   Nominatim's usage policy explicitly forbids typeahead on the public
//   endpoint. Photon was built for that exact use case. Trade-off: Photon
//   doesn't guarantee availability ("usage might be subject to change"),
//   so we degrade gracefully — the autocomplete swallows fetch errors and
//   the caller can still submit an address-less project.
//
// We keep this file tiny and side-effect-free (just a fetch wrapper). All
// UX concerns — debouncing, aborting superseded requests, dropdown UI —
// live in AddressAutocomplete.tsx. That boundary keeps the network
// contract easy to mock in tests and easy to swap (self-hosted Photon,
// different geocoder) without touching React components.
// ────────────────────────────────────────────────────────────────────────

import type { ProjectAddress } from '../types';

/**
 * A single autocomplete suggestion. This is a superset of ProjectAddress
 * (same field shape) plus a stable `key` for React lists. We keep it
 * distinct from ProjectAddress so consumers can tell "unvetted candidate"
 * from "committed project address" at the type level.
 */
export interface AddressSuggestion extends ProjectAddress {
  /** Stable React key derived from OSM id+type so list keys are stable
   *  across re-renders even when the formatted label is identical
   *  (two streets in different cities can share a display string). */
  key: string;
}

// Photon's GeoJSON response shape. We only model the fields we actually
// read — anything else is declared `unknown` / dropped. Defined inline
// rather than exported because no consumer outside this file cares.
interface PhotonFeature {
  type: 'Feature';
  geometry: {
    type: 'Point';
    // Photon returns [lon, lat] per GeoJSON convention.
    coordinates: [number, number];
  };
  properties: {
    osm_id?: number;
    osm_type?: string;
    // Human-friendly primary label — usually a place or street name.
    name?: string;
    // Structured components (best-effort; any can be absent).
    street?: string;
    housenumber?: string;
    city?: string;
    postcode?: string;
    country?: string;
    state?: string;
    // Top-level category Photon assigns: "place", "building", "street",
    // "highway" — we don't filter on this but could later to drop POIs
    // (restaurants, shops) that aren't useful as installation addresses.
    osm_key?: string;
    osm_value?: string;
  };
}

interface PhotonResponse {
  type: 'FeatureCollection';
  features: PhotonFeature[];
}

/**
 * Build the display label we show in the dropdown + store on the project.
 *
 * Prefer Photon's `name` for the first line if it reads like a street
 * address (i.e. we also have a housenumber or street). Otherwise fall
 * back to the most informative combination of structured parts. This is
 * intentionally simple — we don't try to beat Photon at label-building,
 * we just produce something that reads sensibly when the obvious join
 * doesn't work.
 */
function formatLabel(p: PhotonFeature['properties']): string {
  const parts: string[] = [];
  // Street line: prefer "street housenumber", else Photon's `name`.
  const streetLine =
    p.street && p.housenumber
      ? `${p.street} ${p.housenumber}`
      : p.street ?? p.name ?? '';
  if (streetLine) parts.push(streetLine);
  // City line: "12345 Munich" style if we have both, otherwise whichever
  // is present. Falls back to state if neither city/postcode are known
  // (rural points-of-interest).
  const cityLine = [p.postcode, p.city].filter(Boolean).join(' ') || p.state || '';
  if (cityLine) parts.push(cityLine);
  if (p.country) parts.push(p.country);
  return parts.join(', ');
}

/**
 * Query Photon for address suggestions.
 *
 * @param query     The user's search string. Caller is responsible for
 *                  trimming and for not calling with an empty string —
 *                  we still guard below but expect debouncing upstream.
 * @param signal    AbortSignal so the caller can cancel a superseded
 *                  request. When a user types fast, in-flight requests
 *                  for older queries would otherwise race the response
 *                  for the latest query — and the older one winning
 *                  would overwrite the dropdown with stale suggestions.
 * @param lang      Photon supports `en`, `de`, `fr`, `it`. We pass the
 *                  current i18n language through so results come back
 *                  in the user's locale where possible.
 *
 * Returns an empty list on HTTP errors, malformed responses, or aborts.
 * The caller treats "no results" and "service down" the same way (show
 * an empty dropdown), so a thrown error would force every caller to
 * wrap in try/catch for no UX benefit. Aborts ARE re-thrown as AbortError
 * so callers using the standard AbortController idiom (`if (e.name !==
 * 'AbortError') …`) can distinguish supersede-cancel from real errors.
 */
export async function searchAddresses(
  query: string,
  signal: AbortSignal,
  lang: string = 'en'
): Promise<AddressSuggestion[]> {
  const trimmed = query.trim();
  // Photon returns 400 on empty `q`. Short-circuit rather than burn a
  // request + error path on it.
  if (trimmed.length === 0) return [];

  // `limit=6` keeps the dropdown a comfortable size. Photon defaults to
  // 15; we'd truncate client-side anyway, and the smaller response
  // trims network latency on mobile.
  const url = new URL('https://photon.komoot.io/api/');
  url.searchParams.set('q', trimmed);
  url.searchParams.set('limit', '6');
  // Photon only officially supports these 4 languages. Unknown values
  // fall back silently on the server side, but we still clamp here so
  // we don't ship a user-specific string as a URL param.
  if (lang === 'de' || lang === 'fr' || lang === 'it') {
    url.searchParams.set('lang', lang);
  } else {
    url.searchParams.set('lang', 'en');
  }

  const res = await fetch(url.toString(), { signal });
  if (!res.ok) return [];

  // The API can occasionally return unexpected JSON on backend hiccups
  // (e.g. a 200 with an error payload). Treat any parse error or missing
  // features array as "no suggestions" rather than cratering the caller.
  let body: PhotonResponse;
  try {
    body = (await res.json()) as PhotonResponse;
  } catch {
    return [];
  }
  if (!body.features || !Array.isArray(body.features)) return [];

  const out: AddressSuggestion[] = [];
  for (const f of body.features) {
    // Defensive: a feature missing coordinates is useless for our
    // downstream map-preview + auto-center use case. Skip rather than
    // fake coords — ProjectAddress's contract is lat/lon are always
    // present.
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length !== 2) continue;
    const [lon, lat] = coords;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;

    const label = formatLabel(f.properties);
    if (!label) continue; // Skip features we can't produce a display string for.

    // Street fallback: when Photon returns a street-level result (not a
    // specific building), it puts the road name in `name` and leaves
    // `street` empty. For our purposes "Am Brunnenbühl" IS the street,
    // so fall through to `name` when `street` is absent. Not a perfect
    // heuristic — for POI results (e.g. a cafe) `name` is the POI's
    // own name and the true street sits in `street`; but the `??` order
    // below handles that case correctly (prefer explicit `street`).
    const streetPart = f.properties.street ?? f.properties.name;
    out.push({
      key: `${f.properties.osm_type ?? 'X'}:${f.properties.osm_id ?? Math.random()}`,
      formatted: label,
      street: streetPart,
      housenumber: f.properties.housenumber,
      city: f.properties.city,
      postcode: f.properties.postcode,
      country: f.properties.country,
      lat,
      lon,
    });
  }
  return out;
}
