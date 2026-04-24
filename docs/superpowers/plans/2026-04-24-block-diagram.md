# Electrical Block Diagram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an A4-landscape node-edge electrical block diagram as a second view inside the project editor, bootstrapped from roof/inverter data and exportable as a PDF page.

**Architecture:** React Flow (`@xyflow/react`) renders the node graph; diagram state lives in `project.diagram` (optional field on `Project`) flowing through the existing Zustand store and sync pipeline. A toggle button in the Sidebar switches between the existing roof-plan canvas and the new diagram view. PDF export uses `html2canvas` to screenshot the A4 div and inserts it as a second page.

**Tech Stack:** React 18, `@xyflow/react` (new), Zustand, `html2canvas`, `@react-pdf/renderer`, Tailwind CSS, TypeScript.

---

### Task 1: Install dependency + extend types + store actions

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/store/projectStore.ts`

- [ ] Install `@xyflow/react`:
  ```bash
  cd /path/to/project && npm install @xyflow/react
  ```

- [ ] Add diagram types to `src/types/index.ts` (append after the `STRING_COLORS` export):
  ```ts
  export type DiagramNodeType =
    | 'solarGenerator' | 'inverter' | 'switch'
    | 'fuse' | 'battery' | 'fre' | 'gridOutput';

  export interface DiagramNodeData {
    label: string;
    sublabel?: string;
  }

  // Matches React Flow's Node shape so we can pass these directly.
  export interface DiagramNode {
    id: string;
    type: DiagramNodeType;
    position: { x: number; y: number };
    data: DiagramNodeData;
  }

  export interface DiagramEdge {
    id: string;
    source: string;
    sourceHandle: string;
    target: string;
    targetHandle: string;
  }

  export interface DiagramMeta {
    client?: string;      // ← project.name on bootstrap
    module?: string;      // ← panelType.name on bootstrap
    systemSize?: string;  // ← computed kWp on bootstrap
    salesperson?: string;
    planner?: string;
    company?: string;
    date?: string;        // ISO date string
  }

  export interface Diagram {
    nodes: DiagramNode[];
    edges: DiagramEdge[];
    meta: DiagramMeta;
  }
  ```

- [ ] Add `diagram?: Diagram` to the `Project` interface in `src/types/index.ts`.

- [ ] Add the bootstrap helper to `src/store/projectStore.ts` (near the `uid` helper at the top):
  ```ts
  // Produces a starter Diagram from existing roof/panel/inverter data.
  // Called on first open of the diagram view when project.diagram is absent.
  function buildBootstrapDiagram(
    roofs: Roof[],
    panels: Panel[],
    inverters: Inverter[],
    panelType: PanelType,
    projectName: string,
  ): Diagram {
    const totalKwp = (panels.length * panelType.wattPeak) / 1000;
    const generatorNodes: DiagramNode[] = roofs.map((roof, i) => {
      const count = panels.filter(p => p.roofId === roof.id).length;
      const kwp = (count * panelType.wattPeak) / 1000;
      return {
        id: `sg-${roof.id}`,
        type: 'solarGenerator',
        position: { x: 80 + i * 240, y: 60 },
        data: { label: roof.name, sublabel: `${count} Module · ${kwp.toFixed(1)} kWp` },
      };
    });
    const inverterNodes: DiagramNode[] = inverters.map((inv, i) => ({
      id: `inv-${inv.id}`,
      type: 'inverter',
      position: { x: 80 + i * 240, y: 300 },
      data: { label: inv.name, sublabel: '' },
    }));
    return {
      nodes: [...generatorNodes, ...inverterNodes],
      edges: [],
      meta: {
        client: projectName,
        module: panelType.name,
        systemSize: `${totalKwp.toFixed(2)} kWp`,
        date: new Date().toISOString().split('T')[0],
      },
    };
  }
  ```

- [ ] Add these store action type declarations to the `ProjectStore` interface in `src/store/projectStore.ts`:
  ```ts
  bootstrapDiagram: () => void;
  setDiagramNodes: (nodes: DiagramNode[]) => void;
  setDiagramEdges: (edges: DiagramEdge[]) => void;
  updateDiagramMeta: (patch: Partial<DiagramMeta>) => void;
  addDiagramNode: (node: DiagramNode) => void;
  ```

- [ ] Implement those actions in the `create(...)` body (follow the same `set(...)` pattern used by `addRoof` / `updateRoof`). None of these need undo history — they are not passed to `undoable()`. Simple `set` calls:
  ```ts
  bootstrapDiagram: () =>
    set(s => {
      if (s.project.diagram) return s; // already exists — never overwrite
      return {
        project: {
          ...s.project,
          diagram: buildBootstrapDiagram(
            s.project.roofs, s.project.panels,
            s.project.inverters, s.project.panelType,
            s.project.name,
          ),
        },
      };
    }),

  setDiagramNodes: (nodes) =>
    set(s => ({ project: { ...s.project, diagram: { ...s.project.diagram!, nodes } } })),

  setDiagramEdges: (edges) =>
    set(s => ({ project: { ...s.project, diagram: { ...s.project.diagram!, edges } } })),

  updateDiagramMeta: (patch) =>
    set(s => ({
      project: {
        ...s.project,
        diagram: {
          ...s.project.diagram!,
          meta: { ...s.project.diagram!.meta, ...patch },
        },
      },
    })),

  addDiagramNode: (node) =>
    set(s => ({
      project: {
        ...s.project,
        diagram: {
          ...s.project.diagram!,
          nodes: [...s.project.diagram!.nodes, node],
        },
      },
    })),
  ```

- [ ] Verify TypeScript compiles: `npm run build -- --noEmit` (or `npx tsc --noEmit`). Fix any type errors.

- [ ] Commit:
  ```bash
  git add src/types/index.ts src/store/projectStore.ts
  git commit -m "feat(diagram): types, store actions, bootstrap helper"
  ```

---

### Task 2: BaseNode + all 7 node components

**Files:**
- Create: `src/components/diagram/nodes/BaseNode.tsx`
- Create: `src/components/diagram/nodes/SolarGeneratorNode.tsx`
- Create: `src/components/diagram/nodes/InverterNode.tsx`
- Create: `src/components/diagram/nodes/SwitchNode.tsx`
- Create: `src/components/diagram/nodes/FuseNode.tsx`
- Create: `src/components/diagram/nodes/BatteryNode.tsx`
- Create: `src/components/diagram/nodes/FreNode.tsx`
- Create: `src/components/diagram/nodes/GridOutputNode.tsx`

- [ ] Create `src/components/diagram/nodes/BaseNode.tsx`:
  ```tsx
  import { Handle, Position, useReactFlow } from '@xyflow/react';
  import type { DiagramNodeData } from '../../../../types';

  interface BaseNodeProps {
    id: string;
    data: DiagramNodeData;
    selected?: boolean;
    color: string;          // header bg color
    textColor?: string;     // header text/icon color; defaults to white
    typeLabel: string;      // e.g. "Solargenerator"
    icon: React.ReactNode;
  }

  const HANDLES = [
    { pos: Position.Top, id: 'top' },
    { pos: Position.Right, id: 'right' },
    { pos: Position.Bottom, id: 'bottom' },
    { pos: Position.Left, id: 'left' },
  ];

  export default function BaseNode({ id, data, selected, color, textColor = 'white', typeLabel, icon }: BaseNodeProps) {
    const { updateNodeData } = useReactFlow();

    return (
      <div
        className={`rounded-xl bg-white shadow-md min-w-[140px] border-2 transition-shadow ${selected ? 'shadow-lg' : ''}`}
        style={{ borderColor: color }}
      >
        {HANDLES.map(({ pos, id: hid }) => (
          <Handle key={hid} type="source" position={pos} id={hid}
            className="!w-3 !h-3 !rounded-full !border-2 !border-white"
            style={{ background: color }}
          />
        ))}
        <div className="rounded-t-[9px] px-2.5 py-1.5 flex items-center gap-1.5" style={{ background: color }}>
          <span style={{ color: textColor }} className="flex-shrink-0">{icon}</span>
          <span className="text-[11px] font-bold" style={{ color: textColor }}>{typeLabel}</span>
        </div>
        <div className="px-2.5 py-2 text-xs text-slate-800">
          <div
            className="font-semibold outline-none cursor-text"
            contentEditable
            suppressContentEditableWarning
            onBlur={e => updateNodeData(id, { label: e.currentTarget.textContent ?? data.label })}
          >
            {data.label}
          </div>
          {data.sublabel && <div className="text-slate-500 mt-0.5 text-[10px]">{data.sublabel}</div>}
        </div>
      </div>
    );
  }
  ```

- [ ] Create the 7 node type files. They are all thin wrappers around `BaseNode`. Use this pattern for each:

  **`SolarGeneratorNode.tsx`** (amber `#f59e0b`, dark text):
  ```tsx
  import type { NodeProps } from '@xyflow/react';
  import type { DiagramNodeData } from '../../../../types';
  import BaseNode from './BaseNode';

  const SunIcon = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#1e293b" strokeWidth="2.5">
      <circle cx="12" cy="12" r="5"/>
      <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
  );

  export default function SolarGeneratorNode({ id, data, selected }: NodeProps<DiagramNodeData>) {
    return <BaseNode id={id} data={data} selected={selected} color="#f59e0b" textColor="#1e293b" typeLabel="Solargenerator" icon={<SunIcon />} />;
  }
  ```

  Repeat for the remaining 6 types using these colors and labels:
  | File | color | textColor | typeLabel | Icon (inline SVG suggestion) |
  |---|---|---|---|---|
  | `InverterNode` | `#3b82f6` | `white` | `Wechselrichter` | lightning bolt `<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>` |
  | `SwitchNode` | `#64748b` | `white` | `Schalter` | simple rectangle with lines |
  | `FuseNode` | `#ef4444` | `white` | `Sicherung` | circle with vertical line |
  | `BatteryNode` | `#10b981` | `white` | `Batterie` | battery rect `<rect x="2" y="7" width="20" height="14" rx="2"/>` |
  | `FreNode` | `#8b5cf6` | `white` | `FRE Controller` | monitor `<rect x="2" y="3" width="20" height="14" rx="2"/>` |
  | `GridOutputNode` | `#0ea5e9` | `white` | `Netzeinspeisung` | power plug |

