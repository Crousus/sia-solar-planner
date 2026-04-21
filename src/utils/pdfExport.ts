// ────────────────────────────────────────────────────────────────────────────
// PDF export — DIN A4 landscape. Layout (post-redesign):
//
//   ┌───────────────────────────────────────────────────────────────┐
//   │ Header: project name …………………………………………………………… date           │
//   ├───────────────────────────────────────────────────────────────┤
//   │                                                               │
//   │                    Plan image (full width)                    │
//   │                 aspect-fit, centered horizontally             │
//   │                                                               │
//   ├───────────────────────────────────────────────────────────────┤
//   │ Strings                                                       │
//   │ [String | Clr | Panels | Wp | Inv]  ×  1-3 sub-columns        │
//   ├───────────────────────────────────────────────────────────────┤
//   │ Total: N panels · X kWp  |  Panel: …  |  Scale: …             │
//   └───────────────────────────────────────────────────────────────┘
//
// Why this shape:
//   Roof overhead imagery is almost always landscape, and A4 landscape is
//   too — so the image gets to use the full page width and dominates the
//   sheet. The strings table goes below where A4's leftover vertical band
//   lives, not to the right where it was squeezing the plan into 60% of
//   the page. When strings don't fit in one column, we split into 2 or 3
//   side-by-side sub-columns (same as newspaper columnization) before
//   paginating — this keeps the whole plan on a single sheet for typical
//   project sizes.
//
// Approach (post-ADR-007):
//   Since lock captures the satellite view and Konva now owns the full
//   scene (background image + roofs + panels + strings), one html2canvas
//   pass on the overlay container grabs everything already composited at
//   the user's current zoom/pan. No separate map+overlay compositing.
//
// Why not `stage.toDataURL()` directly? That would require plumbing the
// Konva Stage ref all the way here. html2canvas over the .konva-overlay
// DOM node is effectively the same output (Konva paints to real
// <canvas> elements, html2canvas just reads them) with no prop-drilling.
//
// Tile CORS is no longer a concern for export — the tiles were already
// rasterized at lock time into a same-origin PNG, so re-capture can't
// taint the canvas.
// ────────────────────────────────────────────────────────────────────────────

import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import type { Project, PvString } from '../types';

/**
 * Top-level export. Returns a boolean so callers can show a failure toast.
 * Any thrown error is logged to console for debugging.
 */
