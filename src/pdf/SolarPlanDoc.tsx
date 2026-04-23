// ────────────────────────────────────────────────────────────────────────────
// SolarPlanDoc — the @react-pdf/renderer document for the export.
//
// Page layout (one A4 landscape sheet, single-page-guaranteed):
//
//   ┌───────────────┬────────────────────────────────────────┐
//   │  Header       │                                        │
//   │  (brand,      │                                        │
//   │  project name,│                                        │
//   │  date)        │                                        │
//   │               │             Plan picture               │
//   │  Customer     │      (aspect-fit, centered in box)     │
//   │  data         │                                        │
//   │               │                                        │
//   │  Notes        │                                        │
//   │  (optional)   │                                        │
//   │               │                                        │
//   │  ─ ── ── ── ─ │                                        │
//   │  Stats tiles  │                                        │
//   └───────────────┴────────────────────────────────────────┘
//   ┌──────────────────────────────────────────────────────────┐
//   │  Strings table — full width, only when project has any   │
//   └──────────────────────────────────────────────────────────┘
//
// Why this shape:
//   The previous design stacked a wide masthead above the plan and a
//   stat-tile footer below. With realistic plan aspect ratios (often
//   ~1.4-1.7), that layout left big horizontal whitespace flanking the
//   image AND vertically squeezed the strings table off the page once
//   the image filled out. Moving identity + customer + notes + stats
//   into a 200pt left rail gives the plan picture its own ~561pt-wide
//   real estate at near-page-height, and the strings table gets the
//   full content width as a bottom band — exactly the proportions a
//   client deliverable wants.
//
// Visual identity (unchanged from before):
//   - Scarlet (`--sun-400` = #ff6363) is the lone accent color.
//   - Near-black ink scale for everything else.
//   - Hairline gray rules + subtle borders for containment, no shadows
//     (react-pdf doesn't render them well).
//   - Tabular numerics with right-aligned numeric columns in the table.
//   - Stats use the largest scarlet display type on the page, because
//     they're what the recipient looks for first.
//
// Why translations + numerics are passed in as a plain object:
//   Keeps the component pure and trivially testable, decouples it from
//   the i18next module, and means the lazy chunk doesn't need to re-import
//   i18next (which is already in the main bundle anyway). The caller
//   resolves all strings — and pre-formats all numerics — once before
//   rendering, so this file is purely about layout and styling.
// ────────────────────────────────────────────────────────────────────────────

import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer';
import type { Project } from '../types';

/**
 * All localized strings + pre-formatted values the PDF needs. Computed
 * once by the caller (with locale-aware number formatting) so the doc
 * doesn't depend on i18next or `Intl` at render time.
 */
export interface PdfStrings {
  // Header (sidebar top)
  kicker: string;
  date: string;
  metaClient: string;   // label, e.g. "Client"
  metaAddress: string;  // label, e.g. "Address"
  notesLabel: string;
  // Strings table (bottom band)
  strings: string;
  panelInfo: string;    // subtitle under the strings caption (panel type)
  colString: string;
  colColor: string;
  colPanels: string;
  colWp: string;
  colInverter: string;
  // Stat tiles (sidebar bottom)
  statPanels: string;   // label
  statPower: string;    // label
  statScale: string;    // label
  unitKwp: string;
  unitMpp: string;
  scaleZoom: string;    // tertiary line under scale value
}

/**
 * Pre-formatted numeric values for the stat tiles. Caller does the locale-
 * aware formatting (`Intl.NumberFormat`) so the doc just slots strings
 * into place. `scaleMpp` is empty when the map isn't locked — the tile
 * hides when so.
 */
export interface PdfStats {
  panelsCount: string;  // e.g. "24"
  powerKwp: string;     // e.g. "9.6"
  scaleMpp: string;     // e.g. "0.0892" — empty when no map lock
  /** Pre-formatted WGS84 coordinates line, e.g. "48.13710° N · 11.57540° E".
   *  Empty string when the project has no address (the whole sub-line
   *  collapses in that case). Rendered under the address in the sidebar. */
  addressCoords: string;
}

export interface SolarPlanDocProps {
  project: Project;
  /** Pre-composed plan image (drafting paper + grid + Konva overlay). */
  imageDataUrl: string;
  /** Final image dimensions on the page, in points. The caller computes
   *  these from the captured aspect ratio and the right-column box so
   *  the document doesn't have to know about page geometry. */
  imageWidthPt: number;
  imageHeightPt: number;
  strings: PdfStrings;
  stats: PdfStats;
}

