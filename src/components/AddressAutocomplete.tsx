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

// ────────────────────────────────────────────────────────────────────────
// AddressAutocomplete — typeahead address input backed by Photon.
//
// Interaction model (matches what users expect from a "modern" search box):
//   - Type → 250ms debounce → fire one Photon query → show dropdown.
//   - ↑/↓ move highlight, Enter picks highlighted row, Esc closes.
//   - Clicking a row picks it. Clicking outside the component closes
//     the dropdown without picking.
//   - Clear (×) button zeroes the value and emits onChange(null).
//
// State contract (emission):
//   - Emits a full ProjectAddress the moment the user picks a suggestion.
//   - Emits null when the user clears, or types anew after a pick (the
//     freshly typed string is NOT a validated address — we refuse to
//     store free-form text as a structured address).
//   - While the user is mid-typing after a previous pick, the committed
//     value upstream is already null; the visible input text is only
//     the uncommitted query.
//
// Why we store `query` separately from the committed value:
//   After a pick, we want the input to show the chosen `formatted`
//   label. But as soon as the user edits that text, they're no longer
//   describing the committed address — the committed value is stale.
//   Splitting "what's in the textbox" from "what we've emitted upstream"
//   is the only honest way to represent that transition.
// ────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectAddress } from '../types';
import { searchAddresses, type AddressSuggestion } from '../backend/photon';

// 250ms is the sweet spot for typeahead: fast enough that results feel
// live, slow enough to avoid firing on every single keystroke during
// normal typing (≈160ms between keys at 75 WPM).
const DEBOUNCE_MS = 250;

interface Props {
  /** The committed, validated address (or undefined). */
  value: ProjectAddress | undefined;
  /** Emitted when the user picks a suggestion or clears the field. */
  onChange: (next: ProjectAddress | undefined) => void;
  /** Optional placeholder; falls back to a sensible default via i18n. */
  placeholder?: string;
  /** Whether the input should autofocus on mount — used on the bootstrap
   *  page where the name field above it owns initial focus, so typically
   *  false here. */
  autoFocus?: boolean;
}

