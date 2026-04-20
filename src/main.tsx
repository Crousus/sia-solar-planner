// ────────────────────────────────────────────────────────────────────────────
// App entry point.
//
// StrictMode is on — helps surface double-effect bugs early. It does NOT
// break Konva or Leaflet in our usage (components are idempotent on mount).
//
// The Leaflet CSS import is CRITICAL: without it, tile container layout
// collapses to zero height and the map appears empty. Keep this import
// alongside `index.css` so the order is obvious.
// ────────────────────────────────────────────────────────────────────────────

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import 'leaflet/dist/leaflet.css';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
