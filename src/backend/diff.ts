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

// ────────────────────────────────────────────────────────────────────────
// JSON Patch wrapper.
//
// We use `fast-json-patch` because:
//   - It ships both `compare` (produce a patch) and `applyPatch` (consume).
//   - ~10 KB gzipped — cheaper than `rfc6902` for equivalent capability.
//   - Zero dependencies.
//
// This module is the ONLY place the rest of the app imports the library.
// Swapping libraries later = one file's worth of churn.
//
// Shape:
//   diffProjects(a, b) -> Operation[]        // a → b transform
//   applyProjectPatch(doc, ops) -> Project   // doc with ops applied
//   toJsonDoc(doc) -> Project                // strip undefined/NaN (server shape)
//   rebaseProject(base, theirs, mine)        // id-aware three-way merge
//
// Index-addressed ops from diffProjects are only safe when applied to
// the exact doc they were computed from. The sync client guarantees
// that (see ADR-016); anything that must combine two divergent docs goes
// through rebaseProject instead.
//
// applyProjectPatch clones its input before acting (fast-json-patch can
// mutate documents in place depending on flags). diffProjects does not
// clone — see the comment inside for the rationale.
// ────────────────────────────────────────────────────────────────────────

import { compare, applyPatch as fastApplyPatch, type Operation } from 'fast-json-patch';
import type { Project } from '../types';

export type Op = Operation;

/** Produce a patch that transforms `a` into `b`. */
export function diffProjects(a: Project, b: Project): Op[] {
  // Note: the plan proposed cloning here defensively to insulate against
  // future lib changes. We skip it — diff is called on every store change
  // in the sync client, and a structuredClone per call is measurable on
  // larger projects. compare() has a stable documented no-mutation
  // contract; if we ever swap libraries and that contract weakens, we
  // add the clone then.
  return compare(a as unknown as object, b as unknown as object);
}

/**
 * Apply `ops` to `doc` and return the resulting project. Throws if the
 * patch is malformed or any `test` op fails; callers in syncClient
 * translate throws into a full-resync fallback.
 */
export function applyProjectPatch(doc: Project, ops: Op[]): Project {
  // We pass `mutate=false` so fast-json-patch internally clones the
  // document before applying ops. We additionally clone the input
  // ourselves so that even if a future library version changes the
  // mutate semantics or we forget the flag, callers' references stay
  // pristine — apply() is called from the sync client where the input
  // doc is the authoritative current store state.
  //
  // structuredClone is native since Node 17 / browsers of the same era —
  // no shim needed given our target environments (see tsconfig lib).
  const result = fastApplyPatch(
    structuredClone(doc),
    ops,
    /* validate */ true,
    /* mutate */ false,
  );
  return result.newDocument;
}

// ────────────────────────────────────────────────────────────────────────
// JSON normalisation
//
// The server stores `doc` as JSON (Go's encoding/json round-trip), so it
// can never contain `undefined`, NaN or Infinity. The in-memory store
// CAN (optional fields set to `undefined` by spread-updates are common).
// If the sync baseline kept those JS-only values, later diffs would
// produce ops like `replace /roofs/0/foo` for a key that does not exist
// on the server — RFC 6902 `replace`/`remove` require the target to
// exist, so the server rejects the whole patch with 400. Every baseline
// the sync client keeps therefore goes through `toJsonDoc` first, which
// makes it byte-for-byte what the server would hold after applying the
// same ops.
//
// Implementation preserves object identity for any subtree that needs no
// change. That matters: the doc may embed a multi-MB base64 map capture,
// and both `compare()` and `rebaseProject()` short-circuit on `===`, so
// a naive JSON.parse(JSON.stringify()) would turn every later diff into
// a full deep walk and copy the image string on every POST.
// ────────────────────────────────────────────────────────────────────────

function toJsonValue(v: unknown, inArray: boolean): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
    // JSON.stringify drops these from objects and nulls them in arrays.
    return inArray ? null : undefined;
  }
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < v.length; i++) {
      const next = toJsonValue(v[i], true);
      if (next !== v[i] && out === null) out = v.slice(0, i);
      if (out) out.push(next);
    }
    return out ?? v;
  }
  const obj = v as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const next = toJsonValue(obj[k], false);
    // `next === undefined` means "drop this key" — it compares equal to
    // an undefined input value, so test it explicitly.
    if ((next === undefined || next !== obj[k]) && out === null) {
      out = {};
      for (let j = 0; j < i; j++) out[keys[j]] = obj[keys[j]];
    }
    if (out && next !== undefined) out[k] = next;
  }
  return out ?? obj;
}

/** Return `doc` as the server would store it (no undefined / NaN). */
export function toJsonDoc(doc: Project): Project {
  return toJsonValue(doc, false) as Project;
}

