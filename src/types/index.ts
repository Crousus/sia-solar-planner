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
  // ── Optional extended fields (present when sourced from the catalog) ──
  //
  // These are populated ONLY when the project's `panelType` was hydrated
  // from a `panel_models` catalog record via the expand=panel_model path
  // in ProjectEditor. Legacy projects (manually-entered panelType, no
  // catalog FK) will have all of these undefined.
  //
  // Kept on PanelType (rather than carried as a separate record in the
  // store) so every read path — sidebar display, PDF export, anything
  // that already destructures panelType — picks them up for free. If we
  // split them into a side-channel record, every consumer would have to
  // opt in to showing the richer info.
  efficiencyPct?: number;
  weightKg?: number;
  voc?: number;
  isc?: number;
  vmpp?: number;
  impp?: number;
  tempCoefficientPmax?: number;
  warrantyYears?: number;
  datasheetUrl?: string;
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
  groupId: string;                  // which panel group this panel belongs to (used for grid snapping)
  cx: number;                       // center x, canvas pixels
  cy: number;                       // center y, canvas pixels
  stringId: string | null;          // null = unassigned
  indexInString: number | null;     // 1-based; reflects wiring order
  /**
   * Per-panel orientation. All panels in the same group share the same
   * value — orientation is logically a group-level attribute, but we
   * store it on the panel so the data model stays flat (no PanelGroup
   * entity to keep in sync). See panelDisplaySize() and
   * updateGroupOrientation().
   *
   * Always present on live panels: `addPanel` writes it at creation,
   * and the `migrateProject` helper (utils/projectSerializer.ts) back-
   * fills it from `roof.panelOrientation` on both Zustand rehydration
   * and JSON import of pre-migration saves. Before the migration existed,
   * this field was optional and five consumer sites carried
   * `p.orientation ?? roof.panelOrientation` fallback; making the field
   * required centralizes the fallback at the persistence boundary.
   */
  orientation: 'portrait' | 'landscape';
}

/**
 * A PV string: an ordered set of panels wired in series, optionally routed
 * to an inverter. Panel membership lives on the Panel via `stringId`; the
 * order is the sequence the user added the panels (via paint/lasso),
 * preserved across geometric moves and compacted on delete. See
 * `renumberStrings()` in projectStore for the full policy.
 */
export interface PvString {
  id: string;
  label: string;                    // "String 1", "String 2", …
  inverterId: string | null;        // which inverter this string feeds (nullable)
  /**
   * Which MPPT input port on the inverter this string connects to.
   * Addressed alphabetically: "A" = first tracker, "B" = second, etc.
   * Null / undefined = not specified (user hasn't picked a port yet).
   * Only meaningful when `inverterId` is set AND the linked inverter model
   * has `mpptCount > 0`; we keep it on the string rather than computing
   * it so the selection survives inverter model swaps mid-session.
   * Reset to null whenever the string is moved to a different inverter
   * (because port "B" on inverter X is unrelated to port "B" on inverter Y).
   */
  mpptPort?: string | null;
  color: string;                    // hex from STRING_COLORS palette
}

/** An inverter (a.k.a. "transformer" in the user's original brief). */
export interface Inverter {
  id: string;
  name: string;                     // "Inverter A" etc.; user-editable
  /**
   * Optional FK into the `inverter_models` catalog.
   *
   * App-enforced only — there is NO server-side relation field for this
   * (inverters live inside the opaque `doc` JSON, not on a dedicated
   * table row). If the referenced model is deleted from the catalog,
   * this id becomes a dangling reference; UI code that resolves it
   * (Sidebar, via `inverterModelCache` in the store) MUST tolerate a
   * cache miss by falling back to the user-editable `name` alone.
   *
   * Null / undefined means "not linked" — a legacy, name-only inverter.
   */
  inverterModelId?: string | null;
}

