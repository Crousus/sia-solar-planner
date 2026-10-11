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
// Straight-edge detection on the captured satellite image (ADR-019).
//
// Lets the roof draw tool snap to eaves, ridges and roof-face boundaries
// that are visible in the imagery but not yet drawn. Pure: no DOM, no store
// — runs in a Web Worker in the app (imageEdges.worker.ts) and directly in
// unit tests.
//
// Algorithm: a reduced LSD (Line Segment Detector, von Gioi et al.):
//   1. Light Gaussian blur (σ≈1) — satellite JPEG noise and tile texture
//      otherwise fragment every edge.
//   2. Sobel gradient → magnitude + orientation per pixel.
//   3. Seeds in descending gradient order (bucket sort); grow 8-connected
//      "line-support regions" of pixels whose gradient orientation stays
//      within τ of the region's running mean. Opposite-contrast sides of a
//      thin feature have opposite orientations and stay separate.
//   4. Fit each region by weighted PCA: the major axis is the line. Keep
//      it only if it is long, thin, dense and its gradients really point
//      across the line — this is what rejects tree crowns, gravel, cars.
//   5. Merge collinear pieces separated by small gaps (an eave interrupted
//      by a chimney, a dormer or a row of panels).
//   6. A-contrario validation (LSD's NFA test): a candidate survives only if
//      that many aligned pixels inside its rectangle would be essentially
//      impossible in noise. This is what stops noise fragments from being
//      chained into fake lines, and it scales with length automatically
//      (long faint edges pass, short noisy ones don't).
// ────────────────────────────────────────────────────────────────────────────

import type { Point } from '../types';

/** A detected straight edge, in the coordinate frame of the input image
 *  (or whatever frame the caller converts it to — see scaleEdges). */
export type ImageEdge = {
  a: Point;
  b: Point;
  /** Direction a→b, radians (atan2). */
  angle: number;
  length: number;
  /** Mean gradient magnitude along the edge (intensity units per px). */
  strength: number;
};

export interface DetectOptions {
  /** Shortest edge to report, in image pixels. */
  minLength: number;
  /** Minimum per-pixel gradient (0–255 intensity per px) for a pixel to
   *  take part. Default 5 ≈ a 12–15 level step after the blur. */
  gradientThreshold?: number;
  /** Max deviation of a pixel's gradient orientation from its region's. */
  angleTolDeg?: number;
  /** Region pixels / fitted rectangle area. Rejects blobs. */
  minDensity?: number;
}

