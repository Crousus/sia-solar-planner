# Hardware Catalog Design

**Date:** 2026-04-23
**Status:** Approved

## Overview

Introduce a global hardware catalog for PV panel models and inverter models. Projects reference catalog entries via proper PocketBase relation fields (for panels) and inline IDs in the project doc (for inverters), giving live reference semantics: catalog edits propagate to all projects using that entry.

---

## 1. Data Model

### 1.1 `panel_models` collection (global, no team field)

| Field | Type | Required | Notes |
|---|---|---|---|
| `manufacturer` | text | yes | max 100 |
| `model` | text | yes | max 100, e.g. "SPR-MAX3-400" |
| `widthM` | number | yes | real-world short side, meters |
| `heightM` | number | yes | real-world long side, meters |
| `wattPeak` | number | yes | nameplate watts |
| `efficiencyPct` | number | no | e.g. 21.4 for 21.4% |
| `weightKg` | number | no | for roof load documentation |
| `voc` | number | no | open-circuit voltage, V |
| `isc` | number | no | short-circuit current, A |
| `vmpp` | number | no | max-power-point voltage, V |
| `impp` | number | no | max-power-point current, A |
| `tempCoefficientPmax` | number | no | %/°C, typically negative |
| `warrantyYears` | number | no | product warranty |
| `datasheetUrl` | url | no | link to manufacturer PDF |
| `deleted` | bool | no | default false; soft-delete flag |

### 1.2 `inverter_models` collection (global, no team field)

| Field | Type | Required | Notes |
|---|---|---|---|
| `manufacturer` | text | yes | max 100 |
| `model` | text | yes | max 100 |
| `maxAcPowerW` | number | yes | nominal AC output, W |
| `maxDcPowerW` | number | no | max DC input, W |
| `efficiencyPct` | number | no | max efficiency % |
| `phases` | number | no | 1 or 3 |
| `maxStrings` | number | no | max MPPT / string inputs |
| `maxInputVoltageV` | number | no | max Voc input, V |
| `datasheetUrl` | url | no | |
| `deleted` | bool | no | default false; soft-delete flag |

### 1.3 Auth rules (both collections)

Any authenticated user may list/view/create/update. Any authenticated user may call delete — the delete handler enforces soft-delete-if-referenced at the app level (no PocketBase rule complexity needed).

### 1.4 `projects.panel_model` relation field

New optional relation field on the `projects` collection:
- FK → `panel_models.id`
- `cascadeDelete: false` — deleting a model does not cascade to projects
- `required: false` — existing projects without a catalog link continue to work

No equivalent top-level field for inverters: inverter model links live inside `doc` (see §2).

---

## 2. Live Reference Semantics

### 2.1 Panel model

On project load the client fetches the project record with `expand=panel_model,customer`. If `expand.panel_model` is present it is used as the runtime `panelType`; the store never writes back to `doc.panelType` for catalog-linked projects.

Legacy projects (no `panel_model` FK) continue to use `doc.panelType` as today. No forced migration.

Changing the panel model PATCHes `projects.panel_model` directly (a PocketBase field, not a doc JSON patch) — the same mechanism as `projects.customer`.

### 2.2 Inverter models

`Inverter` in `src/types/index.ts` gains `inverterModelId?: string | null`. On project load the store batch-fetches all referenced `inverter_models` IDs in one call (`filter=id~"id1,id2,…"` or individual GETs) and caches them in a local map for sidebar display and PDF output. The `inverterModelId` string in `doc` is an app-enforced FK — not a PocketBase column constraint.

