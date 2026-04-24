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
// SolarPlanDoc — A4 landscape PDF, two pages:
//
//   Page 1: Roof plan
//     Background = PlanPageFrame capture (full 1122×794 px frame as raster).
//     Plan image  = high-res Konva composite, composited on top of the
//                   placeholder area measured from the frame DOM.
//     Text        = PDF Text elements at positions extracted by
//                   collectDiagramTexts, scaled 1122px → 841.89pt.
//
//   Page 2: Block diagram
//     Background = DiagramView capture (same pattern as page 1).
//     Text        = same extraction + overlay approach.
//
// Both pages use the identical architecture: CSS-rendered visual chrome in
// the background image, real PDF Text overlaid for selectability. No
// react-pdf View/Text layout primitives are used for page content — only
// for the outermost <Page> wrapper.
//
// This approach was adopted because react-pdf's box-model produces
// sub-pixel gaps between adjacent table rows (float arithmetic in the
// renderer) and can only use Helvetica/Courier — not the JetBrains Mono /
// Geist fonts the app's design system uses. By capturing from the HTML/CSS
// DOM, we get pixel-perfect borders and the exact font metrics for free;
// the pdf-service just needs to embed the image and overlay text.
// ────────────────────────────────────────────────────────────────────────────

import { Document, Page, View, Text, Image } from '@react-pdf/renderer';
import type { DiagramTextRun } from './composeStageImage';


// ── Captured page type ───────────────────────────────────────────────────────
// Both pages share this shape: a background raster + extracted text runs.
interface CapturedPage {
  image: string;
  texts: DiagramTextRun[];
  captureWidth: number;
  captureHeight: number;
}

// ── Props ────────────────────────────────────────────────────────────────────

export interface SolarPlanDocProps {
  // Page 1 — roof plan frame (from PlanPageFrame via captureDiagramView).
  planFrameCapture?: CapturedPage;
  // High-res plan image (Konva capture + grid), composited on top of the
  // placeholder area in planFrameCapture.
  planImageDataUrl?: string;
  // Position and size of the plan image within the PDF page, in pt.
  // Pre-computed by pdfExport.tsx from the measured plan-area DOM rect.
  planImageRectPt?: { x: number; y: number; w: number; h: number };

  // Page 2 — block diagram (unchanged from previous design).
  diagramCapture?: CapturedPage;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Render a CapturedPage as a full-bleed A4 landscape page: background image
// at page dimensions, text overlaid at extracted positions.
function CapturedPageView({
  capture,
  pageW,
  pageH,
  children,
}: {
  capture: CapturedPage;
  pageW: number;
  pageH: number;
  children?: React.ReactNode;
}) {
  const pxToPt = pageW / capture.captureWidth;
  return (
    <View style={{ position: 'relative', width: pageW, height: pageH }}>
      {/* Background: the full captured frame image */}
      <Image
        src={capture.image}
        style={{ position: 'absolute', left: 0, top: 0, width: pageW, height: pageH }}
      />
      {/* Any additional layers inserted by the caller (e.g. plan image) */}
      {children}
      {/* Text overlays: real PDF Text at extracted positions, matching font/color */}
      {capture.texts.map((t, i) => {
        const fontFamily = t.fontFamily === 'mono'
          ? (t.bold ? 'Courier-Bold' : 'Courier')
          : (t.bold ? 'Helvetica-Bold' : 'Helvetica');
        return (
          <Text
            key={i}
            style={{
              position: 'absolute',
              left: t.x * pxToPt,
              top:  t.y * pxToPt,
              width: t.width * pxToPt,
              fontSize: t.fontSize * pxToPt,
              fontFamily,
              color: t.color,
              textAlign: t.textAlign,
              letterSpacing: t.letterSpacing * pxToPt,
              lineHeight: 1,
            }}
          >
            {t.text}
          </Text>
        );
      })}
    </View>
  );
}

// ── Main document ─────────────────────────────────────────────────────────────

export function SolarPlanDoc({
  planFrameCapture,
  planImageDataUrl,
  planImageRectPt,
  diagramCapture,
}: SolarPlanDocProps) {
  // A4 landscape page dimensions in points.
  const PAGE_W = 841.89;
  const PAGE_H = 595.28;

  return (
    <Document>
      {/* ── Page 1: Roof plan ────────────────────────────────────────── */}
      {planFrameCapture && (
        <Page
          size="A4"
          orientation="landscape"
          // No padding: the frame capture fills the full page, and the
          // PlanPageFrame component's own PAD (32px) handles the margin.
          style={{ padding: 0 }}
        >
          <CapturedPageView capture={planFrameCapture} pageW={PAGE_W} pageH={PAGE_H}>
            {/* High-res plan image composited at the measured placeholder rect */}
            {planImageDataUrl && planImageRectPt && (
              <Image
                src={planImageDataUrl}
                style={{
                  position: 'absolute',
                  left: planImageRectPt.x,
                  top:  planImageRectPt.y,
                  width:  planImageRectPt.w,
                  height: planImageRectPt.h,
                }}
              />
            )}
          </CapturedPageView>
        </Page>
      )}

      {/* ── Page 2: Block diagram ───────────────────────────────────── */}
      {diagramCapture && (() => {
        // The diagram capture is always 1122×794 (A4 landscape at 96 dpi).
        // Content area inside the PDF's 28/32 padding is 777.89×535.28 pt —
        // aspect-fit the capture image into that space and center it.
        const CONTENT_W = PAGE_W - 64;   // 777.89 pt (2 × 32 pt pad)
        const CONTENT_H = PAGE_H - 60;   // 535.28 pt (28 top + 32 bottom)
        const { captureWidth, captureHeight } = diagramCapture;
        const capAspect     = captureWidth / captureHeight;
        const contentAspect = CONTENT_W / CONTENT_H;
        const imgW = capAspect > contentAspect ? CONTENT_W : CONTENT_H * capAspect;
        const imgH = capAspect > contentAspect ? CONTENT_W / capAspect : CONTENT_H;
        const offsetX = (CONTENT_W - imgW) / 2;
        const offsetY = (CONTENT_H - imgH) / 2;
        const pxToPt  = imgW / captureWidth;

        return (
          <Page
            size="A4"
            orientation="landscape"
            style={{ paddingTop: 28, paddingHorizontal: 32, paddingBottom: 32 }}
          >
            <View style={{ position: 'relative', width: CONTENT_W, height: CONTENT_H }}>
              <Image src={diagramCapture.image} style={{
                position: 'absolute',
                left: offsetX, top: offsetY,
                width: imgW, height: imgH,
              }} />
              {diagramCapture.texts.map((t, i) => {
                const fontFamily = t.fontFamily === 'mono'
                  ? (t.bold ? 'Courier-Bold' : 'Courier')
                  : (t.bold ? 'Helvetica-Bold' : 'Helvetica');
                return (
                  <Text key={i} style={{
                    position: 'absolute',
                    left: offsetX + t.x * pxToPt,
                    top:  offsetY + t.y * pxToPt,
                    width: t.width * pxToPt,
                    fontSize: t.fontSize * pxToPt,
                    fontFamily,
                    color: t.color,
                    textAlign: t.textAlign,
                    letterSpacing: t.letterSpacing * pxToPt,
                    lineHeight: 1,
                  }}>
                    {t.text}
                  </Text>
                );
              })}
            </View>
          </Page>
        );
      })()}
    </Document>
  );
}
