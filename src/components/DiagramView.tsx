// ────────────────────────────────────────────────────────────────────────────
// DiagramView — the A4 container that wraps the electrical block-diagram UI.
//
// Rendered as the right-hand pane when Sidebar's view-toggle is set to
// "diagram" (alternative to the roof-plan canvas). Structure:
//   [DiagramToolbar]       ← node-add buttons / export / etc.
//   [DiagramCanvas]        ← React Flow canvas, fills remaining height
//   [DiagramMetaTable]     ← footer table summarising the diagram
//
// Why a fixed-pixel A4 sheet rather than a responsive flex canvas:
//   - The PDF export rasterises this element via html2canvas; a fixed
//     pixel size means the screenshot is deterministic regardless of the
//     viewport. 1122×794 px = 297×210 mm at 96 dpi (A4 landscape).
//   - The user gets a "WYSIWYG" preview — what they see here is exactly
//     what lands on the printed sheet.
// ────────────────────────────────────────────────────────────────────────────

import { useEffect } from 'react';
import { useProjectStore } from '../store/projectStore';
import DiagramCanvas from './diagram/DiagramCanvas';
import DiagramToolbar from './diagram/DiagramToolbar';
import DiagramMetaTable from './diagram/DiagramMetaTable';

// A4 landscape at 96 dpi: 297mm × 210mm → 1122×794 px.
// Extracted as constants so they're discoverable from a single place if
// we ever switch to portrait or a different DPI target for export.
const A4_W = 1122;
const A4_H = 794;

export default function DiagramView() {
  // Bootstrap on first mount — if the project doesn't yet have a diagram
  // (e.g. legacy projects created before this feature), the store action
  // seeds a sensible default layout derived from current inverters/strings.
  // No-op when a diagram already exists, so this is cheap to run on every
  // mount.
  const bootstrapDiagram = useProjectStore((s) => s.bootstrapDiagram);

  useEffect(() => {
    bootstrapDiagram();
  }, [bootstrapDiagram]);

  return (
    // Outer: dark "drafting table" background that the white A4 sheet sits
    // on top of. `overflow-auto` so very small viewports still give the
    // user a way to scroll to all four corners of the sheet.
    <div className="flex-1 overflow-auto bg-slate-700 flex items-start justify-center p-6">
      {/*
        The A4 sheet itself. `data-diagram-view` is the export hook —
        html2canvas selects this element during PDF export so only the
        sheet is captured (not the surrounding dark chrome). `flexShrink:
        0` stops the flex parent from squeezing the sheet on narrow
        viewports; we'd rather scroll than distort the aspect ratio.
      */}
      <div
        data-diagram-view
        style={{ width: A4_W, height: A4_H, flexShrink: 0 }}
        className="bg-white shadow-2xl flex flex-col"
      >
        <DiagramToolbar />
        {/* React Flow fills the remaining vertical space between the
            toolbar and the meta table. `min-h-0` is the classic flex
            escape hatch so the child isn't stretched by its intrinsic
            content height. */}
        <div className="flex-1 min-h-0">
          <DiagramCanvas />
        </div>
        <DiagramMetaTable />
      </div>
    </div>
  );
}
