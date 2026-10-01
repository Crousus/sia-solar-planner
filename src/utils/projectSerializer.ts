// Solar Planner - Frontend web application for designing and planning rooftop solar panel installations
// Copyright (C) 2026  Johannes Wenz github.com/Crousus
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

// ────────────────────────────────────────────────────────────────────────────
// Project serializer.
//
// Owns the JSON save/load format and all schema migrations that run at the
// persistence boundary (file import AND every `loadProject` — i.e. each
// time a doc arrives from the server). Zustand localStorage persistence
// was removed in ADR-015; the server is the source of truth.
// Previously this logic lived inline in Toolbar.tsx, which meant:
//   - The v2 envelope shape (`{ version, project, history }`) was asserted
//     only by inline `parsed.version === 2` checks behind an `as Project`
//     cast — a runtime guarantee dressed up as a compile-time one.
//   - A v3 format would have required touching a React component.
//   - There was no shared place to run data-shape migrations (the
//     `Panel.orientation` fallback was scattered across 5 call sites).
//
// This module is pure: no React, no store, no DOM. That lets the store's
// `loadProject` call `migrateProject` without pulling in anything else,
// and lets tests exercise import/export without a stage. It must not
// import from `store/*` (AGENTS.md layering rule) — the history types it
// needs live in types/index.ts for exactly that reason.
//
// Format history:
//   v1 — raw `Project` at the root of the JSON document. Written before
//        undo/redo shipped (ADR-014). Still read because exports from
//        older builds are in users' hands.
//   v2 — envelope `{ version: 2, project, history: { past, future } }`
//        where past/future are full UndoableSlice SNAPSHOTS. See commit
//        f5f0ac2 + ADR-014. Still read; history is handed to loadProject
//        tagged `kind: 'snapshots'` and converted to deltas there.
//   v3 — same envelope, `version: 3`, past/future are id-keyed DELTA
//        entries (HistoryEntry, ADR-015). Written by current builds.
// ────────────────────────────────────────────────────────────────────────────

import type {
  Project,
  Panel,
  Roof,
  Diagram,
  DiagramNode,
  DiagramEdge,
  UndoableSlice,
  HistoryEntry,
  LoadableHistory,
} from '../types';
import { MIN_ROOF_TILT_DEG, MAX_ROOF_TILT_DEG, DEFAULT_ROOF_TILT_DEG } from '../types';

/** v3 wire format. `history` is non-optional on writes; it's optional on
 *  reads for tolerance to truncated files (see `deserializeProject`). */
export interface ExportPayloadV3 {
  version: 3;
  project: Project;
  history: {
    past: HistoryEntry[];
    future: HistoryEntry[];
  };
}

/** Result of deserializing a v1, v2 or v3 payload. `history` is absent
 *  for v1 imports — callers (loadProject) treat `undefined` as "empty
 *  stacks", matching the pre-envelope contract. v2 history arrives as
 *  `{ kind: 'snapshots', ... }`; loadProject converts it. */
export interface DeserializedPayload {
  project: Project;
  history?: LoadableHistory;
}

/** Thrown when the input isn't a JSON object at all, or is missing the
 *  bare minimum structure we need to identify a version. Used so the
 *  caller (Toolbar's file picker) can show a clean error message rather
 *  than the raw "Cannot read properties of undefined" from a naive cast. */
export class ProjectDeserializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectDeserializationError';
  }
}

/**
 * Build the v2 payload from the current store state.
 *
 * We accept the three fields we need rather than the whole store handle
 * so the caller doesn't have to own a reference to `useProjectStore`.
 * Keeping this pure lets the caller cheaply construct a test payload,
 * and it makes it obvious at the call site what gets exported.
 */
export function serializeProject(state: {
  project: Project;
  past: HistoryEntry[];
  future: HistoryEntry[];
}): ExportPayloadV3 {
  return {
    version: 3,
    project: state.project,
    history: { past: state.past, future: state.future },
  };
}

/**
 * Clamp a roof tilt into the supported range (see MAX_ROOF_TILT_DEG in
 * types/index.ts for why the range exists and why it is 0–60).
 * Non-finite input (NaN from a corrupted doc, ±Infinity) falls back to the
 * default pitch rather than to a range edge — an edge value would look
 * like a deliberate choice.
 *
 * Exported so the store's updateRoof clamps with exactly the same rule as
 * the persistence boundary.
 */
export function clampTilt(tiltDeg: number): number {
  if (typeof tiltDeg !== 'number' || !Number.isFinite(tiltDeg)) return DEFAULT_ROOF_TILT_DEG;
  return Math.min(MAX_ROOF_TILT_DEG, Math.max(MIN_ROOF_TILT_DEG, tiltDeg));
}

