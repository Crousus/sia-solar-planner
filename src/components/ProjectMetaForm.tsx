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
// ProjectMetaForm — the controlled form used by both the new-project
// bootstrap page and the project-settings page. Pure presentation +
// local state: the parent owns submission, navigation, and server talk.
//
// Why extract from the two pages rather than inline:
//   The new-project and settings pages have different submit semantics
//   (one creates a PocketBase record, the other patches an existing
//   doc) but the form contents + validation are identical. Extracting
//   keeps the form logic in one place; if we add a field later, both
//   pages pick it up automatically.
//
// What lives inside vs outside this component:
//   Inside:  field state, validation, map preview, submit button
//            disabled-state wiring, form layout.
//   Outside: what "submit" means (create vs patch), navigation on
//            success, spinner label text, error surfacing. The parent
//            passes in the submit handler and a busy flag; we show it.
// ────────────────────────────────────────────────────────────────────────

import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import { Link } from 'react-router-dom';
import L from 'leaflet';
import type { ProjectMeta, ProjectAddress } from '../types';
import AddressAutocomplete from './AddressAutocomplete';
import CustomerPicker from './CustomerPicker';

// Leaflet's default marker icon relies on CSS-relative image URLs that
// don't survive Vite's asset pipeline without a shim. Rather than wiring
// up the full icon-URL dance for a component that just shows one pin,
// we build a tiny inline-SVG icon and register it on the marker
// instance directly. Small, crisp, and locale-agnostic.
const PREVIEW_MARKER_ICON = L.divIcon({
  className: 'solar-address-marker',
  html:
    '<svg width="26" height="32" viewBox="0 0 26 32" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M13 31C13 31 24 19.5 24 12.5C24 6.15 19.0751 1 13 1C6.92487 1 2 6.15 2 12.5C2 19.5 13 31 13 31Z" ' +
    'fill="#E63946" stroke="white" stroke-width="2"/>' +
    '<circle cx="13" cy="12" r="4.5" fill="white"/></svg>',
  iconSize: [26, 32],
  iconAnchor: [13, 32],
});

// ESRI's public imagery endpoint — same as MapView uses in the editor,
// so the preview's visual matches what the user will see on lock.
const ESRI_SAT =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

/**
 * Helper component used inside MapContainer so we can call setView
 * declaratively whenever the address changes. Sits inside the Leaflet
 * React context, which setView needs.
 *
 * Kept inline rather than hoisted because it's 6 lines and only used
 * here — exporting it would imply reusability we don't intend.
 */
function PreviewFollower({ lat, lon }: { lat: number; lon: number }) {
  const map = useMap();
  // Use flyTo for a smooth pan/zoom when the user picks a suggestion —
  // helps them see that the preview is responding to their selection
  // without feeling jarring. Zoom level 17 shows the building + a bit
  // of surrounding context; enough to verify the right address without
  // going so tight that a slightly-off geocode looks correct.
  map.flyTo([lat, lon], 17, { duration: 0.6 });
  return null;
}

/**
 * Single value type shared by both caller pages. Name is always
 * present; meta is always an object (possibly with all-undefined
 * fields) so the form doesn't need to treat "no meta" and "empty
 * meta" as different states.
 */
export interface ProjectMetaFormValue {
  name: string;
  meta: ProjectMeta;
  customerId: string | null;
}

interface Props {
  /** Team ID — passed to CustomerPicker so it can scope the customer list. */
  teamId: string;
  /** Initial values for the form. For new projects, pass name='' and
   *  meta={}; for settings, pass the existing record values. */
  initialValue: ProjectMetaFormValue;
  /** Parent-provided submit handler. Receives the fully-trimmed, valid
   *  value; parent handles any async work (POST / PATCH / navigate).
   *  Throwing from onSubmit is allowed — parent should surface an error
   *  via `error` prop rather than bubbling up. */
  onSubmit: (value: ProjectMetaFormValue) => void | Promise<void>;
  /** Where Cancel navigates to — caller-specific (team page vs editor). */
  cancelHref: string;
  /** Parent-controlled busy flag — disables submit + shows the spinner. */
  busy?: boolean;
  /** Optional error string shown inside the form card. */
  error?: string | null;
  /** Label for the primary submit button ("Create project" / "Save"). */
  submitLabel: string;
  /** Active-state label while `busy` is true ("Creating…" / "Saving…"). */
  submitBusyLabel: string;
  /** Optional extra slot rendered just above the submit row — used by
   *  NewProjectPage to inject the PanelModelPicker without needing to
   *  reimplement the form. Kept generic (ReactNode) so future callers
   *  can add any field without further plumbing. Not wired into the
   *  canSubmit check — callers that need the extra field to block
   *  submission should pass `extraDisabled` alongside. */
  extra?: React.ReactNode;
  /** When true, the submit button is disabled regardless of internal
   *  validation. Used together with `extra` to enforce required fields
   *  outside the form's knowledge (e.g. "you must pick a panel model"). */
  extraDisabled?: boolean;
}

