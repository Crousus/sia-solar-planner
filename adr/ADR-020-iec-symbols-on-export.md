# ADR-020: Standard (IEC 60617) symbols for the block diagram on export

**Status:** Accepted

**Date:** 2026-10-11

## Requirement

Keep editing the block diagram in the app's own visual design, but let the
user choose at export time to print the diagram with official electrical
schematic symbols instead.

## Context

- The editor draws nodes as dark "chips" with colored accents (BaseNode) plus
  three custom drawings (switch, FRE device, house). They are easy to work
  with on screen but are not what an electrician or a utility expects on a
  submitted plan.
- The PDF diagram page is a raster capture of the rendered `DiagramView`
  (html-to-image) plus re-emitted PDF text (ADR-018). Whatever the DOM
  shows is what prints.
- Node positions are top-left corners, edges attach to handles on the node
  box, and the canvas snaps node centres to a grid. A symbol with a
  different box size would move every attached wire.

## Decision

1. **Render-time style, not document state.** `DiagramSymbolStyle =
   'app' | 'iec'` (`components/diagram/symbolStyle.ts`) is provided through
   React context by `DiagramView` (`symbolStyle` prop, default `'app'`) and
   read by every node and by `EditableSmoothStepEdge`. Nothing is persisted
   or synced; the editor always renders `'app'`.
2. **Same box, different drawing.** In `'iec'` style a chip node keeps its
   chip content laid out but `visibility: hidden` as a sizer, so the node's
   measured size, handle positions, snap centre and edge routing are
   identical. An overlay draws the IEC glyph (`nodes/IecSymbols.tsx`)
   centred in the box, conductor stubs from each *connected* handle to the
   glyph, and the label/sublabel to the right of the glyph (above / below
   the horizontal centre line, so a wire entering from the right passes
   between them). The inverter also prints its name (`iecDesignation`).
   Switch, FRE and consumer swap their SVG inside the existing fixed-size
   wrappers. Edges get square corners.
3. **Symbols** (IEC 60617 general forms, simplified): PV generator (box +
   cell + light arrows), inverter (box + diagonal, `=` / `~`), fuse (box with
   conductor through, axial), battery (two cells, axial, `+`), DC switch as
   a disconnector (bar on the fixed contact, open), grid connection (box +
   `~`), consumer as the general component rectangle, FRE as a device box
   with the antenna symbol and an output contact. Axial symbols lie
   horizontal when the node is only wired from the sides.
4. **Export flow.** The Export button opens a menu: "app design" or
   "standard symbols". For `'iec'` the diagram page is always rendered
   offscreen (`<DiagramView exportMode symbolStyle="iec">`, fitted to the
   nodes) because the on-screen view is in app style.
5. **Ink.** Glyphs and stubs use `--iec-ink`, a solid tone that the
   `[data-pdf-export]` print theme sets to the printed edge colour
   (#4d4d4d), so overlapping strokes don't print darker at joints.

## Consequences

- The plan can be submitted with standard symbols without maintaining a
  second diagram or changing the editing experience.
- Adding a node type now also means adding its IEC glyph (BaseNode requires
  `iecGlyph`).
- An IEC export ignores the user's on-screen pan/zoom for the diagram page
  (fitted instead); the app-design export keeps using the mounted view.
- Labels sit to the right of the symbol and can extend past the node box;
  very long labels can run into a neighbouring node on a crowded sheet.
- The symbols are simplified general forms, not a certified symbol library;
  utility-specific conventions (e.g. a meter or a specific switch-
  disconnector qualifier) would be new glyphs.
- Found while building this, fixed for both styles: connected handle dots
  printed half-visible (mid-transition at capture time), edge-label chips
  printed as black boxes, and left-aligned PDF text wrapped early because
  Helvetica sets wider than Geist.
