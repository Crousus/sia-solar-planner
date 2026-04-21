/**
 * Parse a `#RRGGBB` hex string into r/g/b bytes (0–255).
 *
 * Used by pdfExport to feed jsPDF's setFillColor(r,g,b) — the library
 * doesn't accept CSS hex strings directly. Also useful any time we need
 * to bridge between the CSS palette in index.css and a non-CSS renderer.
 *
 * No format validation: we trust callers (all in-tree) to pass the
 * 6-digit form. Shorthand `#RGB` and named colors would silently produce
 * NaN bytes, but that's a contract the call sites uphold today.
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return { r, g, b };
}

/**
 * Darken a hex color by a given percentage.
 */
export function darkenColor(hex: string, amount: number): string {
  // Remove hash
  hex = hex.replace(/^#/, '');
  // Parse components
  let r = parseInt(hex.substring(0, 2), 16);
  let g = parseInt(hex.substring(2, 4), 16);
  let b = parseInt(hex.substring(4, 6), 16);

  // Darken and clamp
  r = Math.max(0, Math.min(255, Math.floor(r * (1 - amount))));
  g = Math.max(0, Math.min(255, Math.floor(g * (1 - amount))));
  b = Math.max(0, Math.min(255, Math.floor(b * (1 - amount))));

  // Back to hex
  const rr = r.toString(16).padStart(2, '0');
  const gg = g.toString(16).padStart(2, '0');
  const bb = b.toString(16).padStart(2, '0');

  return `#${rr}${gg}${bb}`;
}
