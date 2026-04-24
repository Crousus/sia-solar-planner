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
 * RotationDock) is structurally excluded from this capture: `toCanvas`
 * renders only Konva's internal scene graph, which contains no HTML
 * nodes. A replacement compass is drawn directly onto the composed
 * canvas in `composeWithGrid` using the rotation returned here.
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
export async function captureStage(stageEl: HTMLElement): Promise<{
  canvas: HTMLCanvasElement;
  stageRotation: number;
}> {
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
    return {
      canvas: konvaStage.toCanvas({ pixelRatio: 3 }),
      // rotation() returns the stage's current rotation in degrees — used
      // by composeWithGrid to orient the export compass correctly.
      stageRotation: konvaStage.rotation(),
    };
  }
  return {
    canvas: await html2canvas(stageEl, {
      backgroundColor: null,
      logging: false,
      scale: 3,
      // Guard against the 0-dim-canvas createPattern crash if html2canvas
      // is ever exercised (unlikely — the Konva path above handles this
      // app). Skipping a 0×0 canvas is lossless: a 0-dim element has no
      // content the capture would have shown anyway.
      ignoreElements: (el) =>
        el instanceof HTMLCanvasElement && (el.width === 0 || el.height === 0),
    }),
    stageRotation: 0,
  };
}

/**
 * Capture the DiagramView DOM element for PDF embedding.
 *
 * Why a separate function from captureStage:
 *   - captureStage captures a Konva scene graph (vector) via
 *     `stage.toCanvas` for crisp pixelRatio 3× output. The block
 *     diagram is plain HTML/CSS (the A4 div identified by
 *     `data-diagram-view`), so html2canvas is the right tool here.
 *   - The diagram has no mm-scale grid to bake in and no rotating
 *     compass, so there's no compose step — the captured PNG is the
 *     final page image. Returning a dataURL keeps the call site
 *     symmetric with `composeWithGrid`.
 *
 * Dimensions (1122 × 794 px) match the A4 landscape container set by
 * DiagramView. `scale: 1` is deliberate: the diagram is pure vector/CSS
 * rendered at this exact size, so upscaling adds file size without
 * adding detail — html2canvas doesn't re-rasterize CSS at higher DPI,
 * it bilinear-upscales the screenshot.
 *
 * `ignoreElements` guards against html2canvas 1.4.1's
 * `createPattern on a canvas with width/height of 0` crash (same bug
 * documented in `captureStage` — some rendering libraries briefly
 * have 0-sized canvas children mid-layout).
 */
export async function captureDiagramView(el: HTMLElement): Promise<string> {
  const canvas = await html2canvas(el, {
    useCORS: true,
    scale: 1,
    width: 1122,
    height: 794,
    ignoreElements: (e) => e.tagName === 'CANVAS' && (e as HTMLCanvasElement).width === 0,
  });
  return canvas.toDataURL('image/png');
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
 *
 * `stageRotation` (degrees) is forwarded from the Konva stage so the
 * export compass indicates the correct north bearing in the image.
 */
export function composeWithGrid(shot: HTMLCanvasElement, drawWidthMm: number, stageRotation: number): string {
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

  // Export compass — drawn last so it sits above everything else. The
  // interactive CompassWidget/RotationDock are HTML DOM siblings of the
  // Konva stage and are never included in the canvas capture above, so
  // this is the only compass the exported image has.
  drawExportCompass(ctx, c.width, drawWidthMm, stageRotation);

  // JPEG 0.9: visually indistinguishable from source on A4 print, ~1/5
  // the PNG size. Below ~0.8, roof outlines and label text develop
  // block artifacts against large flat fills.
  return c.toDataURL('image/jpeg', 0.9);
}

/**
 * Draw a minimal print-compass onto the composed canvas.
 *
 * Design choices vs the interactive CompassWidget:
 *   - Diamond needle only (no tick ring, no cardinal ring), keeps it
 *     unobtrusive at print scale.
 *   - Single 'N' label inside the disc, no E/S/W — a bearing reference,
 *     not a full rose.
 *   - Sized in mm so the printed diameter is the same regardless of the
 *     zoom level the user had when they exported.
 *   - Placed top-right to match the editor widget's position, so the
 *     user's eye already knows where to look.
 *
 * `stageRotation` is the Konva stage rotation in degrees. When non-zero
 * the satellite imagery in the captured canvas is rotated, so north in
 * the image points `stageRotation` degrees clockwise from image-up. The
 * needle is rotated by the same amount so it correctly indicates north.
 */
function drawExportCompass(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  drawWidthMm: number,
  stageRotation: number,
): void {
  const pxPerMm = canvasW / drawWidthMm;
  // 8 mm radius → 16 mm printed diameter, readable on A4 without dominating.
  const r = 8 * pxPerMm;
  // 12 mm from each edge keeps the disc fully inside the canvas at any rotation.
  const margin = 12 * pxPerMm;
  const cx = canvasW - margin;
  const cy = margin;

  const rotRad = (stageRotation * Math.PI) / 180;

  ctx.save();

  // Dark semi-transparent background disc, slightly larger than the needle.
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.25, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(10, 8, 4, 0.72)';
  ctx.fill();
  // Hairline amber-tinted bezel ring.
  ctx.strokeStyle = 'rgba(255, 228, 185, 0.28)';
  ctx.lineWidth = Math.max(1, pxPerMm * 0.4);
  ctx.stroke();

  // Rotate around the compass center to orient the needle.
  ctx.translate(cx, cy);
  ctx.rotate(rotRad);

  // Diamond needle — same geometry as CompassWidget.tsx but drawn with
  // Canvas 2D instead of SVG paths. The waist point (ws) sits slightly
  // above center so north and south halves share the same widest points
  // without a flat edge where they meet.
  const hw = r * 0.22;   // half-width at the widest point (y=0)
  const nt = -(r * 0.72); // north tip
  const st = r * 0.72;    // south tip
  const ws = -(r * 0.11); // waist y — the shared inner vertex

  // North half (amber)
  ctx.beginPath();
  ctx.moveTo(0, nt);
  ctx.lineTo(hw, 0);
  ctx.lineTo(0, ws);
  ctx.lineTo(-hw, 0);
  ctx.closePath();
  ctx.fillStyle = '#f5b544';
  ctx.fill();

  // South half (muted warm gray)
  ctx.beginPath();
  ctx.moveTo(0, st);
  ctx.lineTo(hw, 0);
  ctx.lineTo(0, ws);
  ctx.lineTo(-hw, 0);
  ctx.closePath();
  ctx.fillStyle = '#6c6557';
  ctx.fill();

  // Glowing pivot dot
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.13, 0, Math.PI * 2);
  ctx.fillStyle = '#fff4d6';
  ctx.fill();

  ctx.restore();

  // 'N' label — placed just beyond the needle tip in the north direction,
  // inside the dark disc so it always has contrast. Coordinates are in
  // the unrotated canvas frame, derived by converting (0, -0.86r) from
  // the rotated needle frame to screen space.
  const lx = cx + Math.sin(rotRad) * r * 0.86;
  const ly = cy - Math.cos(rotRad) * r * 0.86;
  const fontSize = Math.max(9, r * 0.5);
  ctx.save();
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f5b544';
  ctx.fillText('N', lx, ly);
  ctx.restore();
}
