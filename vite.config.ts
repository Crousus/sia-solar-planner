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

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // During `npm run dev`, forward any /api/* request to the PocketBase
    // instance running on :8090. This lets client code use same-origin
    // paths like /api/sp/patch in both dev and prod — in prod, we'll put
    // PocketBase behind a reverse proxy at the same origin as the SPA.
    //
    // changeOrigin:true rewrites the Host header so PocketBase sees its
    // own hostname, not vite's. ws:true forwards the SSE realtime stream
    // (PocketBase implements realtime over SSE, not websockets, but the
    // upgrade flag covers both just in case a future version switches).
    proxy: {
      '/api': {
        // API_TARGET lets the Docker Compose dev setup point to the backend
        // container by name rather than 127.0.0.1 (which doesn't reach across
        // Docker network boundaries).  Falls back to the local default for
        // the native two-terminal dev workflow.
        target: process.env.API_TARGET ?? 'http://127.0.0.1:8090',
        changeOrigin: true,
        ws: true,
      },
      // PDF export goes directly to the pdf-service, bypassing PocketBase
      // entirely. PocketBase has a 32 MB body limit that the image payload
      // can exceed; the pdf-service has its own auth validation and a 60 MB
      // limit. PDF_TARGET follows the same pattern as API_TARGET for Docker.
      '/pdf': {
        target: process.env.PDF_TARGET ?? 'http://127.0.0.1:3002',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pdf/, ''),
      },
    },
  },
});
