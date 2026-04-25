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
// calibration tests.
//
// metersPerPixel is one line of code but it sits under EVERY measurement in
// the app — panel sizes on the canvas, projected area in the sidebar, length
// labels on roof edges, kWp totals on the PDF. A typo in the magic constant
// or a sign flip on the cosine factor would make every project ship with
// silently-wrong dimensions, so we lock the formula down with the two
// reference values in the function's docstring plus the structural
// invariants (cos(lat) scaling, zoom doubling halves m/px).
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { metersPerPixel } from './calibration';

describe('metersPerPixel', () => {
  it('matches the documented sanity value at zoom 19, lat 48° (~0.200 m/px)', () => {
    // The typical Bavarian house-scale calibration we'd hit when locking the
    // map for a normal PV project. Drift here means the formula constant
    // (156543.03392) is wrong. Earlier docstring claimed ~0.233 — that was
    // off (corrected 2026-04 alongside this test); the value below is the
    // ground-truth Web-Mercator output.
    expect(metersPerPixel(19, 48)).toBeCloseTo(0.1998, 3);
  });

  it('matches the documented sanity value at zoom 21, lat 48° (~0.050 m/px)', () => {
    // Tile over-zoom case — also exercises the 2^Z denominator at a higher
    // exponent. Same docstring correction story as the zoom-19 case.
    expect(metersPerPixel(21, 48)).toBeCloseTo(0.0499, 3);
  });

  it('returns the equator constant at lat=0 (cos(0) = 1, no Mercator stretch)', () => {
    // 156543.03392 / 2^0 = 156543.03392 m/px at zoom 0 along the equator.
    // This is the pure base constant before any latitude scaling.
    expect(metersPerPixel(0, 0)).toBeCloseTo(156543.03392, 1);
  });

  it('halves m/px when zoom increases by 1 (2^Z scaling)', () => {
    // The Web Mercator pyramid: each zoom level doubles the tile count, so
    // each pixel covers half the meters of the previous level.
    const z10 = metersPerPixel(10, 48);
    const z11 = metersPerPixel(11, 48);
    expect(z11).toBeCloseTo(z10 / 2);
  });

  it('scales by cos(lat) — at 60°N, m/px is half the equator value (cos(60°)=0.5)', () => {
    const equator = metersPerPixel(15, 0);
    const sixty = metersPerPixel(15, 60);
    // cos(60°) = 0.5 exactly, so the high-latitude value is exactly half.
    expect(sixty).toBeCloseTo(equator * 0.5);
  });

  it('is symmetric across the equator (north vs south same |lat|)', () => {
    // cos(-φ) = cos(φ) — the Mercator stretch is the same in both hemispheres.
    expect(metersPerPixel(18, 45)).toBeCloseTo(metersPerPixel(18, -45));
  });
});
