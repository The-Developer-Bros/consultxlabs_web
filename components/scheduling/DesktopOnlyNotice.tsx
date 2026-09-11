"use client";

import { useEffect, useState } from "react";
import { Monitor } from "lucide-react";

/**
 * Gate for surfaces that genuinely need a wide viewport — the slot heatmap is
 * seven day-columns of 30-minute rows, which does not survive a phone.
 *
 * Two gates, deliberately, because they answer different questions.
 *
 * CSS decides what is VISIBLE. Detecting the viewport in JS to pick the branch
 * would either render the wrong one on the server and correct it after
 * hydration (a visible flash, and a mismatch), or force the whole page to be
 * client-only. Two siblings and a Tailwind breakpoint have neither problem.
 *
 * JS decides what is MOUNTED, which CSS cannot: `hidden` still mounts its
 * subtree, so the calendar ran its availability fetch on phones for a grid
 * nobody could see. `isDesktop` starts false so the server and the first
 * client render agree; the children mount one effect later, and the calendar
 * has a loading state for exactly that gap.
 */
export function DesktopOnlyNotice({
  children,
  className,
}: Readonly<{ children: React.ReactNode; className?: string }>) {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    // Tailwind's `lg`. Kept in sync by hand: a media query string cannot read
    // the theme, and the alternative is measuring on every resize.
    const query = window.matchMedia("(min-width: 1024px)");
    // Latches: once true it never goes back. Unmounting on a shrink would
    // destroy the calendar's own slot selection while SlotPicker keeps its
    // copy, so a resize, a split screen or a browser zoom leaves the footer
    // claiming "N slots selected" over a grid showing none — and submitting
    // sends times the user can no longer see. The CSS gate still hides the
    // subtree below `lg`, which is what the notice is actually for; this only
    // decides whether the fetch-on-mount ever happens.
    const sync = () => {
      if (query.matches) setIsDesktop(true);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return (
    <>
      <div className="lg:hidden flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-16 text-center">
        <Monitor className="h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium text-foreground">
          Please access this on desktop for now
        </p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Choosing times needs a wider screen than this one. Everything else in
          your dashboard works here.
        </p>
      </div>

      {/* Flex, not block: the calendar sizes itself with `flex-1`, which needs
          a flex parent to fill. */}
      <div className={`hidden lg:flex lg:flex-col ${className ?? ""}`}>
        {isDesktop ? children : null}
      </div>
    </>
  );
}
