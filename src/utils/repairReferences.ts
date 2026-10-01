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
// repairReferences — whole-project referential-integrity repair.
//
// Why this exists: the sync client's three-way rebase (rebaseProject in
// backend/diff.ts) merges entity arrays BY ID and is deliberately
// schema-agnostic. That makes it great at keeping non-overlapping edits
// from both sides, but it has no idea that a Panel's `roofId` points into
// `roofs`. Concurrent edits it happily accepts can therefore produce a
// doc no single client could have made:
//
//   - Bob deletes a roof while Alice places panels on it  → panels on a
//     missing roof (invisible, but still counted in kWp totals / PDF)
//   - Bob deletes a string while Alice paints panels into it → panels
//     whose stringId dangles
//   - Bob deletes an inverter while Alice routes a string to it
//   - Bob deletes a diagram node while Alice draws an edge to it → React
//     Flow logs warnings and the PDF export draws a stub edge
//   - both add panels to the same string → two panels with the same
//     indexInString (the "duplicate #7" failure mode renumberStrings in
//     projectStore.ts exists to prevent)
//
// The undo middleware has its own TARGETED repair (applyEntry in
// store/undoMiddleware.ts) that only cascades from what an undo step
// touched. A merge has no such small "touched" set — any field may have
// come from either side — so this is a full sweep instead. It runs after
// every merge result in syncClient, before the store write, which means
// the repair becomes an ordinary local edit that is diffed against the
// server baseline and POSTed like any other change.
//
// Contract:
//   - Pure: no store / backend imports (AGENTS.md layering rule for utils).
//   - Deterministic: depends only on the input doc (array order is the
//     tiebreak), so two clients repairing the same merged doc agree.
//   - Idempotent: repair(repair(x)) deep-equals repair(x).
//   - Identity-preserving: returns the SAME object when nothing needed
//     fixing, and keeps untouched sub-arrays / entities by reference. The
//     sync client diffs the result against the store on every merge, and
//     `compare()` short-circuits on `===` — returning a fresh copy would
//     force a deep walk of the (possibly multi-MB) doc for nothing.
// ────────────────────────────────────────────────────────────────────────

import type { Panel, Project, PvString } from '../types';

/**
 * Restore referential integrity of `project`:
 *
 *   1. panels whose roof no longer exists are DROPPED (same cascade as
 *      deleteRoof — a panel can't render without its roof's geometry);
 *   2. panels whose string no longer exists become unassigned
 *      (stringId/indexInString → null, same as deleteString);
 *      an unassigned panel carrying a stale indexInString is cleared too;
 *   3. strings whose inverter no longer exists lose inverterId AND
 *      mpptPort (a port letter is meaningless without its inverter, same
 *      as deleteInverter);
 *   4. diagram edges whose source or target node is missing are dropped;
 *   5. every string's indexInString is made dense 1..N.
 *
 * Numbering policy for (5) mirrors renumberStrings in projectStore.ts
 * ("preserve the sequence the user added them"): numbered panels keep
 * their relative order (ascending existing index), un-numbered members are
 * appended in array order, and the result is compacted to 1..N. Ties —
 * two panels both claiming #7 after concurrent additions — break by array
 * position, which after rebaseProject means "their ordering first, then
 * panels only we added", i.e. the collaborator's already-committed panel
 * keeps the lower number and ours goes after it. A string that is already
 * dense is left untouched (no panel objects are rewritten).
 *
 * renumberStrings itself isn't reused because it lives in the store
 * (utils must not import store/*) and takes an insertion-order hint that
 * only makes sense inside an action; the two-tier sort is the same.
 */
export function repairReferences(project: Project): Project {
  const roofIds = new Set(project.roofs.map((r) => r.id));
  const stringIds = new Set(project.strings.map((s) => s.id));
  const inverterIds = new Set(project.inverters.map((i) => i.id));

  // ── Strings → inverters ────────────────────────────────────────────
  let strings: PvString[] = project.strings;
  {
    let changed = false;
    const next = project.strings.map((s) => {
      if (s.inverterId == null || inverterIds.has(s.inverterId)) return s;
      changed = true;
      return { ...s, inverterId: null, mpptPort: null };
    });
    if (changed) strings = next;
  }

  // ── Panels → roofs / strings ───────────────────────────────────────
  let panels: Panel[] = project.panels;
  {
    let changed = false;
    const next: Panel[] = [];
    for (const p of project.panels) {
      if (!roofIds.has(p.roofId)) {
        changed = true;
        continue;
      }
      if (p.stringId != null && !stringIds.has(p.stringId)) {
        changed = true;
        next.push({ ...p, stringId: null, indexInString: null });
        continue;
      }
      if (p.stringId == null && p.indexInString != null) {
        changed = true;
        next.push({ ...p, indexInString: null });
        continue;
      }
      next.push(p);
    }
    if (changed) panels = next;
  }

  // ── Dense string numbering ─────────────────────────────────────────
  panels = renumberAllDense(panels);

  // ── Diagram edges → nodes ──────────────────────────────────────────
  let diagram = project.diagram;
  if (diagram) {
    const nodeIds = new Set(diagram.nodes.map((n) => n.id));
    const edges = diagram.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
    if (edges.length !== diagram.edges.length) diagram = { ...diagram, edges };
  }

  if (
    strings === project.strings &&
    panels === project.panels &&
    diagram === project.diagram
  ) {
    return project;
  }
  // Only re-attach `diagram` when it was changed: spreading
  // `diagram: undefined` onto a project that never had the key would add
  // a JS-only key that the JSON-patch diff then has to reason about.
  const out: Project = { ...project, strings, panels };
  if (diagram !== project.diagram) out.diagram = diagram;
  return out;
}

/**
 * Compact every string's indexInString to 1..N (see repairReferences for
 * the ordering policy). Returns `panels` unchanged by reference when every
 * string is already dense. Assumes every non-null stringId is live (the
 * caller has already unassigned dangling ones).
 */
function renumberAllDense(panels: Panel[]): Panel[] {
  // Group members by string, remembering array positions so the rewrite
  // is in place — other consumers (PanelLayer keys, rebase ordering) rely
  // on the panels array order staying stable.
  const byString = new Map<string, number[]>();
  panels.forEach((p, i) => {
    if (p.stringId == null) return;
    const list = byString.get(p.stringId);
    if (list) list.push(i);
    else byString.set(p.stringId, [i]);
  });

  let out: Panel[] | null = null;
  for (const members of byString.values()) {
    const sorted = [...members].sort((a, b) => {
      const ai = panels[a].indexInString;
      const bi = panels[b].indexInString;
      if (ai != null && bi != null && ai !== bi) return ai - bi;
      if (ai != null && bi == null) return -1;
      if (ai == null && bi != null) return 1;
      return a - b; // equal / both null → array position
    });
    for (let k = 0; k < sorted.length; k++) {
      const i = sorted[k];
      if (panels[i].indexInString === k + 1) continue;
      out ??= [...panels];
      out[i] = { ...panels[i], indexInString: k + 1 };
    }
  }
  return out ?? panels;
}
