# ADR-002: Painting-Style String Assignment

- **Status:** Accepted
- **Date:** 2026-04-20
- **Requirement:** Replace the rectangle lasso for string assignment with a "painting" interaction where dragging over panels or clicking them assigns them to the active string.

## Context
The previous rectangle lasso was precise but felt clunky for complex, non-rectangular string layouts. Users often want to "trace" the path of the wiring by dragging the mouse over panels in order. The selection box was also visually noisy for a process that is essentially a sequential assignment.

## Decision
1.  **Remove Lasso:** Deleted `StringLasso.tsx` and all rectangle-math state (`lassoRect`) from `KonvaOverlay.tsx`.
2.  **Paint Mode:** Introduced an `isPainting` state in `KonvaOverlay`. It is active during `mousedown` while the `assign-string` tool is selected.
3.  **Real-time Hit Testing:** On every `mousemove` during painting, the app performs a distance-based hit test (15px radius) from the cursor to all panel centers.
4.  **Immediate Feedback:** If a panel is hit and not already in the active string, it is immediately assigned via `assignPanelsToString([hit.id], sid)`.
5.  **Click Support:** `handleMouseDown` also calls the hit-test logic, enabling single-click assignment.

## Consequences
- **Pros:** Much more fluid interaction; naturally supports "S-shaped" or complex wiring paths; simplified UI (no dashed boxes).
- **Cons:** Less precise for bulk-selecting 50+ panels at once (requires "painting" over them), but the typical string size (10-20 panels) makes this a non-issue.