export default function AddressAutocomplete({ value, onChange, placeholder, autoFocus }: Props) {
  const { t, i18n } = useTranslation();

  // `query` — what's visible in the <input>. Seeded from value?.formatted
  // so an already-committed address displays correctly on mount.
  const [query, setQuery] = useState<string>(value?.formatted ?? '');
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number>(-1);
  const [loading, setLoading] = useState(false);
  // Set when the last fetch errored. We show a small inline hint rather
  // than an alert because the form itself remains usable — the user can
  // type a free-form description elsewhere or just submit without an
  // address (address is optional in our data model).
  const [fetchError, setFetchError] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  // Track the in-flight AbortController so a new query can cancel the
  // previous one. Without this, a slow response to an older query can
  // arrive AFTER the response to a newer query and overwrite the list.
  const abortRef = useRef<AbortController | null>(null);
  // Timer id for the debounce. Stored in a ref so we can clear it from
  // unrelated code paths (pick, blur, clear) without reading state.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `suppressNextQuery` bypasses the debounced effect exactly once.
  // Needed when we programmatically set `query` to a picked suggestion's
  // label: the query effect would otherwise fire a fresh search for that
  // label and reopen the dropdown right after we just closed it.
  const suppressNextQueryRef = useRef(false);

  // ── Outside-click closes the dropdown. Captured on the document so
  //    clicks anywhere (even on other form fields) dismiss the list.
  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setHighlight(-1);
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [open]);

  // ── Debounced search effect. Each time `query` changes, we schedule a
  //    Photon call; any previous timer / in-flight request is cancelled
  //    first. The effect deliberately depends ONLY on query + lang — it
  //    must not re-run when `open` toggles, or picking would retrigger
  //    a search.
  useEffect(() => {
    // One-shot bypass: a programmatic setQuery from the pick handler
    // shouldn't re-query.
    if (suppressNextQueryRef.current) {
      suppressNextQueryRef.current = false;
      return;
    }

    // Clear the debounce + any in-flight request whenever the input
    // changes — even if we end up not querying (empty string), we still
    // want to cancel the previous one.
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();

    const trimmed = query.trim();
    if (trimmed.length < 3) {
      // <3 chars → not useful enough to query. Avoids flooding Photon
      // with one-letter requests during fast typing starts.
      setSuggestions([]);
      setLoading(false);
      setFetchError(false);
      return;
    }

    setLoading(true);
    setFetchError(false);
    const controller = new AbortController();
    abortRef.current = controller;

    debounceRef.current = setTimeout(async () => {
      try {
        const results = await searchAddresses(trimmed, controller.signal, i18n.language);
        // Guard against a stale timer firing after a newer query
        // superseded it — the abort should prevent this, but on some
        // browsers the fetch resolves before abort propagates.
        if (controller.signal.aborted) return;
        setSuggestions(results);
        setOpen(results.length > 0);
        setHighlight(results.length > 0 ? 0 : -1);
      } catch (err) {
        // AbortError is expected on supersede-cancel → ignore.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setFetchError(true);
        setSuggestions([]);
        setOpen(false);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      controller.abort();
    };
    // i18n.language is intentionally in deps: switching language while
    // the field has text should re-query for localized labels.
  }, [query, i18n.language]);

  // ── Commit a suggestion upstream + reflect it in the input.
  const pick = useCallback(
    (s: AddressSuggestion) => {
      // Strip the `key` field — that's for React list identity only and
      // doesn't belong in our data model.
      const addr: ProjectAddress = {
        formatted: s.formatted,
        street: s.street,
        housenumber: s.housenumber,
        city: s.city,
        postcode: s.postcode,
        country: s.country,
        lat: s.lat,
        lon: s.lon,
      };
      onChange(addr);
      suppressNextQueryRef.current = true;
      setQuery(s.formatted);
      setOpen(false);
      setSuggestions([]);
      setHighlight(-1);
    },
    [onChange]
  );

  const clear = useCallback(() => {
    onChange(undefined);
    suppressNextQueryRef.current = true;
    setQuery('');
    setOpen(false);
    setSuggestions([]);
    setHighlight(-1);
  }, [onChange]);

  // ── When the user types after a previous commit, invalidate the
  //    committed value. Done in handleChange rather than a useEffect on
  //    query because we want this coupling to be synchronous with the
  //    user's keystroke — a consumer reading `value` on the very next
  //    render should see undefined, not a stale pick.
  const handleChange = useCallback(
    (next: string) => {
      setQuery(next);
      if (value && next !== value.formatted) {
        onChange(undefined);
      }
    },
    [value, onChange]
  );

  // ── Keyboard navigation inside the dropdown.
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) {
      // Still handle Esc so the user can dismiss a lingering dropdown
      // even after results cleared.
      if (e.key === 'Escape') {
        setOpen(false);
        setHighlight(-1);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1));
    } else if (e.key === 'Enter') {
      if (highlight >= 0 && highlight < suggestions.length) {
        e.preventDefault();
        pick(suggestions[highlight]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setHighlight(-1);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <input
          className="input"
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => {
            // Reopen the dropdown on refocus IF we still have suggestions
            // cached — avoids a flash of empty list + immediate re-query
            // when the user tabs back in.
            if (suggestions.length > 0) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? t('projectMeta.addressPlaceholder')}
          autoComplete="off"
          // aria plumbing for the listbox pattern.
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls="address-autocomplete-listbox"
          aria-activedescendant={
            highlight >= 0 ? `address-autocomplete-option-${highlight}` : undefined
          }
          autoFocus={autoFocus}
          style={{ paddingRight: query ? 68 : 28 }}
        />
        {/* Loading spinner or clear button — the right-side rail is
            mutually exclusive between the two states so we don't need
            separate positioning. */}
        {loading && (
          <svg
            className="animate-spin absolute right-2 top-1/2 -translate-y-1/2"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            style={{ color: 'var(--ink-400)' }}
          >
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
            <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        )}
        {!loading && query && (
          <button
            type="button"
            onClick={clear}
            aria-label={t('projectMeta.clearAddress')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-[11px] font-mono"
            style={{ color: 'var(--ink-400)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--ink-200)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--ink-400)')}
          >
            ×
          </button>
        )}
      </div>

      {fetchError && (
        <div
          className="mt-1 text-[11px] font-mono"
          style={{ color: 'var(--ink-400)' }}
        >
          {t('projectMeta.addressLookupFailed')}
        </div>
      )}

      {/* Dropdown listbox. Absolute-positioned below the input. Not a
          portal: in the contexts where we use it (modal-free pages), a
          simple absolute child keeps z-index reasoning local. */}
      {open && suggestions.length > 0 && (
        <ul
          id="address-autocomplete-listbox"
          role="listbox"
          className="surface absolute left-0 right-0 mt-1 rounded-lg overflow-hidden z-20"
          style={{ maxHeight: 280, overflowY: 'auto' }}
        >
          {suggestions.map((s, i) => {
            const active = i === highlight;
            return (
              <li
                id={`address-autocomplete-option-${i}`}
                key={s.key}
                role="option"
                aria-selected={active}
                // onMouseDown (not onClick) so the pick happens BEFORE
                // the input's blur fires — otherwise the outside-click
                // handler would close the dropdown between mousedown
                // and click and the pick would never register.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                onMouseEnter={() => setHighlight(i)}
                className="px-3 py-2 cursor-pointer"
                style={{
                  background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
                  borderTop: i === 0 ? 'none' : '1px solid var(--hairline)',
                }}
              >
                <div className="text-[13px]" style={{ color: 'var(--ink-100)' }}>
                  {s.formatted}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
