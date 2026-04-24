// ────────────────────────────────────────────────────────────────────────
// BrandMark — the app's wordmark glyph.
//
// Reads as a stylized sun inside a command-palette square:
//   - rounded square container echoes Raycast's app-icon grid
//   - radial blue gradient inside is the "solar" domain cue
//   - a tiny crosshair bisects the disc — a PV-cell nod plus a "precision
//     instrument" signal
//
// Rendered inline so it inherits the current color flow for mask uses
// (PDF header, favicons) if that ever comes up later. `size` is the
// outer bounding box; everything else is proportional.
// ────────────────────────────────────────────────────────────────────────

interface Props {
  size?: number;
}

export function BrandMark({ size = 22 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="shrink-0"
    >
      {/* Rounded-square container — Raycast-icon shape. Soft inner shadow
          via stacked rects gives the mark a tactile, app-like presence. */}
      <rect
        x="1"
        y="1"
        width="22"
        height="22"
        rx="6"
        fill="url(#bm-bg)"
        stroke="url(#bm-stroke)"
        strokeWidth="0.75"
      />
      {/* Inner disc — a blue bloom that reads as the primary accent. */}
      <circle cx="12" cy="12" r="5.2" fill="url(#bm-core)" />
      {/* Crosshair — PV grid + precision-tool signal. Low alpha so it
          doesn't compete with the core; only visible at close range. */}
      <path
        d="M12 6.8v10.4M6.8 12h10.4"
        stroke="rgba(255, 255, 255, 0.75)"
        strokeWidth="0.9"
        strokeLinecap="round"
      />
      <defs>
        {/* Container fill — near-black with a faint cool tint to echo the blue accent. */}
        <linearGradient id="bm-bg" x1="12" y1="1" x2="12" y2="23" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#111318" />
          <stop offset="100%" stopColor="#0a0b0e" />
        </linearGradient>
        {/* Container stroke — slightly brighter on top for an edge-lit feel. */}
        <linearGradient id="bm-stroke" x1="12" y1="1" x2="12" y2="23" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="rgba(255,255,255,0.18)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0.04)" />
        </linearGradient>
        {/* Core disc gradient — blue radial. Offset toward the top-left
            so the disc has a convincing highlight. */}
        <radialGradient id="bm-core" cx="0.38" cy="0.32" r="0.9">
          <stop offset="0%" stopColor="#bfdbfe" />
          <stop offset="45%" stopColor="#60a5fa" />
          <stop offset="100%" stopColor="#1d4ed8" />
        </radialGradient>
      </defs>
    </svg>
  );
}
