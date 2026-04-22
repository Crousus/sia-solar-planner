// ────────────────────────────────────────────────────────────────────────
// PageShell — shared chrome for the dashboard pages (TeamPicker,
// TeamView, NewTeamPage, TeamMembers).
//
// Why a shared component now when each page used to roll its own Shell?
// The previous system had each page reimplementing a ~4-line wrapper,
// which was fine when they just set a dark bg. The new "Command Console"
// aesthetic layers on: atmospheric background, top nav pill with brand
// mark and user menu, FIG_## corner markers, consistent max-width and
// vertical rhythm. That's more variation than is worth duplicating —
// pulling it out keeps the page files focused on their specific content.
//
// Kept deliberately out of scope: AuthGuard, routing, any kind of
// "layout with outlet" pattern. AppShell already handles the auth wiring;
// PageShell is pure presentation.
// ────────────────────────────────────────────────────────────────────────

import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { BrandMark } from './BrandMark';

interface Props {
  /** Content rendered in the main column. */
  children: ReactNode;
  /**
   * Mono-cap label for the top-left "figure" marker (e.g. "FIG_01 ·
   * WORKSPACES"). Purely decorative; gives each page a technical-manual
   * anchor without requiring a visible heading.
   */
  label?: string;
  /** Signed-in user's email, shown in the top-right of the nav pill. */
  userEmail?: string;
  /** Optional sign-out handler — if provided, renders the sign-out link. */
  onSignOut?: () => void;
  /**
   * Tighter max-width for narrow pages (NewTeamPage, TeamMembers). Default
   * is 640px; pages that need more room can pass `wide`.
   */
  width?: 'narrow' | 'default' | 'wide';
}

export function PageShell({
  children,
  label,
  userEmail,
  onSignOut,
  width = 'default',
}: Props) {
  // Max-width tokens map to a three-step scale. Keeping them explicit here
  // rather than exposing raw Tailwind classes means the pages can't drift
  // to arbitrary widths and the layout stays coherent.
  const maxWidth =
    width === 'narrow' ? 'max-w-[480px]'
    : width === 'wide' ? 'max-w-[960px]'
    : 'max-w-[640px]';

  return (
    <div className="min-h-screen w-full page-atmosphere text-ink-100 relative overflow-x-hidden">
      {/* ── Top nav pill ─────────────────────────────────────────────
          A floating hairline-bordered bar, raycast.com-style. Contains
          the brand mark (links to /) on the left, and the user's email
          + sign-out on the right. Fixed width, centered, sits above the
          page content with some vertical margin. */}
      <nav
        className="surface mx-auto mt-5 mb-10 rounded-full flex items-center justify-between gap-4 pl-3 pr-2 py-1.5"
        style={{ maxWidth: 680, width: 'calc(100% - 32px)' }}
      >
        <Link
          to="/"
          className="flex items-center gap-2 pl-1 pr-3 py-1 rounded-full hover:bg-white/[0.04] transition-colors"
        >
          <BrandMark size={20} />
          <span className="font-display text-[14px] font-semibold text-ink-50 leading-none">
            Solar
          </span>
          <span className="font-mono text-[11px] text-ink-400 leading-none">
            /planner
          </span>
        </Link>

        {userEmail && (
          <div className="flex items-center gap-2">
            <span
              className="hidden sm:inline font-mono text-[11px] text-ink-400 tabular-nums"
              title={userEmail}
            >
              {userEmail}
            </span>
            {onSignOut && (
              <button
                onClick={onSignOut}
                className="btn btn-ghost text-[12px]"
                style={{ padding: '6px 10px' }}
              >
                Sign out
              </button>
            )}
          </div>
        )}
      </nav>

      {/* ── Corner tech-label ────────────────────────────────────────
          Top-left marker. Echoes the FIG_## labels on raycast.com —
          purely ornamental. Hidden on narrow viewports to avoid
          competing with content. */}
      {label && (
        <span
          aria-hidden
          className="tech-label hidden md:block absolute top-7 left-6 select-none"
        >
          {label}
        </span>
      )}
      <span
        aria-hidden
        className="tech-label hidden md:block absolute bottom-6 right-6 select-none opacity-70"
      >
        SOLAR / PLANNER · v0.1
      </span>

      {/* ── Main column ─────────────────────────────────────────────
          Centered, width-capped. Bottom padding leaves room for the
          corner labels without overlap. */}
      <main className={`${maxWidth} mx-auto px-5 pb-24`}>{children}</main>
    </div>
  );
}
