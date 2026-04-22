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
    },
  },
});