// ── Brand tokens ──────────────────────────────────────────────────────────
// Mirror of the CSS custom properties in /src/index.css (--sun-*, --ink-*).
// Duplicating the literals (rather than parsing CSS) keeps the lazy chunk
// self-contained — react-pdf renders headlessly, no DOM is available to
// resolve `getComputedStyle` against.
const SUN = '#ff6363';      // canonical scarlet accent
const SUN_DARK = '#c13636'; // for hover/active states (used here for swatch borders)
const INK = '#0b0b0c';      // primary text (deep near-black)
const INK_MUTED = '#3a3a3f';// secondary text
const INK_HINT = '#65656b'; // tertiary text (labels)
const INK_FAINT = '#95959c';// quaternary text (rule + meta inline)
const RULE = '#dcdce0';     // hairline gray (cards, table separators)
const ZEBRA = '#fafafa';    // alternating row band — VERY subtle

// Layout constants. SolarPlanDoc owns these but the caller in
// pdfExport.tsx mirrors SIDEBAR_W and COL_GAP so it can compute the
// plan-image box dimensions before constructing the document. If you
// change either of these here, change the matching constant there.
//
// Why 110pt: the sidebar's job is identity + summary numerics, not a
// reading column. Customer names and addresses still wrap to 2-3 short
// lines, which matches the magazine-sidebar feel — and crucially gives
// the plan picture an extra ~90pt of horizontal real estate.
const SIDEBAR_W = 110;       // left-rail width (pt)
const COL_GAP = 16;          // gap between sidebar and plan frame
const ROW_GAP = 16;          // gap between top row and strings band

