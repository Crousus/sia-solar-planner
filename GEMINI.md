# Solar Planner

## Project Overview
Solar Planner is a frontend web application for designing and planning rooftop solar panel installations. It provides an interactive interface where users can navigate a map to their location, "lock" the map to establish a fixed coordinate space, and then use drawing tools to trace roof outlines, place solar panels, and group panels into electrical strings connected to inverters.

### Main Technologies
- **Framework & Build:** React 18, TypeScript, and Vite.
- **State Management:** Zustand (with `localStorage` persistence for project data).
- **Mapping:** Leaflet (`leaflet`, `react-leaflet`) for the base map imagery.
- **Interactive Drawing:** Konva (`konva`, `react-konva`) provides a high-performance 2D canvas overlay for drawing roofs, placing panels, and handling lasso selections.
- **Styling:** Tailwind CSS.
- **Export:** `jspdf` and `html2canvas` for generating PDF reports of the planned layout.

### Architecture Highlights
- **Layered View:** The main workspace stacks a Konva `<Stage>` precisely on top of a Leaflet map. Interactions on the Konva layer are toggled based on the active tool mode, allowing seamless switching between panning the map and drawing on the canvas.
- **Centralized State:** `src/store/projectStore.ts` serves as the single source of truth. It divides state into persistent project data (roofs, panels, strings) and ephemeral UI state (current tool mode, active selection), ensuring clean JSON exports and reliable reloads.
- **Spatial Geometry:** Drawing interactions feature robust snapping and guide systems for precision, transitioning from geographical (lat/lng) to local pixel coordinates once the map is locked.

## Building and Running

The project uses `npm` for package management.

- **Install dependencies:** `npm install`
- **Start development server:** `npm run dev`
- **Build for production:** `npm run build`
- **Preview production build:** `npm run preview`

## Development Conventions

- **State Mutations:** All state changes must go through Zustand actions defined in `projectStore.ts`. Components should not mutate state directly.
- **Tool Modes & Shortcuts:** The application relies on specific "modes" (idle, draw-roof, place-panels, assign-string, delete). Single-letter keyboard shortcuts (e.g., `r`, `p`, `s`, `d`) are used to quickly switch modes. `Escape` universally cancels current operations.
- **Persistence:** Ensure that non-essential UI state (like half-drawn polygons or current tool mode) is excluded from `localStorage` persistence via Zustand's `partialize` to avoid corrupting the saved project.
- **Geometry & Rendering:** Handle complex rendering (many panels) via Konva rather than Leaflet SVG layers for performance. Complex geometric calculations (snapping, point-in-polygon) are decoupled into utility functions (`src/utils/`).
- **Comments** Always comment code inline so Agents will know the thought process of each and every piece of the code.
- **Agent.md** Also the AGENT.md file contains important information