/**
 * React Flow decorates nodes/edges with runtime-only fields as the user
 * interacts: `selected`, `dragging`, `measured`, `width`/`height` (the
 * app has no NodeResizer, so these are measurement artefacts, not user
 * intent), `resizing`, `positionAbsolute` (v11), `internals`. None belong
 * in the persisted doc: they bloat it, and — worse — every selection
 * click or drag frame would become a JSON Patch sent to the server and
 * fanned out to collaborators, making Alice's selection appear in Bob's
 * view. DiagramCanvas is expected to keep these in local React state and
 * hand the store stripped nodes; stripping here is the safety net.
 */
const TRANSIENT_NODE_KEYS = [
  'selected',
  'dragging',
  'measured',
  'width',
  'height',
  'resizing',
  'positionAbsolute',
  'internals',
] as const;
const TRANSIENT_EDGE_KEYS = ['selected'] as const;

function stripKeys<T extends object>(obj: T, keys: readonly string[]): T {
  let out: Record<string, unknown> | null = null;
  for (const k of keys) {
    if (k in obj) {
      if (!out) out = { ...(obj as Record<string, unknown>) };
      delete out[k];
    }
  }
  // Same reference when nothing was transient — keeps selectors quiet.
  return (out ?? obj) as T;
}

/** Strip React Flow runtime fields from one node (same ref if clean). */
export function stripDiagramNode(n: DiagramNode): DiagramNode {
  return stripKeys(n, TRANSIENT_NODE_KEYS);
}

/** Strip React Flow runtime fields from one edge (same ref if clean). */
export function stripDiagramEdge(e: DiagramEdge): DiagramEdge {
  return stripKeys(e, TRANSIENT_EDGE_KEYS);
}

/** Map with reference preservation: returns the input array when every
 *  element came back identical. */
function mapStable<T>(arr: T[], fn: (x: T) => T): T[] {
  let changed = false;
  const out = arr.map((x) => {
    const y = fn(x);
    if (y !== x) changed = true;
    return y;
  });
  return changed ? out : arr;
}

function migrateDiagram(d: Diagram): Diagram {
  // Tolerate malformed docs (missing arrays) — the diagram view
  // bootstraps lazily, so we only clean what is there.
  const nodes = Array.isArray(d.nodes) ? mapStable(d.nodes, stripDiagramNode) : d.nodes;
  const edges = Array.isArray(d.edges) ? mapStable(d.edges, stripDiagramEdge) : d.edges;
  return nodes === d.nodes && edges === d.edges ? d : { ...d, nodes, edges };
}

/**
 * Data migration run at every persistence boundary (loadProject, JSON
 * import). Idempotent; returns the SAME reference when nothing needed
 * changing. Steps:
 *
 *   1. Fill `Panel.orientation` from the owning roof's default for any
 *      panel that lacks one. Before this migration existed the field was
 *      optional and five consumer sites carried
 *      `p.orientation ?? roof.panelOrientation`; running it here lets the
 *      type be required. A panel whose roof id is unknown falls back to
 *      'portrait' — consistent with addRoof's default.
 *   2. Clamp `Roof.tiltDeg` into [MIN_ROOF_TILT_DEG, MAX_ROOF_TILT_DEG]
 *      (an imported 90° roof would otherwise produce zero-height cells).
 *   3. Strip React Flow runtime fields from diagram nodes/edges.
 */
export function migrateProject(p: Project): Project {
  // ── Roof tilt clamp ──────────────────────────────────────────────────
  const roofs: Roof[] = mapStable(p.roofs, (r) => {
    const t = clampTilt(r.tiltDeg);
    return t === r.tiltDeg ? r : { ...r, tiltDeg: t };
  });

  // ── Panel orientation back-fill ──────────────────────────────────────
  // Build a lookup once; keeps the panel pass O(n).
  const roofOrientation = new Map<string, 'portrait' | 'landscape'>();
  for (const r of roofs) roofOrientation.set(r.id, r.panelOrientation);
  const panels: Panel[] = mapStable(p.panels, (panel) =>
    panel.orientation
      ? panel
      : { ...panel, orientation: roofOrientation.get(panel.roofId) ?? 'portrait' },
  );

  // ── Diagram transient-field strip ────────────────────────────────────
  const diagram = p.diagram ? migrateDiagram(p.diagram) : p.diagram;

  // Preserve reference identity when nothing needed migrating — Zustand
  // uses `===` on sub-trees to short-circuit selector re-renders, and
  // returning a new object on every load would invalidate every
  // subscriber for no reason.
  if (roofs === p.roofs && panels === p.panels && diagram === p.diagram) return p;
  return { ...p, roofs, panels, ...(diagram ? { diagram } : {}) };
}