const styles = StyleSheet.create({
  page: {
    // Padding sets the printable margin. Symmetric now that there's no
    // absolutely-positioned footer crowding the bottom — the strings
    // band is part of the page flow.
    paddingTop: 28,
    paddingHorizontal: 32,
    paddingBottom: 32,
    fontFamily: 'Helvetica',
    color: INK,
  },

  // ── Top row: sidebar + plan frame ───────────────────────────────────────
  // Explicit height is set inline by the caller's planMaxH math so this
  // row consumes everything above the optional strings band. Children
  // stretch to that height by default (alignItems stretch is implicit).
  topRow: {
    flexDirection: 'row',
  },

  // ── Sidebar (left rail) ─────────────────────────────────────────────────
  // Hairline-bordered card that contains the header, customer info,
  // optional notes, and the three stat tiles. `flexDirection: column`
  // is implicit; a flex:1 spacer between the meta and stats blocks
  // pushes stats to the bottom of the sidebar regardless of how much
  // (or little) meta content there is above them.
  sidebar: {
    width: SIDEBAR_W,
    marginRight: COL_GAP,
    borderWidth: 0.5,
    borderColor: RULE,
    borderRadius: 4,
    // Tighter padding than before — 14pt all around left only ~80pt of
    // text width, which made client names break awkwardly. 10pt padding
    // gives ~90pt usable inner width.
    padding: 10,
  },

  // Brand square + kicker on one line. Date is moved to its own row
  // below (the narrow sidebar can't fit "SOLARPLAN" + a long localized
  // date side-by-side without one of them clipping).
  kickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Mini scarlet square as a brand bullet — same vocabulary as the
  // app's BrandMark glyph, scaled tiny so it reads as a colored dot.
  brandSquare: {
    width: 7,
    height: 7,
    backgroundColor: SUN,
    borderRadius: 1,
    marginRight: 6,
  },
  kicker: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: INK_HINT,
    letterSpacing: 1.4,
  },
  // Date sits on its own line under the kicker — small, gray, slightly
  // indented to align with the kicker text rather than the brand square.
  date: {
    fontSize: 7,
    color: INK_HINT,
    marginTop: 2,
    marginLeft: 13, // brand square (7) + marginRight (6) — visually align with kicker text
  },
  // Project name — 16pt fits "Hans Rudi" on one line in the ~90pt
  // inner column. Longer names wrap to 2-3 lines with the tight
  // line height, which still reads as a strong display heading at
  // this scale.
  projectName: {
    fontSize: 16,
    fontFamily: 'Helvetica-Bold',
    color: INK,
    marginTop: 8,
    lineHeight: 1.05,
  },
  accentRule: {
    width: 28,
    height: 2,
    backgroundColor: SUN,
    marginTop: 6,
    marginBottom: 2,
  },

  // ── Sidebar meta sections (customer / notes) ────────────────────────────
  // Each block is a small label above its value(s). Stacked vertically
  // so they read as a column, not the inline label/value rows from the
  // previous wide masthead — that pattern doesn't fit a narrow rail.
  metaSection: {
    marginTop: 12,
  },
  metaLabel: {
    fontSize: 7,
    fontFamily: 'Helvetica-Bold',
    color: INK_HINT,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 3,
  },
  metaValue: {
    fontSize: 9.5,
    color: INK_MUTED,
    lineHeight: 1.35,
  },
  // Small tertiary line under the address, used for the WGS84 coords.
  // Tabular digits + tiny letter-spacing so "48.13710° N · 11.57540° E"
  // reads as technical/coordinate info rather than prose.
  metaCoords: {
    fontSize: 7.5,
    color: INK_FAINT,
    marginTop: 2,
    letterSpacing: 0.2,
  },
  metaValueSpacer: {
    // Gap between consecutive meta values inside the same section
    // (e.g. between client and address when both are present).
    marginTop: 6,
  },
  // Notes prose: italic, slightly smaller, looser leading so a few
  // sentences breathe. Same scarlet left bar as before.
  notesRow: {
    flexDirection: 'row',
  },
  notesBar: {
    width: 2,
    backgroundColor: SUN,
    marginRight: 8,
  },
  notesContent: {
    flex: 1,
  },
  notesText: {
    fontSize: 9,
    fontFamily: 'Helvetica-Oblique',
    color: INK_MUTED,
    lineHeight: 1.45,
  },

  // Spacer that pushes the stats tile block to the bottom of the
  // sidebar — without it, stats would sit immediately under the meta
  // and float in the middle of the rail.
  flex1: {
    flex: 1,
    minHeight: 12,
  },

  // ── Stats block (sidebar bottom) ────────────────────────────────────────
  // Three tiles stacked vertically, with a top rule separating them
  // from the meta content above. Big scarlet number on each line.
  statsBlock: {
    borderTopWidth: 0.5,
    borderTopColor: RULE,
    paddingTop: 10,
  },
  statTile: {
    marginBottom: 8,
  },
  statTileLast: {
    // No bottom margin on the last tile — keeps the stats block
    // visually balanced against the sidebar's bottom padding.
    marginBottom: 0,
  },
  statLabel: {
    fontSize: 7,
    fontFamily: 'Helvetica-Bold',
    color: INK_HINT,
    letterSpacing: 1,
    marginBottom: 2,
  },
  statValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  // 16pt scarlet keeps the totals scannable at glance distance while
  // leaving room for "0,0252" + " m/px" in the narrow column.
  statValue: {
    fontSize: 16,
    fontFamily: 'Helvetica-Bold',
    color: SUN,
    letterSpacing: -0.4,
  },
  statUnit: {
    fontSize: 7.5,
    color: INK_HINT,
    marginLeft: 3,
  },
  statSubvalue: {
    fontSize: 7,
    color: INK_HINT,
    marginTop: 1,
    letterSpacing: 0.4,
  },

  // ── Plan frame (right of sidebar) ───────────────────────────────────────
  // Flex container that centers the aspect-fit image inside the right
  // column box. The image itself carries the visible border; this view
  // is structural only.
  planFrame: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  planImage: {
    borderWidth: 0.5,
    borderColor: RULE,
  },

  // ── Strings band (bottom, full width) ───────────────────────────────────
  // Same hairline-bordered card vocabulary as the sidebar so the page
  // reads as two cards above + one card below.
  stringsBand: {
    marginTop: ROW_GAP,
    borderWidth: 0.5,
    borderColor: RULE,
    borderRadius: 4,
    paddingTop: 10,
    paddingBottom: 8,
    paddingHorizontal: 14,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 6,
  },
  stringsCaption: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
    color: INK,
    marginRight: 8,
  },
  // Right of the caption: small italic gray panel-type subtitle.
  stringsSubtitle: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Oblique',
    color: INK_FAINT,
    flex: 1,
  },
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 0.75,
    borderBottomColor: INK,    // strong upper border = "this is a table"
    paddingTop: 4,
    paddingBottom: 4,
  },
  tableHeaderCell: {
    fontSize: 7,
    fontFamily: 'Helvetica-Bold',
    color: INK_HINT,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  tableRowBase: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 5,
    paddingBottom: 5,
    fontSize: 9.5,
  },
  tableRowAlt: {
    backgroundColor: ZEBRA,
  },
  // Column geometry (points). Widths are the same as before since the
  // strings band still has roughly the same content width as the old
  // page-flow table. `cellInverter` takes the remainder via flex: 1.
  cellLabel: { width: 96, fontFamily: 'Helvetica-Bold', color: INK },
  cellSwatch: { width: 50 },
  cellPanels: {
    width: 64,
    textAlign: 'right',
    paddingRight: 18,
    color: INK_MUTED,
  },
  cellWp: {
    width: 80,
    textAlign: 'right',
    paddingRight: 18,
    color: INK_MUTED,
  },
  cellInverter: { flex: 1, color: INK_MUTED, paddingLeft: 4 },
  swatch: {
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 0.6,
    borderColor: SUN_DARK,
  },
  inverterEmpty: {
    color: INK_FAINT,
  },
});

