# Electrical Block Diagram — Design Spec

**Date:** 2026-04-24
**Status:** Approved

## Overview

A second canvas view inside each project: an A4-landscape electrical block diagram that the user draws after completing the roof plan. The diagram is bootstrapped automatically from existing roof/inverter data, edited freely via a node-edge UI, and exported as a second page in the existing PDF.

---

## 1. Navigation

A toggle button is added to the **Sidebar**, above the "PROJEKT" section. It switches between two views:

- **Roof Plan** — the existing Konva/map canvas (current behaviour, unchanged)
- **Block Diagram** — the new React Flow canvas

This is a local UI state change — no routing change, no new URL. The toggle replaces the main canvas area; the sidebar itself stays visible in both views.

---

## 2. Canvas Library

**React Flow** (`@xyflow/react`) is added as a new dependency. Rationale: the existing Konva code is tightly coupled to the map/panel use case and shares nothing useful with a node-graph. React Flow provides handles, edge routing, zoom/pan, and connection logic out of the box — approximately 3–4× less custom code than rebuilding on Konva.

The React Flow `<ReactFlow>` component is rendered inside a fixed A4-landscape container (297 × 210 mm at 96 dpi → 1122 × 794 px). The viewport clips to A4 bounds on PDF export but is freely pannable in the editor.

---

## 3. Data Model

A new optional field `diagram` is added to the existing `Project` type. Embedding alongside `roofs`, `panels`, `strings`, and `inverters` keeps it inside the existing sync/patch pipeline with no new PocketBase table or fetch required.

```ts
// src/types/index.ts additions

export type DiagramNodeType =
  | 'solarGenerator'
  | 'inverter'
  | 'switch'
  | 'fuse'
  | 'battery'
  | 'fre'
  | 'gridOutput';

export interface DiagramNodeData {
  label: string;        // user-editable display name
  sublabel?: string;    // secondary line (kWp, model name, etc.) — auto-filled on bootstrap
}

export interface DiagramNode {
  id: string;
  type: DiagramNodeType;
  position: { x: number; y: number };
  data: DiagramNodeData;
}

export interface DiagramEdge {
  id: string;
  source: string;
  sourceHandle: string; // 'top' | 'right' | 'bottom' | 'left'
  target: string;
  targetHandle: string;
}

export interface DiagramMeta {
  // All seven table columns — pre-filled on bootstrap, freely editable after.
  // Stored as plain strings so the user can override any value without
  // affecting the underlying project data.
  client?: string;        // Projekt für Kunde  ← project.name on bootstrap
  module?: string;        // Modul              ← panelType.name on bootstrap
  systemSize?: string;    // Anlagengröße       ← computed kWp on bootstrap
  salesperson?: string;   // Verkauf
  planner?: string;       // Planung
  company?: string;       // Firma
  date?: string;          // Datum (ISO date string)
}

export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  meta: DiagramMeta;
}

// Project gets:
//   diagram?: Diagram;
// Absent = "not yet created" — triggers auto-bootstrap on first open.
```

`DiagramNode` and `DiagramEdge` use React Flow's native shape (id, type, position, data / id, source, target, sourceHandle, targetHandle) so they can be passed directly to `<ReactFlow nodes={} edges={}>` without transformation.

---

## 4. Node Types

Seven node types, each rendered as a custom React Flow node component: rounded rectangle, color-coded header with SVG icon, body with editable label + sublabel. Handles (small circles) on all four sides — used to start/end edges.

| Type | Header Color | Label | Bootstrap source |
|---|---|---|---|
| `solarGenerator` | Amber `#f59e0b` | Roof name | One per `Roof` |
| `inverter` | Blue `#3b82f6` | Inverter name | One per `Inverter` |
| `switch` | Slate `#64748b` | "Schalter" | Manual |
| `fuse` | Red `#ef4444` | "Sicherung" | Manual |
| `battery` | Emerald `#10b981` | "Batterie" | Manual |
| `fre` | Violet `#8b5cf6` | "FRE Controller" | Manual |
| `gridOutput` | Sky `#0ea5e9` | "Netzeinspeisung" | Manual |

