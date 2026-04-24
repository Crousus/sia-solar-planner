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
// pdf-service — server-side PDF renderer for Solar Planner.
//
// The client captures the Konva stage (roof plan) and diagram as raster
// images, resolves branding and i18n strings, then POSTs the assembled
// payload to the Go backend which auth-gates and proxies here. We run
// @react-pdf/renderer in a Node.js process so the output is deterministic
// regardless of the client device — no browser rendering quirks, no iOS
// WebKit/foreignObject bugs, no per-OS font hinting differences.
//
// Why this service instead of running react-pdf in the browser:
//   react-pdf works in both environments, but in the browser it competes
//   with the rest of the UI for RAM (the current in-browser path peaks at
//   3-4 GB on large captures). A dedicated Node.js process keeps the main
//   tab lean and the output consistent across all clients including mobile.
//
// Import path note:
//   This file lives at pdf-service/server.ts. It imports shared source via
//   "../src/…" which resolves correctly whether the service is run from
//   the repo root in dev or from /app in Docker (same relative structure
//   in both cases — see Dockerfile).
// ────────────────────────────────────────────────────────────────────────────

import express from 'express';
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { SolarPlanDoc } from '../src/pdf/SolarPlanDoc';

const app = express();

// PocketBase URL for token validation. Defaults to localhost for the native
// two-terminal dev workflow; docker-compose sets it to http://backend:8090.
const POCKETBASE_URL = (process.env.POCKETBASE_URL ?? 'http://localhost:8090').replace(/\/$/, '');

// Validate a PocketBase auth token by hitting the auth-refresh endpoint.
// This is a lightweight ~10 ms hop that confirms the token is still valid
// without us having to implement JWT verification ourselves.
async function validateToken(authHeader: string | undefined): Promise<boolean> {
  if (!authHeader?.startsWith('Bearer ')) return false;
  try {
    const res = await fetch(`${POCKETBASE_URL}/api/collections/users/auth-refresh`, {
      method: 'POST',
      headers: { Authorization: authHeader },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Image data URLs can reach 10-30 MB JPEG as base64; set a generous limit
// so we don't reject legitimate large captures on big monitors.
app.use(express.json({ limit: '60mb' }));

app.post('/render', async (req, res) => {
  if (!await validateToken(req.headers.authorization)) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }

  try {
    const {
      planFrameCapture,
      planImageDataUrl,
      planImageRectPt,
      diagramCapture,
    } = req.body;

    if (!planFrameCapture && !diagramCapture) {
      res.status(400).json({ error: 'at least one of planFrameCapture or diagramCapture is required' });
      return;
    }

    const element = React.createElement(SolarPlanDoc, {
      planFrameCapture,
      planImageDataUrl,
      planImageRectPt,
      diagramCapture,
    });

    // renderToBuffer is the Node.js-specific API — pdf().toBuffer() is the
    // browser path and returns the internal PDFDocument object in Node.js
    // rather than a Buffer, which causes express to try to JSON-serialize it.
    const buffer = await renderToBuffer(element);

    res.setHeader('Content-Type', 'application/pdf');
    res.send(buffer);
  } catch (err) {
    console.error('[pdf-service] render failed:', err);
    res.status(500).json({ error: String(err) });
  }
});

// Health check for docker-compose depends_on condition in the future.
app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = parseInt(process.env.PORT ?? '3002', 10);
app.listen(PORT, () => {
  console.log(`pdf-service listening on :${PORT}`);
});
