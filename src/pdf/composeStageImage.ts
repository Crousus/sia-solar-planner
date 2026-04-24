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
 * One text run inside the captured diagram. All coordinates and sizes are
 * in diagram pixels (the 1122×794 capture frame, top-left origin). The PDF
 * layout rescales these to points when overlaying the text on the embedded
 * image. Styling is flattened to what react-pdf can render: the browser's
 * full computed style is lossy here (no gradients, no custom fonts beyond
 * the Helvetica/Courier mapping) but what survives is enough to reproduce
 * the designer's look.
 */
export interface DiagramTextRun {
  /** Visible text content — already upper-cased when the source style
   *  uses `text-transform: uppercase`, since react-pdf renders literals
   *  without the CSS text-transform pipeline. */
  text: string;
  /** Top-left of the element's bounding box in diagram px. */
  x: number;
  y: number;
  /** Bounding box size in diagram px. Width is set on the PDF Text so
   *  text-align works; height is kept so the overlay roughly matches the
   *  original line box when fonts have slightly different metrics. */
  width: number;
  height: number;
  /** Computed font size in diagram px. Scaled to points at render time. */
  fontSize: number;
  /** 'sans' → Helvetica, 'mono' → Courier (the built-in react-pdf fonts
   *  we're mapping to; Geist and JetBrains Mono don't ship with the PDF). */
  fontFamily: 'sans' | 'mono';
  /** Whether to use the bold face variant. We only have normal/bold,
   *  not 500/600/800 — so this collapses all heavy weights to one. */
  bold: boolean;
  /** Computed color as a CSS color string, passed straight to react-pdf. */
  color: string;
  /** 'left' | 'center' | 'right' | 'justify' — from computed textAlign. */
  textAlign: 'left' | 'center' | 'right' | 'justify';
  /** Letter-spacing in diagram px. Scaled to points at render time. */
  letterSpacing: number;
}

/**
 * Walk the diagram DOM and extract each leaf text element's position and
 * style. We need the bounding rects measured in the SAME render state that
 * produces the capture — i.e. with `[data-pdf-export]` applied — so call
 * this after the theme attribute is set but before hiding the text.
 *
 * Criteria for "leaf text element":
 *   - has at least one direct text-node child whose content is non-empty
 *   - has NO element children (we skip mixed-content nodes like inline
 *     icons next to labels, because positioning only the text half is
 *     fiddly and no element in the diagram relies on that pattern today)
 *   - has a non-zero bounding rect (collapsed/display:none elements are
 *     implicitly excluded by the width/height check)
 *
 * This heuristic cleanly picks up: the title strip heading, the project
 * name, every node type label, every node body label, every node sublabel,
 * and every meta-table cell (label + readonly value + input placeholder).
 * It deliberately skips icon swatches (their SVG child is an element, so
 * the container's children are element-typed) so icons remain baked into
 * the image rather than being re-emitted as text.
 */
