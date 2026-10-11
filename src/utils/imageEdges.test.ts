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

import { describe, it, expect } from 'vitest';
import {
  detectLineSegments,
  findImageEdges,
  ImageEdgeIndex,
  lineAngleDiff,
  mergeCollinearEdges,
  pointSegmentDistance,
  type ImageEdge,
} from './imageEdges';
import type { Point } from '../types';

// ── Synthetic image helpers ────────────────────────────────────────────────

/** Deterministic PRNG so noisy fixtures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function insidePolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Render filled polygons (4×4 supersampled → anti-aliased edges) with
 *  Gaussian-ish noise, like a soft satellite image. */
function render(
  w: number,
  h: number,
  shapes: { poly: Point[]; value: number }[],
  background: number,
  noise: number,
  seed = 1,
): Float32Array {
  const img = new Float32Array(w * h);
  const rand = rng(seed);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const p = { x: x + (sx + 0.5) / 4, y: y + (sy + 0.5) / 4 };
          let v = background;
          for (const s of shapes) if (insidePolygon(p, s.poly)) v = s.value;
          acc += v;
        }
      }
      const n = (rand() + rand() + rand() - 1.5) * 2 * noise;
      img[y * w + x] = Math.max(0, Math.min(255, acc / 16 + n));
    }
  }
  return img;
}

function rotated(cx: number, cy: number, hw: number, hh: number, deg: number): Point[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => ({ x: cx + x * c - y * s, y: cy + x * s + y * c }));
}

/** An edge matches a reference side if it is parallel, on the line and
 *  covers most of it. */
function matchesSide(e: ImageEdge, a: Point, b: Point, tolPx = 1.5): boolean {
  const ref = Math.atan2(b.y - a.y, b.x - a.x);
  if ((lineAngleDiff(e.angle, ref) * 180) / Math.PI > 1.5) return false;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const off = (p: Point) => Math.abs(-(p.x - a.x) * uy + (p.y - a.y) * ux);
  if (off(e.a) > tolPx || off(e.b) > tolPx) return false;
  return e.length > len * 0.75;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('detectLineSegments + findImageEdges', () => {
  it('finds all four sides of a rotated, noisy, anti-aliased roof', () => {
    const poly = rotated(100, 80, 60, 35, 17);
    const img = render(200, 160, [{ poly, value: 170 }], 70, 6);
    const edges = findImageEdges(img, 200, 160, 20);
    for (let i = 0; i < 4; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % 4];
      expect(edges.some((e) => matchesSide(e, a, b))).toBe(true);
    }
  });

  it('locates an axis-aligned step on the pixel boundary (no half-pixel bias)', () => {
    // Bright block covering columns 40..119 → left edge exactly at x = 40.
    const poly = [{ x: 40, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 100 }, { x: 40, y: 100 }];
    const img = render(160, 120, [{ poly, value: 200 }], 50, 0);
    const edges = findImageEdges(img, 160, 120, 20);
    const left = edges.find((e) => matchesSide(e, poly[3], poly[0]));
    expect(left).toBeDefined();
    expect((left!.a.x + left!.b.x) / 2).toBeCloseTo(40, 0);
  });

  it('finds the ridge between two roof faces of different brightness', () => {
    // Gable roof seen from above: two faces (sun / shade side) meet at a ridge.
    const sun = [{ x: 30, y: 30 }, { x: 170, y: 30 }, { x: 170, y: 80 }, { x: 30, y: 80 }];
    const shade = [{ x: 30, y: 80 }, { x: 170, y: 80 }, { x: 170, y: 130 }, { x: 30, y: 130 }];
    const img = render(200, 160, [{ poly: sun, value: 190 }, { poly: shade, value: 120 }], 60, 5);
    const edges = findImageEdges(img, 200, 160, 20);
    expect(edges.some((e) => matchesSide(e, { x: 30, y: 80 }, { x: 170, y: 80 }))).toBe(true);
  });

  it('drops edges shorter than the minimum length', () => {
    const poly = rotated(80, 80, 6, 6, 0); // 12 px square
    const img = render(160, 160, [{ poly, value: 220 }], 40, 0);
    expect(findImageEdges(img, 160, 160, 20)).toHaveLength(0);
  });

  it('handles degenerate inputs', () => {
    expect(detectLineSegments(new Float32Array(4), 2, 2, { minLength: 5 })).toEqual([]);
    expect(findImageEdges(new Float32Array(100 * 100).fill(128), 100, 100, 10)).toEqual([]);
  });
});

// ── Recall / precision benchmark ──────────────────────────────────────────
// Guards the tuned defaults: a grid of rotated gable roofs (two faces → four
// eaves + a ridge each) on a textured background. "low" contrast is harsher
// than typical imagery (12–25 level steps under ±25 noise).