export async function exportPdf(project: Project): Promise<boolean> {
  try {
    // The overlay container holds every Konva <canvas> (background image,
    // roofs, panels, strings, labels — all layers). html2canvas walks
    // the DOM and paints it all into a single output canvas in one go.
    const stageEl = document.querySelector('.konva-overlay') as HTMLElement | null;
    if (!stageEl) {
      console.error('Konva overlay not found — is the map locked?');
      return false;
    }

    const W = stageEl.clientWidth;
    const H = stageEl.clientHeight;
    // Capture the Konva stage with a TRANSPARENT background so the PDF's
    // own vector-drawn backdrop (warm gray + grid, see drawPlanBackground
    // below) shows through any area the captured raster doesn't cover.
    // The screen-side app uses a dark textured backdrop (`.canvas-bg` in
    // index.css), but printing that burns toner on large flat areas and
    // photocopies badly — so we substitute a light "drafting paper" look
    // in the PDF only. The in-app rendering is untouched.
    //
    // Why draw the grid as PDF vectors instead of stamping it into the
    // html2canvas output: vectors stay crisp at any print size, keep the
    // output file small, and let us match mm-accurate grid spacing (5 mm
    // fine / 25 mm coarse) to the page coordinate system directly.
    //
    // `scale: EXPORT_SCALE` multiplies html2canvas's rendering DPI above
    // the default (window.devicePixelRatio). Konva overlays (roofs,
    // strings, labels, panels) are vector shapes and re-paint at this
    // higher DPI with crisp edges; the rasterized satellite background
    // is bilinearly upscaled, which doesn't ADD detail but also doesn't
    // degrade — large roofs in the viewport now print with significantly
    // sharper line/label work. We keep the capture bounded to the
    // current viewport (no fit-to-content reframe) so what the user sees
    // on screen is what they get on paper, just higher-fidelity.
    //
    // Cost: PNG embedded in the PDF grows roughly EXPORT_SCALE²; capture
    // takes ~EXPORT_SCALE² as long. 3 is the sweet spot for A4 — clearly
    // sharper than 2, while 4 pushes file size past ~10 MB with little
    // visible gain at A4's physical dimensions.
    const EXPORT_SCALE = 3;
    const shot = await html2canvas(stageEl, {
      backgroundColor: null,
      logging: false,
      scale: EXPORT_SCALE,
    });
    // Note: we don't encode `shot` yet — we need the PDF layout math
    // (specifically `drawW` in mm) before we can composite a grid at
    // real millimeter spacing. The encode happens after layout below.

    // ── PDF layout (DIN A4 landscape: 297 × 210 mm) ────────────────────
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 8;
    const headerH = 14;
    const contentY = margin + headerH;
    const contentH = pageH - contentY - margin;
    const fullW = pageW - margin * 2;

    // Row height for data rows (mm). 4.5 is tight but readable at 8pt — the
    // difference between 4.5 and 5 lets us pack ~10% more rows per column.
    const rowHeight = 4.5;

    // Vertical space reserved at the very bottom for the one-line totals
    // strip (panels + kWp + panel type + scale). 12 mm covers a single
    // text line + a separator stroke above it with some padding.
    const totalsStripH = 12;

    // Floor for the plan image's vertical extent. Even with many strings,
    // we don't want the image squeezed below this — the image is the
    // primary content of the sheet. When strings demand more table room
    // than this floor allows, we cap page-1 rows-per-col at whatever fits
    // and spill the rest onto page 2. 90 mm is roughly half the content
    // band, so the image still clearly dominates visually.
    const minImageH = 90;

    // Soft rows-per-column target. We prefer to "break" into a new column
    // after this many strings rather than stacking more vertically — that
    // keeps the table short and wide, leaving more vertical room for the
    // image above it. Feels right for typical residential projects
    // (2-9 strings fit in a 1-3 row strip).
    const softRowsPerCol = 3;

    // Caption + per-col-header overhead (mm): 8 mm for the "Strings"
    // caption above + 5 mm for the column-header row + separator + a
    // little padding. Used both when sizing the image and when rendering.
    const tableChromeH = 8 + 5 + 1;

    /**
     * Composite the captured (transparent) Konva stage onto a warm-gray
     * "drafting paper" canvas with a mm-accurate grid baked in, and
     * return the result as a JPEG data URL.
     *
     * Why composite into the raster instead of drawing the grid as PDF
     * vectors under a transparent image:
     *   WebP through jsPDF silently discards the alpha channel (verified
     *   empirically — transparent regions and even translucent fills get
     *   flattened to black), and PNG with alpha embeds at 5-10× the file
     *   size of JPEG. Baking the grid into the raster lets us use JPEG
     *   cleanly: no alpha concerns, much smaller file, identical visual
     *   result. We lose the "infinitely crisp vector grid at any zoom"
     *   property, but at EXPORT_SCALE=3 the grid is rendered at ~225 DPI
     *   on A4 — print-sharp for any realistic viewing.
     *
     * Grid cadence (mm):
     *   - Fine every 5 mm — gives a millimeter reference surface
     *   - Coarse every 25 mm — visual rhythm at a glance
     * Matched to the PDF's mm coordinate system via `pxPerMm`, computed
     * from the final drawW (image width on paper) and the composite
     * canvas width in pixels.
     */
    const composePlanJpeg = (drawWmm: number): string => {
      const c = document.createElement('canvas');
      c.width = shot.width;
      c.height = shot.height;
      const ctx = c.getContext('2d');
      if (!ctx) {
        // Degenerate fallback: stamping gray is better than a blank PDF.
        // Real browsers always return a 2D context here; this branch
        // exists only to satisfy the non-null check.
        return shot.toDataURL('image/jpeg', 0.9);
      }

      // Warm-gray base — matches the `.canvas-bg` "drafting paper" feel
      // but tuned for print: lighter than the on-screen backdrop, still
      // dark enough that white roof strokes and pale amber/cyan guides
      // retain contrast. Same #9a9284 we used as the flat fallback.
      ctx.fillStyle = '#9a9284';
      ctx.fillRect(0, 0, c.width, c.height);

      // How many raster pixels equal one printed millimeter. The PDF
      // draws this canvas at `drawWmm` millimeters wide, so:
      //    pxPerMm = canvasPixelsWide / drawWmm
      const pxPerMm = c.width / drawWmm;

      // Fine grid — one shade darker than the base, hairline weight.
      // Using 0.5-pixel stroke alignment (`+ 0.5`) keeps the 1-device-
      // pixel line crisp instead of antialiased across two rows.
      ctx.strokeStyle = '#8a8378';
      ctx.lineWidth = 1;
      const fineStepPx = 5 * pxPerMm;
      for (let gx = 0; gx <= c.width; gx += fineStepPx) {
        ctx.beginPath();
        ctx.moveTo(Math.round(gx) + 0.5, 0);
        ctx.lineTo(Math.round(gx) + 0.5, c.height);
        ctx.stroke();
      }
      for (let gy = 0; gy <= c.height; gy += fineStepPx) {
        ctx.beginPath();
        ctx.moveTo(0, Math.round(gy) + 0.5);
        ctx.lineTo(c.width, Math.round(gy) + 0.5);
        ctx.stroke();
      }

      // Coarse grid — two shades darker, slightly heavier. Visual rhythm
      // without shouting "frame".
      ctx.strokeStyle = '#6c6557';
      ctx.lineWidth = 2;
      const coarseStepPx = 25 * pxPerMm;
      for (let gx = 0; gx <= c.width; gx += coarseStepPx) {
        ctx.beginPath();
        ctx.moveTo(Math.round(gx) + 0.5, 0);
        ctx.lineTo(Math.round(gx) + 0.5, c.height);
        ctx.stroke();
      }
      for (let gy = 0; gy <= c.height; gy += coarseStepPx) {
        ctx.beginPath();
        ctx.moveTo(0, Math.round(gy) + 0.5);
        ctx.lineTo(c.width, Math.round(gy) + 0.5);
        ctx.stroke();
      }

      // Captured Konva stage on top — `shot` has transparent background,
      // so the grid shows through anywhere the satellite raster + roof
      // fills don't cover.
      ctx.drawImage(shot, 0, 0);

      // JPEG 0.9: indistinguishable from source on typical A4 print,
      // roughly 1/5 the PNG size. Below ~0.8, roof outlines and label
      // text start showing block artifacts against large flat roof
      // fills.
      return c.toDataURL('image/jpeg', 0.9);
    };

    /**
     * Draw the page-wide header bar (project name + date).
     * Called at the top of every page so each sheet is self-identifying.
     */
    const drawPageHeader = () => {
      pdf.setFontSize(14);
      pdf.setFont('helvetica', 'bold');
      pdf.text(`Solar Plan — ${project.name}`, margin, margin + 5);
      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'normal');
      pdf.text(new Date().toLocaleDateString(), pageW - margin, margin + 5, { align: 'right' });
    };

    // Inverter name lookup — used per-row; precompute once to avoid O(S·I)
    // scans in the hot row-render loop.
    const inverterById = new Map(project.inverters.map((i) => [i.id, i.name]));

    // ── Sub-column geometry ───────────────────────────────────────────
    // Offsets measured in mm from each sub-column's left edge. Sized to
    // fit comfortably even at 3-column layout (~93 mm per sub-column).
    // At 1-column layout (full 281 mm), the rightmost "Inverter" field
    // just gets more breathing room — same offsets still look fine.
    //
    // Rough widths:
    //   String label  : 20 mm  (fits "String 12" at 8pt)
    //   Color swatch  :  6 mm  (4×4 filled square + padding)
    //   Panels count  : 14 mm  (1-3 digit count)
    //   Wp per string : 16 mm  (up to ~99999)
    //   Inverter name : remainder (truncation-free at 1-col, tight at 3-col)
    const subColOffsets = { str: 0, color: 22, panels: 30, wp: 46, inv: 62 } as const;

    /**
     * Render a single row of the strings table into a given sub-column.
     * `originX` is the left edge of the sub-column; offsets are added on
     * top so the same logic works regardless of column count.
     */
    const drawRow = (originX: number, y: number, str: PvString) => {
      const count = project.panels.filter((p) => p.stringId === str.id).length;
      const wp = count * project.panelType.wattPeak;
      const invName = str.inverterId ? inverterById.get(str.inverterId) || '?' : '—';
      pdf.text(str.label, originX + subColOffsets.str, y);
      // Color swatch — small filled rect matching the string's UI color,
      // drawn slightly above the text baseline so it visually aligns with
      // the row rather than sitting on the next line.
      const rgb = hexToRgb(str.color);
      pdf.setFillColor(rgb.r, rgb.g, rgb.b);
      pdf.rect(originX + subColOffsets.color, y - 3, 4, 4, 'F');
      pdf.text(String(count), originX + subColOffsets.panels, y);
      pdf.text(wp.toString(), originX + subColOffsets.wp, y);
      pdf.text(invName, originX + subColOffsets.inv, y);
    };

    /**
     * Draw the per-sub-column header row (the "String | Clr | Panels …"
     * line + separator). Returns y for the first data row.
     */
    const drawColumnHeader = (originX: number, colW: number, y: number): number => {
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'bold');
      pdf.text('String', originX + subColOffsets.str, y);
      pdf.text('Clr', originX + subColOffsets.color, y);
      pdf.text('Panels', originX + subColOffsets.panels, y);
      pdf.text('Wp', originX + subColOffsets.wp, y);
      pdf.text('Inverter', originX + subColOffsets.inv, y);
      const lineY = y + 1.5;
      pdf.setDrawColor(120);
      pdf.line(originX, lineY, originX + colW - 2, lineY);
      pdf.setFont('helvetica', 'normal');
      return lineY + 3.5;
    };

    /**
     * Decide the shape (numCols × rowsPerCol) of the strings table for
     * a page that has `availH` mm of vertical room between the caption's
     * top and the bottom of the table band. We prefer short tables:
     *
     *   - break to a new column after `softRowsPerCol` rows rather than
     *     stacking more vertically (keeps the image up top bigger),
     *   - but if even 3 columns × softRows can't fit `remaining`, we
     *     grow rowsPerCol up to whatever fits in availH — overflow then
     *     spills onto the next page.
     *
     * `availH` is only the rows area (caller has already subtracted
     * tableChromeH). Returns how many strings this page can render plus
     * the chosen shape.
     */
    const pickTableShape = (
      remaining: number,
      availH: number
    ): { numCols: 1 | 2 | 3; rowsPerCol: number; capacity: number } => {
      const maxRowsByHeight = Math.max(1, Math.floor(availH / rowHeight));

      // First try the "nice" shape: ceil(remaining / cols) ≤ softRowsPerCol.
      let numCols: 1 | 2 | 3;
      if (remaining <= softRowsPerCol) numCols = 1;
      else if (remaining <= softRowsPerCol * 2) numCols = 2;
      else numCols = 3;

      let rowsPerCol = Math.max(1, Math.ceil(remaining / numCols));
      // If the nice shape doesn't fit vertically, the page is height-
      // constrained — pack as many rows as the page allows (still 3 cols
      // since we've already maxed numCols) and let the caller paginate.
      if (rowsPerCol > maxRowsByHeight) {
        numCols = 3;
        rowsPerCol = maxRowsByHeight;
      }
      return { numCols, rowsPerCol, capacity: numCols * rowsPerCol };
    };

    /**
     * Render a block of strings into a multi-column table using a
     * pre-computed shape. Starts at `startY`, fills rows top-down in
     * each sub-column then left-to-right (newspaper-style). Returns the
     * next string index to draw so the caller can decide on pagination.
     */
    const renderStringTable = (
      startY: number,
      startIndex: number,
      numCols: number,
      rowsPerCol: number
    ): number => {
      // Caption spans full width so the reader sees "Strings" as one
      // heading, not three. Drawn once per page.
      pdf.setFontSize(11);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Strings', margin, startY + 4);
      const rowsHeaderY = startY + 8;

      const colW = fullW / numCols;
      const capacity = numCols * rowsPerCol;
      const endIndex = Math.min(project.strings.length, startIndex + capacity);

      // Track the tallest column's final y so the vertical dividers
      // between big columns span the actual occupied rows — not a fixed
      // rowsPerCol worth of height, which would draw past the data in a
      // last-column-not-full case (e.g. 7 strings in 3 cols → 3,3,1).
      let maxColBottomY = rowsHeaderY;

      for (let c = 0; c < numCols; c++) {
        const originX = margin + c * colW;
        let y = drawColumnHeader(originX, colW, rowsHeaderY);
        const base = startIndex + c * rowsPerCol;
        for (let i = 0; i < rowsPerCol && base + i < endIndex; i++) {
          drawRow(originX, y, project.strings[base + i]);
          y += rowHeight;
        }
        if (y > maxColBottomY) maxColBottomY = y;
      }

      // Vertical dividers between big columns. Drawn after the rows so
      // they sit on top of (though functionally beside) the content, and
      // span from just below the caption down through the last row of
      // the tallest column. Light gray to match the horizontal separator
      // under each column header — it reads as part of the table chrome,
      // not a heavy structural line.
      if (numCols > 1) {
        pdf.setDrawColor(180);
        for (let c = 1; c < numCols; c++) {
          const x = margin + c * colW - 2; // small inset so the divider
                                           // nestles into the gutter
                                           // rather than clipping text
          pdf.line(x, rowsHeaderY - 1, x, maxColBottomY - rowHeight + 2);
        }
      }
      return endIndex;
    };

    /**
     * One-line totals strip across the bottom of the last page. Three
     * cells laid out left / center / right — denser than the previous
     * three-line stack, which was wasting vertical space under the table.
     */
    const drawTotalsStrip = () => {
      const stripTopY = pageH - margin - totalsStripH;
      // Separator above — makes the strip read as a footer, distinct from
      // the last row of the table above it.
      pdf.setDrawColor(120);
      pdf.line(margin, stripTopY + 2, pageW - margin, stripTopY + 2);

      const textY = stripTopY + 7;
      const totalPanels = project.panels.length;
      const totalKwp = (totalPanels * project.panelType.wattPeak) / 1000;

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.text(
        `Total: ${totalPanels} panels · ${totalKwp.toFixed(2)} kWp`,
        margin,
        textY
      );

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      const panelInfo = `Panel: ${project.panelType.name} · ${project.panelType.widthM}×${project.panelType.heightM} m · ${project.panelType.wattPeak} Wp`;
      pdf.text(panelInfo, pageW / 2, textY, { align: 'center' });

      if (project.mapState.locked) {
        pdf.text(
          `Scale: ${project.mapState.metersPerPixel.toFixed(4)} m/px @ zoom ${project.mapState.zoom}`,
          pageW - margin,
          textY,
          { align: 'right' }
        );
      }
    };

    // ── Page 1: header + plan (top, full width) + table below ─────────
    drawPageHeader();

    // ---- Pre-size the table so the image can claim the leftover space.
    //
    // Strategy: pick the table shape FIRST (using the soft break-at-3
    // rule), compute how tall that band actually needs to be, and give
    // the rest of the content area to the image. This is the fix for
    // "table takes too much space when there are few strings" — e.g.
    // with 3 strings we use a single column × 3 rows and the image gets
    // ~140 mm of vertical room instead of a fixed 90 mm slab.
    //
    // The image's floor is `minImageH`, so with many strings we cap
    // page-1 rows-per-col at whatever still leaves that floor and let
    // overflow rows spill onto page 2.
    const gapBelowImage = 4; // breathing room between image and caption
    const maxTableBandH = contentH - minImageH - totalsStripH - gapBelowImage;
    const maxRowsPage1 = Math.max(
      1,
      Math.floor((maxTableBandH - tableChromeH) / rowHeight)
    );
    const page1Shape =
      project.strings.length === 0
        // Zero-strings edge case: no table at all, image gets the whole
        // band above the totals strip.
        ? { numCols: 1 as const, rowsPerCol: 0, capacity: 0 }
        : pickTableShape(
            project.strings.length,
            maxRowsPage1 * rowHeight
          );

    // Actual vertical band this table will occupy (0 when no strings).
    const tableBandH =
      page1Shape.rowsPerCol === 0
        ? 0
        : tableChromeH + page1Shape.rowsPerCol * rowHeight;

    // Plan image: full content width, aspect-preserved. Height is bounded
    // by whatever the table (and totals strip + gap) leaves behind.
    const planAreaH =
      contentH - tableBandH - totalsStripH - (tableBandH > 0 ? gapBelowImage : 0);
    const aspect = W / H;
    let drawW = fullW;
    let drawH = fullW / aspect;
    if (drawH > planAreaH) {
      drawH = planAreaH;
      drawW = planAreaH * aspect;
    }
    const planX = margin + (fullW - drawW) / 2;
    // Center the image vertically in its band so a very-landscape capture
    // doesn't hug the top of the page with a big empty gap below.
    const planY = contentY + (planAreaH - drawH) / 2;
    // The grid and gray backdrop are baked into the JPEG by composePlanJpeg
    // (mm-accurate via the final drawW), so we can draw the image alone
    // and just stroke a border on top for visual closure.
    const planDataUrl = composePlanJpeg(drawW);
    pdf.addImage(planDataUrl, 'JPEG', planX, planY, drawW, drawH);
    pdf.setDrawColor(180);
    pdf.setLineWidth(0.2);
    pdf.rect(planX, planY, drawW, drawH);

    // Strings table sits directly under the plan area. Even if the image
    // was centered within a taller band (rare — only when aspect very
    // wide), the table starts at the bottom of the reserved band so it
    // stays aligned with the totals strip.
    let nextIdx = 0;
    if (page1Shape.rowsPerCol > 0) {
      const tableTopY = contentY + planAreaH + gapBelowImage;
      nextIdx = renderStringTable(
        tableTopY,
        0,
        page1Shape.numCols,
        page1Shape.rowsPerCol
      );
    }

    // Overflow pages — entirely table, full content area. Each page
    // re-runs pickTableShape against the remaining strings so a few
    // leftover rows don't get spread across 3 narrow columns.
    while (nextIdx < project.strings.length) {
      pdf.addPage();
      drawPageHeader();
      const remaining = project.strings.length - nextIdx;
      const availRowsH = contentH - tableChromeH - totalsStripH - 2;
      const shape = pickTableShape(remaining, availRowsH);
      nextIdx = renderStringTable(
        contentY,
        nextIdx,
        shape.numCols,
        shape.rowsPerCol
      );
    }

    // Totals always appear on whatever the final page turned out to be.
    drawTotalsStrip();

    const filename = `solar-plan-${project.name.replace(/[^a-z0-9-_]/gi, '_')}-${dateStamp()}.pdf`;
    pdf.save(filename);
    return true;
  } catch (err) {
    console.error('PDF export failed', err);
    return false;
  }
}

/** Parse #RRGGBB → {r, g, b} for jsPDF's setFillColor. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return { r, g, b };
}

/** YYYYMMDD for the filename suffix — avoids collisions on same-day exports
 *  while staying short and filesystem-friendly. */
function dateStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