// ────────────────────────────────────────────────────────────────────────
// Three-way rebase
//
// Used by the sync client whenever the server-confirmed baseline moves
// (an inbound patch from a collaborator, a 409 response carrying the
// server's current doc, or a full resync) while the local store still
// holds edits that have not been acknowledged yet. See ADR-016.
//
//   base   = the doc both sides started from (last server-confirmed doc)
//   theirs = the new server doc
//   mine   = the local store's project (base + unsent local edits)
//
// Why a structural merge instead of "diff mine vs base, apply onto
// theirs": fast-json-patch's `compare` addresses array elements by INDEX.
// If a collaborator deleted panels[1], our `replace /panels/2/x` would
// land on the wrong panel, and our `remove /panels/5` could delete a
// panel the user never touched. Every top-level collection in a Project
// (roofs, panels, strings, inverters, diagram nodes/edges, …) is an array
// of entities with a stable string `id`, so we merge those arrays BY ID.
// The JSON-patch diff is then only ever computed between two docs held
// in the same place (store→store, or baseline→local where the baseline
// is exactly the server doc), where index addressing is always correct.
//
// Merge rules per value:
//   - only one side changed it      → take that side
//   - both changed it identically   → take it
//   - both are plain objects        → recurse key by key
//   - both are id-keyed arrays      → recurse element by element (by id)
//   - otherwise (true conflict)     → keep MINE and record the path
//
// "Keep mine" on conflict is deliberate: it never silently drops local
// work. Callers decide what to do with `conflicts` (the sync client
// surfaces them via the conflict modal instead of auto-applying).
// ────────────────────────────────────────────────────────────────────────

export interface RebaseResult {
  doc: Project;
  /** JSON-pointer-ish paths where both sides changed the same value. */
  conflicts: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep equality with JSON semantics: object keys whose value is
 * `undefined` count as absent (matches how compare() and the server see
 * them). Identity short-circuit first — the common case by far.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    // NaN/Infinity serialise to null on the server; treat as equal to
    // each other so a non-finite local value isn't a perpetual "edit".
    return !Number.isFinite(a) && !Number.isFinite(b);
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], bb[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!jsonEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/** Array whose elements are all objects with a unique string `id`. */
function isEntityArray(v: unknown): v is Array<Record<string, unknown> & { id: string }> {
  if (!Array.isArray(v)) return false;
  const seen = new Set<string>();
  for (const el of v) {
    if (!isPlainObject(el) || typeof el.id !== 'string') return false;
    if (seen.has(el.id)) return false; // duplicate ids → can't merge by id safely
    seen.add(el.id);
  }
  return true;
}

function merge3(
  base: unknown,
  theirs: unknown,
  mine: unknown,
  path: string,
  conflicts: string[],
): unknown {
  if (jsonEqual(mine, base)) return theirs;
  if (jsonEqual(theirs, base)) return mine;
  if (jsonEqual(mine, theirs)) return mine;

  if (isPlainObject(theirs) && isPlainObject(mine) && (base === undefined || isPlainObject(base))) {
    const b = (base ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // Key order: theirs first, then keys only mine has. Order of object
    // keys is irrelevant to JSON semantics but keeping it stable makes
    // diffs against either side minimal.
    const keys = [...Object.keys(theirs)];
    for (const k of Object.keys(mine)) if (!(k in theirs)) keys.push(k);
    for (const k of Object.keys(b)) if (!(k in theirs) && !(k in mine)) keys.push(k);
    for (const k of keys) {
      const v = merge3(b[k], theirs[k], mine[k], `${path}/${k}`, conflicts);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  if (isEntityArray(theirs) && isEntityArray(mine) && (base === undefined || isEntityArray(base))) {
    const baseById = new Map((base ?? []).map((e) => [e.id, e]));
    const mineById = new Map(mine.map((e) => [e.id, e]));
    const theirsIds = new Set(theirs.map((e) => e.id));
    const out: unknown[] = [];
    // Pass 1 — walk theirs in order (their ordering wins for shared
    // elements; ordering-only changes on both sides are not conflicts we
    // care about for this data model).
    for (const t of theirs) {
      const b = baseById.get(t.id);
      const m = mineById.get(t.id);
      const elPath = `${path}/[id=${t.id}]`;
      if (m !== undefined) {
        out.push(merge3(b, t, m, elPath, conflicts));
      } else if (b !== undefined) {
        // Mine deleted it. If they also modified it, that's a conflict;
        // the local delete wins (it is local work).
        if (!jsonEqual(t, b)) conflicts.push(elPath);
      } else {
        // Added by them only.
        out.push(t);
      }
    }
    // Pass 2 — elements only mine still has.
    for (const m of mine) {
      if (theirsIds.has(m.id)) continue;
      const b = baseById.get(m.id);
      if (b === undefined) {
        // Added locally — keep.
        out.push(m);
      } else if (!jsonEqual(m, b)) {
        // They deleted it but we modified it: conflict, keep ours.
        conflicts.push(`${path}/[id=${m.id}]`);
        out.push(m);
      }
      // else: they deleted it, we didn't touch it → accept the delete.
    }
    return out;
  }

  // Scalars, non-entity arrays (polygon vertex lists, …), type changes.
  conflicts.push(path || '/');
  return mine;
}

/**
 * Carry the local edits in `mine` (relative to `base`) onto `theirs`.
 * Never throws; conflicting leaves resolve to `mine` and are reported.
 */
export function rebaseProject(base: Project, theirs: Project, mine: Project): RebaseResult {
  const conflicts: string[] = [];
  const doc = merge3(base, theirs, mine, '', conflicts) as Project;
  return { doc, conflicts };
}