/**
 * Map viewport snapshot.
 *
 * Modelled as a discriminated union on `locked`. The three captured-image
 * fields only exist in the locked variant — previously they were optional
 * on a single flat struct, which let consumers ask for `capturedImage`
 * while `locked === false` (always returning undefined). Splitting into
 * variants forces call sites to narrow via `mapState.locked` before
 * reading the captured fields, making the invariant "if locked then
 * captured image is present" a compile-time guarantee rather than a
 * convention enforced only by `lockMap`/`unlockMap`.
 *
 * Shared fields (centerLat/Lng/zoom/metersPerPixel/mapProvider) exist in
 * both variants and survive a lock/unlock round-trip; we reuse them as
 * the defaults on re-lock so the user's last map position sticks.
 *
 *  - `locked: false` → user is panning/zooming to find their building via
 *    Leaflet. No drawing is possible; the Konva overlay is a passthrough.
 *  - `locked: true`  → Leaflet is torn down from the view. At lock time we
 *    rasterize the current tiles (html2canvas → PNG dataURL) and stash
 *    them in `capturedImage`. Konva then shows that image as a static
 *    background, owning pan/zoom natively without any Leaflet round-trip
 *    (which historically desynchronized scale during zoom animations —
 *    see ADR-001, superseded by ADR-007).
 *
 * `metersPerPixel` is computed from (zoom, lat) via Web Mercator at lock
 * time; it's the ONE calibration number used by the rest of the app.
 * Unlocking invalidates drawings for practical purposes (we don't
 * re-project them on unlock).
 *
 * `capturedWidth`/`capturedHeight` are the pixel dimensions of the
 * Leaflet container at lock time — which is also the coordinate frame
 * all roofs/panels are stored in. Used by the background layer to know
 * the image's native size (after Konva zoom the image is scaled, but
 * world pixels stay anchored to these dims).
 */
interface MapStateShared {
  centerLat: number;
  centerLng: number;
  zoom: number;
  metersPerPixel: number;
  /** The currently selected map tile provider. */
  mapProvider?: 'esri' | 'bayern';
}
export interface MapStateUnlocked extends MapStateShared {
  locked: false;
}
export interface MapStateLocked extends MapStateShared {
  locked: true;
  /** base64 PNG dataURL of the satellite view captured at lock time. */
  capturedImage: string;
  /** Width of the captured image in canvas pixels (world-frame width). */
  capturedWidth: number;
  /** Height of the captured image in canvas pixels (world-frame height). */
  capturedHeight: number;
  /**
   * Initial Konva-stage rotation (degrees, clockwise) applied when the
   * captured image is first painted post-lock. Written by `lockMap` when
   * the user rotated the Leaflet preview before locking (see App's
   * `preLockRotation` + MapView's CSS-transform rotation). Absent = 0.
   *
   * Persisted so reopening a saved project restores the user's chosen
   * orientation. Live stage rotation (middle-mouse drag, RotationDock)
   * is intentionally NOT written back here — that stays session-local;
   * only the at-lock-time value is considered "the project's frame".
   */
  initialRotationDeg?: number;
}
export type MapState = MapStateUnlocked | MapStateLocked;

/**
 * Geocoded address. A project's address is either fully structured (user
 * picked an autocomplete suggestion) or absent. We don't store partial /
 * free-form strings: downstream consumers (map auto-center, future map-
 * preview) depend on `lat`/`lon` being present. Half-states would force
 * every caller to null-check coords again, which the type already solved.
 *
 * `formatted` is the human-readable label Photon returned as the display
 * value (e.g. "Marienplatz 8, 80331 Munich, Germany"). We render this
 * directly rather than re-composing from the structured parts, because
 * Photon's label ordering is locale-aware and we'd lose that if we
 * rebuilt the string ourselves.
 */
export interface ProjectAddress {
  formatted: string;
  /**
   * Best-effort structured components from Photon. Any may be absent
   * on initial pick (Photon doesn't always produce every field) and
   * any may be user-edited after the pick via the form's structured
   * inputs — so "matches the geocode" is NOT an invariant we can
   * depend on. What IS invariant is `lat`/`lon` below: those stay
   * anchored to the original geocode regardless of text edits.
   */
  street?: string;
  housenumber?: string;
  city?: string;
  postcode?: string;
  country?: string;
  /** WGS84 coordinates — the ONLY fields consumers can rely on. */
  lat: number;
  lon: number;
}

/**
 * Project-level metadata captured at bootstrap time (and editable via
 * the settings page). Kept in a sub-object rather than sprinkled at the
 * top level of `Project` so:
 *   - The editor blob (roofs/panels/strings/etc.) stays conceptually
 *     separate from admin/meta info — useful for JSON export/import,
 *     where a future exporter might strip `meta` for sharing.
 *   - Adding more metadata later (contact email, install date, …) has
 *     an obvious home with no further type surgery.
 *
 * All fields are optional so existing projects (created before this
 * feature landed) load without migration — `meta` is simply absent on
 * their doc.
 */
export interface ProjectMeta {
  client?: string;
  address?: ProjectAddress;
  notes?: string;
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
  /**
   * Optional metadata sub-object. Absent on docs created before the
   * bootstrap flow existed — consumers MUST treat `meta` as possibly
   * undefined rather than assume an empty object.
   */
  meta?: ProjectMeta;
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
