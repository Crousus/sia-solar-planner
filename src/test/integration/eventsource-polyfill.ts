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
// eventsource-polyfill — installs the `eventsource` npm package as the
// global `EventSource` in the Vitest jsdom environment.
//
// Why this is needed:
//   PocketBase's JS SDK uses `EventSource` for its realtime SSE subscription
//   (pb.collection('...').subscribe()). jsdom (the default Vitest test
//   environment) does NOT ship an EventSource implementation — jsdom's
//   scope deliberately limits itself to features with solid spec coverage
//   and a testable surface area. Node 22 has EventSource behind the
//   --experimental-eventsource flag, which is unavailable in a standard
//   Vitest run.
//
//   Both the existing `src/backend/sync.integration.test.ts` and the new
//   store-level `src/store/sync.integration.test.ts` subscribe to PocketBase
//   realtime in the jsdom environment. Without a polyfill, subscribe() throws
//   "EventSource is not defined" before the first SSE event arrives.
//
// Why `eventsource` v4:
//   The package is a well-maintained WhatWG/W3C-compliant EventSource
//   implementation for Node.js and browsers. v4 exports a named `EventSource`
//   symbol (not a default export), matching the shape expected by the PB SDK.
//
// This file is listed as a `setupFiles` entry in `vitest.integration.config.ts`
// so it runs once per worker before any test file is loaded, guaranteeing the
// global is in place before `pocketbase` is first imported.
// ────────────────────────────────────────────────────────────────────────────

import { EventSource } from 'eventsource';

// Assign to globalThis so both `EventSource` (bare) and `window.EventSource`
// (jsdom's global window proxy) resolve to the polyfill.
// The cast to `typeof globalThis.EventSource` is required because the
// polyfill's type isn't an exact structural match for the browser's built-in
// EventSource type (they differ on a few non-essential generics). In practice
// the PB SDK only calls `new EventSource(url, opts)` and `close()` — both of
// which are present on the polyfill.
globalThis.EventSource = EventSource as unknown as typeof globalThis.EventSource;
