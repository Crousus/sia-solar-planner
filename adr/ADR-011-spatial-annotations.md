# ADR-011: Automated Spatial Annotations

- **Status:** Accepted
- **Date:** 2026-04-20
- **Requirement:** Provide users and installation crews with real-world dimensions (in meters) for both building outlines and panel arrays.

## Context
While the planner was visually accurate, users had to guess lengths or use external tools to verify if the plan actually fit the building.

## Decision
1.  **Roof Edge Labels:** Implemented automated labeling of every committed roof edge. Math: $lengthPx \times metersPerPixel$.
2.  **Panel Array Dimensions:** Built a "Perimeter Run" detection algorithm (`getPanelGroupDimensions` in `geometry.ts`). It identifies contiguous horizontal or vertical runs of panels and labels their total real-world length if they are longer than a single panel.
3.  **Readability:** Implemented automated text flipping (90/270 degree normalization) so labels never appear upside-down regardless of viewport rotation.
4.  **Scaling:** Labels are scaled by `1/stageScale` to remain readable at high zoom levels without becoming massive.

## Consequences
- **Pros:** Instant feedback on roof and array sizes; provides a "ready for construction" level of detail in the PDF export.
- **Cons:** Labels can occasionally overlap in very dense or complex geometries (mitigated by outward normal offsets).
