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
// DiagramView — the A4 container that wraps the electrical block-diagram UI.
//
// Rendered as the right-hand pane when Sidebar's view-toggle is set to
// "diagram" (alternative to the roof-plan canvas). Visual layout (top to
// bottom within the dark surround):
//
//   [A4 sheet]
//     ├─ title strip ("ELECTRICAL BLOCK DIAGRAM / project name")
//     ├─ DiagramCanvas (React Flow, fills remaining height)
//     └─ DiagramMetaTable (engineering title block)
//
// The node-insert palette ("Add switch / fuse / battery / …") lives in
// the main app Toolbar, swapped in for the roof-plan controls when
// `activeView === 'diagram'`. Keeping authoring controls in the single
// top header (rather than a floating rail above the sheet) means the
// user never sees two toolbars competing for attention, and nothing
// extraneous leaks into the html2canvas capture of the sheet.
//
// Why a fixed-pixel A4 sheet rather than a responsive flex canvas:
//   - The PDF export rasterises this element via html2canvas; a fixed
//     pixel size means the screenshot is deterministic regardless of the
//     viewport. 1122×794 px = 297×210 mm at 96 dpi (A4 landscape).
//   - The user gets a "WYSIWYG" preview — what they see here is exactly
//     what lands on the printed sheet.
// ────────────────────────────────────────────────────────────────────────────

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../store/projectStore';
import DiagramCanvas from './diagram/DiagramCanvas';
import DiagramMetaTable from './diagram/DiagramMetaTable';

// A4 landscape at 96 dpi: 297mm × 210mm → 1122×794 px.
// Extracted as constants so they're discoverable from a single place if
// we ever switch to portrait or a different DPI target for export.
const A4_W = 1122;
const A4_H = 794;

// Register-mark primitive used on all four corners of the A4 sheet. Sells
// the "technical drawing" feel without adding real content. Rendered as an
// absolutely-positioned cross — two hairlines in a plus-shape — offset
// slightly outside the sheet so the corner reads clearly against the dark
// surround. Uses the same --hairline-strong token as other app dividers so
// the marks feel native rather than bespoke.
function RegisterMark({ corner }: { corner: 'tl' | 'tr' | 'bl' | 'br' }) {
  // Build the cross from two lines: a horizontal and a vertical segment
  // that intersect at the sheet's corner. The segment that points
  // "outward" is longer than the inner one so the L reads as a printer's
  // corner mark rather than a plus sign.
  const ARM = 10;
  const COLOR = 'rgba(255, 255, 255, 0.18)';
  const positions: Record<typeof corner, React.CSSProperties> = {
    tl: { top: -ARM, left: -ARM },
    tr: { top: -ARM, right: -ARM },
    bl: { bottom: -ARM, left: -ARM },
    br: { bottom: -ARM, right: -ARM },
  };
  return (
    <span
      aria-hidden="true"
      className="absolute pointer-events-none select-none"
      style={{ ...positions[corner], width: ARM * 2, height: ARM * 2 }}
    >
      <span
        className="absolute"
        style={{
          top: ARM - 0.5,
          left: 0,
          width: ARM * 2,
          height: 1,
          background: COLOR,
        }}
      />
      <span
        className="absolute"
        style={{
          top: 0,
          left: ARM - 0.5,
          width: 1,
          height: ARM * 2,
          background: COLOR,
        }}
      />
    </span>
  );
}

