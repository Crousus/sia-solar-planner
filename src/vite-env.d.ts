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

/// <reference types="vite/client" />

// Ambient reference that pulls in Vite's client types (including the
// `ImportMetaEnv` interface with `DEV`, `PROD`, `MODE`, etc.). Without this,
// `import.meta.env.DEV` fails type-checking with TS2339 because the default
// `ImportMeta` lib shim has no `env` property.
//
// Kept deliberately minimal — project-specific env var declarations
// (e.g. `interface ImportMetaEnv { readonly VITE_FOO: string }`) can be
// added here as the app grows. For now, only the standard Vite booleans
// (DEV/PROD/SSR/MODE/BASE_URL) are needed, and the vite/client reference
// alone is enough to type them.