/** ITU-R 601 luma from an RGBA buffer (ImageData.data). */
export function rgbaToGray(rgba: Uint8ClampedArray, pixelCount: number): Float32Array {
  const g = new Float32Array(pixelCount);
  for (let i = 0, j = 0; i < pixelCount; i++, j += 4) {
    g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  return g;
}

/** Separable 5-tap Gaussian, σ = 1, clamped borders. */
function gaussianBlur(src: Float32Array, w: number, h: number): Float32Array {
  const k = [0.0545, 0.2442, 0.4026, 0.2442, 0.0545];
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let t = -2; t <= 2; t++) {
        const xx = x + t < 0 ? 0 : x + t >= w ? w - 1 : x + t;
        acc += src[row + xx] * k[t + 2];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let t = -2; t <= 2; t++) {
        const yy = y + t < 0 ? 0 : y + t >= h ? h - 1 : y + t;
        acc += tmp[yy * w + x] * k[t + 2];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/** Smallest unsigned difference between two orientations (full 2π). */
function orientDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/** Smallest unsigned difference between two LINE directions (mod π). */
export function lineAngleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

/** ln Γ(x), Lanczos approximation (g = 7, n = 9) — ample precision here. */
function logGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** log10 of P[Binomial(n, p) ≥ k]. */
function log10BinomialTail(n: number, k: number, p: number): number {
  if (k <= 0) return 0;
  if (k > n) return -Infinity;
  // First term in log space, then the rest as ratios (no under/overflow).
  const lnFirst =
    logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log(1 - p);
  let term = 1;
  let sum = 1;
  for (let i = k; i < n; i++) {
    term *= ((n - i) / (i + 1)) * (p / (1 - p));
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return (lnFirst + Math.log(sum)) / Math.LN10;
}

function makeEdge(a: Point, b: Point, strength: number): ImageEdge {
  return {
    a,
    b,
    angle: Math.atan2(b.y - a.y, b.x - a.x),
    length: Math.hypot(b.x - a.x, b.y - a.y),
    strength,
  };
}

/**
 * Detect straight edges in a grayscale image (row-major, 0–255).
 * Returned coordinates are pixel-boundary based: a step between pixel
 * columns 19 and 20 is reported at x = 20, matching how the image is drawn
 * on the canvas (pixel i covers [i, i+1)).
 */
export function detectLineSegments(
  gray: Float32Array,
  w: number,
  h: number,
  opts: DetectOptions,
): ImageEdge[] {
  if (w < 5 || h < 5 || gray.length < w * h) return [];
  // Defaults tuned on synthetic roofs under heavy noise (imageEdges.test.ts):
  // LSD's classic τ = 22.5° fragmented noisy edges (gradient orientation
  // jitters more than that at low SNR) — 35° kept recall at ~100% with no
  // false lines in pure noise; density 0.4 tolerates the ragged regions.
  const rho = opts.gradientThreshold ?? 5;
  const tau = ((opts.angleTolDeg ?? 35) * Math.PI) / 180;
  const minDensity = opts.minDensity ?? 0.4;
  const minLength = Math.max(4, opts.minLength);

  const b = gaussianBlur(gray, w, h);
  const n = w * h;
  const mag = new Float32Array(n);
  const ang = new Float32Array(n);
  let maxMag = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      // Sobel / 8 → a per-pixel derivative estimate in intensity units.
      const gx =
        (b[i - w + 1] + 2 * b[i + 1] + b[i + w + 1] - b[i - w - 1] - 2 * b[i - 1] - b[i + w - 1]) / 8;
      const gy =
        (b[i + w - 1] + 2 * b[i + w] + b[i + w + 1] - b[i - w - 1] - 2 * b[i - w] - b[i - w + 1]) / 8;
      const m = Math.hypot(gx, gy);
      mag[i] = m;
      ang[i] = Math.atan2(gy, gx);
      if (m > maxMag) maxMag = m;
    }
  }
  if (maxMag <= rho) return [];

  // ── Seeds in descending magnitude (bucket "pseudo-sort", as in LSD) ──
  const BINS = 1024;
  const binOf = (m: number) => Math.min(BINS - 1, Math.floor(((m - rho) / (maxMag - rho)) * BINS));
  const counts = new Int32Array(BINS);
  let candidates = 0;
  for (let i = 0; i < n; i++) {
    if (mag[i] > rho) {
      counts[binOf(mag[i])]++;
      candidates++;
    }
  }
  const starts = new Int32Array(BINS);
  for (let k = BINS - 1, acc = 0; k >= 0; k--) {
    starts[k] = acc;
    acc += counts[k];
  }
  const order = new Int32Array(candidates);
  for (let i = 0; i < n; i++) {
    if (mag[i] > rho) order[starts[binOf(mag[i])]++] = i;
  }

  const used = new Uint8Array(n);
  const edges: ImageEdge[] = [];
  // Number of tests in the a-contrario model (LSD: all rectangles of the
  // image at 11 width/angle precisions ≈ (W·H)^(5/2)·11). ε = 1 → on
  // average less than one false line per noise image.
  const logNumTests = 2.5 * Math.log10(w * h) + Math.log10(11);
  // Probability that a random gradient orientation is within ±τ of a given
  // one (orientations uniform on the full circle).
  const pAligned = tau / Math.PI;
  const region: number[] = [];
  const minPixels = Math.max(8, Math.floor(minLength * 0.6));

  for (let s = 0; s < order.length; s++) {
    const seed = order[s];
    if (used[seed]) continue;

    // ── Region growing ────────────────────────────────────────────────
    region.length = 0;
    region.push(seed);
    used[seed] = 1;
    let sumC = Math.cos(ang[seed]);
    let sumS = Math.sin(ang[seed]);
    let regAng = ang[seed];
    for (let k = 0; k < region.length; k++) {
      const p = region[k];
      const px = p % w;
      const py = (p - px) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = py + dy;
        if (yy < 1 || yy >= h - 1) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = px + dx;
          if (xx < 1 || xx >= w - 1) continue;
          const q = yy * w + xx;
          if (used[q] || mag[q] <= rho) continue;
          if (orientDiff(ang[q], regAng) >= tau) continue;
          used[q] = 1;
          region.push(q);
          sumC += Math.cos(ang[q]);
          sumS += Math.sin(ang[q]);
          regAng = Math.atan2(sumS, sumC);
        }
      }
    }
    if (region.length < minPixels) continue;

    // ── Weighted PCA fit ──────────────────────────────────────────────
    let wsum = 0;
    let cx = 0;
    let cy = 0;
    for (const p of region) {
      const m = mag[p];
      const x = p % w;
      wsum += m;
      cx += m * x;
      cy += m * ((p - x) / w);
    }
    cx /= wsum;
    cy /= wsum;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const p of region) {
      const m = mag[p];
      const x = p % w;
      const dx = x - cx;
      const dy = (p - x) / w - cy;
      sxx += m * dx * dx;
      syy += m * dy * dy;
      sxy += m * dx * dy;
    }
    const phi = 0.5 * Math.atan2(2 * sxy, sxx - syy); // major axis = line direction
    const ux = Math.cos(phi);
    const uy = Math.sin(phi);
    let tmin = Infinity;
    let tmax = -Infinity;
    let vmin = Infinity;
    let vmax = -Infinity;
    for (const p of region) {
      const x = p % w;
      const dx = x - cx;
      const dy = (p - x) / w - cy;
      const t = dx * ux + dy * uy;
      const v = -dx * uy + dy * ux;
      if (t < tmin) tmin = t;
      if (t > tmax) tmax = t;
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }
    const length = tmax - tmin + 1;
    const width = vmax - vmin + 1;
    if (length < minLength) continue;
    // Thin and dense: a real edge is a 2–4 px wide ridge of gradient.
    if (width > Math.max(5, length * 0.15)) continue;
    if (region.length / (length * width) < minDensity) continue;
    // Gradients must point ACROSS the fitted line (normal ⟂ direction),
    // otherwise PCA found the long axis of a blob, not an edge.
    if (Math.abs(Math.cos(regAng - phi)) > Math.sin(tau)) continue;

    // ── A-contrario validation ────────────────────────────────────────
    // Count every pixel inside the fitted rectangle (not just the region)
    // and how many of them have a gradient aligned with the edge normal.
    // Sub-threshold pixels count towards n but never as aligned.
    const normal =
      Math.cos(regAng - (phi + Math.PI / 2)) >= 0 ? phi + Math.PI / 2 : phi - Math.PI / 2;
    const corners = [
      [tmin, vmin],
      [tmin, vmax],
      [tmax, vmin],
      [tmax, vmax],
    ].map(([t, v]) => ({ x: cx + ux * t - uy * v, y: cy + uy * t + ux * v }));
    const bx0 = Math.max(1, Math.floor(Math.min(...corners.map((c) => c.x))));
    const bx1 = Math.min(w - 2, Math.ceil(Math.max(...corners.map((c) => c.x))));
    const by0 = Math.max(1, Math.floor(Math.min(...corners.map((c) => c.y))));
    const by1 = Math.min(h - 2, Math.ceil(Math.max(...corners.map((c) => c.y))));
    let total = 0;
    let aligned = 0;
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const t = dx * ux + dy * uy;
        const v = -dx * uy + dy * ux;
        if (t < tmin - 0.5 || t > tmax + 0.5 || v < vmin - 0.5 || v > vmax + 0.5) continue;
        total++;
        const q = y * w + x;
        if (mag[q] > rho && orientDiff(ang[q], normal) < tau) aligned++;
      }
    }
    if (logNumTests + log10BinomialTail(total, aligned, pAligned) > 0) continue;

    // +0.5: pixel centres → pixel-boundary coordinates (see doc comment).
    const a = { x: cx + ux * tmin + 0.5, y: cy + uy * tmin + 0.5 };
    const bb = { x: cx + ux * tmax + 0.5, y: cy + uy * tmax + 0.5 };
    edges.push(makeEdge(a, bb, wsum / region.length));
  }
  return edges;
}