export function SolarPlanDoc({
  project,
  imageDataUrl,
  imageWidthPt,
  imageHeightPt,
  strings,
  stats,
}: SolarPlanDocProps) {
  // Inverter name lookup — used per-row in the strings table.
  const inverterById = new Map(project.inverters.map((i) => [i.id, i.name]));

  // Sidebar meta — both client and address are optional. We render the
  // whole "Customer" section only when at least one is present, so the
  // sidebar doesn't carry an empty labeled box.
  const clientText = project.meta?.client?.trim() || '';
  const addressText = project.meta?.address?.formatted?.trim() || '';
  const hasCustomer = clientText !== '' || addressText !== '';

  const notes = project.meta?.notes?.trim() || '';

  // Scale tile sub-line: only when the map is locked (an unlocked map
  // has no meaningful `metersPerPixel` to print).
  const showScale = project.mapState.locked && stats.scaleMpp !== '';
  const scaleZoomLine = project.mapState.locked
    ? strings.scaleZoom.replace('{{z}}', String(project.mapState.zoom))
    : '';

  // The top row needs an explicit height so the sidebar can stretch
  // (and its flex:1 spacer can do its job pushing stats to the bottom).
  // The caller already computed planH for the same reason — we reuse
  // it as the top-row height since the plan image is the tallest
  // element in the right column.
  const topRowHeight = imageHeightPt;

  // Stats: build the array first so we know which is "last" for the
  // marginBottom: 0 styling. Scale is conditional.
  const statTiles: Array<{
    key: string;
    label: string;
    value: string;
    unit?: string;
    sub?: string;
  }> = [
    { key: 'panels', label: strings.statPanels, value: stats.panelsCount },
    {
      key: 'power',
      label: strings.statPower,
      value: stats.powerKwp,
      unit: strings.unitKwp,
    },
  ];
  if (showScale) {
    statTiles.push({
      key: 'scale',
      label: strings.statScale,
      value: stats.scaleMpp,
      unit: strings.unitMpp,
      sub: scaleZoomLine,
    });
  }

  return (
    <Document>
      <Page size="A4" orientation="landscape" style={styles.page}>
        {/* Top row: sidebar + plan frame. Explicit height ensures the
            sidebar stretches so its flex:1 spacer can do its job. */}
        <View style={[styles.topRow, { height: topRowHeight }]}>
          {/* ── Sidebar ─────────────────────────────────────────────── */}
          <View style={styles.sidebar}>
            {/* Header: brand square + kicker, then date on its own line.
                Stacked rather than side-by-side because the narrow rail
                can't fit both side-by-side without one clipping. */}
            <View style={styles.kickerRow}>
              <View style={styles.brandSquare} />
              <Text style={styles.kicker}>{strings.kicker}</Text>
            </View>
            <Text style={styles.date}>{strings.date}</Text>
            <Text style={styles.projectName}>{project.name}</Text>
            <View style={styles.accentRule} />

            {/* Customer block (client + address) — collapsed entirely
                when neither value is set. */}
            {hasCustomer && (
              <View style={styles.metaSection}>
                {clientText !== '' && (
                  <>
                    <Text style={styles.metaLabel}>{strings.metaClient}</Text>
                    <Text style={styles.metaValue}>{clientText}</Text>
                  </>
                )}
                {addressText !== '' && (
                  <>
                    <Text
                      style={
                        clientText !== ''
                          ? [styles.metaLabel, styles.metaValueSpacer]
                          : styles.metaLabel
                      }
                    >
                      {strings.metaAddress}
                    </Text>
                    <Text style={styles.metaValue}>{addressText}</Text>
                    {stats.addressCoords !== '' && (
                      <Text style={styles.metaCoords}>{stats.addressCoords}</Text>
                    )}
                  </>
                )}
              </View>
            )}

            {/* Notes — italic prose with the scarlet left bar. */}
            {notes !== '' && (
              <View style={styles.metaSection}>
                <Text style={styles.metaLabel}>{strings.notesLabel}</Text>
                <View style={styles.notesRow}>
                  <View style={styles.notesBar} />
                  <View style={styles.notesContent}>
                    <Text style={styles.notesText}>{notes}</Text>
                  </View>
                </View>
              </View>
            )}

            {/* Spacer pushes stats to the bottom of the sidebar. */}
            <View style={styles.flex1} />

            {/* Stats tiles, vertically stacked with a top rule. */}
            <View style={styles.statsBlock}>
              {statTiles.map((tile, idx) => (
                <View
                  key={tile.key}
                  style={
                    idx === statTiles.length - 1
                      ? [styles.statTile, styles.statTileLast]
                      : styles.statTile
                  }
                >
                  <Text style={styles.statLabel}>{tile.label}</Text>
                  <View style={styles.statValueRow}>
                    <Text style={styles.statValue}>{tile.value}</Text>
                    {tile.unit !== undefined && (
                      <Text style={styles.statUnit}>{tile.unit}</Text>
                    )}
                  </View>
                  {tile.sub !== undefined && tile.sub !== '' && (
                    <Text style={styles.statSubvalue}>{tile.sub}</Text>
                  )}
                </View>
              ))}
            </View>
          </View>

          {/* ── Plan frame: aspect-fit image, centered ─────────────── */}
          <View style={styles.planFrame}>
            <Image
              src={imageDataUrl}
              style={[
                styles.planImage,
                { width: imageWidthPt, height: imageHeightPt },
              ]}
            />
          </View>
        </View>

        {/* ── Strings band (bottom, full width) ─────────────────────── */}
        {project.strings.length > 0 && (
          <View style={styles.stringsBand}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.stringsCaption}>{strings.strings}</Text>
              <Text style={styles.stringsSubtitle}>{strings.panelInfo}</Text>
            </View>
            <View style={styles.tableHeader}>
              <Text style={[styles.tableHeaderCell, styles.cellLabel]}>
                {strings.colString}
              </Text>
              <Text style={[styles.tableHeaderCell, styles.cellSwatch]}>
                {strings.colColor}
              </Text>
              <Text style={[styles.tableHeaderCell, styles.cellPanels]}>
                {strings.colPanels}
              </Text>
              <Text style={[styles.tableHeaderCell, styles.cellWp]}>
                {strings.colWp}
              </Text>
              <Text style={[styles.tableHeaderCell, styles.cellInverter]}>
                {strings.colInverter}
              </Text>
            </View>
            {project.strings.map((s, idx) => {
              const count = project.panels.filter((p) => p.stringId === s.id).length;
              const wp = count * project.panelType.wattPeak;
              const invName = s.inverterId
                ? inverterById.get(s.inverterId) || '?'
                : '—';
              const isEmptyInverter = invName === '—';
              const rowStyle = idx % 2 === 1
                ? [styles.tableRowBase, styles.tableRowAlt]
                : [styles.tableRowBase];
              return (
                <View key={s.id} style={rowStyle} wrap={false}>
                  <Text style={[styles.cellLabel, { paddingLeft: 4 }]}>{s.label}</Text>
                  <View style={styles.cellSwatch}>
                    <View style={[styles.swatch, { backgroundColor: s.color }]} />
                  </View>
                  <Text style={styles.cellPanels}>{String(count)}</Text>
                  <Text style={styles.cellWp}>{String(wp)}</Text>
                  <Text
                    style={
                      isEmptyInverter
                        ? [styles.cellInverter, styles.inverterEmpty]
                        : styles.cellInverter
                    }
                  >
                    {invName}
                  </Text>
                </View>
              );
            })}
          </View>
        )}
      </Page>
    </Document>
  );
}
