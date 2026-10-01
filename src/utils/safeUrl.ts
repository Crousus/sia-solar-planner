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
// safeHttpUrl — guard for rendering user/doc-supplied URLs into href/src.
//
// Why this exists: fields like `project.panelType.datasheetUrl` live in the
// shared project doc, which ANY team member can rewrite via a JSON patch
// (and the server treats `doc` as opaque). Rendering such a value straight
// into `<a href>` is a stored-XSS vector — `javascript:alert(document.cookie)`
// runs in the victim's origin (with their PocketBase token in localStorage)
// the moment they click the link. React only warns about `javascript:` URLs;
// it doesn't block them, and `data:`/`vbscript:` aren't even warned about.
//
// Rule: only absolute http(s) URLs are linkified. Everything else (other
// schemes, relative paths, garbage) returns null and the caller renders
// the raw value as plain text (or nothing).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returns a normalised absolute http(s) URL string, or null when `raw` is
 * not safe to place in an `href`/`src`.
 *
 * Parsing goes through the WHATWG URL parser rather than a regex so that
 * obfuscations browsers would still execute (leading whitespace/control
 * chars, mixed case `JaVaScRiPt:`, embedded tabs/newlines) are normalised
 * the same way the browser would before we look at the protocol.
 *
 * No base URL is passed on purpose: relative URLs throw and are rejected.
 * A relative path in a shared doc could point at an authenticated route in
 * our own origin, which is not something a "datasheet" link should do.
 */
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.href;
}

/**
 * Returns `raw` when it is a base64 raster-image data: URI (png / jpeg /
 * webp / gif), else null.
 *
 * Used for `<img src>` values read from the shared project doc, e.g. the
 * captured satellite backdrop (`mapState.capturedImage`) shown as a
 * thumbnail on TeamView. `javascript:` in an img src doesn't execute in
 * modern browsers, but a collaborator could still swap in an external
 * http(s) URL and turn every teammate's project list into a tracking
 * pixel (leaking IP / timing). The app itself only ever writes data URIs
 * here, so anything else is rejected. SVG is excluded on purpose — it is a
 * document format, and there is no legitimate producer of it in this
 * field.
 */
export function safeDataImageUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return /^data:image\/(png|jpeg|webp|gif);base64,/i.test(raw) ? raw : null;
}
