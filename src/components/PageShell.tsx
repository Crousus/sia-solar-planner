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
  // to arbitrary widths and the layout stays coherent. We keep both the
  // Tailwind class (for the <main>) and the raw pixel value (for the nav
  // pill) in sync via `maxWidthPx` — the nav should grow to the same
  // column width the page content uses, so the two align visually and
  // the Sign-out button ends up above the content edge, not floating
  // in a narrower bar.
  const maxWidthPx = width === 'narrow' ? 480 : width === 'wide' ? 960 : 640;
  const maxWidth =
    width === 'narrow' ? 'max-w-[480px]'
    : width === 'wide' ? 'max-w-[960px]'
    : 'max-w-[640px]';

  return (
    // Height pinning vs scroll:
    //   #root is `height: 100%; overflow: hidden` (see index.css — that
    //   rule exists so the editor's fullscreen canvas can't ever create
    //   page-level scroll). For the shell to own its own scroll axis,
    //   ITS height must be capped to the viewport — otherwise tall
    //   content pushes the shell past #root and just gets clipped.
    //
    //   `h-full` pins the shell to 100% of #root (which itself is 100vh),
    //   and `overflow-y-auto` lets overflowing content scroll INSIDE the
    //   shell. Previously we used `min-h-screen`, which allowed the shell
    //   to grow past the viewport — that's why long pages (like the
    //   project bootstrap form + map preview) couldn't scroll.
    //   `overflow-x-hidden` is kept to prevent horizontal bounce from
    //   the decorative gradients bleeding past the viewport edge.
    <div className="h-full w-full page-atmosphere text-ink-100 relative overflow-x-hidden overflow-y-auto">
      {/* ── Top nav pill ─────────────────────────────────────────────
          A floating hairline-bordered bar, raycast.com-style. Contains
          the brand mark (links to /) on the left, and the user's email
          + sign-out on the right. Fixed width, centered, sits above the
          page content with some vertical margin. */}
      <nav
        className="surface mx-auto mt-6 mb-12 rounded-full flex items-center justify-between gap-4 pl-4 pr-3 py-2"
        style={{ maxWidth: maxWidthPx, width: 'calc(100% - 32px)' }}
      >
        <Link
          to="/"
          className="flex items-center gap-2.5 pl-1 pr-3 py-1 rounded-full hover:bg-white/[0.04] transition-colors"
        >
          <BrandMark size={24} />
          <span className="font-display text-[16px] font-semibold text-ink-50 leading-none">
            Solar
          </span>
          <span className="font-mono text-[13px] text-ink-400 leading-none">
            /planner
          </span>
        </Link>

        {userEmail && (
          <div className="flex items-center gap-3">
            <span
              className="hidden sm:inline font-mono text-[13px] text-ink-400 tabular-nums"
              title={userEmail}
            >
              {userEmail}
            </span>
            {onSignOut && (
              <button
                onClick={onSignOut}
                className="btn btn-ghost text-[13px]"
                style={{ padding: '7px 13px' }}
              >
                Sign out
              </button>
            )}
          </div>
        )}
      </nav>

      {/* ── Corner tech-labels ───────────────────────────────────────
          Top-left figure marker + bottom-right version stamp. Ornamental
          only. `position: fixed` (not absolute) so they stay pinned to
          the viewport edge while the shell's main column scrolls — an
          absolute label on a scrolling container would ride up with
          the content, which looks broken on pages longer than the
          viewport. Hidden on narrow viewports to avoid competing with
          content. */}
      {label && (
        <span
          aria-hidden
          className="tech-label hidden md:block fixed top-8 left-7 select-none pointer-events-none z-10"
          style={{ fontSize: 13 }}
        >
          {label}
        </span>
      )}
      <span
        aria-hidden
        className="tech-label hidden md:block fixed bottom-7 right-7 select-none pointer-events-none opacity-70 z-10"
        style={{ fontSize: 13 }}
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