export interface MergeOptions {
  /** Max direction difference to count as collinear. */
  angleTolDeg?: number;
  /** Max perpendicular offset between the two lines (px). */
  offsetTol?: number;
  /** Max gap along the line between the pieces (px). */
  gapTol: number;
}

/**
 * Greedily merge collinear pieces (longest first). The merged edge keeps the
 * longer piece's line and spans both pieces' projections onto it.
 */
export function mergeCollinearEdges(edges: ImageEdge[], opts: MergeOptions): ImageEdge[] {
  const angTol = ((opts.angleTolDeg ?? 2.5) * Math.PI) / 180;
  const offTol = opts.offsetTol ?? 2.5;
  let list = [...edges].sort((p, q) => q.length - p.length);
  let changed = true;
  while (changed) {
    changed = false;
    const out: ImageEdge[] = [];
    const removed = new Uint8Array(list.length);
    for (let i = 0; i < list.length; i++) {
      if (removed[i]) continue;
      let cur = list[i];
      for (let j = i + 1; j < list.length; j++) {
        if (removed[j]) continue;
        const o = list[j];
        if (lineAngleDiff(cur.angle, o.angle) > angTol) continue;
        const ux = Math.cos(cur.angle);
        const uy = Math.sin(cur.angle);
        const off = (p: Point) => Math.abs(-(p.x - cur.a.x) * uy + (p.y - cur.a.y) * ux);
        if (off(o.a) > offTol || off(o.b) > offTol) continue;
        const along = (p: Point) => (p.x - cur.a.x) * ux + (p.y - cur.a.y) * uy;
        const t0 = Math.min(along(o.a), along(o.b));
        const t1 = Math.max(along(o.a), along(o.b));
        const gap = Math.max(0, t0 - cur.length, -t1);
        if (gap > opts.gapTol) continue;
        const lo = Math.min(0, t0);
        const hi = Math.max(cur.length, t1);
        const strength = (cur.strength * cur.length + o.strength * o.length) / (cur.length + o.length);
        cur = makeEdge(
          { x: cur.a.x + ux * lo, y: cur.a.y + uy * lo },
          { x: cur.a.x + ux * hi, y: cur.a.y + uy * hi },
          strength,
        );
        removed[j] = 1;
        changed = true;
      }
      out.push(cur);
    }
    list = out.sort((p, q) => q.length - p.length);
  }
  return list;
}

