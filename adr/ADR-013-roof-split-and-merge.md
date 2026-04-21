# ADR-013: Roof Split and Merge via Draw-Roof Overload

- **Status:** Accepted
- **Date:** 2026-04-21
- **Requirement:** Let users subdivide a roof by drawing a cut across it, and recombine two adjacent roofs by removing their shared edge, without introducing a separate tool mode.

## Context
Rectangular roofs often need to be split later: the user discovers two different pitches, finds a chimney that bisects the array, or realizes a single polygon is hiding two distinct planes. The inverse happens when a roof was over-decomposed and should actually be one surface.

Before this change, the only workflow was delete-and-redraw — which also deletes every panel and string assignment on the roof. That punishes the user for a small geometric correction and makes iteration painful.

Two design pressures shaped the decision:
1. **No new tool mode.** The toolbar is already dense (`r/p/s/d`) and the split action is semantically a variant of "drawing a roof". Adding a fifth mode would require a keybind, an icon, and teach-the-user surface area for what is effectively "draw, but inside an existing polygon".
2. **Panels must survive.** A split or merge that silently reassigned panels to arbitrary halves would break string wiring (strings carry a snake-ordered `indexInString` that depends on panel positions). The implementation has to preserve `roofId` identity for the dominant half and renumber strings deterministically around merges.

## Decision

1. **Overload `draw-roof`.** The first vertex of a new polyline is hit-tested against every existing roof's boundary (tolerance 8 px, same as the snap system). If it lands on a boundary, the store records a `splitCandidateRoofId`. Subsequent clicks behave normally (build up a polyline) until another vertex lands on the same roof's boundary — at which point the polyline becomes a cut and `splitRoof` fires instead of `addRoof`. Enter and double-click also commit the cut if the last vertex is on-boundary; Escape clears the candidate. The "click the first vertex to close" path still works and creates a regular new roof.

2. **Polygon geometry isolated in a new module.** `src/utils/polygonCut.ts` holds four pure functions: `pointOnPolygonBoundary`, `splitPolygon`, `findSharedEdge`, `mergePolygons`. The module imports only from `types` — no cross-imports from sibling utils, even for point-in-polygon (duplicated from `geometry.ts` on purpose). Keeping the unit self-contained means the split/merge logic is test-ready independently and never accidentally couples to the store or Konva.

3. **Survivor rule on split: majority panel count wins.** When a cut is committed, the half containing more panel centers keeps the original roof's id, name, tilt, and orientation. The other half becomes a brand-new empty roof inheriting only tilt + orientation. Ties break by area (larger survives). Crucially, **all panels stay on the original `roofId`** even if they geometrically fall inside the new half — this is an explicit choice: re-homing panels across ids would invalidate the group-based snap grid (ADR-010) and scatter strings across two different roofs. The user can move panels manually if the default is wrong. String `indexInString` values are untouched because no panel changed `roofId`.

4. **Merge trigger: right-click on a shared edge.** In `draw-roof` mode, right-clicking the per-edge hit-area of a roof checks whether that roof shares any edge with another roof (within 2 px tolerance). If yes, `mergeRoofs` fires; if no, silent no-op. The larger-area roof survives; the smaller is absorbed, its panels reassigned to the survivor, and every affected string renumbered via `renumberStrings` to restore the snake order across the reshaped polygon. A browser `confirm()` prompts before destructive merges where either roof has panels.

5. **Ephemeral state in the store, not component-local.** `splitCandidateRoofId` lives on the Zustand store even though only `KonvaOverlay` drives it. Rationale: the hint banner in `App.tsx` reads it too, and plumbing a prop through `KonvaOverlay` for a purely transient UI flag would bloat the component interface. The field is excluded from persistence by the existing `partialize` (which only persists `project`).

## Consequences
- **Pros:** Common post-hoc geometry fixes no longer require rebuilding panels + strings. Split and merge compose with the existing snap and drawing-guide systems (no new code paths in `drawingSnap.ts`). The polygon-cut module is pure and self-contained, so future features (overlap resolution, split-by-obstacle) can reuse it without importing the store.
- **Cons:** Overloading `draw-roof` means the mode now has three possible outcomes per commit (new-roof, split, no-op). The state machine is discoverable only via the hint banner that appears once a cut candidate is set. The "panels stay on original roofId across a split" rule can visually confuse users whose panels end up on top of a different roof's polygon — mitigated by manual relocation but not surfaced in the UI.
