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
// Both deep-clone their inputs before acting (fast-json-patch mutates by
// default when given arrays). The safety cost is a structuredClone per
// call; negligible for our sizes (< 100 KB typical project).
// ────────────────────────────────────────────────────────────────────────

import jsonpatch from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';
import type { Project } from '../types';

// fast-json-patch ships as a CJS module with a default export bag of
// functions (`compare`, `applyPatch`, …). Under our ESM/bundler setup
// the named imports resolve to `undefined` at runtime even though the
// type declarations advertise them — so we destructure off the default
// export. The shape is identical, just one indirection. If we ever
// switch to a fully ESM-native patch library (e.g. `rfc6902`), this
// destructuring goes away in the same edit.
const { compare, applyPatch: fastApplyPatch } = jsonpatch;

export type Op = Operation;

/** Produce a patch that transforms `a` into `b`. */
export function diffProjects(a: Project, b: Project): Op[] {
  // compare() does NOT mutate its inputs, so cloning is unnecessary here.
  // We rely on that contract rather than paying for a clone we don't need:
  // diffs run on every store change in the sync client and adding a
  // structuredClone per call would noticeably tax that hot path.
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
  return result.newDocument as Project;
}
