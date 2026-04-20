// ────────────────────────────────────────────────────────────────────────────
// Shared types for the entire app.
//
// Everything in this file is pure data — no functions, no React. Import from
// here anywhere in `src/`. Keeping the data model in one small file makes it
// easy to see the full shape of the app at a glance (see AGENTS.md).
// ────────────────────────────────────────────────────────────────────────────

/**
 * A 2D point in **canvas pixel coordinates** (x right, y down).
 *
 * IMPORTANT: "canvas pixels" here means pixels in the Leaflet map container
 * at the moment the map was locked. All roof vertices, panel centers, etc.
 * are stored in this frame. Convert to meters by multiplying by
 * `mapState.metersPerPixel` (mpp).
 */
export type Point = { x: number; y: number };

/** Axis-aligned rectangle in canvas pixel coordinates. */
export type Rect = { x: number; y: number; w: number; h: number };

/**
 * A PV module spec. Real-world dimensions (in meters) — NOT canvas pixels.
 * The on-screen size is derived at render time from `mpp` and `tiltDeg`
 * (see `panelDisplaySize` in utils/geometry.ts).
 */
export interface PanelType {
  id: string;
  name: string;
  widthM: number;   // real-world short side, meters
  heightM: number;  // real-world long side, meters
  wattPeak: number; // nameplate watts, used for kWp totals in sidebar + PDF
}

/**
 * A roof surface. Drawn by the user as a polygon on the locked map.
 *
 * The polygon vertices are in canvas pixel coordinates. Tilt and orientation
 * control panel grid geometry (see `panelDisplaySize`).
 */
export interface Roof {
  id: string;
  name: string;                             // user-editable; defaults to "Roof N"
  polygon: Point[];                         // vertex list; closed implicitly
  tiltDeg: number;                          // 0 = flat, up to 60; drives cos(θ) projection
  panelOrientation: 'landscape' | 'portrait';
}

/**
 * A single placed panel.
 *
 * `cx`, `cy` are the panel's center in canvas pixels. Its rendered size is
 * computed on the fly from the owning roof's tilt + the project's panelType.
 *
 * `stringId` is null until assigned via lasso. `indexInString` is rewritten
 * by `renumberStrings()` whenever membership changes — NEVER set it manually
 * outside that helper (off-by-one errors would follow silently).
 */
export interface Panel {
  id: string;
  roofId: string;                   // which Roof this panel lives on
  cx: number;                       // center x, canvas pixels
  cy: number;                       // center y, canvas pixels
  stringId: string | null;          // null = unassigned
  indexInString: number | null;     // 1-based; reflects wiring order
}

/**
 * A PV string: an ordered set of panels wired in series, optionally routed
 * to an inverter. Panel membership lives on the Panel via `stringId`; the
 * order comes from `renumberStrings()` sorting by (bottom→top, left→right).
 */
export interface PvString {
  id: string;
  label: string;                    // "String 1", "String 2", …
  inverterId: string | null;        // which inverter this string feeds (nullable)
  color: string;                    // hex from STRING_COLORS palette
}

/** An inverter (a.k.a. "transformer" in the user's original brief). */
export interface Inverter {
  id: string;
  name: string;                     // "Inverter A" etc.; user-editable
}

/**
 * Map viewport snapshot. The app has two map states:
 *  - `locked: false` → user is panning/zooming to find their building.
 *    No drawing is possible. The Konva overlay has pointer-events: none.
 *  - `locked: true`  → viewport is frozen. `metersPerPixel` was computed
 *    from (zoom, lat) via Web Mercator and is the ONE calibration number
 *    used by the rest of the app. Unlocking invalidates drawings for
 *    practical purposes (we don't re-project them on unlock).
 */
export interface MapState {
  locked: boolean;
  centerLat: number;
  centerLng: number;
  zoom: number;
  metersPerPixel: number;
}

/**
 * Full project — the root persistent object. Serialized to localStorage by
 * Zustand's `persist` middleware and used verbatim for JSON export/import.
 *
 * If you add a field here you're adding to the save format. Consider whether
 * older saves should still load (Zustand's `persist` has a `version` option
 * if you need to migrate; not currently used).
 */
export interface Project {
  name: string;
  panelType: PanelType;
  roofs: Roof[];
  panels: Panel[];
  strings: PvString[];
  inverters: Inverter[];
  mapState: MapState;
}

/**
 * Active interaction mode. A tagged string union — cheap and exhaustive
 * switch-able. All mode-gated behavior (ghost panel, lasso, etc.) keys off
 * this value.
 */
export type ToolMode =
  | 'idle'            // no tool active; clicks just select roofs
  | 'draw-roof'       // clicks add polygon vertices
  | 'place-panels'    // ghost follows cursor; click places
  | 'assign-string'   // mouse-drag draws a lasso rect
  | 'delete';         // click panel/roof to remove

/**
 * Color palette used when auto-assigning colors to new strings.
 *
 * Chosen for distinctness + decent contrast against aerial imagery.
 * When the Nth string is added, it takes color `STRING_COLORS[N % len]` —
 * so with more strings than colors we wrap and lose uniqueness, which is
 * acceptable for a personal tool (12 distinct colors is plenty in practice).
 */
export const STRING_COLORS = [
  '#E63946', '#457B9D', '#2A9D8F', '#E9C46A', '#F4A261',
  '#A8DADC', '#9B2226', '#6A4C93', '#81B29A', '#F2CC8F',
  '#264653', '#E76F51',
];