/** Map edges from one pixel frame to another by a uniform scale. */
export function scaleEdges(edges: ImageEdge[], factor: number): ImageEdge[] {
  return edges.map((e) =>
    makeEdge(
      { x: e.a.x * factor, y: e.a.y * factor },
      { x: e.b.x * factor, y: e.b.y * factor },
      e.strength,
    ),
  );
}

/** Distance from p to the segment ab (clamped). */
export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Anything the snap layer can ask for "detected edges near this point". */
export interface ImageEdgeSource {
  near(p: Point, radius: number): ImageEdge[];
}

/**
 * Uniform-grid spatial index. Snapping runs on every pointer move and only
 * ever needs the handful of edges within a few dozen pixels of the cursor,
 * out of possibly thousands detected in the whole image.
 */
export class ImageEdgeIndex implements ImageEdgeSource {
  private readonly cells = new Map<number, number[]>();
  constructor(
    readonly edges: ImageEdge[],
    private readonly cellSize = 64,
  ) {
    edges.forEach((e, idx) => {
      const x0 = Math.floor(Math.min(e.a.x, e.b.x) / cellSize);
      const x1 = Math.floor(Math.max(e.a.x, e.b.x) / cellSize);
      const y0 = Math.floor(Math.min(e.a.y, e.b.y) / cellSize);
      const y1 = Math.floor(Math.max(e.a.y, e.b.y) / cellSize);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          // Only cells the segment actually passes near — long diagonal
          // edges would otherwise fill their whole bounding box.
          const centre = { x: (cx + 0.5) * cellSize, y: (cy + 0.5) * cellSize };
          if (pointSegmentDistance(centre, e.a, e.b) > cellSize * 0.75) continue;
          const key = cellKey(cx, cy);
          const bucket = this.cells.get(key);
          if (bucket) bucket.push(idx);
          else this.cells.set(key, [idx]);
        }
      }
    });
  }

  near(p: Point, radius: number): ImageEdge[] {
    const s = this.cellSize;
    const x0 = Math.floor((p.x - radius) / s);
    const x1 = Math.floor((p.x + radius) / s);
    const y0 = Math.floor((p.y - radius) / s);
    const y1 = Math.floor((p.y + radius) / s);
    const seen = new Set<number>();
    const out: ImageEdge[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = this.cells.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const idx of bucket) {
          if (seen.has(idx)) continue;
          seen.add(idx);
          const e = this.edges[idx];
          if (pointSegmentDistance(p, e.a, e.b) <= radius) out.push(e);
        }
      }
    }
    return out;
  }
}

