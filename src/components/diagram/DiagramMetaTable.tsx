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

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../store/projectStore';

// Title-block layout — a single 5-column × 2-row grid. The Address cell
// spans BOTH rows (gridRow: '1 / 3') so long postal addresses have room
// to wrap onto a second line without squeezing the other cells. The
// remaining 4 columns host the project-derived info in row 1 and the
// editable team/date fields in row 2.
//
// Salesperson was intentionally removed from the editable set so the
// row-2 field count matches the number of non-address columns (4). If
// you add another editable field, widen the grid to 6 columns and put
// the new cell wherever it fits — don't leave empty slots, they read
// as unfilled form fields rather than intentional blank space.

/**
 * Editable title block shown beneath the diagram. Structured as an
 * engineering-drawing title block:
 *
 *   ┌────────┬──────────────┬────────┬─────────────┬────────────┐
 *   │ CUST.  │              │ MODULE │ PANELS      │ SYS. SIZE  │
 *   ├────────┤   ADDRESS    ├────────┼─────────────┼────────────┤
 *   │ PLAN.  │              │ PHONE  │ COMPANY     │ DATE       │
 *   └────────┴──────────────┴────────┴─────────────┴────────────┘
 *
 * Row 1 (derived from project state) is read-only so the block can never
 * drift from the rest of the app — editing a customer name in settings
 * or adding a panel on the roof plan is reflected here immediately.
 *
 * Row 2 (planner, phone, company, date) stays as free-text because those
 * facts have no canonical source elsewhere in the Project blob. Each
 * keystroke patches the single changed field into the store.
 */
