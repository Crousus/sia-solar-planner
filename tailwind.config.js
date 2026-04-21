/** @type {import('tailwindcss').Config} */
// ─────────────────────────────────────────────────────────────────────────────
// Tailwind config — extends the default theme with the "Precision Solar
// Instrument" design tokens.
//
// Why not ship everything in CSS variables only?
//   We still do — see src/index.css for the canonical palette. The reason we
//   mirror a subset into Tailwind's `theme.extend` is so components can write
//   `font-display` / `font-mono` / `bg-ink-900` etc. without dropping into
//   inline styles. Tailwind is our main styling surface in this project and
//   the utility classes should feel native to the design system.
//
// The color names are deliberate:
//   - `ink-*`       : the warm-charcoal base (NOT pure neutral — faint amber tint).
//   - `sun-*`       : solar-amber primary accent. Saturated, not muted.
//   - `copper-*`    : tungsten-orange secondary accent. Used sparingly for warmth.
//   - `volt-*`      : electrical-cyan for wiring / string emphasis.
// ─────────────────────────────────────────────────────────────────────────────
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // These pick up the Google-Font-loaded stacks. Keep system-ui as the
        // last fallback so the app remains legible if fonts fail to load
        // (offline dev, locked-down corporate network, etc.).
        display: ['"Bricolage Grotesque"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        // Warm-charcoal base. Unlike Tailwind's `neutral-*` (which is perfectly
        // gray), these carry a 3-5° hue shift toward amber so the UI reads as
        // "instrument warm" rather than clinical gray. Generated from
        // hsl(32, 8%, L%) with a lift at the deepest values.
        ink: {
          50:  '#f6f3ef',
          100: '#e7e2da',
          200: '#c8c1b5',
          300: '#9a9284',
          400: '#6c6557',
          500: '#494337',
          600: '#322e25',
          700: '#24211a',
          800: '#1a1812',
          900: '#121009',
          950: '#0a0804',
        },
        // Solar-amber primary. Tuned warmer than Tailwind's amber-400 (#fbbf24)
        // by dragging the hue from 46° to 42° and dropping saturation one step.
        // Reads as "golden hour" rather than "highlighter".
        sun: {
          100: '#fff4d6',
          200: '#ffe29a',
          300: '#ffcb5f',
          400: '#f5b544',   // primary accent
          500: '#e39a20',
          600: '#c07a0e',
          700: '#8f580a',
          800: '#5f3a07',
        },
        // Tungsten copper — used sparingly for hover-warmth and destructive
        // warnings that still need to feel crafted rather than alarmist-red.
        copper: {
          300: '#ff9c6b',
          400: '#ff7043',
          500: '#e55a2e',
          600: '#b94620',
        },
        // Electrical cyan — wiring, strings, "signal" accents.
        volt: {
          300: '#7ee9ff',
          400: '#2fd0ef',
          500: '#0ab2d4',
          600: '#0788a3',
        },
      },
      boxShadow: {
        // Hairline inset highlight + drop shadow combo. Gives floating panels
        // a materials feel without resorting to heavy-handed drop shadows.
        instrument:
          'inset 0 1px 0 rgba(255,255,255,0.05), 0 1px 0 rgba(0,0,0,0.4), 0 8px 24px -12px rgba(0,0,0,0.6)',
        glow: '0 0 0 1px rgba(245,181,68,0.35), 0 0 24px -4px rgba(245,181,68,0.35)',
      },
      // Subtle animation primitives reused by multiple components.
      keyframes: {
        'pulse-sun': {
          '0%, 100%': { opacity: '0.55', transform: 'scale(1)' },
          '50%':      { opacity: '0.95', transform: 'scale(1.05)' },
        },
        'shimmer': {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'pulse-sun': 'pulse-sun 2.8s ease-in-out infinite',
        'shimmer':   'shimmer 3s linear infinite',
      },
    },
  },
  plugins: [],
};
