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
// PlanPageFrame — HTML/CSS render of the roof-plan PDF page.
//
// Rendered offscreen (via ReactDOM.createRoot into a fixed off-viewport div)
// during export, then captured with captureDiagramView from composeStageImage.
// The resulting { image, texts } are sent to the pdf-service exactly like
// the diagram page capture — the background image carries all structural
// chrome (borders, fills, swatches, crosshairs) while real PDF Text overlays
// the extracted text runs for selectability.
//
// Why HTML/CSS instead of react-pdf primitives:
//   react-pdf's box-model renders borders as individual rect strokes with
//   float-arithmetic sub-pixel gaps between adjacent rows. CSS gives us
//   pixel-perfect table dividers, JetBrains Mono and Geist at their actual
//   rendered widths, and the exact visual language of DiagramView / DiagramMetaTable
//   — all captured faithfully by html-to-image.
//
// Dimensions: 1122 × 794 px (A4 landscape at 96 dpi, same as DiagramView).
// Coordinate scale: 841.89 / 1122 = 0.7503 pt/px — applied in SolarPlanDoc
// when mapping the extracted text positions to PDF points.
//
// The plan image area (data-plan-area) is a WHITE PLACEHOLDER. The actual
// high-resolution Konva composite is passed separately to the pdf-service and
// overlaid at the exact measured rect in the PDF. This keeps the plan image
// at its original 3× Konva quality rather than being downsampled through
// the html-to-image capture.
// ────────────────────────────────────────────────────────────────────────────

import React from 'react';
import type { Project } from '../types';
// ── String / stats prop interfaces ──────────────────────────────────────────
// Defined here (canonical location). SolarPlanDoc.tsx re-exports them so
// pdfExport.tsx can import from either place without a circular reference.

export interface PdfStrings {
  kicker: string;
  date: string;
  metaClient: string;
  metaAddress: string;
  notesLabel: string;
  strings: string;
  panelInfo: string;
  colString: string;
  colColor: string;
  colPanels: string;
  colWp: string;
  colInverterNum: string;
  colMpptPort: string;
  colInverterModel: string;
  statPanels: string;
  statPower: string;
  statScale: string;
  unitKwp: string;
  unitMpp: string;
  scaleZoom: string;
}

export interface PdfStats {
  panelsCount: string;
  powerKwp: string;
  scaleMpp: string;
  addressCoords: string;
}

// ── Pixel layout (A4 landscape = 1122 × 794 px) ─────────────────────────────
// Derived from the pt constants in SolarPlanDoc by × (1122 / 841.89 = 1.3327).
export const PX_A4_W    = 1122;
export const PX_A4_H    = 794;
export const PX_PAD     = 32;   // 24 pt
export const PX_TITLE_H = 29;   // 22 pt
export const PX_SIDE_W  = 147;  // 110 pt
export const PX_COL_G   = 16;   // 12 pt
export const PX_V_GAP   = 11;   // 8 pt
export const PX_STR_CAP = 21;   // 16 pt — strings caption line
export const PX_STR_HDR = 29;   // 22 pt — strings header row
export const PX_STR_ROW = 24;   // 18 pt — strings data rows

// ── Light-mode color tokens ──────────────────────────────────────────────────
// These mirror [data-pdf-export] overrides in index.css. Written as literals
// (not var(--…)) so the component is self-contained when rendered in an
// isolated ReactDOM.createRoot container.
const INK       = '#18181b';   // --ink-100
const INK_MID   = '#27272a';   // --ink-200
const INK_DIM   = '#52525b';   // --ink-300 (unused here, but kept for completeness)
void INK_DIM;
const INK_LABEL = '#71717a';   // --ink-400
const INK_FAINT = '#a1a1aa';   // --ink-500
const HL        = 'rgba(0,0,0,0.08)';   // --hairline
const HL_ST     = 'rgba(0,0,0,0.18)';   // --hairline-strong

