# ADR-005: String Color Customization

- **Status:** Accepted
- **Date:** 2026-04-20
- **Requirement:** Allow users to change the color of individual PV strings from the sidebar.

## Context
While the app provides a default color palette for new strings, users may want to customize colors for better grouping, specific inverter matching, or simply personal preference. Previously, string colors were immutable after creation.

## Decision
1.  **Store Action:** Added `updateString(id, changes)` to `projectStore.ts` to allow modifying any `PvString` field.
2.  **UI Integration:** Added a native `<input type="color">` to the string list in `Sidebar.tsx`.
3.  **Clean Styling:** Used a "hidden input + styled swatch" pattern to keep the UI clean. Clicking the color swatch opens the browser's color picker, while clicking the string label still activates the "paint" mode.
4.  **Instant Update:** Because the color is central to both `PanelLayer` and `StringLayer`, changing the color in the sidebar immediately updates the panels and wiring lines on the canvas.

## Consequences
- **Pros:** Full flexibility for the user to manage their project's visual organization; no new dependencies (uses browser native picker).
- **Cons:** Native color pickers vary by OS/browser, but are generally reliable for hex selection.
