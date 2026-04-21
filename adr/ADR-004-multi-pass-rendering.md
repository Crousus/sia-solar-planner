# ADR-004: Multi-Pass Panel Rendering for Wiring Clarity

- **Status:** Accepted
- **Date:** 2026-04-20
- **Requirement:** Ensure wiring lines are distinct and match the darkened color of the panel dots, without color mixing from semi-transparent panels.

## Context
Solar panels are rendered with 85% opacity to allow the satellite imagery to peek through. Wiring lines, if rendered behind panels, appear lighter and blueish because they are viewed through the panel's color. Rendering the lines entirely on top of the panels would obscure the sequence numbers.

## Decision
1.  **Two-Pass Rendering:** Refactored `PanelLayer.tsx` to support a `renderPass` prop (`'base'` or `'labels'`).
2.  **Layering Stack:** Reordered the rendering in `KonvaOverlay.tsx`:
    *   `PanelLayer (renderPass="base")`: Renders the panel rectangles.
    *   `StringLayer`: Renders the wiring lines. Because they are on top of the base panels, there is no color mixing or occlusion.
    *   `PanelLayer (renderPass="labels")`: Renders the dark dots and white numbers on top of everything.
3.  **Consistency:** Ensured both the `StringLayer` wiring and `PanelLayer` dots use the exact same `darkenColor(base, 0.85)` calculation.

## Consequences
- **Pros:** Perfect color matching between wiring and dots; significantly improved visual clarity; wiring "snake" is clearly visible across the entire path.
- **Cons:** Slightly more complexity in the component structure, but performance remains high as Konva handles the multiple layers efficiently.
