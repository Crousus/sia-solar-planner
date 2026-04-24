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
// persistence boundary (file import AND Zustand localStorage rehydration).
// Previously this logic lived inline in Toolbar.tsx, which meant:
//   - The v2 envelope shape (`{ version, project, history }`) was asserted
//     only by inline `parsed.version === 2` checks behind an `as Project`
//     cast — a runtime guarantee dressed up as a compile-time one.
//   - A v3 format would have required touching a React component.
//   - There was no shared place to run data-shape migrations (the
//     `Panel.orientation` fallback was scattered across 5 call sites).
//
// This module is pure: no React, no store, no DOM. That lets the store's
// `onRehydrateStorage` callback call `migrateProject` without pulling in
// anything else, and lets tests exercise import/export without a stage.
//
// Format history:
//   v1 — raw `Project` at the root of the JSON document. Written before
//        undo/redo shipped (ADR-014). Still read because exports from
//        older builds are in users' hands.
//   v2 — envelope `{ version: 2, project, history: { past, future } }`
//        that round-trips the undo stacks alongside the project. See
//        commit f5f0ac2 + ADR-014.
// ────────────────────────────────────────────────────────────────────────────

import type { Project, Panel } from '../types';
import type { UndoableSlice } from '../store/undoMiddleware';

/** v2 wire format. `history` is non-optional on writes; it's optional on
 *  reads for tolerance to truncated files (see `deserializeProject`). */
export interface ExportPayloadV2 {
  version: 2;
  project: Project;
  history: {
    past: UndoableSlice[];
    future: UndoableSlice[];
  };
}

/** Result of deserializing either a v1 or v2 payload. `history` is absent
 *  for v1 imports — callers (loadProject) treat `undefined` as "empty
 *  stacks", matching the pre-envelope contract. */
export interface DeserializedPayload {
  project: Project;
  history?: {
    past: UndoableSlice[];
    future: UndoableSlice[];
  };
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
  past: UndoableSlice[];
  future: UndoableSlice[];
}): ExportPayloadV2 {
  return {
    version: 2,
    project: state.project,
    history: { past: state.past, future: state.future },
  };
}

/**
 * Data migration: fill `Panel.orientation` from the owning roof's default
 * for any panel that lacks one.
 *
 * Before this migration existed, `Panel.orientation` was optional and five
 * consumer sites handled the missing case with `p.orientation ?? roof.panelOrientation`.
 * That scattered the fallback and meant every new consumer had to
 * remember to do it. Running migration at the serialization boundary
 * (and at Zustand rehydration) lets the `Panel.orientation` type become
 * required and kills all five fallback sites.
 *
 * A panel whose owning roof id is unknown (e.g. cascaded-deleted roof in
 * corrupted data) falls back to 'portrait' — an arbitrary choice but
 * consistent with `addRoof`'s default and with what the downstream
 * rendering code already did before this migration.
 */
export function migrateProject(p: Project): Project {
  // Build a lookup once; keeps the panel pass O(n).
  const roofOrientation = new Map<string, 'portrait' | 'landscape'>();
  for (const r of p.roofs) roofOrientation.set(r.id, r.panelOrientation);

  let changed = false;
  const migratedPanels: Panel[] = p.panels.map((panel) => {
    if (panel.orientation) return panel;
    changed = true;
    return {
      ...panel,
      orientation: roofOrientation.get(panel.roofId) ?? 'portrait',
    };
  });

  // Preserve reference identity when nothing needed migrating — Zustand
  // uses `===` on sub-trees to short-circuit selector re-renders, and
  // returning a new object every rehydrate would invalidate every
  // subscriber for no reason.
  return changed ? { ...p, panels: migratedPanels } : p;
}

/**
 * Same orientation fill, applied to the panels inside one history slice.
 *
 * History slices use `unknown[]` for their sub-arrays (see UndoableSlice)
 * because the middleware stays Project-agnostic; here we know the shape
 * well enough to migrate, but we cast narrowly instead of tightening
 * UndoableSlice globally (which would create a circular import between
 * undoMiddleware and types).
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
 *   - v2 envelope: `{ version: 2, project, history: { past, future } }`
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

  // v2 dispatch. We check both `version === 2` AND that `project` is an
  // object, because in principle a v1 file could have a stray `version`
  // property (from some future field) and we don't want to mis-route.
  if (obj.version === 2) {
    if (obj.project === null || typeof obj.project !== 'object') {
      throw new ProjectDeserializationError('v2 payload is missing `project`.');
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
      return {
        project,
        history: {
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
      'Unrecognized project file shape — expected v1 Project or v2 envelope.',
    );
  }
  return { project: migrateProject(raw as Project) };
}
