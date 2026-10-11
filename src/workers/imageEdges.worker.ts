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

// Runs straight-edge detection off the main thread (ADR-019). ~100 ms per
// 1.6 MP image is fine for a one-off after map lock, but on the main thread
// it would stall the first pointer moves right when the user starts
// drawing. The protocol is deliberately flat (typed arrays, transferred)
// so no structured-clone of thousands of small objects happens.

import { findImageEdges } from '../utils/imageEdges';

export interface ImageEdgesRequest {
  id: number;
  gray: Float32Array;
  width: number;
  height: number;
  minLengthPx: number;
}

export interface ImageEdgesResponse {
  id: number;
  /** [ax, ay, bx, by, strength] per edge, in the request's pixel frame. */
  edges: Float32Array;
}

self.onmessage = (ev: MessageEvent<ImageEdgesRequest>) => {
  const { id, gray, width, height, minLengthPx } = ev.data;
  const found = findImageEdges(gray, width, height, minLengthPx);
  const flat = new Float32Array(found.length * 5);
  found.forEach((e, i) => {
    flat.set([e.a.x, e.a.y, e.b.x, e.b.y, e.strength], i * 5);
  });
  const res: ImageEdgesResponse = { id, edges: flat };
  (self as unknown as Worker).postMessage(res, [flat.buffer]);
};
