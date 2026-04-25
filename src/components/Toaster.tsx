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
// Toaster — fly-in message stack pinned to the top of the viewport.
//
// Mounted exactly once in <AppShell/>. Listens to the toast store via
// `useToasts()`; renders the live array as a vertically stacked column
// of cards. Each card has:
//   - A coloured left border indicating severity.
//   - The message (and optional detail line).
//   - An × close button on the right that calls dismissToast(id).
//
// Visual notes:
//   - `pointer-events-none` on the outer container so the toast region
//     never swallows clicks meant for the canvas underneath. Each card
//     re-enables pointer events on itself so the close button still works.
//   - The fly-in animation is a one-shot `@keyframes` injected via a
//     <style> sibling. We keep it inline rather than in index.css to
//     scope the styling next to the component that owns it; the
//     existing codebase already mixes Tailwind with localised <style>
//     blocks (see index.css's konva-overlay rules).
//   - Top inset is 56px so the stack hangs just below the toolbar's
//     bottom edge in the editor view. On non-editor pages there's no
//     toolbar, but 56px still reads as "near the top, with breathing
//     room", so we don't bother conditionalising.
// ────────────────────────────────────────────────────────────────────────────

import { useTranslation } from 'react-i18next';
import { dismissToast, useToasts, type Toast, type ToastLevel } from '../store/toastStore';

/** Per-level visual treatment — left band colour + subtle background tint. */
const LEVEL_STYLES: Record<ToastLevel, { band: string; bg: string }> = {
  // Error: warm red. Matches the inline `role="alert"` styling already
  // used by form-field validation messages elsewhere in the app, so the
  // user sees a consistent "this is wrong" colour story.
  error:   { band: '#ef4444', bg: 'rgba(239, 68, 68, 0.08)' },
  // Info: neutral sky blue.
  info:    { band: '#0ea5e9', bg: 'rgba(14, 165, 233, 0.08)' },
  // Success: emerald — matches the accent used by SyncStatusIndicator.
  success: { band: '#10b981', bg: 'rgba(16, 185, 129, 0.08)' },
};

/**
 * Default export: drop into the React tree once. No props — the
 * Toaster is a singleton and reads state directly from the toast store.
 */
export default function Toaster() {
  const toasts = useToasts();
  // No early-return on empty so the keyframes stay parsed and ready —
  // avoids a tiny first-toast flicker where the animation rule is still
  // being committed by the browser. Negligible DOM cost (one empty div).

  return (
    <>
      {/* Inline keyframes for the fly-in. Defined once at the top of the
          stack rather than in index.css to keep the animation scoped to
          this component. `transform: translateY(-12px)` plus `opacity: 0`
          is the minimum viable "drops in from above" feel — no spring,
          no scale, matches the user's "nothing too fancy" brief. */}
      <style>{`
        @keyframes solar-toast-in {
          from { transform: translateY(-12px); opacity: 0; }
          to   { transform: translateY(0);     opacity: 1; }
        }
      `}</style>

      <div
        // role=region announces the live area to AT users; aria-live
        // polite means new toasts get read out without interrupting
        // whatever the user was last hearing. Errors don't escalate to
        // assertive because that would also cut off in-progress speech,
        // which is more disruptive than the toast warrants.
        role="region"
        aria-label="Notifications"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-14 z-[1000] flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} />
        ))}
      </div>
    </>
  );
}

/**
 * Single toast card. Pulled out so each one gets its own animation
 * instance (without this, swapping the array would re-run the keyframe
 * on already-mounted siblings).
 */
function ToastCard({ toast }: { toast: Toast }) {
  const { t } = useTranslation();
  const style = LEVEL_STYLES[toast.level];

  return (
    <div
      // role=alert ensures the message is announced for screen readers
      // even though the parent's aria-live would already cover it — some
      // assistive tech only picks up the inner role. Doubly-correct,
      // never wrong.
      role="alert"
      className="pointer-events-auto flex max-w-md items-start gap-3 rounded-lg px-3 py-2 text-[12.5px] shadow-md"
      style={{
        background: style.bg,
        border: `1px solid ${style.band}`,
        borderLeftWidth: '4px',
        color: 'var(--sun-200)',
        // The animation runs once on mount. Forwards keeps the final
        // state (opacity 1) so a re-render doesn't snap back to the
        // animation's "from" frame.
        animation: 'solar-toast-in 180ms ease-out both',
      }}
    >
      <div className="flex-1">
        <div className="font-medium leading-snug">{toast.message}</div>
        {toast.detail && (
          <div className="mt-0.5 text-[11px] opacity-70 leading-snug">
            {toast.detail}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        // aria-label uses the i18n key so screen-reader text is
        // localised the same way visible text is. `errors.dismiss` lives
        // in the new errors namespace (en.ts/de.ts).
        aria-label={t('errors.dismiss')}
        className="-mr-1 -mt-0.5 rounded p-1 text-[14px] leading-none opacity-60 transition hover:bg-black/20 hover:opacity-100"
        style={{ color: 'var(--sun-200)' }}
      >
        ×
      </button>
    </div>
  );
}