- [ ] Verify TypeScript: `npx tsc --noEmit`.

- [ ] Commit:
  ```bash
  git add src/components/diagram/
  git commit -m "feat(diagram): BaseNode + 7 node type components"
  ```

---

### Task 3: DiagramCanvas, DiagramToolbar, DiagramMetaTable

**Files:**
- Create: `src/components/diagram/DiagramCanvas.tsx`
- Create: `src/components/diagram/DiagramToolbar.tsx`
- Create: `src/components/diagram/DiagramMetaTable.tsx`

- [ ] Create `src/components/diagram/DiagramCanvas.tsx`:
  ```tsx
  import { useCallback } from 'react';
  import {
    ReactFlow, Background, Controls, MiniMap,
    applyNodeChanges, applyEdgeChanges,
    addEdge,
    type NodeChange, type EdgeChange, type Connection,
  } from '@xyflow/react';
  import '@xyflow/react/dist/style.css';
  import { useProjectStore } from '../../store/projectStore';
  import type { DiagramNode, DiagramEdge } from '../../types';
  import SolarGeneratorNode from './nodes/SolarGeneratorNode';
  import InverterNode from './nodes/InverterNode';
  import SwitchNode from './nodes/SwitchNode';
  import FuseNode from './nodes/FuseNode';
  import BatteryNode from './nodes/BatteryNode';
  import FreNode from './nodes/FreNode';
  import GridOutputNode from './nodes/GridOutputNode';

  const nodeTypes = {
    solarGenerator: SolarGeneratorNode,
    inverter: InverterNode,
    switch: SwitchNode,
    fuse: FuseNode,
    battery: BatteryNode,
    fre: FreNode,
    gridOutput: GridOutputNode,
  };

  export default function DiagramCanvas() {
    const nodes = useProjectStore(s => s.project.diagram?.nodes ?? []);
    const edges = useProjectStore(s => s.project.diagram?.edges ?? []);
    const setDiagramNodes = useProjectStore(s => s.setDiagramNodes);
    const setDiagramEdges = useProjectStore(s => s.setDiagramEdges);

    const onNodesChange = useCallback(
      (changes: NodeChange[]) => setDiagramNodes(applyNodeChanges(changes, nodes) as DiagramNode[]),
      [nodes, setDiagramNodes],
    );
    const onEdgesChange = useCallback(
      (changes: EdgeChange[]) => setDiagramEdges(applyEdgeChanges(changes, edges) as DiagramEdge[]),
      [edges, setDiagramEdges],
    );
    const onConnect = useCallback(
      (connection: Connection) => setDiagramEdges(addEdge(connection, edges) as DiagramEdge[]),
      [edges, setDiagramEdges],
    );

    return (
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        deleteKeyCode={['Delete', 'Backspace']}
        fitView
      >
        <Background gap={16} color="#cbd5e1" />
        <Controls />
        <MiniMap />
      </ReactFlow>
    );
  }
  ```