/**
 * Same orientation fill, applied to the panels inside one LEGACY (v2)
 * history snapshot, before loadProject diffs consecutive snapshots into
 * delta entries. Without it, the diff would record a phantom
 * "orientation: undefined → portrait" update on every panel.
 *
 * Snapshot sub-arrays are `unknown[]` (see UndoableSlice) because the
 * middleware stays Project-agnostic; we cast narrowly here.
 */
function migrateSlice(slice: UndoableSlice): UndoableSlice {
  const roofs = slice.roofs as Array<{ id: string; panelOrientation: 'portrait' | 'landscape' }>;
  const roofOrientation = new Map<string, 'portrait' | 'landscape'>();
  for (const r of roofs) roofOrientation.set(r.id, r.panelOrientation);

  type PanelLike = { roofId: string; orientation?: 'portrait' | 'landscape' } & Record<string, unknown>;
  const panels = slice.panels as PanelLike[];

  let changed = false;
  const migratedPanels = panels.map((panel) => {
    if (panel.orientation) return panel;
    changed = true;
    return {
      ...panel,
      orientation: roofOrientation.get(panel.roofId) ?? 'portrait',
    };
  });

  return changed ? { ...slice, panels: migratedPanels } : slice;
}

/**
 * Parse a raw JSON value into a `Project` plus optional undo history.
 *
 * Accepts:
 *   - v3 envelope: `{ version: 3, project, history: { past, future } }`
 *     with delta entries
 *   - v2 envelope: same, `version: 2`, snapshot history (tagged
 *     `kind: 'snapshots'` in the result for loadProject to convert)
 *   - v1 legacy: a bare `Project` object
 *
 * Throws `ProjectDeserializationError` if the input can't be identified
 * as either. We intentionally do NOT deeply validate every Project field
 * — the tool is single-user and the only way a v2 file gets produced is
 * by this app itself, so defending against arbitrary shapes is overkill.
 * The guard here is just enough to give a clean error for "user picked
 * the wrong file" and to protect the type-cast to `Project` from being
 * a complete lie.
 */
export function deserializeProject(raw: unknown): DeserializedPayload {
  if (raw === null || typeof raw !== 'object') {
    throw new ProjectDeserializationError('Payload is not a JSON object.');
  }

  const obj = raw as Record<string, unknown>;

  // v2/v3 dispatch. We check both the version AND that `project` is an
  // object, because in principle a v1 file could have a stray `version`
  // property (from some future field) and we don't want to mis-route.
  if (obj.version === 2 || obj.version === 3) {
    if (obj.project === null || typeof obj.project !== 'object') {
      throw new ProjectDeserializationError(`v${obj.version} payload is missing \`project\`.`);
    }
    const project = migrateProject(obj.project as Project);

    // History is optional for defensiveness: a truncated or older v2 file
    // with the envelope but no history key should still load as an empty
    // stack rather than throw.
    const historyRaw = obj.history as { past?: unknown; future?: unknown } | undefined;
    if (
      historyRaw &&
      Array.isArray(historyRaw.past) &&
      Array.isArray(historyRaw.future)
    ) {
      // Entries must at least be objects; anything else means a hand-
      // edited / corrupted file — drop the history rather than feed junk
      // into the undo engine (the project itself still loads).
      const allObjects = [...historyRaw.past, ...historyRaw.future].every(
        (e) => e !== null && typeof e === 'object',
      );
      if (!allObjects) return { project };
      if (obj.version === 3) {
        return {
          project,
          history: {
            past: historyRaw.past as HistoryEntry[],
            future: historyRaw.future as HistoryEntry[],
          },
        };
      }
      return {
        project,
        history: {
          kind: 'snapshots',
          past: (historyRaw.past as UndoableSlice[]).map(migrateSlice),
          future: (historyRaw.future as UndoableSlice[]).map(migrateSlice),
        },
      };
    }
    return { project };
  }

  // v1 fallback: the root IS the Project. Basic shape check so we don't
  // hand a totally wrong document (e.g. a random JSON array) downstream.
  if (!('roofs' in obj) || !('panels' in obj) || !('mapState' in obj)) {
    throw new ProjectDeserializationError(
      'Unrecognized project file shape — expected v1 Project or v2/v3 envelope.',
    );
  }
  return { project: migrateProject(raw as Project) };
}
