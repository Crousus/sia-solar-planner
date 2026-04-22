// ────────────────────────────────────────────────────────────────────────────
// App entry point.
//
// We now render an <AppShell/> with a BrowserRouter rather than a bare
// <App/>. App.tsx is still the editor body but is rendered via the
// router at /p/:projectId (see AppShell + ProjectEditor) — wiring lands
// in Tasks 8 & 9.
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
import AppShell from './components/AppShell';
import 'leaflet/dist/leaflet.css';
import './index.css';
// Side-effect import: configures the i18next instance before the React
// tree mounts, so useTranslation() is ready on first render.
import './i18n';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppShell />
  </React.StrictMode>
);