export default function DiagramMetaTable() {
  const { t } = useTranslation();
  const meta = useProjectStore(s => s.project.diagram?.meta ?? {});
  const updateDiagramMeta = useProjectStore(s => s.updateDiagramMeta);

  // Derived values pulled live from project state. Granular selectors so
  // the table only re-renders when one of these specific fields changes —
  // a full `project` selector would thrash on every panel drag.
  // Seed the date with today's ISO whenever it's missing. Covers (a) fresh
  // projects where bootstrapDiagram hasn't run yet on this mount and
  // (b) legacy projects whose diagram was bootstrapped before meta.date
  // existed. Runs once per "empty-seen" transition so explicit user-
  // cleared values don't re-populate mid-session.
  useEffect(() => {
    if (!meta.date) {
      updateDiagramMeta({ date: new Date().toISOString().split('T')[0] });
    }
  }, [meta.date, updateDiagramMeta]);

  const customer = useProjectStore(s => s.project.meta?.client ?? '');
  // Structured address components — read individually instead of the
  // `formatted` one-liner so the title block can lay them out on three
  // visual lines (street / zip+city / country), matching the postal
  // convention on paperwork. Falling back to `formatted` only when no
  // structured parts are available preserves behaviour for legacy docs
  // whose address was stored before we captured structured fields.
  const addrStreet = useProjectStore(
    s => s.project.meta?.address?.street ?? '',
  );
  const addrNumber = useProjectStore(
    s => s.project.meta?.address?.housenumber ?? '',
  );
  const addrPostcode = useProjectStore(
    s => s.project.meta?.address?.postcode ?? '',
  );
  const addrCity = useProjectStore(
    s => s.project.meta?.address?.city ?? '',
  );
  const addrCountry = useProjectStore(
    s => s.project.meta?.address?.country ?? '',
  );
  const addrFormatted = useProjectStore(
    s => s.project.meta?.address?.formatted ?? '',
  );
  const moduleName = useProjectStore(s => s.project.panelType.name);
  const wattPeak = useProjectStore(s => s.project.panelType.wattPeak);
  const panelCount = useProjectStore(s => s.project.panels.length);

  // System size in kWp, 2-decimal precision to match the sidebar hero
  // stat — one authoritative presentation wherever the same number shows.
  const systemSizeKwp = (panelCount * wattPeak) / 1000;

  // Compact "count × Wp" notation is the standard engineering shorthand
  // for a PV array's panel configuration. Keeps panel count and panel
  // wattage both visible without eating two separate grid cells.
  const panelsDisplay =
    panelCount > 0 && wattPeak > 0
      ? `${panelCount} × ${wattPeak} Wp`
      : panelCount > 0
        ? panelCount.toString()
        : '';

  const emptyDash = t('diagram.meta.emptyDash');

  // Build the three postal-style lines. Each line is only included when
  // it has content — skipping a line rather than rendering an empty row
  // means a partial address (e.g. city only) doesn't leave visible gaps
  // between its populated lines. `.trim()` collapses the case where one
  // half of a line is missing (e.g. street set but no house number).
  const addressLines = [
    `${addrStreet} ${addrNumber}`.trim(),
    `${addrPostcode} ${addrCity}`.trim(),
    addrCountry,
  ].filter(Boolean);
  // Fall back to the single-line `formatted` string for legacy addresses
  // that never captured structured parts. Split on common separators so
  // something like "Marienplatz 8, 80331 Munich, Germany" still reads
  // as multiple lines when the user had a pre-structured geocode.
  const addressLinesFallback =
    addressLines.length === 0 && addrFormatted
      ? addrFormatted.split(/,\s*/).filter(Boolean)
      : addressLines;

  return (
    <div
      className="grid"
      style={{
        flexShrink: 0,
        // Five columns; the Address cell (col 2) spans both rows so it
        // gets double the vertical space — long postal addresses wrap
        // onto a second line rather than being truncated.
        gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
        gridAutoRows: 'minmax(36px, auto)',
        // Single hairline top rule separates the block from the canvas.
        borderTop: '1px solid var(--hairline-strong)',
        background: 'transparent',
      }}
    >
      {/* ── Row 1, col 1 — Customer ─────────────────────────────── */}
      <LabeledCell
        label={t('diagram.meta.customer')}
        style={{
          gridColumn: '1',
          gridRow: '1',
          borderRight: '1px solid var(--hairline)',
          borderBottom: '1px solid var(--hairline)',
        }}
      >
        <ReadonlyText value={customer} fallback={emptyDash} />
      </LabeledCell>

      {/* ── Address — col 2, spans rows 1 & 2 ───────────────────── */}
      {/* `gridRow: '1 / 3'` claims both rows; this is the "two rows"
          the user asked for so a full street + city + postcode line
          can wrap without truncating. Text wrap enabled via the
          `allowWrap` flag on ReadonlyText. */}
      <LabeledCell
        label={t('diagram.meta.address')}
        style={{
          gridColumn: '2',
          gridRow: '1 / 3',
          borderRight: '1px solid var(--hairline)',
        }}
      >
        <AddressLines lines={addressLinesFallback} fallback={emptyDash} />
      </LabeledCell>

      {/* ── Row 1, col 3 — Module name ──────────────────────────── */}
      <LabeledCell
        label={t('diagram.meta.module')}
        style={{
          gridColumn: '3',
          gridRow: '1',
          borderRight: '1px solid var(--hairline)',
          borderBottom: '1px solid var(--hairline)',
        }}
      >
        <ReadonlyText value={moduleName} fallback={emptyDash} />
      </LabeledCell>

      {/* ── Row 1, col 4 — Panels (count × Wp) ──────────────────── */}
      {/* Combines panel count and per-module wattage in the engineering
          shorthand "24 × 400 Wp". Lets both facts fit one cell without
          forcing the grid to a sixth column (which would leave row 2
          with an empty slot after removing salesperson). */}
      <LabeledCell
        label={t('diagram.meta.panels')}
        style={{
          gridColumn: '4',
          gridRow: '1',
          borderRight: '1px solid var(--hairline)',
          borderBottom: '1px solid var(--hairline)',
        }}
      >
        <ReadonlyText value={panelsDisplay} fallback={emptyDash} />
      </LabeledCell>

      {/* ── Row 1, col 5 — System size ──────────────────────────── */}
      <LabeledCell
        label={t('diagram.meta.systemSize')}
        style={{
          gridColumn: '5',
          gridRow: '1',
          borderBottom: '1px solid var(--hairline)',
        }}
      >
        <ReadonlyText
          value={panelCount > 0 ? `${systemSizeKwp.toFixed(2)} kWp` : ''}
          fallback={emptyDash}
        />
      </LabeledCell>

      {/* ── Row 2, col 1 — Planner ──────────────────────────────── */}
      <LabeledCell
        label={t('diagram.meta.planner')}
        style={{
          gridColumn: '1',
          gridRow: '2',
          borderRight: '1px solid var(--hairline)',
        }}
      >
        <EditableInput
          value={meta.planner ?? ''}
          onChange={v => updateDiagramMeta({ planner: v })}
        />
      </LabeledCell>

      {/* ── Row 2, col 3 — Planner phone ────────────────────────── */}
      <LabeledCell
        label={t('diagram.meta.plannerPhone')}
        style={{
          gridColumn: '3',
          gridRow: '2',
          borderRight: '1px solid var(--hairline)',
        }}
      >
        <EditableInput
          value={meta.plannerPhone ?? ''}
          onChange={v => updateDiagramMeta({ plannerPhone: v })}
          type="tel"
        />
      </LabeledCell>

      {/* ── Row 2, col 4 — Company ──────────────────────────────── */}
      <LabeledCell
        label={t('diagram.meta.company')}
        style={{
          gridColumn: '4',
          gridRow: '2',
          borderRight: '1px solid var(--hairline)',
        }}
      >
        <EditableInput
          value={meta.company ?? ''}
          onChange={v => updateDiagramMeta({ company: v })}
        />
      </LabeledCell>

      {/* ── Row 2, col 5 — Date ─────────────────────────────────── */}
      {/* Stored internally as ISO (YYYY-MM-DD) but displayed in the
          app's active language — German renders DD.MM.YYYY, English
          renders MM/DD/YYYY. A native <input type="date"> would follow
          the browser's OS locale instead of i18next, so we replace it
          with a locale-formatted text input here. */}
      <LabeledCell
        label={t('diagram.meta.date')}
        style={{ gridColumn: '5', gridRow: '2' }}
      >
        <LocaleDateInput
          value={meta.date ?? ''}
          onChange={v => updateDiagramMeta({ date: v })}
        />
      </LabeledCell>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Cell primitives. Extracted so row 1 read-only cells and row 2 editable
// cells share label typography / padding exactly — the two rows must
// feel like one continuous title block, not two glued-together tables.
// ────────────────────────────────────────────────────────────────────────

function LabeledCell({
  label,
  children,
  style,
}: {
  label: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className="flex flex-col"
      style={{ padding: '6px 10px 7px', minWidth: 0, ...style }}
    >
      <span
        className="uppercase select-none"
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 8.5,
          fontWeight: 600,
          letterSpacing: '0.16em',
          color: 'var(--ink-400)',
          lineHeight: 1.3,
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function ReadonlyText({
  value,
  fallback,
  allowWrap,
}: {
  value: string;
  fallback: string;
  // When true, long values wrap to further lines inside the cell
  // instead of being truncated. Used for the Address cell which spans
  // two rows and therefore has headroom for a second line.
  allowWrap?: boolean;
}) {
  return (
    <span
      className={allowWrap ? undefined : 'truncate'}
      style={{
        fontFamily: "'Geist', ui-sans-serif, system-ui, sans-serif",
        fontSize: 12,
        fontWeight: 500,
        // Dim the fallback dash so empty cells read quieter than filled
        // ones — same visual weight contract as an unfilled input.
        color: value ? 'var(--ink-100)' : 'var(--ink-500)',
        marginTop: 2,
        minWidth: 0,
        // Two-line wrap behaviour for the address. -webkit-line-clamp is
        // widely supported in modern Chromium/Safari/Firefox and gives a
        // clean "clip to 2 lines with ellipsis" instead of letting a
        // very long address overflow its row-span. The supporting
        // `display: -webkit-box` and `-webkit-box-orient` are required
        // by the line-clamp contract.
        ...(allowWrap
          ? ({
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 2,
              overflow: 'hidden',
              whiteSpace: 'normal',
              lineHeight: 1.35,
            } as React.CSSProperties)
          : null),
      }}
      title={value || undefined}
    >
      {value || fallback}
    </span>
  );
}

function AddressLines({
  lines,
  fallback,
}: {
  lines: string[];
  fallback: string;
}) {
  // Empty address — render the same dimmed dash the other readonly cells
  // use so the "no value" visual is consistent across the title block.
  if (lines.length === 0) {
    return (
      <span
        style={{
          fontFamily: "'Geist', ui-sans-serif, system-ui, sans-serif",
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--ink-500)',
          marginTop: 2,
        }}
      >
        {fallback}
      </span>
    );
  }
  return (
    <div
      style={{
        fontFamily: "'Geist', ui-sans-serif, system-ui, sans-serif",
        fontSize: 11.5,
        fontWeight: 500,
        color: 'var(--ink-100)',
        marginTop: 2,
        // Each line gets its own row — tight leading so three lines
        // comfortably fit inside the cell's row-spanned height without
        // forcing the grid to stretch. Values tuned so a three-line
        // address just about fills the doubled cell height without
        // overflowing or leaving dead space above/below.
        lineHeight: 1.3,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      {lines.map((line, i) => (
        <span
          key={i}
          className="truncate"
          title={line}
          style={{ minWidth: 0 }}
        >
          {line}
        </span>
      ))}
    </div>
  );
}

function EditableInput({
  value,
  onChange,
  type = 'text',
}: {
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'tel' | 'date';
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        fontFamily: "'Geist', ui-sans-serif, system-ui, sans-serif",
        fontSize: 12,
        fontWeight: 500,
        color: 'var(--ink-100)',
        background: 'transparent',
        border: 'none',
        outline: 'none',
        padding: 0,
        marginTop: 2,
        cursor: 'text',
        minWidth: 0,
        width: '100%',
      }}
    />
  );
}

// ────────────────────────────────────────────────────────────────────────
// LocaleDateInput — text input that accepts/renders DD.MM.YYYY under the
// German locale and MM/DD/YYYY otherwise, while storing the canonical ISO
// YYYY-MM-DD on `meta.date`. We keep ISO on disk so the value round-trips
// regardless of which language a teammate opens the project in; the
// display format is a pure presentation layer.
//
// Why not `<input type="date">`: browsers render that in the OS locale and
// ignore any i18n framework running on top. Language-toggle users can't
// get the dotted German form without also switching their whole browser.
//
// Editing contract: users can type in the localized form; we parse on
// blur. If the value fails to parse we fall back to writing the raw text
// (so a half-typed date doesn't silently erase prior input) — the next
// blur with a valid form normalises it back to ISO.
// ────────────────────────────────────────────────────────────────────────
function LocaleDateInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (iso: string) => void;
}) {
  const { i18n } = useTranslation();
  const lang = i18n.language || 'en';
  const isDe = lang.toLowerCase().startsWith('de');

  // Display draft — decoupled from the stored ISO so the caret doesn't
  // jump while typing. We seed it from the stored value whenever that
  // value changes from outside (e.g. language toggle, remote sync patch).
  const [draft, setDraft] = useState(() => isoToDisplay(value, isDe));
  useEffect(() => {
    setDraft(isoToDisplay(value, isDe));
  }, [value, isDe]);

  return (
    <input
      type="text"
      inputMode="numeric"
      placeholder={isDe ? 'TT.MM.JJJJ' : 'MM/DD/YYYY'}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => {
        const iso = displayToIso(draft, isDe);
        // Accept a successful parse — otherwise keep whatever was stored
        // so we don't lose prior data because the user tabbed away mid-edit.
        if (iso !== null) {
          onChange(iso);
          setDraft(isoToDisplay(iso, isDe));
        } else if (draft.trim() === '') {
          // Empty input → clear the stored value so removing a date works.
          onChange('');
        } else {
          // Unparseable draft → revert the visible field to the last good
          // stored ISO rather than leaving a nonsense string hanging.
          setDraft(isoToDisplay(value, isDe));
        }
      }}
      style={{
        fontFamily: "'Geist', ui-sans-serif, system-ui, sans-serif",
        fontSize: 12,
        fontWeight: 500,
        color: 'var(--ink-100)',
        background: 'transparent',
        border: 'none',
        outline: 'none',
        padding: 0,
        marginTop: 2,
        cursor: 'text',
        minWidth: 0,
        width: '100%',
      }}
    />
  );
}

// ISO → "24.04.2026" (de) or "04/24/2026" (en). Returns '' for empty /
// malformed values so the input reads as "no date" rather than "NaN".
function isoToDisplay(iso: string, isDe: boolean): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  const [, y, mo, d] = m;
  return isDe ? `${d}.${mo}.${y}` : `${mo}/${d}/${y}`;
}

// Parse a localized draft back to ISO. Tolerates 1–2 digit day/month and
// 2 or 4-digit year (2-digit assumed 2000s, matching the rest of the
// datasets we care about). Returns null on any mismatch so the caller can
// decide whether to revert or keep the raw string.
function displayToIso(input: string, isDe: boolean): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const re = isDe
    ? /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/
    : /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
  const m = re.exec(trimmed);
  if (!m) return null;
  const day = isDe ? Number(m[1]) : Number(m[2]);
  const month = isDe ? Number(m[2]) : Number(m[1]);
  const yearRaw = Number(m[3]);
  const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
  // Reject obviously invalid combinations without constructing a Date
  // (Date silently rolls 32 Jan into 1 Feb — we want to reject, not roll).
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year.toString().padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