// ── Typography helpers ───────────────────────────────────────────────────────
const MONO = "'JetBrains Mono', ui-monospace, monospace";
const SANS = "'Geist', ui-sans-serif, system-ui, sans-serif";

// ── Sub-components ───────────────────────────────────────────────────────────

// Crosshair register mark centered on a content-area corner. The box is
// 2×ARM wide/tall, centered exactly over the content corner, so the cross
// intersection sits at the padding boundary — same visual as DiagramView's
// RegisterMark but for a white page.
function CornerMark({ corner }: { corner: 'tl' | 'tr' | 'bl' | 'br' }) {
  const ARM = 10;
  const W   = 0.75;
  const isTop  = corner[0] === 't';
  const isLeft = corner[1] === 'l';
  // Position the ARM×2 box so its center lands at the content-area corner.
  const style: React.CSSProperties = {
    position: 'absolute',
    width: ARM * 2,
    height: ARM * 2,
    top:    isTop  ? PX_PAD - ARM : undefined,
    bottom: isTop  ? undefined     : PX_PAD - ARM,
    left:   isLeft ? PX_PAD - ARM : undefined,
    right:  isLeft ? undefined     : PX_PAD - ARM,
    pointerEvents: 'none',
  };
  return (
    <div style={style}>
      {/* Horizontal arm */}
      <div style={{
        position: 'absolute', top: ARM - W / 2, left: 0, right: 0, height: W,
        background: HL_ST,
      }} />
      {/* Vertical arm */}
      <div style={{
        position: 'absolute', left: ARM - W / 2, top: 0, bottom: 0, width: W,
        background: HL_ST,
      }} />
    </div>
  );
}

// Labeled meta block: JetBrains Mono uppercase label above value(s).
// Matches DiagramMetaTable's LabeledCell layout exactly.
function MetaBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 10 }}>
      <span style={{
        display: 'block',
        fontFamily: MONO,
        fontSize: 8,
        fontWeight: 600,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color: INK_LABEL,
        marginBottom: 2,
      }}>
        {label}
      </span>
      {children}
    </div>
  );
}

// ── Props ────────────────────────────────────────────────────────────────────

export interface PlanPageFrameProps {
  project: Project;
  strings: PdfStrings;
  stats: PdfStats;
  inverterModelNames: Record<string, string>;
  branding?: {
    companyName: string;
    logoDataUrl?: string;
    plannerName: string;
    plannerPhone: string;
    plannerLabel: string;
    phoneLabel: string;
  };
}

// ── Main component ───────────────────────────────────────────────────────────