export default function ProjectMetaForm({
  teamId,
  initialValue,
  onSubmit,
  cancelHref,
  busy = false,
  error,
  submitLabel,
  submitBusyLabel,
  extra,
  extraDisabled = false,
}: Props) {
  const { t } = useTranslation();

  // Local controlled state for every field. Keeping them as separate
  // useState hooks (rather than one object) keeps each setter stable
  // and makes targeted updates (e.g. onChange on a single input) not
  // re-render fields that didn't change.
  const [name, setName] = useState(initialValue.name);
  const [customerId, setCustomerId] = useState<string | null>(initialValue.customerId ?? null);
  const [address, setAddress] = useState<ProjectAddress | undefined>(
    initialValue.meta.address
  );
  const [notes, setNotes] = useState(initialValue.meta.notes ?? '');

  // Submit is disabled when name is empty (post-trim) — the only hard
  // requirement. Optional fields never block.
  const canSubmit = useMemo(
    () => name.trim().length > 0 && !busy && !extraDisabled,
    [name, busy, extraDisabled],
  );

  // Map preview uses a stable initial center when no address is picked
  // so the Leaflet container has a valid viewport on mount — we hide
  // the tiles behind an overlay in that case rather than passing
  // undefined coords (which Leaflet rejects). Munich just because it
  // matches the editor's initialProject default center and is visually
  // distinctive enough that empty state is obvious.
  const previewCenter: [number, number] = address
    ? [address.lat, address.lon]
    : [48.137, 11.575];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    // Strip empty-string optional fields so we never persist "" for
    // `notes` — keeps patches / diffs minimal and avoids a difference
    // between "never entered" and "entered then cleared". The client
    // name lives on the customer relation now (see customerId below),
    // no longer on meta.client.
    const meta: ProjectMeta = {};
    if (address) meta.address = address;
    const nTrim = notes.trim();
    if (nTrim) meta.notes = nTrim;

    await onSubmit({ name: name.trim(), meta, customerId });
  }

  return (
    <form onSubmit={handleSubmit} className="surface rounded-[14px] p-6 space-y-4">
      <label className="block">
        <span className="field-label">{t('projectMeta.name')}</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('projectMeta.namePlaceholder')}
          required
          minLength={1}
          maxLength={120}
          autoFocus
        />
      </label>

      <div className="block">
        <span className="field-label">{t('customer.label')}</span>
        <CustomerPicker teamId={teamId} value={customerId} onChange={setCustomerId} />
      </div>

      <div className="block">
        <span className="field-label">{t('projectMeta.address')}</span>
        <AddressAutocomplete value={address} onChange={setAddress} />

        {/*
          Structured address parts. Shown ONLY after the user has picked
          a suggestion (i.e. `address` is truthy + carries coords). We
          let the user edit these in place — Photon occasionally parses
          parts imperfectly (e.g. puts the house number inside `street`
          for certain OSM records) and the user is a better authority
          than a remote geocoder on what should appear on an invoice.
          We intentionally do NOT re-geocode on edit: the lat/lon and
          map pin stay anchored to the location the user confirmed by
          picking the suggestion. Edits only affect the stored text.
        */}
        {address && (
          <div className="mt-3 grid grid-cols-4 gap-2">
            <label className="col-span-3 block">
              <span className="field-label">{t('projectMeta.street')}</span>
              <input
                className="input"
                value={address.street ?? ''}
                onChange={(e) => setAddress({ ...address, street: e.target.value })}
                maxLength={120}
              />
            </label>
            <label className="col-span-1 block">
              <span className="field-label">{t('projectMeta.housenumber')}</span>
              <input
                className="input"
                value={address.housenumber ?? ''}
                onChange={(e) => setAddress({ ...address, housenumber: e.target.value })}
                maxLength={20}
              />
            </label>
            <label className="col-span-1 block">
              <span className="field-label">{t('projectMeta.postcode')}</span>
              <input
                className="input"
                value={address.postcode ?? ''}
                onChange={(e) => setAddress({ ...address, postcode: e.target.value })}
                maxLength={20}
              />
            </label>
            <label className="col-span-3 block">
              <span className="field-label">{t('projectMeta.city')}</span>
              <input
                className="input"
                value={address.city ?? ''}
                onChange={(e) => setAddress({ ...address, city: e.target.value })}
                maxLength={120}
              />
            </label>
          </div>
        )}

        {/* Map preview — always rendered so the height is stable; shows
            a dimmed "pick an address" hint until the user commits one.
            Using `pointerEvents: none` would disable the child <MapContainer>'s
            tile loading so we instead rely on the interaction props being
            all false. */}
        <div
          className="mt-3 rounded-lg overflow-hidden relative"
          style={{
            height: 220,
            border: '1px solid var(--hairline)',
            background: 'var(--ink-900)',
            // `isolation: isolate` forces a new stacking context so
            // Leaflet's internal pane z-indices (tile=200, marker=600,
            // popup=700 — see leaflet.css) stay trapped INSIDE this box.
            // Without it, .leaflet-container doesn't create a stacking
            // context of its own and those high pane values bleed up and
            // paint over our sibling elements — notably the address
            // autocomplete dropdown that can extend over the map.
            isolation: 'isolate',
          }}
        >
          <MapContainer
            center={previewCenter}
            zoom={address ? 17 : 11}
            dragging={false}
            zoomControl={false}
            scrollWheelZoom={false}
            doubleClickZoom={false}
            touchZoom={false}
            boxZoom={false}
            keyboard={false}
            attributionControl={false}
            style={{ height: '100%', width: '100%' }}
          >
            <TileLayer url={ESRI_SAT} maxZoom={22} maxNativeZoom={19} />
            {address && (
              <>
                <Marker position={[address.lat, address.lon]} icon={PREVIEW_MARKER_ICON} />
                <PreviewFollower lat={address.lat} lon={address.lon} />
              </>
            )}
          </MapContainer>
          {!address && (
            <div
              className="absolute inset-0 flex items-center justify-center text-[12px] font-mono pointer-events-none"
              style={{
                color: 'var(--ink-300)',
                // Semi-opaque wash so the tiles don't fight the hint text.
                background: 'rgba(15, 18, 22, 0.55)',
              }}
            >
              {t('projectMeta.selectAddressToPreview')}
            </div>
          )}
        </div>
      </div>

      <label className="block">
        <span className="field-label">{t('projectMeta.notes')}</span>
        <textarea
          className="input"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t('projectMeta.notesPlaceholder')}
          maxLength={2000}
          rows={3}
          style={{ resize: 'vertical', minHeight: 72 }}
        />
      </label>

      {/* Parent-supplied extra field(s). Rendered after notes, before
          the error banner, so it sits right above the submit row where
          a "required field" error naturally draws the eye. */}
      {extra}

      {error && (
        <div
          role="alert"
          className="rounded-lg px-3 py-2 text-[12.5px]"
          style={{
            background: 'rgba(255, 99, 99, 0.08)',
            border: '1px solid rgba(255, 99, 99, 0.35)',
            color: 'var(--sun-200)',
          }}
        >
          {error}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={!canSubmit}
          className="btn btn-primary flex-1 justify-center"
          style={{ padding: '10px 14px', fontSize: 13 }}
        >
          {busy ? (
            <>
              <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
              <span>{submitBusyLabel}</span>
            </>
          ) : (
            <span>{submitLabel}</span>
          )}
        </button>
        <Link
          to={cancelHref}
          className="btn btn-ghost"
          style={{ padding: '10px 14px', fontSize: 13 }}
        >
          {t('projectMeta.cancel')}
        </Link>
      </div>
    </form>
  );
}