function benchmarkScene(hi: number, lo: number, seed: number) {
  const W = 800;
  const H = 500;
  const img = new Float32Array(W * H);
  const rand = rng(seed);
  for (let i = 0; i < W * H; i++) img[i] = 90 + (rand() - 0.5) * 50;
  const roofs: { cx: number; cy: number; hw: number; hh: number; r: number }[] = [];
  for (let k = 0; k < 8; k++) {
    roofs.push({
      cx: 110 + (k % 4) * 195,
      cy: 125 + Math.floor(k / 4) * 250,
      hw: 50 + rand() * 25,
      hh: 30 + rand() * 12,
      r: rand() * Math.PI,
    });
  }
  for (const R of roofs) {
    const c = Math.cos(R.r);
    const s = Math.sin(R.r);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = x + 0.5 - R.cx;
        const dy = y + 0.5 - R.cy;
        const u = dx * c + dy * s;
        const v = -dx * s + dy * c;
        if (Math.abs(u) < R.hw && Math.abs(v) < R.hh) img[y * W + x] = (v < 0 ? hi : lo) + (rand() - 0.5) * 30;
      }
    }
  }
  const lines: [Point, Point][] = [];
  for (const R of roofs) {
    const c = Math.cos(R.r);
    const s = Math.sin(R.r);
    const P = (u: number, v: number) => ({ x: R.cx + u * c - v * s, y: R.cy + u * s + v * c });
    lines.push(
      [P(-R.hw, -R.hh), P(R.hw, -R.hh)],
      [P(R.hw, -R.hh), P(R.hw, R.hh)],
      [P(R.hw, R.hh), P(-R.hw, R.hh)],
      [P(-R.hw, R.hh), P(-R.hw, -R.hh)],
      [P(-R.hw, 0), P(R.hw, 0)], // ridge
    );
  }
  return { W, H, img, lines };
}

function recall(edges: ImageEdge[], lines: [Point, Point][]): number {
  const hit = lines.filter(([a, b]) => edges.some((e) => matchesSide(e, a, b, 2) || coversMost(e, a, b)));
  return hit.length / lines.length;
}
/** Looser than matchesSide: ≥ 60 % coverage (corners blur the ends). */
function coversMost(e: ImageEdge, a: Point, b: Point): boolean {
  const ref = Math.atan2(b.y - a.y, b.x - a.x);
  if (lineAngleDiff(e.angle, ref) > 0.03) return false;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const off = (p: Point) => Math.abs(-(p.x - a.x) * uy + (p.y - a.y) * ux);
  return off(e.a) < 2 && off(e.b) < 2 && e.length > len * 0.6;
}

describe('findImageEdges — recall / precision benchmark', () => {
  it('finds ≥ 95 % of eaves and ridges on clearly visible roofs', () => {
    const sc = benchmarkScene(175, 125, 3);
    expect(recall(findImageEdges(sc.img, sc.W, sc.H, 20), sc.lines)).toBeGreaterThanOrEqual(0.95);
  });

  it('finds most edges on low-contrast roofs (dark roof on dark ground)', () => {
    // SNR < 1 per pixel — a stress case, not a target. Measured ~68 %;
    // the threshold leaves headroom so detector tweaks that trade a little
    // recall for precision don't trip it.
    const sc = benchmarkScene(115, 102, 4);
    expect(recall(findImageEdges(sc.img, sc.W, sc.H, 20), sc.lines)).toBeGreaterThanOrEqual(0.6);
  });

  it('reports no lines in strong pure noise (several seeds)', () => {
    for (const seed of [7, 8, 9, 10, 11]) {
      const img = render(160, 160, [], 120, 25, seed);
      expect(findImageEdges(img, 160, 160, 20)).toHaveLength(0);
    }
  });
});

describe('mergeCollinearEdges', () => {
  const e = (ax: number, ay: number, bx: number, by: number): ImageEdge => ({
    a: { x: ax, y: ay },
    b: { x: bx, y: by },
    angle: Math.atan2(by - ay, bx - ax),
    length: Math.hypot(bx - ax, by - ay),
    strength: 10,
  });

  it('joins pieces of one eave interrupted by a chimney', () => {
    const merged = mergeCollinearEdges([e(0, 50, 40, 50), e(46, 50.5, 100, 50)], { gapTol: 10 });
    expect(merged).toHaveLength(1);
    expect(merged[0].length).toBeCloseTo(100, 0);
  });

  it('keeps parallel lines that are offset (two different eaves)', () => {
    expect(mergeCollinearEdges([e(0, 50, 40, 50), e(46, 56, 100, 56)], { gapTol: 10 })).toHaveLength(2);
  });

  it('keeps collinear pieces separated by a large gap', () => {
    expect(mergeCollinearEdges([e(0, 50, 40, 50), e(80, 50, 120, 50)], { gapTol: 10 })).toHaveLength(2);
  });

  it('handles reversed direction of the second piece', () => {
    const merged = mergeCollinearEdges([e(0, 0, 50, 0), e(100, 0, 52, 0)], { gapTol: 5 });
    expect(merged).toHaveLength(1);
    expect(merged[0].length).toBeCloseTo(100, 0);
  });
});

describe('ImageEdgeIndex', () => {
  it('returns exactly the edges within the radius', () => {
    const edges: ImageEdge[] = [
      { a: { x: 0, y: 0 }, b: { x: 1000, y: 1000 }, angle: Math.PI / 4, length: 1414, strength: 5 },
      { a: { x: 500, y: 0 }, b: { x: 600, y: 0 }, angle: 0, length: 100, strength: 5 },
    ];
    const idx = new ImageEdgeIndex(edges, 32);
    const near = idx.near({ x: 700, y: 710 }, 10);
    expect(near).toEqual([edges[0]]);
    expect(idx.near({ x: 550, y: 5 }, 6)).toEqual([edges[1]]);
    expect(idx.near({ x: 300, y: 900 }, 20)).toEqual([]);
  });

  it('pointSegmentDistance clamps to the endpoints', () => {
    expect(pointSegmentDistance({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5);
  });
});
