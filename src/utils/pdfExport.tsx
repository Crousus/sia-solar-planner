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
// pdfExport — thin entry point for generating the project PDF.
//
// Why this file is small:
//   The heavy stuff — @react-pdf/renderer (~1 MB after gzip) and the
//   SolarPlanDoc component — lives behind a dynamic `import()` so it only
//   loads the first time the user clicks Export. Keeping this entry tiny
//   means importing it from Toolbar costs nothing in the main bundle
//   beyond a couple of lines of glue.
//
//   Vite/Rollup automatically code-splits everything reachable through
//   `import('@react-pdf/renderer')` and `import('../pdf/SolarPlanDoc')`
//   into a separate chunk. The chunk is cached after first download, so
//   subsequent exports are instant.
//
//   IMPORTANT: nothing in /src/pdf/ may be statically imported from
//   anywhere else in the codebase, or the bundler will pull it back into
//   the main chunk and the lazy split disappears. This file's only static
//   imports are i18next (already in the main bundle) and types.
//
// On `prefetchPdfExport`:
//   The Toolbar wires this to onMouseEnter / onFocus on the Export button
//   so the chunk is fetched as soon as the user shows intent to click —
//   eliminating the ~200-500 ms first-click latency. It's safe to call
//   repeatedly: dynamic imports are de-duplicated by the module loader.
// ────────────────────────────────────────────────────────────────────────────

import i18next from 'i18next';
import type { Project } from '../types';
import type { InverterModelRecord } from '../backend/types';

// Page geometry (A4 landscape, in points). These constants are the
// boundary contract with SolarPlanDoc — if you change the page padding
// there, change them here too.
//
// Why points: react-pdf's coordinate unit is pt, so doing layout math
// here in pt avoids round-trips through mm. (composeStageImage takes mm
// because the grid spacing is naturally specified in metric — we convert
// once, when calling it.)
const PAGE_W_PT = 841.89;
const PAGE_H_PT = 595.28;
// Symmetric padding now that the stats live in the sidebar instead of
// an absolutely-positioned footer band.
const PAD_TOP_PT = 28;
const PAD_BOTTOM_PT = 32;
const PAD_HORIZ_PT = 32;
const CONTENT_W_PT = PAGE_W_PT - 2 * PAD_HORIZ_PT;       // ≈ 777.89
const CONTENT_H_PT = PAGE_H_PT - PAD_TOP_PT - PAD_BOTTOM_PT; // ≈ 535.28
const PT_PER_MM = 2.83465;

// Two-column layout geometry. These mirror SIDEBAR_W / COL_GAP / ROW_GAP
// in SolarPlanDoc — keep them in sync, or the plan image will either
// overflow the right column or leave dead space in it.
const SIDEBAR_W_PT = 110;
const COL_GAP_PT = 16;
const ROW_GAP_PT = 16;
// Width available to the plan image (right column inner width). The
// image's own 0.5pt border eats into this, but at the page scale it's
// invisible — no need to subtract it.
const RIGHT_COL_W_PT = CONTENT_W_PT - SIDEBAR_W_PT - COL_GAP_PT; // ≈ 651.89

// Single-page contract:
//   The PDF must always fit on one A4 sheet. The plan image is the only
//   element with a flexible size, so we compute the strings band height
//   exactly and size the image to fill whatever's left in the top row.
//   Customer / notes / stats live in the sidebar where they sit
//   alongside (not above/below) the image, so they don't compete with
//   the image for vertical space.
//
// Strings table components (in pt) — mirrors SolarPlanDoc.stringsBand:
//   - card paddingTop:                                10
//   - section header row (caption fontSize 12 × lh 1.2 + marginBottom 6): 22
//   - table header (fontSize 7 × lh 1.2 + paddingTop 4 + paddingBottom 4): 17
//   - per data row (fontSize 9.5 × lh 1.2 + paddingTop 5 + paddingBottom 5): 22
//   - card paddingBottom:                              8
const TABLE_BASE_PT = 57;           // paddingTop + section header + table header + paddingBottom
const TABLE_ROW_PT = 22;

// Cushion for kerning/leading variance and the strings-band border
// stroke that our arithmetic doesn't account for. Without it, a project
// right at the boundary can still spill the plan image past the band
// border or push the band onto page 2.
const SAFETY_PT = 8;

/**
 * Top-level export. Captures the Konva overlay, lazy-loads the PDF
 * renderer + document, builds the doc, triggers a browser download.
 *
 * Returns a boolean so callers can show a failure toast without needing
 * to interpret a thrown error. Anything that goes wrong is logged to
 * the console first.
 */
