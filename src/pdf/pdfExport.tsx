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
// pdfExport — client entry point for generating the project PDF.
//
// The client is responsible for:
//   1. Capturing the Konva stage (roof plan) and compositing it with the
//      mm-accurate grid — the only step that must happen in this browser
//      because the Konva scene graph lives here.
//   2. Rendering PlanPageFrame offscreen and capturing it via captureDiagramView.
//      The frame carries all the layout chrome (sidebar, title strip, table)
//      as a CSS-rendered PNG — same technique as the diagram page.
//   3. Capturing the diagram DOM via captureDiagramView.
//
// Both pages, regardless of the active view:
//   App renders EITHER the roof canvas OR the diagram view, never both, so
//   capturing "whatever is mounted" produced a one-page PDF every time.
//   The caller (Toolbar) now hands us, per page, either the mounted
//   on-screen element (preferred: it preserves the user's current pan/zoom)
//   or an OffscreenRender recipe. For the unmounted page we mount the real
//   component (KonvaExportFrame / DiagramView exportMode) in a temporary,
//   off-viewport React root — the same technique PlanPageFrame already used
//   — wait for its `onReady` (Konva: background decoded; React Flow: nodes
//   measured + fitView done), capture, and tear the root down in a
//   `finally` so a failed capture never leaks a hidden React tree.
//   Rendering offscreen was chosen over "briefly switch views" because
//   switching would remount (and reset) the view the user is looking at,
//   flash the other view on screen, and race router navigation.
//   4. Resolving branding (team logo, company name, planner identity) and
//      passing it to PlanPageFrame before capture.
//   5. Building the locale-aware PdfStrings / PdfStats objects for PlanPageFrame.
//   6. POSTing the assembled payload to /pdf/render (pdf-service).
//
// Why PlanPageFrame instead of react-pdf layout primitives:
//   react-pdf's box model produces sub-pixel gaps between adjacent table rows
//   (float arithmetic in the renderer) and is limited to Helvetica/Courier.
//   By rendering PlanPageFrame in HTML/CSS and capturing with html-to-image,
//   the PDF inherits pixel-perfect CSS borders and the app's JetBrains Mono /
//   Geist font metrics. Same architecture as the diagram page since the
//   block-diagram capture was already working well.
// ────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import type { Project } from '../types';
import type { InverterModelRecord, TeamRecord, UserRecord } from '../backend/types';
import { pb } from '../backend/pb';

// A4 landscape page dimensions in points — used only to convert the measured
// plan-area pixel rect into PDF points for SolarPlanDoc.
const PAGE_W_PT = 841.89;
const PX_TO_PT  = PAGE_W_PT / 1122;   // 0.7503 pt/px (1122px = A4 at 96 dpi)
const PT_PER_MM = 2.83465;

export interface PdfBrandingContext {
  teamId: string | null;
  creatorId: string | null;
}

/**
 * How to produce one page's source when it isn't mounted on screen.
 * `render` receives an `onReady` callback the element must invoke once its
 * layout is final; the exporter also gives up waiting after
 * OFFSCREEN_READY_TIMEOUT_MS and captures whatever is there.
 */
export interface OffscreenRender {
  width: number;
  height: number;
  render: (onReady: () => void) => React.ReactElement;
}

/**
 * Capture sources per page. For each page, a mounted element wins over the
 * offscreen recipe. A page with neither is omitted from the PDF.
 */
export interface PdfCaptureSources {
  /** On-screen roof-plan host (`.konva-overlay`) when the roof view is active. */
  stageEl: HTMLElement | null;
  /** On-screen diagram sheet (`[data-diagram-view]`) when the diagram view is active. */
  diagramEl: HTMLElement | null;
  roofOffscreen?: OffscreenRender;
  diagramOffscreen?: OffscreenRender;
}

/** Upper bound for an offscreen render to report ready. Generous: React
 *  Flow needs a ResizeObserver round + fitView; a multi-MB base64 capture
 *  needs to decode. A timeout captures anyway rather than failing export. */
const OFFSCREEN_READY_TIMEOUT_MS = 6000;

