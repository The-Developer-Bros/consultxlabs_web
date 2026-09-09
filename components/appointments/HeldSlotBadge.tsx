"use client";

import { format } from "date-fns";
import { useHoldCountdown } from "@/hooks/useHoldCountdown";
import { cn } from "@/utils/tailwind";

interface HeldSlotBadgeProps {
  /** Payment.expiresAt for the pending payment holding this slot. */
  deadline: Date | null;
  className?: string;
}

/**
 * #1428 — a tentative slot with no visible deadline reads as "the platform
 * lost my booking." This names the state and ticks down against it via the
 * shared `useHoldCountdown` hook, so SessionTimeline's held row and any
 * future held-slot surface agree on when a hold has actually lapsed.
 */
export function HeldSlotBadge({ deadline, className }: HeldSlotBadgeProps) {
  const { minutesLeft, isExpired } = useHoldCountdown(deadline);

  if (!deadline) {
    return (
      <span
        className={cn(
          "text-[10px] font-semibold uppercase text-amber-600 dark:text-amber-400",
          className,
        )}
      >
        Held
      </span>
    );
  }

  if (isExpired) {
    return (
      <span
        className={cn(
          "text-[10px] font-semibold uppercase text-muted-foreground/70",
          className,
        )}
      >
        Hold expired
      </span>
    );
  }

  return (
    <span
      className={cn(
        "text-[10px] font-medium text-amber-700 dark:text-amber-400 tabular-nums",
        className,
      )}
      title={`Held until ${format(deadline, "h:mm a")}`}
    >
      Held until {format(deadline, "h:mm a")} ·{" "}
      {/* minutesLeft floors, so 0 is the live final minute, not a lapsed
          hold — "0m left" next to an active CTA reads as broken. */}
      {minutesLeft === 0 ? "under a minute left" : `${minutesLeft}m left`}
    </span>
  );
}
