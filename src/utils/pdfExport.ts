// ────────────────────────────────────────────────────────────────────────────
// PDF export — DIN A4 landscape: map+panels on the left, string table on the
// right, header/footer with project meta.
//
// Approach:
//   1. Rasterize the Leaflet map to a canvas via html2canvas (so the tile
//      imagery is baked into the PDF — otherwise strings would appear on a
//      blank background).
//   2. Pull the Konva Stage's <canvas> element directly (no html2canvas
//      round-trip needed; Konva already gives us a canvas).
//   3. Composite map + overlay onto a single in-memory canvas, serialize
//      to PNG, embed in the PDF.
//   4. Hand-compose the right-side table + totals with jsPDF primitives.
//
// Known failure mode: tile CORS. Many tile servers set headers that block
// cross-origin canvas use. When html2canvas can't capture the map, we log
// a warning and proceed with just the Konva layer (panels visible on a
// dark background, no imagery). This is imperfect but better than blocking
// export.
// ────────────────────────────────────────────────────────────────────────────

import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import type { Project } from '../types';

/**
 * Top-level export. Returns a boolean so callers can show a failure toast.
 * Any thrown error is logged to console for debugging.
 */
export async function exportPdf(project: Project): Promise<boolean> {
  try {
    // Look up the two DOM nodes we need. `.konva-overlay` is KonvaOverlay's
    // container (which holds a single <canvas>). `.leaflet-container` is
    // the Leaflet root element.
    const stageEl = document.querySelector('.konva-overlay') as HTMLElement | null;
    const mapEl = document.querySelector('.leaflet-container') as HTMLElement | null;
    if (!stageEl || !mapEl) {
      console.error('Map or canvas not found');
      return false;
    }

    // Capture the map (satellite imagery). This is the piece that's most
    // likely to fail due to CORS on tile servers. useCORS + allowTaint try
    // both with-credentials and taint-allowing paths; we still catch and
    // warn because either can fail.
    let mapCanvas: HTMLCanvasElement | null = null;
    try {
      mapCanvas = await html2canvas(mapEl, {
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#1a1a1a',
        logging: false,
      });
    } catch (e) {
      console.warn('Map capture failed (likely CORS); proceeding with canvas only.', e);
    }

    // Konva's canvas is direct — no raster conversion needed. querySelector
    // on the overlay div gives us the single <canvas> element Konva creates.
    const konvaCanvas = stageEl.querySelector('canvas') as HTMLCanvasElement | null;

    // ── Composite into a single canvas so we can embed one PNG in the PDF.
    // Matching the map container's dimensions keeps aspect + overlay
    // alignment pixel-accurate.
    const W = mapEl.clientWidth;
    const H = mapEl.clientHeight;
    const composite = document.createElement('canvas');
    composite.width = W;
    composite.height = H;
    const ctx = composite.getContext('2d')!;
    ctx.fillStyle = '#1a1a1a'; // fallback background if map capture failed
    ctx.fillRect(0, 0, W, H);
    if (mapCanvas) ctx.drawImage(mapCanvas, 0, 0, W, H);
    if (konvaCanvas) ctx.drawImage(konvaCanvas, 0, 0, W, H);
    const planDataUrl = composite.toDataURL('image/png');

    // ── PDF layout (DIN A4 landscape: 297 × 210 mm) ────────────────────
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 8;

    // Header row: project name (left), date (right).
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.text(`Solar Plan — ${project.name}`, margin, margin + 5);
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'normal');
    pdf.text(new Date().toLocaleDateString(), pageW - margin, margin + 5, { align: 'right' });

    const headerH = 14;
    const contentY = margin + headerH;
    const contentH = pageH - contentY - margin;

    // ── Plan image on the left ─────────────────────────────────────────
    // Allocate ~60% of width to the plan, leaving room for the table on the
    // right. We fit the capture into this box preserving aspect (never
    // cropping — rather leave some padding if aspect ratios don't match).
    const planAreaW = pageW * 0.6 - margin * 1.5;
    const planAreaH = contentH;
    const aspect = W / H;
    let drawW = planAreaW;
    let drawH = planAreaW / aspect;
    if (drawH > planAreaH) {
      drawH = planAreaH;
      drawW = planAreaH * aspect;
    }
    const planX = margin + (planAreaW - drawW) / 2;
    const planY = contentY + (planAreaH - drawH) / 2;

    // Thin border around the plan area (helps frame it on the page).
    pdf.setDrawColor(180);
    pdf.rect(margin, contentY, planAreaW, planAreaH);
    pdf.addImage(planDataUrl, 'PNG', planX, planY, drawW, drawH);

    // ── String table on the right ───────────────────────────────────────
    const tableX = margin + planAreaW + margin;
    const tableW = pageW - tableX - margin;
    let cursorY = contentY;

    pdf.setFontSize(11);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Strings', tableX, cursorY + 4);
    cursorY += 8;

    // Column positions (mm offsets from tableX). Chosen to fit a typical
    // ~120mm table width; tune if adding more columns.
    const colX = {
      str: tableX,
      color: tableX + 22,
      panels: tableX + 38,
      wp: tableX + 58,
      inv: tableX + 80,
    };

    // Header row
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'bold');
    pdf.text('String', colX.str, cursorY);
    pdf.text('Color', colX.color, cursorY);
    pdf.text('Panels', colX.panels, cursorY);
    pdf.text('Wp', colX.wp, cursorY);
    pdf.text('Inverter', colX.inv, cursorY);
    cursorY += 1.5;
    pdf.setDrawColor(120);
    pdf.line(tableX, cursorY, tableX + tableW, cursorY);
    cursorY += 4;

    pdf.setFont('helvetica', 'normal');
    // Pre-build a lookup so we don't loop over inverters for each row.
    const inverterById = new Map(project.inverters.map((i) => [i.id, i.name]));

    // Each string → one row. Break early if we're about to spill past the
    // bottom margin (no pagination yet; strings are typically <20 for a
    // residential job).
    for (const str of project.strings) {
      const count = project.panels.filter((p) => p.stringId === str.id).length;
      const wp = count * project.panelType.wattPeak;
      const invName = str.inverterId ? inverterById.get(str.inverterId) || '?' : '—';
      pdf.text(str.label, colX.str, cursorY);
      // Color swatch — small filled rect matching the string's UI color.
      const rgb = hexToRgb(str.color);
      pdf.setFillColor(rgb.r, rgb.g, rgb.b);
      pdf.rect(colX.color, cursorY - 3, 4, 4, 'F');
      pdf.text(String(count), colX.panels, cursorY);
      pdf.text(wp.toString(), colX.wp, cursorY);
      pdf.text(invName, colX.inv, cursorY);
      cursorY += 5;
      if (cursorY > pageH - margin - 25) break;
    }

    // Footer separator before totals.
    cursorY += 4;
    pdf.setDrawColor(120);
    pdf.line(tableX, cursorY, tableX + tableW, cursorY);
    cursorY += 5;

    // Totals block
    const totalPanels = project.panels.length;
    const totalKwp = (totalPanels * project.panelType.wattPeak) / 1000;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.text(`Total: ${totalPanels} panels · ${totalKwp.toFixed(2)} kWp`, tableX, cursorY);
    cursorY += 4;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.text(
      `Panel: ${project.panelType.name} · ${project.panelType.widthM}×${project.panelType.heightM} m · ${project.panelType.wattPeak} Wp`,
      tableX,
      cursorY
    );
    cursorY += 4;
    // Scale reference — useful for anyone reading the PDF later.
    if (project.mapState.locked) {
      pdf.text(
        `Scale: ${project.mapState.metersPerPixel.toFixed(4)} m/px @ zoom ${project.mapState.zoom}`,
        tableX,
        cursorY
      );
    }

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