function cellKey(cx: number, cy: number): number {
  // Cantor-free packing: cell coords stay well within ±2^20 for any image.
  return (cx + 0x100000) * 0x200000 + (cy + 0x100000);
}

/** 2×2 box downsample (half resolution). */
function halfResolution(gray: Float32Array, w: number, h: number): { img: Float32Array; w: number; h: number } {
  const hw = w >> 1;
  const hh = h >> 1;
  const out = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      const i = 2 * y * w + 2 * x;
      out[y * hw + x] = (gray[i] + gray[i + 1] + gray[i + w] + gray[i + w + 1]) / 4;
    }
  }
  return { img: out, w: hw, h: hh };
}

/**
 * Full pipeline used by the worker: detect at full and at half resolution,
 * merge, cap the count.
 *
 * Why two scales: averaging 2×2 pixels halves the noise, which is what makes
 * low-contrast edges (a dark roof on dark ground) detectable at all — on
 * the synthetic benchmark recall for those rose from ~30 % to ~80 %, with no
 * extra false lines. The full-resolution pass keeps sharp edges precisely
 * localised; collinear duplicates from the two passes merge into one.
 */
export function findImageEdges(
  gray: Float32Array,
  w: number,
  h: number,
  minLengthPx: number,
): ImageEdge[] {
  const pieceLength = Math.max(6, minLengthPx * 0.5);
  const full = detectLineSegments(gray, w, h, { minLength: pieceLength });
  const half = halfResolution(gray, w, h);
  // Half-res pixel i covers full-res [2i, 2i+2): scaling the boundary-based
  // coordinates by 2 maps them back exactly.
  const coarse = scaleEdges(
    detectLineSegments(half.img, half.w, half.h, { minLength: pieceLength / 2, gradientThreshold: 3 }),
    2,
  );
  const merged = mergeCollinearEdges([...full, ...coarse], { gapTol: Math.max(3, minLengthPx * 0.8) });
  // Pieces only become useful once merged; drop the short leftovers, and
  // keep at most the 4000 most significant edges (memory + index size).
  return merged
    .filter((e) => e.length >= minLengthPx)
    .sort((p, q) => q.length * q.strength - p.length * p.strength)
    .slice(0, 4000);
}
