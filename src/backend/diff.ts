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