function collectDiagramTexts(root: HTMLElement): Array<DiagramTextRun & { el: HTMLElement }> {
  const rootRect = root.getBoundingClientRect();
  const out: Array<DiagramTextRun & { el: HTMLElement }> = [];

  // React Flow applies a CSS transform (translate + scale) to its
  // `.react-flow__viewport` element for pan / zoom / fitView. For nodes
  // living inside that viewport, `getComputedStyle().fontSize` returns
  // the *unscaled* CSS value (e.g. 13px) while `getBoundingClientRect()`
  // returns the *scaled* layout rect. That mismatch is what makes PDF
  // text come out too small: we'd position nodes correctly (scaled
  // rects) but size their text from the unscaled fontSize.
  //
  // We read the viewport's scale factor once from its transform matrix
  // and apply it to fontSize + letterSpacing for any element that's a
  // descendant of the viewport. Elements outside the viewport (the title
  // strip and meta table live on the A4 sheet, not inside React Flow)
  // stay at their natural CSS size.
  const viewportEl = root.querySelector('.react-flow__viewport') as HTMLElement | null;
  let viewportScale = 1;
  if (viewportEl) {
    const tf = window.getComputedStyle(viewportEl).transform;
    // `matrix(a, b, c, d, tx, ty)` — for a scale+translate transform
    // a === d === scale. `matrix3d` is used by some browsers for
    // identical results in 2D; we handle both.
    const m2d = tf.match(/matrix\(([-0-9.,\se+]+)\)/);
    const m3d = tf.match(/matrix3d\(([-0-9.,\se+]+)\)/);
    if (m2d) {
      const vals = m2d[1].split(',').map((s) => parseFloat(s.trim()));
      if (vals.length >= 4 && !isNaN(vals[0])) viewportScale = vals[0];
    } else if (m3d) {
      const vals = m3d[1].split(',').map((s) => parseFloat(s.trim()));
      // matrix3d scale-x lives in vals[0] for 2D scale-only transforms.
      if (vals.length >= 1 && !isNaN(vals[0])) viewportScale = vals[0];
    }
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    const el = node as HTMLElement;
    node = walker.nextNode();

    // Skip input elements for their *default* capture path — we read
    // their `.value` instead of textContent because inputs render their
    // value rather than a text node.
    const isInput = el.tagName === 'INPUT';
    // An element counts as a text leaf if it has at least one direct text
    // child AND no element children. Inputs are handled explicitly below.
    if (!isInput) {
      const childNodes = Array.from(el.childNodes);
      const hasElementChild = childNodes.some((c) => c.nodeType === Node.ELEMENT_NODE);
      if (hasElementChild) continue;
      const directText = childNodes
        .filter((c) => c.nodeType === Node.TEXT_NODE)
        .map((c) => c.textContent ?? '')
        .join('');
      if (directText.trim() === '') continue;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const cs = window.getComputedStyle(el);
    // Skip elements that are fully transparent or display:none — no
    // contribution to the printed output.
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) {
      continue;
    }

    // Raw value: input.value when it's a form field, otherwise the
    // element's direct text (collapsed whitespace). Empty inputs produce
    // no overlay — we don't want blank placeholders on paper.
    let raw = isInput ? (el as HTMLInputElement).value : el.textContent ?? '';
    raw = raw.replace(/\s+/g, ' ').trim();
    if (raw === '') continue;

    // Apply CSS text-transform at extraction time. react-pdf doesn't run
    // the transform pipeline, so we bake the uppercased form into the
    // string. 'capitalize' and 'lowercase' are handled too for
    // completeness even though the diagram only uses 'uppercase'.
    const tt = cs.textTransform;
    if (tt === 'uppercase') raw = raw.toUpperCase();
    else if (tt === 'lowercase') raw = raw.toLowerCase();
    else if (tt === 'capitalize') raw = raw.replace(/\b\w/g, (m) => m.toUpperCase());

    // Coarse font-family mapping — the diagram uses Geist (sans) and
    // JetBrains Mono (mono). react-pdf's built-in fonts are Helvetica
    // (sans) and Courier (mono). Anything else — including system fonts
    // from the computed style — falls back to sans.
    const ff = cs.fontFamily.toLowerCase();
    const fontFamily: 'sans' | 'mono' =
      ff.includes('mono') || ff.includes('courier') ? 'mono' : 'sans';

    // Font-weight: anything ≥ 600 (or named "bold") we render bold.
    const fwRaw = cs.fontWeight;
    const fw = fwRaw === 'bold' ? 700 : parseInt(fwRaw, 10) || 400;
    const bold = fw >= 600;

    // Text-align — react-pdf supports left/right/center/justify.
    const ta = cs.textAlign;
    const textAlign: DiagramTextRun['textAlign'] =
      ta === 'right' || ta === 'center' || ta === 'justify' ? ta : 'left';

    // Letter-spacing: computed style returns 'normal' or an explicit px
    // value — we only forward the numeric case.
    const lsRaw = cs.letterSpacing;
    const letterSpacingRaw = lsRaw === 'normal' ? 0 : parseFloat(lsRaw) || 0;

    // Apply the React Flow viewport scale to text metrics (not to
    // position — the rects we measured are already scaled). Only
    // elements *inside* the viewport get this multiplier so the A4
    // sheet's title strip and meta table keep their natural CSS size.
    const scale = viewportEl && viewportEl.contains(el) ? viewportScale : 1;

    out.push({
      el,
      text: raw,
      x: rect.left - rootRect.left,
      y: rect.top - rootRect.top,
      width: rect.width,
      height: rect.height,
      fontSize: parseFloat(cs.fontSize) * scale,
      fontFamily,
      bold,
      color: cs.color,
      textAlign,
      letterSpacing: letterSpacingRaw * scale,
    });
  }
  return out;
}

/**
 * Capture the DiagramView DOM element for PDF embedding.
 *
 * Returns the diagram rasterised as a PNG **with its visible text
 * transparent-ed out**, together with the per-text-run metadata needed to
 * re-emit the same text as real PDF Text on top. The net effect in the
 * PDF is pixel-perfect visual chrome (gradients, shadows, icons, edges,
 * backgrounds) underneath selectable/searchable/crisp text — the combination
 * that pure rasterisation loses and pure vector reconstruction can't match
 * for styling fidelity.
 *
 * How it works:
 *   1. Apply the light-theme `[data-pdf-export]` attribute (see index.css).
 *   2. Measure every leaf text element's rect + computed style.
 *   3. Inline `color: transparent` on each of those elements so the
 *      rasteriser captures their chrome (borders, backgrounds, icons) but
 *      no visible glyphs.
 *   4. Run html-to-image.
 *   5. Restore inline colors and remove the theme attribute.
 *
 * `width: 1122, height: 794` matches the on-screen A4 landscape container
 * so the capture scale is 1:1 with the DOM rects we measured. Changing
 * either value without changing the other would invalidate the text
 * positioning math downstream.
 */
