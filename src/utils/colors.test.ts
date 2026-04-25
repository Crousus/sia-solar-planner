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
// colors tests.
//
// Trivial in line count but the function is on every string-color render
// path (the "darker" outline used to make string fills pop against the
// satellite imagery). Edge cases that historically bite hex utilities:
//   - leading-hash tolerance ("#fff" vs "fff" — we don't support the short
//     form, but we MUST accept either presence/absence of the leading "#")
//   - clamp at amount ≥ 1 (must produce #000000, not negative components)
//   - identity at amount = 0 (must round-trip the original color)
//   - zero-padding (a darkened component < 16 must still produce two hex
//     digits, otherwise "#abc" would mis-parse as 3-digit shorthand)
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { darkenColor } from './colors';

describe('darkenColor', () => {
  it('returns the same color (lower-cased) when amount is 0', () => {
    // 0% darkening = identity. Verifies the hex parse + format round-trip
    // doesn't mangle the value.
    expect(darkenColor('#abcdef', 0)).toBe('#abcdef');
  });

  it('halves each component at amount=0.5 (with floor)', () => {
    // #ff8040 → r=255, g=128, b=64. After ×0.5 floor → 127, 64, 32.
    // Hex: 7f, 40, 20.
    expect(darkenColor('#ff8040', 0.5)).toBe('#7f4020');
  });

  it('clamps to #000000 at amount=1', () => {
    // 100% darkening drops every component to 0.
    expect(darkenColor('#ffffff', 1)).toBe('#000000');
  });

  it('clamps to #000000 even when amount > 1 (no negative components)', () => {
    // The arithmetic 255 * (1 - 1.5) = -127.5; the explicit max(0, …) guard
    // keeps the hex output valid.
    expect(darkenColor('#ffffff', 1.5)).toBe('#000000');
  });

  it('accepts input WITHOUT the leading "#" (hash is stripped, then re-added)', () => {
    // The replace(/^#/) is purely tolerant — callers may strip the hash
    // upstream (e.g. when composing with a CSS variable). Verify both
    // forms produce the same canonical "#rrggbb" output.
    expect(darkenColor('ff0000', 0.5)).toBe('#7f0000');
  });

  it('zero-pads single-digit hex components (avoids accidental "#abc" shorthand)', () => {
    // r=255 darkened by 95% → 255 * 0.05 = 12.75 → floor 12 → hex "0c".
    // Without padStart this would emit "c" and the resulting string
    // would be 5 chars long instead of 7, breaking downstream parsers.
    const out = darkenColor('#ff0000', 0.95);
    expect(out).toBe('#0c0000');
    expect(out).toHaveLength(7);
  });
});
