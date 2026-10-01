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

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: false,
    // Exclude integration tests from the default unit-test run.
    // Integration tests require RUN_INTEGRATION=1 and a compiled PocketBase
    // binary — they live in vitest.integration.config.ts instead.
    exclude: ['**/*.integration.test.ts', 'node_modules/**'],
    // Only the frontend's own tests live under src/. pdf-service/, ocr-service/
    // and server/ have their own toolchains (tsx script / pytest / go test) and
    // their own node_modules — without this include, vitest's default glob
    // walks into pdf-service/node_modules and tries to run third-party test
    // files (and pdf-service's tsx-style validate.test.ts) that can't load here.
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
