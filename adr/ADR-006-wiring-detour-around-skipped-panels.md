# ADR-006: Wiring Detour Around Skipped Panels

- **Status:** Accepted
- **Date:** 2026-04-20
- **Requirement:** When a string's wiring path visually passes over a panel that is **not** part of that string, the reader must be able to tell at a glance that the panel is being skipped — not silently included.

## Context
ADR-003 draws each string as a straight polyline through its panel centers in wiring order. That works well when a string's panels are contiguous, but breaks down as soon as the user lassos a non-contiguous set.

Concrete case: three panels **A, B, C** in a row, string contains A and C but not B. The straight segment `A → C` sweeps right through panel B's rectangle — indistinguishable from "the wire stops at B on the way". A reviewer can't tell whether B belongs to the string, is differently assigned, or is unassigned, without cross-checking the index labels.

Additional constraint from the user: adjacent sub-segments of the **same** string should not cross each other when it's possible to avoid it. Self-crossings suggest a wiring topology that doesn't exist.

## Decision

### 1. Perpendicular detour around off-string panels
A new pure utility `src/utils/stringRouting.ts` exposes `computeStringPath()`. For every adjacent pair of in-string panels `A → B`, it:

1. Finds every off-string panel whose center projects onto the segment within its middle 80% (`T_MIN = 0.1`, `T_MAX = 0.9`) AND whose perpendicular distance to the segment is less than `min(panelW, panelH) × NEAR_LINE_RATIO`.
2. Inserts a waypoint at `panel_center + perpendicular × (min(w,h) × DETOUR_SHORT_RATIO)` for each such panel.

The waypoint sits **inside the skipped panel's rectangle** but **outside its index-number circle** (radius `0.25 × min(w,h)` in `PanelLayer.tsx`). The wire therefore visibly draws over the skipped panel's body while missing its center dot — reading as "passing through, not terminating".

Tuned constants (as of this ADR):
- `NEAR_LINE_RATIO = 0.35` — threshold kept below 0.5 so a line slipping cleanly between two adjacent panels doesn't trigger a spurious detour. At 0.5 exactly, floating-point jitter decided which panel got detoured around; 0.35 leaves a comfortable margin.
- `DETOUR_SHORT_RATIO = 0.42` — well outside the 0.25 index-circle radius, safely inside the panel rectangle.

### 2. Self-crossing avoidance (best-effort)
For each segment that has detour candidates, the utility builds **two** candidate sub-paths — detours on the CCW side (perpendicular rotated +90°) and on the CW side (rotated −90°) — then counts how many already-committed same-string sub-segments each candidate crosses (classic orientation test). It commits whichever has fewer crossings; CCW wins ties.

All detours within a single `A → B` pair share the same side; mixing would zigzag through the segment and look worse than either consistent choice.

We do **not** attempt to resolve crossings that are implied by the user's wiring order itself (only the waypoints we add are under our control).

### 3. Data dependencies
`StringLayer.tsx` now derives its polyline from `computeStringPath(stringPanels, otherPanels, roofsById, panelType, mpp)`. The memo key expanded from `[strings, panels]` to include `roofs`, `panelType`, and `mapState.metersPerPixel`, because panel display size (and therefore the near-line threshold and detour magnitude) depend on all three.

## Consequences

- **Pros:**
  - Non-contiguous string selections are visually unambiguous — the bump around the skipped panel is the affordance.
  - Self-crossings introduced by our own detour insertions are minimized.
  - Logic lives in a pure utility with no React/store imports — consistent with `utils/*` convention; easy to reason about and to unit test if tests are ever added.
- **Cons:**
  - Path computation is now `O(S × K × M)` per render where S = strings, K = avg segments per string, M = other-panel count. Fine for residential-scale projects but would need indexing for hundreds of panels.
  - Heuristic tuning: the three ratios (`T_MIN`/`T_MAX`, `NEAR_LINE_RATIO`, `DETOUR_SHORT_RATIO`) are empirical. Changing panel aspect ratios or index-circle size in `PanelLayer.tsx` may require re-tuning `DETOUR_SHORT_RATIO`.
  - The self-crossing minimization is a two-candidate greedy, not a global optimum. A pathological lasso order could still produce crossings the algorithm can't fix.
  - Memo deps grew — a change to any roof (including tilt/orientation) now invalidates string path memos.