- [ ] Create `src/components/diagram/DiagramToolbar.tsx`:
  ```tsx
  import { useProjectStore } from '../../store/projectStore';
  import type { DiagramNodeType } from '../../types';

  const NODE_BUTTONS: { type: DiagramNodeType; label: string; color: string }[] = [
    { type: 'switch',      label: 'Schalter',       color: '#64748b' },
    { type: 'fuse',        label: 'Sicherung',       color: '#ef4444' },
    { type: 'battery',     label: 'Batterie',        color: '#10b981' },
    { type: 'fre',         label: 'FRE',             color: '#8b5cf6' },
    { type: 'gridOutput',  label: 'Netzeinspeisung', color: '#0ea5e9' },
  ];

  export default function DiagramToolbar() {
    const addDiagramNode = useProjectStore(s => s.addDiagramNode);

    const handleAdd = (type: DiagramNodeType, label: string) => {
      addDiagramNode({
        id: Math.random().toString(36).slice(2, 10),
        type,
        position: { x: 200 + Math.random() * 200, y: 200 + Math.random() * 100 },
        data: { label },
      });
    };

    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border-b border-slate-700">
        <span className="text-slate-400 text-xs mr-1">+ Hinzufügen:</span>
        {NODE_BUTTONS.map(({ type, label, color }) => (
          <button
            key={type}
            onClick={() => handleAdd(type, label)}
            className="text-[11px] px-2.5 py-1 rounded-md font-medium text-white hover:opacity-90 transition-opacity"
            style={{ background: color }}
          >
            {label}
          </button>
        ))}
      </div>
    );
  }
  ```

