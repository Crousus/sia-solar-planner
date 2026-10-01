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
// DOM helpers shared by the global keyboard-shortcut handlers.
//
// Three separate window-level keydown listeners (App.tsx shortcuts,
// useDrawingController's Escape/Enter/Shift, useViewport's Space) each used
// to carry their own "is the user typing?" check, and every copy only knew
// about <input>/<textarea>(/<select>). The block diagram edits its labels
// via `contentEditable` (BaseNode & friends, the editable edge label), so
// Ctrl+Z inside a label silently undid an unrelated roof/panel edit and
// r/p/s/d switched the roof tool mode mid-word. One shared predicate keeps
// all three listeners in agreement.
//
// Pure DOM inspection — no React, no store.
// ────────────────────────────────────────────────────────────────────────────

/**
 * True when a keyboard event targeting `target` belongs to a text-entry
 * context and global shortcuts must therefore leave it alone.
 *
 * Covered:
 *   - <input> (any type except the button-like ones, which never take text)
 *   - <textarea>, <select>
 *   - any element that is, or sits inside, a contentEditable region
 *     (`isContentEditable` already resolves inheritance; the attribute
 *     fallback covers jsdom / detached nodes where it isn't computed)
 *   - ARIA text widgets (role="textbox" / "searchbox" / "combobox") so
 *     custom editors that don't use native elements are honoured too.
 *
 * Accepts `EventTarget | null` because that's what KeyboardEvent.target is;
 * non-Element targets (window, document) are never editable.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof Element === 'undefined' || !(target instanceof Element)) {
    return false;
  }
  const el = target as HTMLElement;

  if (el instanceof HTMLInputElement) {
    // Buttons/checkboxes/radios/ranges don't take typed text — keeping
    // shortcuts alive while one of them has focus matches what users
    // expect (e.g. Ctrl+Z after toggling a checkbox still undoes).
    const nonText = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image']);
    return !nonText.has(el.type);
  }
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return true;
  }
  if (el.isContentEditable) return true;
  // jsdom doesn't implement `isContentEditable`, and a node can be inside
  // an editable ancestor — walk up via closest() as a fallback. The
  // selector excludes contenteditable="false", which explicitly opts a
  // subtree back out of editing.
  if (el.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  if (el.closest('[role="textbox"], [role="searchbox"], [role="combobox"]')) return true;
  return false;
}
