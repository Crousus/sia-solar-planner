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
// CompassWidget — decorative top-right compass that shows how the canvas has
// been rotated relative to real-world north.
//
// Extracted from KonvaOverlay (Phase 3 decomposition). This widget is
// deliberately dumb: it takes an angle and renders. The parent (KonvaOverlay)
// owns `stageRotation` and already gates on `locked`, so this file has no
// store awareness.
//
// Why a separate component at all — it used to sit inline inside a 813-line
// god-component and was easy to miss when reading the interaction code. Its
// redesign (brushed-metal dial, 12-tick ring, amber N) belongs next to its
// markup, not inside a state machine.
//
// Magnetic-compass behavior note:
//   The WHOLE svg rotates by `stageRotation`, not just the needle. This
//   mimics a physical compass where the body spins with the vehicle and the
//   needle stays pointing at north on the underlying map. The readout chip
//   below is NOT rotated — it stays upright for legibility.
// ────────────────────────────────────────────────────────────────────────────

interface Props {
  /** Current Stage rotation in degrees — applied as a CSS transform. */
  stageRotation: number;
}

export default function CompassWidget({ stageRotation }: Props) {
  return (
    <div className="absolute top-5 right-5 z-[600] pointer-events-none flex flex-col items-center gap-1.5">
      <svg
        width="68"
        height="68"
        viewBox="0 0 68 68"
        style={{
          transform: `rotate(${stageRotation}deg)`,
          filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.7))',
          transformOrigin: 'center center',
        }}
      >
        <defs>
          <radialGradient id="compass-face" cx="0.35" cy="0.3" r="0.9">
            <stop offset="0%" stopColor="#322e25" />
            <stop offset="65%" stopColor="#1a1812" />
            <stop offset="100%" stopColor="#0a0804" />
          </radialGradient>
          <radialGradient id="compass-center" cx="0.3" cy="0.3" r="0.8">
            <stop offset="0%" stopColor="#fff4d6" />
            <stop offset="100%" stopColor="#f5b544" />
          </radialGradient>
        </defs>
        {/* Outer bezel — hairline amber-tinted border. */}
        <circle cx="34" cy="34" r="32" fill="url(#compass-face)" stroke="rgba(255,228,185,0.22)" strokeWidth="1" />
        <circle cx="34" cy="34" r="30" fill="none" stroke="rgba(255,228,185,0.08)" strokeWidth="0.75" />
        {/* 12-point tick ring — every 30°; the four cardinal ones are longer. */}
        {Array.from({ length: 12 }).map((_, i) => {
          const angle = (i * 30 * Math.PI) / 180;
          const cardinal = i % 3 === 0;
          const r1 = cardinal ? 23 : 26;
          const r2 = 28;
          const x1 = 34 + Math.sin(angle) * r1;
          const y1 = 34 - Math.cos(angle) * r1;
          const x2 = 34 + Math.sin(angle) * r2;
          const y2 = 34 - Math.cos(angle) * r2;
          return (
            <line
              key={i}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={cardinal ? 'rgba(255,228,185,0.5)' : 'rgba(255,228,185,0.2)'}
              strokeWidth={cardinal ? 1.2 : 0.75}
              strokeLinecap="round"
            />
          );
        })}
        {/* Cardinal labels — N emphasized amber, others dim ink. */}
        <text x="34" y="13" fill="var(--sun-300)" fontSize="10" fontWeight="700" fontFamily="'JetBrains Mono'" textAnchor="middle" dominantBaseline="central">N</text>
        <text x="55" y="34" fill="#c8c1b5" fontSize="8" fontWeight="600" fontFamily="'JetBrains Mono'" textAnchor="middle" dominantBaseline="central">E</text>
        <text x="34" y="55" fill="#ff9c6b" fontSize="8" fontWeight="600" fontFamily="'JetBrains Mono'" textAnchor="middle" dominantBaseline="central">S</text>
        <text x="13" y="34" fill="#c8c1b5" fontSize="8" fontWeight="600" fontFamily="'JetBrains Mono'" textAnchor="middle" dominantBaseline="central">W</text>
        {/* Needle — amber half (north) + ink half (south), diamond shape. */}
        <path d="M34 16 L38 34 L34 32 L30 34 Z" fill="var(--sun-400)" stroke="var(--sun-600)" strokeWidth="0.4" strokeLinejoin="round" />
        <path d="M34 52 L38 34 L34 32 L30 34 Z" fill="#6c6557" stroke="#322e25" strokeWidth="0.4" strokeLinejoin="round" />
        {/* Glowing pivot dot */}
        <circle cx="34" cy="33" r="2.4" fill="url(#compass-center)" />
      </svg>
      {/* Live rotation readout — NOT counter-rotated because it sits outside
          the rotating SVG; the flex-column layout keeps it upright anyway. */}
      <div
        className="chip font-mono"
        style={{
          fontSize: 10,
          padding: '2px 7px',
          background: 'rgba(18,16,9,0.75)',
          color: 'var(--sun-300)',
        }}
      >
        {stageRotation.toFixed(0)}°
      </div>
    </div>
  );
}
