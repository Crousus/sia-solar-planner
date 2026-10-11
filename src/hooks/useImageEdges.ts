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
// useImageEdges — detected straight edges of the locked satellite image,
// in world (canvas) coordinates, behind a spatial index (ADR-019).
//
// Lifecycle: runs once per captured image while the feature is enabled;
// the result is cached for that image, so toggling the feature off and on
// again is instant. Detection happens in a Web Worker; a stale result for a
// previous image (re-lock while detecting) is discarded by request id.
//
// Coordinate frames:
//   natural image px — html2canvas captured at devicePixelRatio, so
//                      naturalWidth = worldWidth × DPR
//   processed px     — the image downscaled to ≤ MAX_SIDE for speed
//   world px         — canvas coords (MapStateLocked.capturedWidth frame)
// world = processed × (worldWidth / processedWidth).
// ────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { findImageEdges, ImageEdgeIndex, rgbaToGray, type ImageEdge } from '../utils/imageEdges';
import type { ImageEdgesRequest, ImageEdgesResponse } from '../workers/imageEdges.worker';

/** Longest side of the image fed to the detector. ~1600 px keeps detection
 *  around 100 ms while still resolving ~0.2–0.3 m per px at typical zooms. */
const MAX_SIDE = 1600;
/** Shortest roof edge worth snapping to. Shorter detected lines are mostly
 *  dormers' trim, cars and paving joints. */
const MIN_EDGE_LENGTH_M = 1.5;

export type ImageEdgeStatus = 'idle' | 'computing' | 'ready' | 'error';

export interface UseImageEdgesResult {
  index: ImageEdgeIndex | null;
  status: ImageEdgeStatus;
}

let nextRequestId = 1;

function createWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('../workers/imageEdges.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

/** Downscale + grayscale the decoded image on a scratch canvas. */
function rasterize(image: HTMLImageElement): { gray: Float32Array; width: number; height: number } | null {
  const nw = image.naturalWidth;
  const nh = image.naturalHeight;
  if (!nw || !nh) return null;
  const k = Math.min(1, MAX_SIDE / Math.max(nw, nh));
  const width = Math.max(1, Math.round(nw * k));
  const height = Math.max(1, Math.round(nh * k));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  // The captured image is a data: URL → same-origin, getImageData is allowed.
  ctx.drawImage(image, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  return { gray: rgbaToGray(data, width * height), width, height };
}

function unflatten(flat: Float32Array, factor: number): ImageEdge[] {
  const out: ImageEdge[] = [];
  for (let i = 0; i + 4 < flat.length; i += 5) {
    const a = { x: flat[i] * factor, y: flat[i + 1] * factor };
    const b = { x: flat[i + 2] * factor, y: flat[i + 3] * factor };
    out.push({
      a,
      b,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      length: Math.hypot(b.x - a.x, b.y - a.y),
      strength: flat[i + 4],
    });
  }
  return out;
}

export function useImageEdges(
  image: HTMLImageElement | null,
  worldWidth: number | undefined,
  metersPerPixel: number,
  enabled: boolean,
): UseImageEdgesResult {
  const [result, setResult] = useState<UseImageEdgesResult>({ index: null, status: 'idle' });
  // Cache by image identity: the decoded <img> changes exactly when the
  // captured image does (KonvaOverlay re-decodes per capturedImage).
  const cacheRef = useRef<{ image: HTMLImageElement; index: ImageEdgeIndex } | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !image || !worldWidth || worldWidth <= 0) {
      setResult({ index: null, status: 'idle' });
      return;
    }
    if (cacheRef.current?.image === image) {
      setResult({ index: cacheRef.current.index, status: 'ready' });
      return;
    }

    let cancelled = false;
    const raster = rasterize(image);
    if (!raster) {
      setResult({ index: null, status: 'error' });
      return;
    }
    const toWorld = worldWidth / raster.width;
    const mpp = metersPerPixel > 0 ? metersPerPixel : 0.15;
    const minLengthPx = Math.max(12, MIN_EDGE_LENGTH_M / mpp / toWorld);

    const finish = (edges: ImageEdge[]) => {
      if (cancelled) return;
      const index = new ImageEdgeIndex(edges);
      cacheRef.current = { image, index };
      setResult({ index, status: 'ready' });
    };
    // Main-thread fallback (no Worker support, or the worker failed). Runs
    // after a tick so the lock's own render isn't delayed.
    const runInline = () => {
      setTimeout(() => {
        if (cancelled) return;
        try {
          const edges = findImageEdges(raster.gray, raster.width, raster.height, minLengthPx);
          finish(edges.map((e) => ({
            ...e,
            a: { x: e.a.x * toWorld, y: e.a.y * toWorld },
            b: { x: e.b.x * toWorld, y: e.b.y * toWorld },
            length: e.length * toWorld,
          })));
        } catch {
          if (!cancelled) setResult({ index: null, status: 'error' });
        }
      }, 0);
    };

    setResult({ index: null, status: 'computing' });
    if (!workerRef.current) workerRef.current = createWorker();
    const worker = workerRef.current;
    if (!worker) {
      runInline();
      return () => {
        cancelled = true;
      };
    }

    const id = nextRequestId++;
    const onMessage = (ev: MessageEvent<ImageEdgesResponse>) => {
      if (ev.data.id !== id) return; // stale result for a previous image
      finish(unflatten(ev.data.edges, toWorld));
    };
    const onError = () => {
      // e.g. the worker chunk failed to load — degrade to inline once.
      worker.terminate();
      workerRef.current = null;
      runInline();
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    const req: ImageEdgesRequest = {
      id,
      gray: raster.gray,
      width: raster.width,
      height: raster.height,
      minLengthPx,
    };
    // Copy for the inline fallback is unnecessary once transferred, so keep
    // the raster for runInline by transferring a clone instead.
    const transfer = new Float32Array(raster.gray);
    worker.postMessage({ ...req, gray: transfer }, [transfer.buffer]);
    return () => {
      cancelled = true;
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
  }, [enabled, image, worldWidth, metersPerPixel]);

  return result;
}
