# ADR-003: String Wiring Visualization

- **Status:** Accepted
- **Date:** 2026-04-20
- **Requirement:** Provide a visible connection between panels assigned to the same string to indicate the physical wiring path.

## Context
While panels show their `indexInString` as a number, it's hard to quickly visualize the overall "snake" or wiring path across a roof, especially for larger or complex string layouts. A continuous line makes the installation sequence immediately intuitive.

## Decision
1.  **New Component:** Created `src/components/StringLayer.tsx`.
2.  **Logic:** For each string, panels are filtered and sorted by `indexInString`. A flattened array of their centers `(cx, cy)` is passed to a Konva `Line`.
3.  **Styling:** 
    *   **Color:** Uses the existing string color.
    *   **Style:** Dashed line (`dash: [10, 5]`) with a subtle drop shadow to ensure visibility over satellite imagery and colored panels.
    *   **Layering:** Placed between `RoofLayer` and `PanelLayer`. This keeps the line visible but ensures it doesn't obscure the panel numbers.
4.  **Interaction:** The layer is marked as `listening={false}` so it doesn't intercept clicks meant for panels or roofs.

## Consequences
- **Pros:** Immediate visual feedback during string assignment; clear installation plan for the user; makes "holes" in a string (missing indices) obvious.
- **Cons:** Adds slight rendering overhead, though `useMemo` minimizes re-calculation of the flattened point arrays.
