# ADR-010: Group-Based Snapping Grid

- **Status:** Accepted
- **Date:** 2026-04-20
- **Requirement:** Allow panels to be placed in customized, aligned groups rather than being forced onto a single rigid global grid per roof.

## Context
Previously, `snapPanelToGrid` used the roof's centroid as the fixed origin for an invisible global grid. This meant users couldn't start a panel array at an arbitrary offset (e.g., to dodge an obstacle) while still enjoying grid-snapping for the rest of that array.

## Decision
1.  **Panel Groups:** Added `groupId` to the `Panel` interface.
2.  **Adaptive Origin:** Modified the snapping logic. The first panel in a group has no grid snapping (it moves freely over the roof). Its placement then **defines the origin** for a local grid used only by subsequent panels in that same group.
3.  **Active Group State:** Added `activePanelGroupId` to the store. Switching tool modes or explicitly starting a "new group" resets this, allowing the next placement to be free-form again.
4.  **Resumption:** Clicking an existing panel while in "Place Panels" mode activates its group, allowing users to extend existing arrays even after switching tools.

## Consequences
- **Pros:** Combines the flexibility of free-hand placement with the speed and neatness of grid snapping; supports multiple offset arrays on a single roof.
- **Cons:** Slightly more state to track; requires users to understand the "first panel sets the grid" concept.