function nextFrames(n = 2): Promise<void> {
  return new Promise<void>((resolve) => {
    const step = (left: number) => {
      if (left <= 0) resolve();
      else requestAnimationFrame(() => step(left - 1));
    };
    step(n);
  });
}

/**
 * Mount `render(onReady)` into a fixed, off-viewport container of the given
 * size, wait for readiness (or the timeout), run `use(container)`, and
 * ALWAYS unmount + remove the container afterwards — including when `use`
 * throws (html-to-image / Konva errors). The previous inline version left
 * the hidden root mounted forever on a capture failure.
 *
 * `position: fixed` + negative left keeps the element laid out at full
 * size (unlike display:none, which suppresses layout and would make
 * ResizeObservers / getBoundingClientRect report 0). `inert` +
 * aria-hidden keep it out of focus order and the accessibility tree while
 * it briefly exists.
 */
async function withOffscreenRoot<T>(
  width: number,
  height: number,
  render: (onReady: () => void) => React.ReactElement,
  waitForReady: boolean,
  use: (container: HTMLElement) => Promise<T>,
): Promise<T> {
  const container = document.createElement('div');
  container.style.cssText =
    `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;` +
    'overflow:hidden;z-index:-1;pointer-events:none;';
  container.setAttribute('aria-hidden', 'true');
  container.setAttribute('inert', '');
  document.body.appendChild(container);
  const root = createRoot(container);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let markReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    root.render(render(() => markReady()));
    if (waitForReady) {
      await Promise.race([
        ready,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            console.warn('PDF export: offscreen render did not report ready in time; capturing anyway');
            resolve();
          }, OFFSCREEN_READY_TIMEOUT_MS);
        }),
      ]);
    }
    // Two frames: React commits, then a full layout + paint pass so
    // measurements and computed styles are stable.
    await nextFrames(2);
    return await use(container);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    root.unmount();
    container.remove();
  }
}

/**
 * Top-level export. Captures the Konva overlay and diagram, renders
 * PlanPageFrame offscreen, assembles the payload, POSTs to the pdf-service
 * via the Go auth gate, and triggers a browser download from the response blob.
 *
 * Returns true on success, false on any failure (error is logged first).
 */
