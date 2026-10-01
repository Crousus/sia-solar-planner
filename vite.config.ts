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

// Vendor chunk groups (Rolldown `codeSplitting`, Vite 8's replacement for
// Rollup's manualChunks). Why split at all: without it the eager `index`
// chunk (~600 kB) and the lazy `ProjectEditor` chunk (~780 kB) each carried
// every library they touch, so any one-line app change invalidated the
// browser cache for all of it, and both tripped Vite's 500 kB warning.
//
// Each group is deliberately NARROW (one library family). A group chunk is
// loaded by whichever chunk first imports any module in it, so mixing an
// eager lib (react) with an editor-only lib (konva) in one group would drag
// the editor lib into the first page load. Editor-only families (leaflet,
// konva, xyflow, html2canvas) therefore stay behind the ProjectEditor
// lazy() boundary; react / router / i18n / pocketbase load up front.
//
// Two traps that made editor-only groups load on the FIRST page before
// the rules below existed:
//   - CSS: main.tsx imports leaflet.css eagerly. Had that CSS module been
//     captured by the leaflet group, the entry would import the whole
//     vendor-leaflet chunk (JS included) just to get its stylesheet. CSS
//     is therefore never grouped — it stays with whoever imports it.
//   - Shared deps: a group also captures its members' dependencies.
//     @xyflow/react depends on zustand, so without an earlier group
//     claiming zustand, our (eager) store would import it from
//     vendor-xyflow and pull React Flow into every page. Groups are
//     matched in declaration order, so the shared `vendor-react` group
//     (react + router + zustand) comes first.
//
// `[\\/]` instead of `/` keeps the patterns working on Windows paths.
const VENDOR_GROUPS: Array<{ name: string; re: RegExp }> = [
  { name: 'vendor-react', re: /node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|cookie|set-cookie-parser|zustand|use-sync-external-store)[\\/]/ },
  { name: 'vendor-i18n', re: /node_modules[\\/](i18next|react-i18next|i18next-browser-languagedetector|html-parse-stringify|void-elements)[\\/]/ },
  { name: 'vendor-pocketbase', re: /node_modules[\\/]pocketbase[\\/]/ },
  { name: 'vendor-leaflet', re: /node_modules[\\/](leaflet|react-leaflet|@react-leaflet)[\\/]/ },
  { name: 'vendor-konva', re: /node_modules[\\/](konva|react-konva|react-reconciler|its-fine)[\\/]/ },
  { name: 'vendor-xyflow', re: /node_modules[\\/](@xyflow|d3-[a-z-]+|classcat)[\\/]/ },
  { name: 'vendor-html2canvas', re: /node_modules[\\/](html2canvas|css-line-break|text-segmentation|utrie|base64-arraybuffer)[\\/]/ },
];

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: VENDOR_GROUPS.map(({ name, re }) => ({
            name,
            test: (id: string) => !/\.css($|\?)/.test(id) && re.test(id),
          })),
        },
      },
    },
  },
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