export default function DiagramView() {
  const { t } = useTranslation();
  // Bootstrap on first mount — if the project doesn't yet have a diagram
  // (e.g. legacy projects created before this feature), the store action
  // seeds a sensible default layout derived from current inverters/strings.
  // No-op when a diagram already exists, so this is cheap to run on every
  // mount.
  const bootstrapDiagram = useProjectStore((s) => s.bootstrapDiagram);
  // Read the project name so the sheet's title strip can echo it — turns
  // the A4 into a self-identifying drawing rather than a generic canvas.
  const projectName = useProjectStore((s) => s.project.name);

  useEffect(() => {
    bootstrapDiagram();
  }, [bootstrapDiagram]);

  return (
    // Outer: dark "drafting table" with the app's atmospheric blue bloom.
    // `canvas-bg` is the same dot-grid-plus-bloom treatment used when the
    // roof-plan canvas is displayed without its satellite backdrop — reusing
    // it unifies the two views behind one consistent environment.
    //
    // Scroll behavior:
    //   `h-full w-full` pins the outer to its parent's <main> box. <main>
    //   is `flex-1 relative overflow-hidden` in App.tsx — crucially NOT a
    //   flex container itself, so a `flex-1` here would be a no-op and
    //   the div would balloon to its content height, defeating
    //   `overflow-auto`. Taking the height from the block-positioning
    //   parent with `h-full` is what gives the scroll container a
    //   bounded ceiling to scroll against.
    //
    //   `overflow-auto` on that bounded box handles both axes. The inner
    //   wrapper below uses `w-max min-w-full mx-auto` so horizontal
    //   scroll triggers when the viewport is narrower than the 1122 px
    //   A4 sheet (plain `flex-col items-center` was the classic
    //   centered-overflow footgun — flex centering clips children
    //   instead of exposing a horizontal scrollbar).
    <div className="h-full w-full overflow-auto canvas-bg">
      {/* Inner wrapper:
            - `w-max` lets the box grow with its widest child (the A4
              sheet at 1122 px) so the outer `overflow-auto` container
              exposes a horizontal scrollbar when the viewport is narrower.
            - `min-w-full` ensures the wrapper is still at least as wide
              as the viewport so `mx-auto` can center it when there's
              room; without this the wrapper shrinks to its content and
              centering wouldn't work.
            - `mx-auto` centers horizontally when viewport > content.
            - Vertical padding provides breathing room; vertical overflow
              naturally triggers when content taller than viewport. */}
      <div className="w-max min-w-full mx-auto py-8 px-6 flex flex-col items-center gap-5">
      {/* A4 sheet wrapper — positioned relative so the register-mark pseudo
          elements can sit at its corners. `flexShrink: 0` stops the flex
          parent from squeezing the sheet on narrow viewports; we'd rather
          scroll than distort the aspect ratio. */}
      <div
        className="relative"
        style={{ width: A4_W, height: A4_H, flexShrink: 0 }}
      >
        <RegisterMark corner="tl" />
        <RegisterMark corner="tr" />
        <RegisterMark corner="bl" />
        <RegisterMark corner="br" />

        {/*
          The A4 sheet itself. `data-diagram-view` is the export hook —
          html2canvas selects this element during PDF export so only the
          sheet is captured (not the surrounding dark chrome or the
          floating toolbar above it).

          Transparent background — the sheet's fill IS the surround's
          atmospheric canvas-bg, so the two read as one continuous surface.
          A single 1px hairline border (the app's --hairline-strong token,
          same as other dividers) is all that marks the A4 bounds, which
          is exactly the cue needed for "this rectangle will be exported
          as A4" without the sheet looking like a foreign element.
        */}
        <div
          data-diagram-view
          style={{
            width: '100%',
            height: '100%',
            background: 'transparent',
            border: '1px solid var(--hairline-strong)',
          }}
          className="flex flex-col relative"
        >
          {/* Top title strip — engineering drawing title line. Transparent
              background so the atmospheric surround bleeds through; only
              the hairline bottom rule inks the boundary between the title
              line and the drawing area. Typography shifts to ink-100/400
              tones to match the rest of the app's dark chrome. */}
          <div
            className="flex items-center gap-3 px-5 py-2 shrink-0"
            style={{ borderBottom: '1px solid var(--hairline)' }}
          >
            <span
              className="uppercase"
              style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: '0.18em',
                color: 'var(--ink-200)',
              }}
            >
              {t('diagram.titleBlock.heading')}
            </span>
            <span
              style={{
                flex: 1,
                height: 1,
                background:
                  'linear-gradient(90deg, var(--hairline-strong), rgba(255,255,255,0.02) 80%, transparent)',
              }}
            />
            <span
              className="truncate"
              style={{
                fontFamily: "'Geist', ui-sans-serif, system-ui, sans-serif",
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--ink-200)',
                maxWidth: '60%',
              }}
            >
              {projectName}
            </span>
          </div>

          {/* React Flow fills the remaining vertical space between the
              title strip and the title block. `min-h-0` is the classic
              flex escape hatch so the child isn't stretched by its
              intrinsic content height. */}
          <div className="flex-1 min-h-0">
            <DiagramCanvas />
          </div>

          <DiagramMetaTable />
        </div>
      </div>
      </div>
    </div>
  );
}
