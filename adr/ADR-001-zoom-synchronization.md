# ADR-001: Zoom Synchronization (Locked Map)

- **Status:** Superseded by [ADR-007](ADR-007-snapshot-on-lock.md) (2026-04-20)
- **Date:** 2026-04-20
- **Requirement:** Allow zooming into the map while it's locked, ensuring the drawn elements (roofs/panels) scale correctly with the background imagery.

## Context
When the map is locked, Leaflet interactions were previously disabled to prevent the drawing layer from drifting away from the satellite view. However, users need to zoom in for more precise editing. Simple Leaflet zooming only affects the map layer; the Konva overlay previously remained at a 1:1 scale, causing the drawings to become misaligned with the imagery.

## Decision
1.  **Map Interaction:** Enable `touchZoom`, `scrollWheelZoom`, and other zoom handlers in Leaflet even when the map is locked, while keeping `dragging` disabled to maintain the project center.
2.  **Zoom Constraints:** Set `map.setMinZoom()` to the locked zoom level to prevent zooming out further than the project's original boundaries.
3.  **Dynamic Scaling:** Implement a real-time zoom listener in `KonvaOverlay`. The overlay's stage uses `scaleX` and `scaleY` based on the difference between the current zoom and the locked zoom ($2^{\Delta z}$).
4.  **Coordinate Transformation:** Offset the stage to scale around the viewport center. Update the `getPointer` function to use `stage.getAbsoluteTransform().invert()` to ensure coordinates remain consistent in the original "locked" pixel space regardless of zoom level.

## Consequences
- **Pros:** Users can edit with high precision; the imagery and drawings stay perfectly aligned; no change to the underlying coordinate system (storage is still in "locked pixels").
- **Cons:** Slightly increased complexity in pointer event handling; potential for blurring if zooming far beyond the satellite imagery's resolution.