- [ ] Create `src/components/diagram/DiagramMetaTable.tsx`:
  ```tsx
  import { useProjectStore } from '../../store/projectStore';
  import type { DiagramMeta } from '../../types';

  const COLUMNS: { key: keyof DiagramMeta; label: string }[] = [
    { key: 'client',      label: 'Projekt für Kunde' },
    { key: 'module',      label: 'Modul' },
    { key: 'systemSize',  label: 'Anlagengröße' },
    { key: 'salesperson', label: 'Verkauf' },
    { key: 'planner',     label: 'Planung' },
    { key: 'company',     label: 'Firma' },
    { key: 'date',        label: 'Datum' },
  ];

  export default function DiagramMetaTable() {
    const meta = useProjectStore(s => s.project.diagram?.meta ?? {});
    const updateDiagramMeta = useProjectStore(s => s.updateDiagramMeta);

    return (
      <table className="w-full border-collapse text-[11px] font-sans flex-shrink-0">
        <thead>
          <tr style={{ background: '#1e293b' }}>
            {COLUMNS.map(({ label }) => (
              <th key={label} className="px-2 py-1.5 text-left font-semibold text-slate-100 border-r border-slate-600 last:border-r-0 whitespace-nowrap">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="bg-white">
            {COLUMNS.map(({ key }) => (
              <td key={key} className="border-r border-slate-200 last:border-r-0">
                <input
                  className="w-full px-2 py-1 text-slate-800 bg-transparent outline-none focus:bg-slate-50"
                  value={meta[key] ?? ''}
                  onChange={e => updateDiagramMeta({ [key]: e.target.value })}
                />
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    );
  }
  ```

