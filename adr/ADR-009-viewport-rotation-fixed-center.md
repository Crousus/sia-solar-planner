# ADR-009: Viewport Rotation with Fixed-Center Math

- **Status:** Accepted
- **Date:** 2026-04-20
- **Requirement:** Allow users to rotate the canvas to align with non-orthogonal building layouts, making it easier to draw and place panels relative to roof edges.

## Context
Standard maps are North-aligned. Many buildings are tilted relative to North, making drawing on a static 2D grid difficult. Conventional CAD tools allow viewport rotation to solve this.

## Decision
1.  **State Management:** Added `stageRotation` (degrees) to `KonvaOverlay`.
2.  **Screen-Center Rotation:** Implemented custom logic in `handleRotate` and `setRotationAbsolute`. Standard Konva rotation is around the top-left $(0,0)$. Our implementation calculates the current screen center in world coordinates and adjusts the `stagePos` during rotation so the canvas appears to spin perfectly around the user's focus point.
3.  **Rotation-Invariant Zoom:** Updated the wheel-zoom math. Instead of simple $(pos - offset)/scale$ arithmetic, it now uses Konva's absolute transform matrix to find the world point under the cursor, ensuring zoom remains anchored to the mouse pointer even when the world is rotated.
4.  **UI Controls:** Added a floating rotation panel and supported Middle-Mouse-Button (scroll wheel) horizontal dragging for smooth, seamless rotation.
5.  **Alignment Feature:** Added a "magic button" on roof edges that aligns the viewport perfectly parallel to that specific edge when clicked.

## Consequences
- **Pros:** Makes complex layouts much easier to manage; professional CAD-like feel; alignment tool provides extreme precision.
- **Cons:** Coordinate math becomes significantly more complex (matrix inversion vs. scalar division).
