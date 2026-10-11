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
// IEC 60617 schematic glyphs for the 'iec' diagram symbol style (ADR-020).
//
// Each glyph is drawn in a 44 × 44 viewBox whose edge midpoints are where the
// wires attach (the overlay in BaseNode draws stubs from the node's
// connected handles to exactly those points). Ink is `currentColor`, which
// the overlay sets to `--iec-ink` — a solid tone that matches the printed
// edge stroke, so stubs, symbols and wires read as one line weight on paper
// with no darker alpha overlaps at the joints.
//
// Symbols (IEC 60617 / DIN EN 60617 general forms, simplified):
//   PV generator  box + photovoltaic cell (long / short plate) + incident-
//                 light arrows
//   inverter      box + diagonal, "=" upper-left, "~" lower-right
//   fuse          narrow box with the conductor running through it
//   battery       two cells (long thin + short thick plate), "+" marked
//   grid          box + "~" (AC supply / network connection)
// Fuse and battery are axial: they turn to horizontal when the node is only
// wired from the left/right.
// ────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from 'react';

/** Rendered size of a glyph in the node (px). Glyphs are DRAWN in a 44-unit
 *  viewBox and scaled up, which also brings the 1.6-unit strokes to ≈ 1.9 px
 *  — the weight of the 2 px wires. */
export const IEC_GLYPH_SIZE = 52;
const VIEW = 44;

export interface IecGlyphProps {
  /** Lay an axial symbol (fuse, battery) along the horizontal axis. */
  horizontal?: boolean;
}

export type IecGlyph = (props: IecGlyphProps) => ReactNode;

const STROKE = 1.6;

function Svg({ children, rotate = false }: { children: ReactNode; rotate?: boolean }) {
  const c = VIEW / 2;
  return (
    <svg
      width={IEC_GLYPH_SIZE}
      height={IEC_GLYPH_SIZE}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="square"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <g transform={rotate ? `rotate(90 ${c} ${c})` : undefined}>{children}</g>
    </svg>
  );
}

/** Square symbol outline, inset by half the stroke so it stays inside 44 px. */
const Box = () => <rect x={0.8} y={0.8} width={42.4} height={42.4} />;

/** Arrow pointing down-right ending at (x, y) — incident light on the cell. */
const LightArrow = ({ x, y }: { x: number; y: number }) => (
  <>
    <line x1={x - 8} y1={y - 8} x2={x} y2={y} />
    <polyline points={`${x - 4},${y} ${x},${y} ${x},${y - 4}`} strokeLinecap="butt" />
  </>
);

export const IecPvGenerator: IecGlyph = () => (
  <Svg>
    <Box />
    <LightArrow x={13} y={17} />
    <LightArrow x={18} y={12} />
    {/* Leads from the top / bottom attachment points to the cell. */}
    <line x1={22} y1={1} x2={22} y2={25} />
    <line x1={22} y1={31} x2={22} y2={43} />
    {/* Cell: long thin plate (+) over short thick plate (−). */}
    <line x1={12} y1={25} x2={32} y2={25} />
    <line x1={17} y1={31} x2={27} y2={31} strokeWidth={3.2} strokeLinecap="butt" />
  </Svg>
);

export const IecInverter: IecGlyph = () => (
  <Svg>
    <Box />
    <line x1={1} y1={43} x2={43} y2={1} />
    {/* "=" — DC side */}
    <line x1={7} y1={10} x2={17} y2={10} />
    <line x1={7} y1={14} x2={17} y2={14} />
    {/* "~" — AC side */}
    <path d="M26 33 q2.75 -5 5.5 0 t5.5 0" strokeLinecap="round" />
  </Svg>
);

export const IecFuse: IecGlyph = ({ horizontal }) => (
  <Svg rotate={horizontal}>
    <rect x={15} y={7} width={14} height={30} />
    <line x1={22} y1={0} x2={22} y2={44} />
  </Svg>
);

export const IecBattery: IecGlyph = ({ horizontal }) => (
  <Svg rotate={horizontal}>
    <line x1={22} y1={0} x2={22} y2={13} />
    <line x1={10} y1={13} x2={34} y2={13} />
    <line x1={16} y1={18} x2={28} y2={18} strokeWidth={3.2} strokeLinecap="butt" />
    {/* Dashed link = "further cells" */}
    <line x1={22} y1={18} x2={22} y2={26} strokeDasharray="2 2" strokeLinecap="butt" />
    <line x1={10} y1={26} x2={34} y2={26} />
    <line x1={16} y1={31} x2={28} y2={31} strokeWidth={3.2} strokeLinecap="butt" />
    <line x1={22} y1={31} x2={22} y2={44} />
    {/* "+" at the positive (long) plate — drawn, not text, so it rotates
        with the symbol and stays out of the PDF text-extraction pass. */}
    <line x1={35} y1={7} x2={41} y2={7} strokeLinecap="butt" />
    <line x1={38} y1={4} x2={38} y2={10} strokeLinecap="butt" />
  </Svg>
);

export const IecGrid: IecGlyph = () => (
  <Svg>
    <Box />
    <path d="M10 22 q3 -7 6 0 t6 0 t6 0 t6 0" strokeLinecap="round" />
  </Svg>
);