- [ ] Verify TypeScript: `npx tsc --noEmit`.

- [ ] Commit:
  ```bash
  git add src/components/diagram/
  git commit -m "feat(diagram): DiagramCanvas, DiagramToolbar, DiagramMetaTable"
  ```

---

### Task 4: DiagramView + sidebar toggle + App wiring

**Files:**
- Create: `src/components/DiagramView.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`

- [ ] Create `src/components/DiagramView.tsx`. This is the full A4-landscape container (canvas + table), exported with a `ref` for html2canvas later:
  ```tsx
  import { useEffect } from 'react';
  import { useProjectStore } from '../store/projectStore';
  import DiagramCanvas from './diagram/DiagramCanvas';
  import DiagramToolbar from './diagram/DiagramToolbar';
  import DiagramMetaTable from './diagram/DiagramMetaTable';

  // A4 landscape at 96 dpi: 297mm × 210mm
  const A4_W = 1122;
  const A4_H = 794;

  export default function DiagramView() {
    const bootstrapDiagram = useProjectStore(s => s.bootstrapDiagram);

    // Bootstrap on first mount if diagram is absent.
    useEffect(() => { bootstrapDiagram(); }, [bootstrapDiagram]);

    return (
      // Outer: centers the A4 sheet in the available space, dark background.
      <div className="flex-1 overflow-auto bg-slate-700 flex items-start justify-center p-6">
        {/* A4 sheet */}
        <div
          style={{ width: A4_W, height: A4_H, flexShrink: 0 }}
          className="bg-white shadow-2xl flex flex-col"
        >
          <DiagramToolbar />
          {/* React Flow fills remaining height above the table */}
          <div className="flex-1 min-h-0">
            <DiagramCanvas />
          </div>
          <DiagramMetaTable />
        </div>
      </div>
    );
  }
  ```

- [ ] Add the view-toggle state and toggle button to `src/App.tsx`. The `App` component already manages local state (e.g. `preLockRotation`) so this fits the same pattern:

  Add near the other `useState` calls at the top of `App`:
  ```ts
  const [activeView, setActiveView] = useState<'roof' | 'diagram'>('roof');
  ```

  In the JSX, conditionally render the main canvas area. Where the current map/Konva area is (inside `<main>`), wrap it:
  ```tsx
  {activeView === 'roof' ? (
    <>
      {/* existing MapView + KonvaOverlay JSX, unchanged */}
    </>
  ) : (
    <DiagramView />
  )}
  ```

  Pass `activeView` and `setActiveView` down to `<Sidebar>` as props (or lift the state — follow whatever pattern the existing Sidebar props use).