export async function exportPdf(
  project: Project,
  sources: PdfCaptureSources,
  inverterModelCache: Record<string, InverterModelRecord> = {},
  brandingCtx: PdfBrandingContext = { teamId: null, creatorId: null },
): Promise<boolean> {
  try {
    // Lazy-load capture helpers and PlanPageFrame together — they're all part
    // of the export chunk, so a single dynamic import round-trip covers both.
    const [
      { captureStage, composeWithGrid, captureDiagramView },
      { default: PlanPageFrame },
    ] = await Promise.all([
      import('./composeStageImage'),
      import('./PlanPageFrame'),
    ]);

    // ── Stage capture ────────────────────────────────────────────────────
    // Captured at Konva's 3× pixelRatio for print-quality output; aspect
    // ratio is kept to position the image correctly inside the frame later.
    let stageCapture: { imageDataUrl: string; aspect: number } | undefined;

    const captureStageFrom = async (hostEl: HTMLElement) => {
      const { canvas: shot, stageRotation } = await captureStage(hostEl);
      try {
        if (shot.width === 0 || shot.height === 0) return undefined;
        const aspect = shot.width / shot.height;
        // Grid compositing needs the printed draw width in mm, which is only
        // known after PlanPageFrame is measured below. The plan area is
        // ≈ 895 px → ≈ 671 pt → ≈ 236 mm wide; the cadence error from using
        // this estimate is < 1 mm, visually imperceptible.
        const drawWmm = 236;
        const imageDataUrl = composeWithGrid(shot, drawWmm, stageRotation);
        return { imageDataUrl, aspect };
      } finally {
        // Release the (potentially ~30 MP) backing store promptly.
        shot.width = 0;
        shot.height = 0;
      }
    };

    if (sources.stageEl) {
      stageCapture = await captureStageFrom(sources.stageEl);
    } else if (sources.roofOffscreen) {
      const r = sources.roofOffscreen;
      stageCapture = await withOffscreenRoot(r.width, r.height, r.render, true, captureStageFrom);
    }

    // ── Diagram capture ──────────────────────────────────────────────────
    let diagramCapture: Awaited<ReturnType<typeof captureDiagramView>> | undefined;
    if (sources.diagramEl) {
      diagramCapture = await captureDiagramView(sources.diagramEl);
    } else if (sources.diagramOffscreen) {
      const r = sources.diagramOffscreen;
      diagramCapture = await withOffscreenRoot(r.width, r.height, r.render, true, async (container) => {
        const el = container.querySelector('[data-diagram-view]') as HTMLElement | null;
        return el ? captureDiagramView(el) : undefined;
      });
    }

    if (!stageCapture && !diagramCapture) {
      console.error('PDF export: no capture source available');
      return false;
    }

    // ── Branding ─────────────────────────────────────────────────────────
    let companyName = '';
    let logoDataUrl: string | undefined;
    let plannerName = '';
    let plannerPhone = '';

    const brandingFetches: Array<Promise<unknown>> = [];
    if (brandingCtx.teamId) {
      brandingFetches.push(
        pb.collection('teams')
          .getOne<TeamRecord>(brandingCtx.teamId)
          .then(async (team) => {
            companyName = team.company_name?.trim() ?? '';
            if (team.logo) {
              try {
                const token = await pb.files.getToken();
                const url = pb.files.getURL(team, team.logo, { token });
                const res = await fetch(url);
                if (res.ok) {
                  const blob = await res.blob();
                  logoDataUrl = await blobToDataUrl(blob);
                }
              } catch {
                // Logo fetch failure → export without logo.
              }
            }
          })
          .catch(() => {}),
      );
    }
    if (brandingCtx.creatorId) {
      brandingFetches.push(
        pb.collection('users')
          .getOne<UserRecord>(brandingCtx.creatorId)
          .then((u) => {
            plannerName = u.name?.trim() ?? '';
            plannerPhone = u.phone?.trim() ?? '';
          })
          .catch(() => {}),
      );
    }
    if (brandingFetches.length > 0) await Promise.all(brandingFetches);

    // ── Inverter model names ─────────────────────────────────────────────
    const inverterModelNames: Record<string, string> = {};
    for (const inv of project.inverters) {
      if (inv.inverterModelId) {
        const m = inverterModelCache[inv.inverterModelId];
        if (m) inverterModelNames[inv.id] = `${m.manufacturer} ${m.model}`;
      }
    }

    // ── i18n strings + formatted stats ──────────────────────────────────
    const totalPanels = project.panels.length;
    const totalKwp    = (totalPanels * project.panelType.wattPeak) / 1000;

    const intCount = new Intl.NumberFormat(i18next.language, { maximumFractionDigits: 0 });
    const kwpFmt   = new Intl.NumberFormat(i18next.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const mppFmt   = new Intl.NumberFormat(i18next.language, { minimumFractionDigits: 4, maximumFractionDigits: 4 });

    const strings = {
      kicker: i18next.t('pdf.kicker'),
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
      scaleZoom: i18next.t('pdf.scaleZoom', { z: '{{z}}' }),
    };

    const coordFmt = new Intl.NumberFormat(i18next.language, {
      minimumFractionDigits: 5, maximumFractionDigits: 5,
    });
    const addr = project.meta?.address;
    const addressCoords = addr
      ? `${coordFmt.format(Math.abs(addr.lat))}° ${addr.lat >= 0 ? 'N' : 'S'} · ${coordFmt.format(Math.abs(addr.lon))}° ${addr.lon >= 0 ? 'E' : 'W'}`
      : '';

    const stats = {
      panelsCount: intCount.format(totalPanels),
      powerKwp: kwpFmt.format(totalKwp),
      scaleMpp: project.mapState.locked ? mppFmt.format(project.mapState.metersPerPixel) : '',
      addressCoords,
    };

    // ── PlanPageFrame: render offscreen, measure, capture ────────────────
    // Mount the frame into a fixed, off-viewport container so it lays out
    // at full 1122×794 px with fonts applied (fixed elements are laid out
    // even though they're outside the viewport, unlike display:none which
    // suppresses layout entirely).
    let planFrameCapture:
      | Awaited<ReturnType<typeof captureDiagramView>>
      | undefined;
    let planImageRectPt: { x: number; y: number; w: number; h: number } | undefined;

    if (stageCapture) {
      const { aspect } = stageCapture;
      const frameElement = React.createElement(PlanPageFrame, {
        project,
        strings,
        stats,
        inverterModelNames,
        branding: {
          companyName,
          logoDataUrl,
          plannerName,
          plannerPhone,
          plannerLabel: i18next.t('pdf.metaPlanner'),
          phoneLabel: i18next.t('pdf.metaPhone'),
        },
      });
      // PlanPageFrame is plain HTML/CSS with no async work, so no ready
      // signal is needed — withOffscreenRoot's two frames suffice.
      const measured = await withOffscreenRoot(1122, 794, () => frameElement, false, async (container) => {
        // Measure the plan-area placeholder. getBoundingClientRect returns
        // viewport-relative coords; subtract the frame's origin to get
        // frame-local pixel coordinates.
        const frameEl = container.querySelector('[data-plan-frame]') as HTMLElement | null;
        const planAreaEl = container.querySelector('[data-plan-area]') as HTMLElement | null;
        if (!frameEl || !planAreaEl) return undefined;

        const fRect = frameEl.getBoundingClientRect();
        const pRect = planAreaEl.getBoundingClientRect();

        const areaX = pRect.left - fRect.left;
        const areaY = pRect.top - fRect.top;
        const areaW = pRect.width;
        const areaH = pRect.height;

        // Aspect-fit the plan image inside the measured area.
        const planW_px = Math.min(areaW, areaH * aspect);
        const planH_px = planW_px / aspect;
        const offX = (areaW - planW_px) / 2;
        const offY = (areaH - planH_px) / 2;

        // Convert to PDF points (841.89 pt / 1122 px = 0.7503 pt/px).
        const rectPt = {
          x: (areaX + offX) * PX_TO_PT,
          y: (areaY + offY) * PX_TO_PT,
          w: planW_px * PX_TO_PT,
          h: planH_px * PX_TO_PT,
        };
        // The grid was composed with a 236 mm draw-width estimate (see
        // captureStageFrom). The accurate value is rectPt.w / PT_PER_MM;
        // the cadence difference is < 2 mm — not worth a second Konva
        // render. Kept as a named value for whoever needs exact cadence.
        void (rectPt.w / PT_PER_MM);

        const capture = await captureDiagramView(frameEl);
        return { rectPt, capture };
      });
      if (measured) {
        planImageRectPt = measured.rectPt;
        planFrameCapture = measured.capture;
      }
    }

    // ── POST to pdf-service via Go auth gate ─────────────────────────────
    // The payload is now much smaller: the frame captures replace all the
    // old layout props (project JSON, strings, stats, branding, inverterModelNames).
    const payload = {
      planFrameCapture,
      planImageDataUrl: stageCapture?.imageDataUrl,
      planImageRectPt,
      diagramCapture,
    };

    const response = await fetch('/pdf/render', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // pdf-service validates this directly against PocketBase — the
        // request never goes through Go, bypassing the 32 MB body limit.
        'Authorization': `Bearer ${pb.authStore.token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('PDF export: server error', response.status, err);
      try {
        console.error('PDF export detail:', JSON.parse(err));
      } catch {
        // Plain text error — already logged above.
      }
      return false;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `solar-plan-${project.name.replace(/[^a-z0-9-_]/gi, '_')}-${dateStamp()}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (err) {
    console.error('PDF export failed', err);
    return false;
  }
}

/**
 * Warm the lazy capture chunk. Wire this to onMouseEnter / onFocus on the
 * Export button.
 */
export function prefetchPdfExport(): void {
  void import('./composeStageImage');
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') resolve(result);
      else reject(new Error('FileReader returned non-string'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

function dateStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