export async function captureDiagramView(el: HTMLElement): Promise<{
  image: string;
  texts: DiagramTextRun[];
  /** Capture frame size in px — echoed so the PDF layout doesn't have to
   *  re-know the 1122×794 literal. */
  captureWidth: number;
  captureHeight: number;
}> {
  // Why `html-to-image` (and not `html2canvas`) for this capture:
  //   html2canvas 1.4.1 has a known bug where its Range-based text
  //   measurement throws
  //     IndexSizeError: Failed to execute 'setEnd' on 'Range': The offset
  //     N is larger than the node's length (N-1).
  //   whenever it walks a text node with `letter-spacing`,
  //   `text-transform: uppercase`, `font-feature-settings`, or
  //   contentEditable. The block diagram uses all of the above on its
  //   node type labels (JetBrains Mono + 0.14em letter-spacing +
  //   uppercase), title strip, and body labels (contentEditable), so the
  //   default html2canvas renderer is a non-starter.
  //   `foreignObjectRendering: true` avoids the Range code path but
  //   reliably produces a blank canvas in Chromium when external web
  //   fonts and CSS custom properties (`var(--ink-*)`, Geist/JetBrains
  //   Mono via @fontsource or similar) can't be inlined into the SVG.
  //   html-to-image is the React-Flow-team-recommended alternative —
  //   it walks the DOM without Range, inlines web fonts by fetching and
  //   base64-encoding them, and resolves CSS custom properties before
  //   serialising. The output matches on-screen fidelity closely enough
  //   that the exported PDF reads as a screenshot of the editor.
  //
  //   We deliberately do NOT swap html2canvas for `captureStage` — that
  //   one uses Konva's `stage.toCanvas` directly and never touches
  //   html2canvas's DOM walker, so it's not affected by the bug in the
  //   first place (and Konva's vector output is already crisper).
  const { toPng } = await import('html-to-image');

  // Print-theme toggle — the editor runs dark-on-dark; for the PDF we
  // swap to a scoped light theme via `[data-pdf-export]` (see index.css).
  //
  // Two rAF ticks before we measure/capture: toggling the attribute
  // schedules a style recomputation, but the computed styles we read
  // for text extraction are only stable AFTER the next paint. One frame
  // is usually enough; two is the classic belt-and-braces for browsers
  // that batch style changes across multiple frames under load.
  el.setAttribute('data-pdf-export', 'true');
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

  // 1) Measure text runs BEFORE we mutate colors — so the rects we store
  //    reflect the exact on-screen layout.
  const runs = collectDiagramTexts(el);

  // 2) Hide the text glyphs by inlining `color: transparent` on each
  //    captured element. Icons are safe because the extractor already
  //    skipped elements with element children (icon swatches have an SVG
  //    child, so they were excluded). Inline color > stylesheet rules,
  //    so this wins over the light-theme's `color: var(--ink-*)` values.
  const savedColors: Array<{ el: HTMLElement; prev: string }> = runs.map((r) => ({
    el: r.el,
    prev: r.el.style.color,
  }));
  for (const r of runs) r.el.style.color = 'transparent';

  try {
    const image = await toPng(el, {
      width: 1122,
      height: 794,
      // Force a white background so transparent regions become paper-
      // white rather than bleeding the editor's canvas-bg through.
      backgroundColor: '#ffffff',
      cacheBust: true,
      // Skip font inlining entirely. html-to-image tries to walk every
      // loaded stylesheet to extract @font-face rules — including Google
      // Fonts, whose CSS is cross-origin and throws a SecurityError when
      // the browser blocks cssRules access. Since all text nodes are made
      // transparent before capture, fonts in the image are irrelevant;
      // they are re-emitted as real PDF text by react-pdf instead.
      skipFonts: true,
    });
    // Strip the `el` reference from each run — callers don't need it and
    // holding a detached DOM reference across async boundaries is fragile.
    const texts: DiagramTextRun[] = runs.map(({ el: _el, ...rest }) => rest);
    return { image, texts, captureWidth: 1122, captureHeight: 794 };
  } finally {
    // Restore inline colors in the REVERSE order of assignment so any
    // element that appeared twice (shouldn't happen but be defensive)
    // ends up with its original value rather than an intermediate one.
    for (let i = savedColors.length - 1; i >= 0; i--) {
      const { el: tEl, prev } = savedColors[i];
      tEl.style.color = prev;
    }
    el.removeAttribute('data-pdf-export');
  }
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
