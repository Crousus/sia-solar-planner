// ────────────────────────────────────────────────────────────────────────────
// composeStageImage — produces the "drafting paper + Konva overlay" image
// that the PDF embeds.
//
// Why this lives in /src/pdf/ rather than /src/utils/:
//   It is part of the lazy-loaded export chunk. Keeping it co-located with
//   SolarPlanDoc makes the dependency graph for the dynamic `import()` in
//   pdfExport.ts obvious — anything in /src/pdf/ should only ever be
//   reachable via that dynamic boundary, never via a static import from
//   the main bundle. (html2canvas itself is already in the main bundle
//   because Toolbar.lockMap uses it; that import doesn't cost us extra.)
//
// Two-step API (capture → compose) instead of one combined call:
//   - We need the captured canvas's pixel aspect ratio BEFORE composing,
//     because the PDF layout sizes the image in points based on that
//     aspect, and composing's grid cadence in pixels depends on the final
//     printed width in mm — which is only knowable after layout.
//   - Splitting also makes the compose step pure & sync, which keeps the
//     PDF render path tighter (only one async hop, the html2canvas pass).
// ────────────────────────────────────────────────────────────────────────────

import html2canvas from 'html2canvas';
import { stages } from 'konva/lib/Stage';

/**
 * Capture the Konva overlay for PDF embedding.
 *
 * Why NOT html2canvas first: html2canvas 1.4.1 throws
 *   InvalidStateError: createPattern on a canvas with width/height of 0
 * when it walks certain canvas children Konva inserts into the DOM
 * (e.g. layer buffers in transient 0-sized states during a render).
 * Konva's own `stage.toCanvas` renders straight from the scene graph
 * without touching the DOM canvas nodes, so it sidesteps the bug AND
 * gives us crisper output (vector shapes are re-rasterized at the
 * requested pixelRatio rather than bilinear-upscaled from screen
 * pixels).
 *
 * The non-Konva sibling DOM inside `.konva-overlay` (CompassWidget,
 * RotationDock) is intentionally NOT captured — those are interactive
 * chrome, not part of the plan. If we ever need to include additional
 * DOM overlays, composite them separately on top of the shot here.
 *
 * `pixelRatio: 3` matches the legacy jsPDF exporter — vector overlays
 * (roofs, strings, labels, panels) re-paint at 3× DPI for crisp print
 * output; the rasterized satellite background upscales which doesn't
 * add detail but doesn't degrade either. Above 3, file size grows
 * without meaningful visual gain at A4 dimensions.
 *
 * Fallback: if no Konva stage is hosted inside `stageEl` (shouldn't
 * happen in this app, but keeps the function general), we fall back to
 * html2canvas — with `ignoreElements` filtering 0-dim canvases so the
 * above bug doesn't bite the fallback path either.
 */
export async function captureStage(stageEl: HTMLElement): Promise<HTMLCanvasElement> {
  // `stages` is Konva's module-level registry of all live Stage instances.
  // Finding ours by DOM-ancestry avoids passing a Konva ref down through
  // Toolbar / exportPdf just to satisfy this one call site.
  const konvaStage = stages.find((s) => {
    try {
      const c = s.container();
      return !!c && stageEl.contains(c);
    } catch {
      return false;
    }
  });
  if (konvaStage) {
    return konvaStage.toCanvas({ pixelRatio: 3 });
  }
  return html2canvas(stageEl, {
    backgroundColor: null,
    logging: false,
    scale: 3,
    // Guard against the 0-dim-canvas createPattern crash if html2canvas
    // is ever exercised (unlikely — the Konva path above handles this
    // app). Skipping a 0×0 canvas is lossless: a 0-dim element has no
    // content the capture would have shown anyway.
    ignoreElements: (el) =>
      el instanceof HTMLCanvasElement && (el.width === 0 || el.height === 0),
  });
}

/**
 * Composite the captured (transparent) Konva stage onto a warm-gray
 * "drafting paper" canvas with a mm-accurate grid baked in, return the
 * result as a JPEG data URL.
 *
 * Why bake the grid into the raster instead of drawing it as PDF vectors:
 *   In react-pdf (as in jsPDF), drawing thousands of grid lines as vector
 *   strokes blows up the file and slows render. A baked-in grid at 3× DPI
 *   is print-sharp at A4, ships as one ~1-2 MB JPEG, and decouples the
 *   PDF doc layout from the grid math entirely — SolarPlanDoc just embeds
 *   a single Image and never reasons about millimeters.
 *
 * Grid cadence (mm):
 *   - Fine every 5 mm — gives a millimeter reference surface
 *   - Coarse every 25 mm — visual rhythm at a glance
 * Matched to the PDF's printed width via `pxPerMm = canvasPixelsWide / drawWidthMm`.
 */
export function composeWithGrid(shot: HTMLCanvasElement, drawWidthMm: number): string {
  const c = document.createElement('canvas');
  c.width = shot.width;
  c.height = shot.height;
  const ctx = c.getContext('2d');
  if (!ctx) {
    // Degenerate fallback: stamping the bare shot is better than a
    // blank PDF. Real browsers always return a 2D context here; this
    // branch exists only to satisfy the non-null check.
    return shot.toDataURL('image/jpeg', 0.9);
  }

  // Warm-gray base — matches the on-screen `.canvas-bg` "drafting paper"
  // feel but tuned for print: lighter than the dark in-app backdrop,
  // still dark enough that white roof strokes and pale guides retain
  // contrast. Same `#9a9284` the legacy exporter used.
  ctx.fillStyle = '#9a9284';
  ctx.fillRect(0, 0, c.width, c.height);

  const pxPerMm = c.width / drawWidthMm;

  // Fine grid — one shade darker, hairline weight. The `+ 0.5` aligns
  // a 1-device-pixel line crisply on the integer grid instead of being
  // antialiased across two rows.
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

  // Coarse grid — two shades darker, slightly heavier. Gives the page
  // visual rhythm without screaming "frame".
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

  // Captured Konva stage on top. `shot` has a transparent background, so
  // the gray-paper + grid we just drew shows through anywhere the
  // satellite raster + roof fills don't cover.
  ctx.drawImage(shot, 0, 0);

  // JPEG 0.9: visually indistinguishable from source on A4 print, ~1/5
  // the PNG size. Below ~0.8, roof outlines and label text develop
  // block artifacts against large flat fills.
  return c.toDataURL('image/jpeg', 0.9);
}