export default function PlanPageFrame({
  project,
  strings,
  stats,
  inverterModelNames,
  branding,
}: PlanPageFrameProps) {
  const inverterById = new Map(project.inverters.map((i) => [i.id, i.name]));
  const clientText  = project.meta?.client?.trim() ?? '';
  const addressText = project.meta?.address?.formatted?.trim() ?? '';
  const notes       = project.meta?.notes?.trim() ?? '';
  const companyLabel = branding?.companyName?.trim() || strings.kicker;
  const showScale   = project.mapState.locked && stats.scaleMpp !== '';

  return (
    <div
      data-plan-frame
      data-pdf-export="true"
      style={{
        width: PX_A4_W,
        height: PX_A4_H,
        background: '#ffffff',
        position: 'relative',
        fontFamily: SANS,
        color: INK,
        overflow: 'hidden',
        flexShrink: 0,
        // Self-contained CSS variable values so the component renders
        // correctly whether it's mounted in the real DOM tree or an isolated
        // createRoot container. These match [data-pdf-export] from index.css.
        ['--hairline' as string]: HL,
        ['--hairline-strong' as string]: HL_ST,
        ['--ink-100' as string]: INK,
        ['--ink-200' as string]: INK_MID,
        ['--ink-400' as string]: INK_LABEL,
        ['--ink-500' as string]: INK_FAINT,
      }}
    >
      {/* Register marks at the four content-area corners */}
      <CornerMark corner="tl" />
      <CornerMark corner="tr" />
      <CornerMark corner="bl" />
      <CornerMark corner="br" />

      {/* Padded content area */}
      <div style={{
        position: 'absolute',
        top: PX_PAD, right: PX_PAD, bottom: PX_PAD, left: PX_PAD,
        display: 'flex',
        flexDirection: 'column',
      }}>

        {/* ── Title strip ──────────────────────────────────────────────────
            [■ brand] COMPANY ──────────────────── Project Name
            Mirrors DiagramView's top header div exactly. */}
        <div style={{
          height: PX_TITLE_H,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderBottom: `1px solid ${HL_ST}`,
          marginBottom: PX_V_GAP,
          flexShrink: 0,
        }}>
          {branding?.logoDataUrl ? (
            <img src={branding.logoDataUrl} style={{ height: 13, objectFit: 'contain', flexShrink: 0 }} />
          ) : (
            <div style={{ width: 6, height: 6, background: INK, flexShrink: 0 }} />
          )}
          <span style={{
            fontFamily: MONO,
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: INK_LABEL,
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}>
            {companyLabel}
          </span>
          {/* Fade rule — same gradient treatment as DiagramView's title separator */}
          <div style={{
            flex: 1,
            height: 1,
            background: `linear-gradient(90deg, ${HL_ST}, transparent 80%)`,
          }} />
          <span style={{
            fontFamily: SANS,
            fontSize: 14,
            fontWeight: 600,
            color: INK_MID,
            maxWidth: '60%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {project.name}
          </span>
        </div>

        {/* ── Main row: sidebar + plan area ────────────────────────────────
            flex:1 so it absorbs all available height between title and table. */}
        <div style={{ display: 'flex', flexDirection: 'row', flex: 1, minHeight: 0, overflow: 'hidden' }}>

          {/* ── Sidebar ────────────────────────────────────────────────── */}
          <div style={{
            width: PX_SIDE_W,
            marginRight: PX_COL_G,
            borderRight: `1px solid ${HL_ST}`,
            paddingRight: 12,
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
            overflow: 'hidden',
          }}>
            {/* Date */}
            <span style={{
              fontFamily: MONO,
              fontSize: 8,
              color: INK_LABEL,
              marginBottom: 4,
            }}>
              {strings.date}
            </span>

            {/* Planner */}
            {branding && (branding.plannerName.trim() || branding.plannerPhone.trim()) && (
              <MetaBlock label={branding.plannerLabel}>
                {branding.plannerName.trim() && (
                  <span style={{ fontFamily: SANS, fontSize: 11, fontWeight: 600, color: INK, display: 'block' }}>
                    {branding.plannerName}
                  </span>
                )}
                {branding.plannerPhone.trim() && (
                  <span style={{ fontFamily: SANS, fontSize: 10, color: INK_MID, display: 'block', marginTop: 1 }}>
                    {branding.plannerPhone}
                  </span>
                )}
              </MetaBlock>
            )}

            {/* Client / address */}
            {(clientText || addressText) && (
              <MetaBlock label={clientText ? strings.metaClient : strings.metaAddress}>
                {clientText && (
                  <span style={{ fontFamily: SANS, fontSize: 11, fontWeight: 600, color: INK, display: 'block' }}>
                    {clientText}
                  </span>
                )}
                {addressText && (
                  <>
                    {clientText && (
                      <span style={{
                        display: 'block',
                        fontFamily: MONO,
                        fontSize: 8,
                        fontWeight: 600,
                        letterSpacing: '0.16em',
                        textTransform: 'uppercase',
                        color: INK_LABEL,
                        marginTop: 7,
                        marginBottom: 2,
                      }}>
                        {strings.metaAddress}
                      </span>
                    )}
                    <span style={{ fontFamily: SANS, fontSize: 10, color: INK_MID, display: 'block', lineHeight: 1.35 }}>
                      {addressText}
                    </span>
                    {stats.addressCoords && (
                      <span style={{ fontFamily: MONO, fontSize: 8, color: INK_FAINT, display: 'block', marginTop: 1 }}>
                        {stats.addressCoords}
                      </span>
                    )}
                  </>
                )}
              </MetaBlock>
            )}

            {/* Notes */}
            {notes && (
              <MetaBlock label={strings.notesLabel}>
                <span style={{ fontFamily: SANS, fontSize: 10, fontStyle: 'italic', color: INK_MID, display: 'block', lineHeight: 1.4 }}>
                  {notes}
                </span>
              </MetaBlock>
            )}

            {/* Spacer — pushes stats block to the sidebar's bottom */}
            <div style={{ flex: 1 }} />

            {/* Stats block */}
            <div style={{ borderTop: `1px solid ${HL_ST}`, paddingTop: 8 }}>
              {/* Panels */}
              <div style={{ marginBottom: 8 }}>
                <span style={{
                  display: 'block',
                  fontFamily: MONO,
                  fontSize: 8,
                  fontWeight: 600,
                  letterSpacing: '0.16em',
                  textTransform: 'uppercase',
                  color: INK_LABEL,
                  marginBottom: 1,
                }}>
                  {strings.statPanels}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 19, fontWeight: 700, color: INK, lineHeight: 1 }}>
                  {stats.panelsCount}
                </span>
              </div>

              {/* Power */}
              <div style={{ marginBottom: 8 }}>
                <span style={{
                  display: 'block',
                  fontFamily: MONO,
                  fontSize: 8,
                  fontWeight: 600,
                  letterSpacing: '0.16em',
                  textTransform: 'uppercase',
                  color: INK_LABEL,
                  marginBottom: 1,
                }}>
                  {strings.statPower}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 19, fontWeight: 700, color: INK, lineHeight: 1 }}>
                  {stats.powerKwp}
                  <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 400, color: INK_LABEL, marginLeft: 4 }}>
                    {strings.unitKwp}
                  </span>
                </span>
              </div>

              {/* Scale — only when map is locked */}
              {showScale && (
                <div>
                  <span style={{
                    display: 'block',
                    fontFamily: MONO,
                    fontSize: 8,
                    fontWeight: 600,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    color: INK_LABEL,
                    marginBottom: 1,
                  }}>
                    {strings.statScale}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, color: INK, lineHeight: 1 }}>
                    {stats.scaleMpp}
                    <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 400, color: INK_LABEL, marginLeft: 4 }}>
                      {strings.unitMpp}
                    </span>
                  </span>
                  <span style={{ display: 'block', fontFamily: MONO, fontSize: 7.5, color: INK_FAINT, marginTop: 2 }}>
                    {strings.scaleZoom.replace('{{z}}', String(
                      project.mapState.locked ? project.mapState.zoom : '',
                    ))}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ── Plan image area — WHITE PLACEHOLDER ─────────────────────
              The high-res Konva composite is overlaid here in the PDF
              by SolarPlanDoc. We leave this white so the plan image
              covers it exactly when positioned at the measured rect. */}
          <div
            data-plan-area
            style={{
              flex: 1,
              background: '#f5f5f7',  // barely-off-white so the area is visible in html-to-image
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          />
        </div>

        {/* ── Strings table — rendered only when project has strings ─────── */}
        {project.strings.length > 0 && (
          <div style={{ marginTop: PX_V_GAP, flexShrink: 0 }}>

            {/* Caption row: "STRINGS" label + panel-type info */}
            <div style={{
              height: PX_STR_CAP,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <span style={{
                fontFamily: MONO,
                fontSize: 8,
                fontWeight: 600,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: INK_LABEL,
              }}>
                {strings.strings}
              </span>
              <span style={{ fontFamily: SANS, fontSize: 8, fontStyle: 'italic', color: INK_FAINT }}>
                {strings.panelInfo}
              </span>
            </div>

            {/* Column header row — mirrors DiagramMetaTable's label style */}
            <div style={{
              display: 'flex',
              flexDirection: 'row',
              height: PX_STR_HDR,
              alignItems: 'center',
              borderTop: `1px solid ${HL_ST}`,
              borderBottom: `1px solid ${HL_ST}`,
              paddingLeft: 6,
              paddingRight: 6,
            }}>
              {(
                [
                  { label: strings.colString,       w: 120              },
                  { label: strings.colColor,         w: 61               },
                  { label: strings.colPanels,        w: 77, right: true  },
                  { label: strings.colWp,            w: 93, right: true  },
                  { label: strings.colInverterNum,   w: 128              },
                  { label: strings.colMpptPort,      w: 77               },
                  { label: strings.colInverterModel, flex: 1             },
                ] as Array<{ label: string; w?: number; flex?: number; right?: boolean }>
              ).map((col) => (
                <span
                  key={col.label}
                  style={{
                    fontFamily: MONO,
                    fontSize: 8,
                    fontWeight: 600,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    color: INK_LABEL,
                    ...(col.w !== undefined ? { width: col.w, flexShrink: 0 } : { flex: col.flex ?? 1 }),
                    ...(col.right ? { textAlign: 'right', paddingRight: 12 } : {}),
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {col.label}
                </span>
              ))}
            </div>

            {/* Data rows */}
            {project.strings.map((s, idx) => {
              const count = project.panels.filter((p) => p.stringId === s.id).length;
              const wp    = count * project.panelType.wattPeak;
              const inv   = s.inverterId ? (inverterById.get(s.inverterId) ?? '?') : '—';
              const port  = s.inverterId && s.mpptPort ? s.mpptPort : '—';
              const model = s.inverterId ? (inverterModelNames[s.inverterId] ?? '—') : '—';
              const unassigned = !s.inverterId;
              return (
                <div
                  key={s.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    height: PX_STR_ROW,
                    borderBottom: `1px solid ${HL}`,
                    backgroundColor: idx % 2 === 1 ? '#f7f7f8' : undefined,
                    paddingLeft: 6,
                    paddingRight: 6,
                  }}
                >
                  {/* String label */}
                  <span style={{
                    width: 120, flexShrink: 0,
                    fontFamily: SANS, fontSize: 11, fontWeight: 600, color: INK,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {s.label}
                  </span>
                  {/* Color swatch — purely visual, stays in background image */}
                  <div style={{ width: 61, flexShrink: 0 }}>
                    <div style={{
                      width: 10, height: 10, borderRadius: '50%',
                      background: s.color,
                      border: '0.75px solid rgba(0,0,0,0.18)',
                    }} />
                  </div>
                  {/* Panel count */}
                  <span style={{
                    width: 77, flexShrink: 0,
                    fontFamily: SANS, fontSize: 11, color: INK_MID,
                    textAlign: 'right', paddingRight: 12,
                    overflow: 'hidden', whiteSpace: 'nowrap',
                  }}>
                    {String(count)}
                  </span>
                  {/* Wp */}
                  <span style={{
                    width: 93, flexShrink: 0,
                    fontFamily: SANS, fontSize: 11, color: INK_MID,
                    textAlign: 'right', paddingRight: 12,
                    overflow: 'hidden', whiteSpace: 'nowrap',
                  }}>
                    {String(wp)}
                  </span>
                  {/* Inverter */}
                  <span style={{
                    width: 128, flexShrink: 0,
                    fontFamily: SANS, fontSize: 11,
                    color: unassigned ? INK_FAINT : INK_MID,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {inv}
                  </span>
                  {/* MPPT port */}
                  <span style={{
                    width: 77, flexShrink: 0,
                    fontFamily: SANS, fontSize: 11,
                    color: port === '—' ? INK_FAINT : INK_MID,
                    overflow: 'hidden', whiteSpace: 'nowrap',
                  }}>
                    {port}
                  </span>
                  {/* Model */}
                  <span style={{
                    flex: 1,
                    fontFamily: SANS, fontSize: 11,
                    color: model === '—' ? INK_FAINT : INK_MID,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {model}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