Strings continue to reference the local `inverterId` (the inverter's UUID inside `doc.inverters`). No change to string routing or sync logic.

### 2.3 Deletion policy

1. **Hard-delete**: only when the entry has zero project references.
   - For `panel_models`: query `projects?filter=panel_model="<id>"` — if empty, hard-delete.
   - For `inverter_models`: no server-side FK, and scanning all project docs server-side is impractical. Hard-delete is always allowed; a `deleted=true` guard prevents the entry from appearing in pickers even if some `doc` still holds the ID (those projects will see a "model not found" fallback).
2. **Soft-delete**: if a `panel_model` is still referenced, set `deleted=true`. The entry is excluded from picker queries (`filter=deleted=false`) but is still returned when fetched by ID (for display in existing open projects).

---

## 3. Frontend

### 3.1 Catalog management page — `/catalog`

Global page, not scoped to a team URL. Linked from TeamView's nav row (alongside Customers).

Layout:
- Two tabs: **Panels** | **Inverters**
- Per-tab: table of non-deleted entries (manufacturer, model, key specs, datasheet icon link, edit/delete actions)
- Inline create/edit form (same panel pattern as `CustomersPage`) — all fields, with `datasheetUrl` opening in a new tab for verification
- Delete action: checks references → hard-delete or soft-delete with confirmation dialog
- Soft-deleted entries are hidden from the table; no "restore" UI in v1

### 3.2 `PanelModelPicker` component

Searchable combobox (same interaction pattern as `CustomerPicker.tsx`):
- Queries `panel_models?filter=deleted=false&sort=manufacturer,model`
- Displays `manufacturer · model · wattPeak Wp`
- Used in: Sidebar panel-type section, `NewProjectPage` bootstrap form

### 3.3 `InverterModelPicker` component

Same pattern, queries `inverter_models?filter=deleted=false`:
- Displays `manufacturer · model · maxAcPowerW W`
- Used in: Sidebar inverter row (link/change model)

### 3.4 Sidebar changes

**Panel Type section** — replaces manual dimension inputs:
- Catalog-linked project: shows `manufacturer model — wattPeak Wp` with a **Change** button that opens `PanelModelPicker` inline
- Legacy project (no FK): shows current `doc.panelType` values with a **Link to catalog** affordance; manual editing remains available until linked
- A small "↗ datasheet" link appears when `datasheetUrl` is set

**Inverter rows** — each existing inverter row gains a second line:
- Catalog-linked: shows `manufacturer model` with a **Change** button
- Unlinked: shows a faint **Link model** affordance

### 3.5 New project flow

`NewProjectPage` gains a panel model picker (after the existing name/address fields). Selecting a model is required to proceed — if the catalog is empty, a "Create your first model" link to `/catalog` is shown in place of the picker. The created project record sets `panel_model` and leaves `doc.panelType` absent (new format). `doc.panelType` is only written for the legacy fallback path.

---

## 4. Type Changes (`src/types/index.ts`)

```ts
// PanelType gains optional extended fields from catalog.
// id matches the panel_models record ID when catalog-linked.
export interface PanelType {
  id: string;
  name: string;        // display: "manufacturer model"
  widthM: number;
  heightM: number;
  wattPeak: number;
  // Optional extended fields — present when sourced from catalog:
  efficiencyPct?: number;
  weightKg?: number;
  voc?: number;
  isc?: number;
  vmpp?: number;
  impp?: number;
  tempCoefficientPmax?: number;
  warrantyYears?: number;
  datasheetUrl?: string;
}

// Inverter gains optional catalog link.
export interface Inverter {
  id: string;
  name: string;
  inverterModelId?: string | null;   // FK to inverter_models (app-enforced)
}
```

`src/backend/types.ts` gains:

```ts
export interface PanelModelRecord extends BaseRecord {
  manufacturer: string;
  model: string;
  widthM: number;
  heightM: number;
  wattPeak: number;
  efficiencyPct?: number;
  weightKg?: number;
  voc?: number;
  isc?: number;
  vmpp?: number;
  impp?: number;
  tempCoefficientPmax?: number;
  warrantyYears?: number;
  datasheetUrl?: string;
  deleted: boolean;
}

export interface InverterModelRecord extends BaseRecord {
  manufacturer: string;
  model: string;
  maxAcPowerW: number;
  maxDcPowerW?: number;
  efficiencyPct?: number;
  phases?: number;
  maxStrings?: number;
  maxInputVoltageV?: number;
  datasheetUrl?: string;
  deleted: boolean;
}
```

`ProjectRecord` gains:
```ts
panel_model: string;   // empty string when not linked
expand?: {
  customer?: CustomerRecord;
  panel_model?: PanelModelRecord;   // NEW
};
```

---

## 5. Backend Migrations

Two new migration files:

**`_panel_models.js`**: creates the `panel_models` collection with all fields above. Auth rules: any authenticated user for all operations.

**`_inverter_models.js`**: creates the `inverter_models` collection.

**`_projects_panel_model.js`**: adds the `panel_model` optional relation field to the `projects` collection (same pattern as the `customer` migration).

---

## 6. Out of Scope (v1)

- PDF output of extended electrical specs (datasheet URL link could be included as a text footnote in a future pass)
- Bulk import of catalog entries (CSV/JSON upload)
- Per-team private catalog entries
- Restore UI for soft-deleted entries
- Validation that a project's inverter string count doesn't exceed `inverter_models.maxStrings`
