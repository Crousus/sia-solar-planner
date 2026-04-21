# ADR-008: Inverter-Centric Workflow

- **Status:** Accepted
- **Date:** 2026-04-20
- **Requirement:** Simplify the association between inverters and strings, especially when a project has multiple inverters and many strings per inverter.

## Context
Previously, new strings were created with `inverterId: null`. Users had to manually select the correct inverter from a dropdown for every single string. In projects with 3+ inverters and 10+ strings, this became a repetitive and error-prone task.

## Decision
1.  **Selectable Inverters:** Added `selectedInverterId` to the UI state in `projectStore.ts`.
2.  **UI Feedback:** Updated `Sidebar.tsx` to render a custom radio-style indicator next to each inverter. Clicking an inverter row selects it (only one at a time).
3.  **Default Assignment:** Modified `addString()` in the store to automatically assign the currently selected inverter to any newly created string.
4.  **Automatic Selection:** New inverters are automatically selected upon creation to streamline the "Add Inverter -> Add its Strings" workflow.

## Consequences
- **Pros:** Significantly faster workflow for complex projects; reduces the number of clicks; provides a clear "active context" for string creation.
- **Cons:** Users must remember to deselect or switch inverters if they want to create an unassigned or differently assigned string.