export async function exportPdf(
  project: Project,
  stageEl: HTMLElement,
  inverterModelCache: Record<string, InverterModelRecord> = {},
): Promise<boolean> {
  try {
    // Lazy-loaded modules. `Promise.all` parallelizes the fetches so
    // first-click cost is one round-trip wide, not three.
    const [
      { pdf },
      { SolarPlanDoc },
      { captureStage, composeWithGrid, captureDiagramView },
    ] = await Promise.all([
      import('@react-pdf/renderer'),
      import('../pdf/SolarPlanDoc'),
      import('../pdf/composeStageImage'),
    ]);

    // ── Stage capture (one Konva toCanvas pass) ─────────────────────────
    // `captureStage` also returns the stage's current rotation so we can
    // orient the export compass correctly in `composeWithGrid`.
    const { canvas: shot, stageRotation } = await captureStage(stageEl);
    const aspect = shot.width / shot.height;

    // ── Layout math: pick an image size that fills the right column ─────
    //
    // Top-row height = page content height minus the strings band (and
    // its row gap) when there are any strings, minus a small safety
    // cushion. This is also the height of the sidebar — the sidebar
    // stretches to match because its parent row has explicit height.
    const tableH = computeTableHeight(project);
    const stringsTotalH = tableH > 0 ? tableH + ROW_GAP_PT : 0;
    const topRowH = CONTENT_H_PT - stringsTotalH - SAFETY_PT;

    // The plan image must aspect-fit within the right column box
    // (RIGHT_COL_W_PT × topRowH). Either bound can be the active
    // constraint depending on the captured aspect ratio:
    //   - tall capture → height-bound, image is narrower than the column
    //   - wide capture → width-bound, image is shorter than the column
    // In both cases the planFrame view in SolarPlanDoc centers the
    // image inside the box, so the dead space (if any) is symmetric.
    const planW = Math.min(RIGHT_COL_W_PT, topRowH * aspect);
    const planH = planW / aspect;

    // ── Compose the plan image at the now-known printed width ───────────
    // Convert pt → mm so the grid in composeWithGrid matches the printed
    // metric scale. composeWithGrid is sync, so this is a single tick of
    // CPU work between the html2canvas hop and the react-pdf hop.
    const drawWmm = planW / PT_PER_MM;
    const imageDataUrl = composeWithGrid(shot, drawWmm, stageRotation);

    // ── Optional block-diagram page capture ─────────────────────────────
    // The diagram lives in a separate sidebar-switchable view; when the
    // user is on the roof-plan tab at export time the DiagramView
    // component is NOT mounted and the querySelector returns null. In
    // that case we skip the capture and SolarPlanDoc suppresses the
    // second page. This is deliberate v1 behavior — we don't force-mount
    // DiagramView off-screen just to capture it, because an unmounted
    // diagram means the user has never visited that tab for this
    // project and has no diagram content worth exporting yet.
    const diagramEl = document.querySelector('[data-diagram-view]') as HTMLElement | null;
    const diagramImage = diagramEl
      ? await captureDiagramView(diagramEl)
      : undefined;

    // ── Build inverter-id → model display name map ───────────────────────
    // Keyed by inverter.id (not model id) so SolarPlanDoc can look up
    // the model name directly from str.inverterId without an extra hop.
    const inverterModelNames: Record<string, string> = {};
    for (const inv of project.inverters) {
      if (inv.inverterModelId) {
        const m = inverterModelCache[inv.inverterModelId];
        if (m) inverterModelNames[inv.id] = `${m.manufacturer} ${m.model}`;
      }
    }

    // ── Pre-resolve all localized strings + numerics ────────────────────
    // SolarPlanDoc is intentionally i18next-free AND Intl-free at render
    // time; we resolve everything here so the doc component stays trivial
    // and locale-aware formatting is applied consistently in one place.
    const totalPanels = project.panels.length;
    const totalKwp = (totalPanels * project.panelType.wattPeak) / 1000;

    // Locale-aware number formatters. Created once per export — not a hot
    // path, but allocating per-cell would be wasteful and inconsistent.
    //   - intCount → grouped integers ("1,234" en / "1.234" de)
    //   - kwpFmt   → 2 fraction digits, useful for the kWp stat
    //   - mppFmt   → 4 fraction digits, scale precision matches the app
    const intCount = new Intl.NumberFormat(i18next.language, {
      maximumFractionDigits: 0,
    });
    const kwpFmt = new Intl.NumberFormat(i18next.language, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const mppFmt = new Intl.NumberFormat(i18next.language, {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    });

    const docStrings = {
      kicker: i18next.t('pdf.kicker'),
      // `dateStyle: 'long'` matches the editorial header tone: e.g.
      // "April 23, 2026" (en) / "23. April 2026" (de).
      date: new Date().toLocaleDateString(i18next.language, { dateStyle: 'long' }),
      metaClient: i18next.t('pdf.metaClient'),
      metaAddress: i18next.t('pdf.metaAddress'),
      notesLabel: i18next.t('pdf.notesLabel'),
      strings: i18next.t('pdf.strings'),
      panelInfo: i18next.t('pdf.panelInfo', {
        name: project.panelType.name,
        w: String(project.panelType.widthM),
        h: String(project.panelType.heightM),
        wp: String(project.panelType.wattPeak),
      }),
      colString: i18next.t('pdf.colString'),
      colColor: i18next.t('pdf.colColor'),
      colPanels: i18next.t('pdf.colPanels'),
      colWp: i18next.t('pdf.colWp'),
      colInverterNum: i18next.t('pdf.colInverterNum'),
      colMpptPort: i18next.t('pdf.colMpptPort'),
      colInverterModel: i18next.t('pdf.colInverterModel'),
      statPanels: i18next.t('pdf.statPanels'),
      statPower: i18next.t('pdf.statPower'),
      statScale: i18next.t('pdf.statScale'),
      unitKwp: i18next.t('pdf.unitKwp'),
      unitMpp: i18next.t('pdf.unitMpp'),
      // Pass through with an unresolved {{z}} placeholder — the doc
      // interpolates the actual zoom number from project.mapState. This
      // avoids carrying yet another numeric prop alongside scaleZoom.
      scaleZoom: i18next.t('pdf.scaleZoom', { z: '{{z}}' }),
    };

    // Coordinates line under the address. Empty when the project has
    // no address (the sub-line collapses in SolarPlanDoc). Format:
    // "48,13710° N · 11,57540° E" — locale-aware decimals (German uses
    // commas), absolute values, hemisphere from sign. 5 fraction digits
    // gives ~1m precision, matching the address granularity a roof plan
    // actually needs.
    const coordFmt = new Intl.NumberFormat(i18next.language, {
      minimumFractionDigits: 5,
      maximumFractionDigits: 5,
    });
    const addr = project.meta?.address;
    const addressCoords = addr
      ? `${coordFmt.format(Math.abs(addr.lat))}° ${addr.lat >= 0 ? 'N' : 'S'} · ${coordFmt.format(Math.abs(addr.lon))}° ${addr.lon >= 0 ? 'E' : 'W'}`
      : '';

    const docStats = {
      panelsCount: intCount.format(totalPanels),
      powerKwp: kwpFmt.format(totalKwp),
      scaleMpp: project.mapState.locked
        ? mppFmt.format(project.mapState.metersPerPixel)
        : '',
      addressCoords,
    };

    // ── Render to blob & trigger download ───────────────────────────────
    const blob = await pdf(
      <SolarPlanDoc
        project={project}
        imageDataUrl={imageDataUrl}
        imageWidthPt={planW}
        imageHeightPt={planH}
        strings={docStrings}
        stats={docStats}
        inverterModelNames={inverterModelNames}
        diagramImage={diagramImage}
      />,
    ).toBlob();

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `solar-plan-${project.name.replace(/[^a-z0-9-_]/gi, '_')}-${dateStamp()}.pdf`;
    a.click();
    // Revoke after a tick so Safari's download flow has time to read the
    // blob URL before it goes away. (Chromium tolerates immediate revoke;
    // Safari occasionally ends up with a 0-byte download otherwise.)
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (err) {
    console.error('PDF export failed', err);
    return false;
  }
}

/**
 * Warm the lazy chunk. Wire this to onMouseEnter / onFocus on the Export
 * button so the renderer + doc are already in memory by the time the user
 * actually clicks. Idempotent — repeat calls hit the module loader's
 * dedupe cache and resolve immediately.
 *
 * Errors are intentionally swallowed: a failed prefetch (offline, network
 * blip) is harmless because the real `exportPdf` call will retry the
 * import and surface the error itself.
 */
export function prefetchPdfExport(): void {
  void import('@react-pdf/renderer');
  void import('../pdf/SolarPlanDoc');
  void import('../pdf/composeStageImage');
}

/** YYYYMMDD for the filename suffix — avoids collisions on same-day
 *  exports while staying short and filesystem-friendly. */
function dateStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** Strings band height: zero when there are no strings (the band JSX
 *  is dropped entirely), otherwise base chrome plus one row height per
 *  string. Notes and customer meta no longer enter into image sizing —
 *  they live in the sidebar where they sit alongside the image. */
function computeTableHeight(project: Project): number {
  if (project.strings.length === 0) return 0;
  return TABLE_BASE_PT + project.strings.length * TABLE_ROW_PT;
}
