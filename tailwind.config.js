/** @type {import('tailwindcss').Config} */
// ─────────────────────────────────────────────────────────────────────────────
// Tailwind config — extends the default theme with the "Command Console"
// design tokens (Raycast-inspired).
//
// We mirror a subset of the CSS-variable palette (see src/index.css) here
// because Tailwind is the main styling surface: components reach for
// `bg-ink-900`, `text-sun-300`, `font-mono` rather than dropping into inline
// styles. Variables stay canonical — change a hex there and remember to
// mirror it here.
//
// Color role recap:
//   - `ink-*`      near-black neutral surface scale (faint 1° warmth, no
//                  discernible hue — won't fight the scarlet accent)
//   - `sun-*`      scarlet primary accent. Name retained from prior system
//                  so existing `text-sun-300 / bg-sun-400` references
//                  retarget cleanly. Semantically: *primary* now, not amber.
//   - `copper-*`   warm tungsten — destructive / warning semantics
//   - `volt-*`     electrical cyan — wiring / string accents
// ─────────────────────────────────────────────────────────────────────────────
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // `display` previously pointed at Bricolage Grotesque. It now resolves
        // to Geist; callers using `font-display` via utility classes pick up
        // the new tight-tracked display treatment (see .font-display in CSS).
        // Keeping the utility name means no component renames.
        display: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        // Near-black neutral scale. The prior amber-tinted scale (hsl 32, 8%)
        // was retired because it fought the scarlet accent. These values
        // hold a *trace* of warmth (~1°) so the UI doesn't read as clinical
        // slate-gray, but sit well below the hue threshold where they'd
        // start competing with the scarlet.
        ink: {
          50:  '#f7f7f8',
          100: '#e8e8ec',
          200: '#c5c5cc',
          300: '#95959c',
          400: '#65656b',
          500: '#3a3a3f',
          600: '#242428',
          700: '#18181b',
          800: '#111113',
          900: '#0b0b0c',
          950: '#080808',
        },
        // Scarlet — Raycast-style warm red. Calibrated against screenshots:
        // a coral-leaning red (not fire-engine, not rose). 400 is the
        // canonical accent, 300 is hover-bright, 500+ is pressed / gradient
        // base. The `sun` name is retained to avoid a 50-file rename; read
        // it as "primary accent" wherever it appears.
        sun: {
          100: '#ffe1da',
          200: '#ffb5a8',
          300: '#ff8a79',
          400: '#ff6363',   // primary accent
          500: '#e84a4a',
          600: '#c13636',
          700: '#962828',
          800: '#6b1c1c',
        },
        // Tungsten — used sparingly for destructive-adjacent signals so
        // scarlet stays *positive*. Hue-shifted from scarlet so they're
        // adjacent-but-distinct.
        copper: {
          300: '#ffb493',
          400: '#ff8a5c',
          500: '#e36d3d',
          600: '#b9532a',
        },
        // Electrical cyan — kept for wiring/strings "signal" semantics.
        volt: {
          300: '#7ee9ff',
          400: '#2fd0ef',
          500: '#0ab2d4',
          600: '#0788a3',
        },
      },
      boxShadow: {
        // Hairline inset highlight + drop shadow. Dialed back vs prior
        // system: the new visual language leans flatter, so the drop
        // shadow carries less weight and the inset highlight is subtler.
        instrument:
          'inset 0 1px 0 rgba(255,255,255,0.03), 0 1px 0 rgba(0,0,0,0.5), 0 12px 32px -14px rgba(0,0,0,0.7)',
        // The scarlet glow ring used on primary CTAs.
        glow: '0 0 0 1px rgba(255,99,99,0.4), 0 0 28px -4px rgba(255,99,99,0.35)',
      },
      keyframes: {
        'pulse-sun': {
          '0%, 100%': { opacity: '0.55', transform: 'scale(1)' },
          '50%':      { opacity: '0.95', transform: 'scale(1.08)' },
        },
        'shimmer': {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        // Slow scarlet bloom for hero background elements; used by the
        // LoginPage atmospheric glow.
        'drift': {
          '0%':   { transform: 'translate3d(0,0,0) scale(1)', opacity: '0.7' },
          '50%':  { transform: 'translate3d(-1%, 0.5%, 0) scale(1.03)', opacity: '0.85' },
          '100%': { transform: 'translate3d(0,0,0) scale(1)', opacity: '0.7' },
        },
      },
      animation: {
        'pulse-sun': 'pulse-sun 2.8s ease-in-out infinite',
        'shimmer':   'shimmer 3s linear infinite',
        'drift':     'drift 14s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