**Interaction:**
- Double-click node body → inline label edit
- Drag from a handle → rubber-band to start a new edge
- Click node/edge + `Delete` or `Backspace` → remove
- Node toolbar (appears on select) → "Add node of type X" buttons for manually-added types

---

## 5. Metadata Table

A fixed table rendered **below** the React Flow canvas (outside the React Flow viewport, always visible). It has a dark header row (`#1e293b`, white text) and alternating white/slate body rows — matching the app's existing header palette.

**Columns:** Projekt für Kunde · Modul · Anlagengröße · Verkauf · Planung · Firma · Datum

**Pre-fill logic on first open:**
- *Projekt für Kunde* ← `project.name`
- *Modul* ← `project.panelType.name` (if set)
- *Anlagengröße* ← computed total kWp across all roofs
- *Datum* ← today's date (ISO → formatted DD.MM.YYYY)
- *Verkauf, Planung, Firma* ← empty (user fills)

All cells are editable inline (`contenteditable` or controlled `<input>`). Changes are persisted into `project.diagram.meta`.

---

## 6. Bootstrap Flow

When `project.diagram` is `null` or `undefined`, the app auto-generates an initial layout on first render of the diagram view:

1. Create one `solarGenerator` node per `Roof`, spaced evenly across the top third of the canvas. Pre-fill `label` with the roof name and `sublabel` with panel count + kWp total.
2. Create one `inverter` node per `Inverter`, spaced evenly across the middle third. Pre-fill `label` with the inverter name and `sublabel` with the linked catalog model name if available.
3. No edges are created — the user draws connections manually.
4. Write the generated `Diagram` into the store immediately (same as any other edit) so subsequent opens load the persisted layout, not a fresh bootstrap.

---

## 7. PDF Export

The block diagram is exported as a **second page** in the existing PDF, after the roof plan page.

**Mechanism:** `html2canvas` (already in the project) screenshots the A4 div (React Flow canvas + metadata table combined). The resulting PNG is embedded in the PDF via `@react-pdf/renderer`'s `<Image>` component — same pattern used for the roof plan raster capture.

The A4 div is rendered at a fixed pixel size (1122 × 794 px at 96 dpi) to ensure consistent output regardless of the user's viewport.

---

## 8. Component Structure

```
src/
  components/
    DiagramView.tsx          # top-level: ReactFlow + metadata table, toggle target
    diagram/
      DiagramCanvas.tsx      # <ReactFlow> with node/edge state wiring
      DiagramToolbar.tsx     # "Add node" buttons above the canvas
      DiagramMetaTable.tsx   # the bottom metadata table
      nodes/
        SolarGeneratorNode.tsx
        InverterNode.tsx
        SwitchNode.tsx
        FuseNode.tsx
        BatteryNode.tsx
        FreNode.tsx
        GridOutputNode.tsx
        BaseNode.tsx         # shared rounded-rect + header + handles layout
  store/
    projectStore.ts          # addDiagramNode / updateDiagramNode / removeDiagramNode
                             # setDiagramEdges / updateDiagramMeta / bootstrapDiagram
  types/
    index.ts                 # DiagramNode, DiagramEdge, DiagramMeta, Diagram added to Project
  pdf/
    SolarPlanDoc.tsx         # second page added: <DiagramPage screenshot={...} />
```

---

## 9. Out of Scope (v1)

- Multiple diagrams per project
- Undo/redo within the diagram (uses existing global undo middleware if feasible, otherwise deferred)
- Custom edge labels / cable spec annotations
- Auto-routing / orthogonal edges (React Flow's default bezier is sufficient)
- Locking / read-only diagram mode