- [ ] Add the toggle button to `src/components/Sidebar.tsx`, above the `PROJEKT` section. Find the spot where the sidebar content begins and insert:
  ```tsx
  {/* View toggle — above project meta */}
  <div className="flex rounded-lg overflow-hidden border border-slate-700 mb-4 text-xs font-medium">
    <button
      onClick={() => setActiveView('roof')}
      className={`flex-1 py-1.5 transition-colors ${activeView === 'roof' ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
    >
      Dachplan
    </button>
    <button
      onClick={() => setActiveView('diagram')}
      className={`flex-1 py-1.5 transition-colors ${activeView === 'diagram' ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
    >
      Schaltplan
    </button>
  </div>
  ```

  Add the required props to `Sidebar`'s props interface:
  ```ts
  activeView: 'roof' | 'diagram';
  setActiveView: (v: 'roof' | 'diagram') => void;
  ```

- [ ] Start dev server (`npm run dev`), open a project, click the toggle — verify the diagram view appears with bootstrapped nodes, toolbar, and metadata table. Check that switching back to roof plan works.

- [ ] Commit:
  ```bash
  git add src/components/DiagramView.tsx src/components/Sidebar.tsx src/App.tsx
  git commit -m "feat(diagram): DiagramView, sidebar toggle, App wiring"
  ```

---

### Task 5: PDF export — diagram as second page

**Files:**
- Modify: `src/utils/pdfExport.tsx`
- Modify: `src/pdf/SolarPlanDoc.tsx`

- [ ] Add a `captureDiagram` function to `src/pdf/composeStageImage.ts` (alongside the existing `captureStage`):
  ```ts
  // Captures the A4 DiagramView div as a PNG dataURL.
  // The caller passes the ref to the outer A4 container div in DiagramView.
  export async function captureDiagramView(el: HTMLElement): Promise<string> {
    const canvas = await html2canvas(el, {
      useCORS: true,
      scale: 1,
      width: 1122,
      height: 794,
      ignoreElements: (e) => e.tagName === 'CANVAS' && (e as HTMLCanvasElement).width === 0,
    });
    return canvas.toDataURL('image/png');
  }
  ```

- [ ] In `src/pdf/SolarPlanDoc.tsx`, add a second `<Page>` after the existing roof plan page. The page takes an optional `diagramImage` prop (a PNG dataURL string):

  Add to the component's props interface:
  ```ts
  diagramImage?: string;
  ```

  After the closing tag of the first `<Page>`, add:
  ```tsx
  {diagramImage && (
    <Page size="A4" orientation="landscape" style={{ padding: 0 }}>
      <Image src={diagramImage} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
    </Page>
  )}
  ```

- [ ] In `src/components/DiagramView.tsx`, add `data-diagram-view` to the A4 container div so Toolbar can find it via DOM query (same pattern as `.konva-overlay` for the stage):
  ```tsx
  <div
    ref={containerRef}
    data-diagram-view
    style={{ width: A4_W, height: A4_H, flexShrink: 0 }}
    className="bg-white shadow-2xl flex flex-col"
  >
  ```

- [ ] In `src/utils/pdfExport.tsx`, add diagram capture after the existing `captureStage` call. The current signature is `exportPdf(project, stageEl, inverterModelCache)` — no signature change needed. Inside the `try` block, after the `composeWithGrid` call, add:
  ```ts
  const diagramEl = document.querySelector('[data-diagram-view]') as HTMLElement | null;
  const { captureDiagramView } = await import('../pdf/composeStageImage');
  const diagramImage = diagramEl ? await captureDiagramView(diagramEl) : undefined;
  ```

  Then pass `diagramImage` when constructing `SolarPlanDoc` (find the `pdf(...)` call that renders the document and add `diagramImage={diagramImage}` to the JSX).

- [ ] Test: open a project, draw some diagram nodes, click Export PDF — verify two pages appear (roof plan + diagram). Check the diagram page renders the metadata table.

- [ ] Commit:
  ```bash
  git add src/pdf/composeStageImage.ts src/pdf/SolarPlanDoc.tsx src/utils/pdfExport.tsx src/components/Toolbar.tsx src/App.tsx
  git commit -m "feat(diagram): PDF export — diagram as second page"
  ```
