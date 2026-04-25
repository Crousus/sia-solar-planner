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
// Map calibration: pixels ↔ meters.
//
// The whole "place panels to scale" workflow depends on this single function.
// It's why using a real slippy-tile map is valuable over a screenshot — we
// get the calibration for free instead of asking the user to draw a
// reference line and type in a known length.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Meters per screen pixel at a given Web Mercator zoom and latitude.
 *
 * Web Mercator tile math:
 *   - Each tile is 256 px.
 *   - At zoom Z the equator is covered by 2^Z tiles, i.e. 256 * 2^Z pixels.
 *   - The Earth's equatorial circumference is ~40 075 017 m
 *     → equator m/px = 40075017 / (256 * 2^Z) ≈ 156543.03392 / 2^Z
 *   - Mercator stretches northward; at latitude φ, 1 pixel covers
 *     cos(φ) times fewer meters than at the equator.
 *
 * Reference value to sanity-check against (verified in calibration.test.ts):
 *   zoom 19, lat 48° → ~0.200 m/px (typical house-scale)
 *   zoom 21, lat 48° → ~0.050 m/px (tile over-zoom; ESRI max native is 19)
 *   zoom 0,  lat 0°  → 156543.034 m/px (the bare equator constant)
 *
 * This function is pure and synchronous — call it exactly once on Lock Map
 * and store the result in `mapState.metersPerPixel`. Don't recompute
 * per-frame; the locked viewport doesn't move, so mpp doesn't change.
 */
export function metersPerPixel(zoom: number, latDeg: number): number {
  return (156543.03392 * Math.cos((latDeg * Math.PI) / 180)) / Math.pow(2, zoom);
}
