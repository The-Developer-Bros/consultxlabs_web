"use client";

import Link from "next/link";
import { Loader2, Video, CreditCard, CalendarPlus, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PrimaryAction } from "@/lib/appointments/adapter";
import { cn } from "@/utils/tailwind";

const ICONS: Record<PrimaryAction["kind"], typeof Video> = {
  join: Video,
  pay: CreditCard,
  schedule: CalendarPlus,
  "complete-booking": CalendarPlus,
  view: Eye,
};

/**
 * The single context-aware button on an appointment row. Join is the loud
 * state; pay-now keeps its amber urgency; everything else stays quiet so
 * rows scan by exception.
 */
export function RowPrimaryAction({
  action,
  onView,
  size = "sm",
}: {
  action: PrimaryAction;
  /** Fallback for `view`-kind actions without their own handler (opens the row target). */
  onView?: () => void;
  size?: "sm" | "default";
}) {
  const Icon = ICONS[action.kind];

  const className = cn(
    "shrink-0 font-medium",
    size === "sm" ? "h-8 px-3 text-xs" : "h-9 px-4 text-sm",
    action.kind === "join" &&
      "bg-green-600 hover:bg-green-700 text-white dark:bg-green-600 dark:hover:bg-green-500",
    action.kind === "pay" &&
      "bg-amber-500 hover:bg-amber-600 text-white dark:bg-amber-600 dark:hover:bg-amber-500",
  );

  const variant =
    action.kind === "join" || action.kind === "pay" ? "default" : "outline";

  const content = (
    <>
      {action.busy ? (
        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
      ) : (
        <Icon className="h-3.5 w-3.5 mr-1.5" />
      )}
      {action.label}
    </>
  );

  // External pay-now URLs open a new tab; internal hrefs client-navigate.
  if (action.href && !action.disabled) {
    if (/^https?:\/\//.test(action.href)) {
      return (
        <Button
          size="sm"
          variant={variant}
          className={className}
          onClick={() =>
            window.open(action.href!, "_blank", "noopener,noreferrer")
          }
        >
          {content}
        </Button>
      );
    }
    return (
      <Button size="sm" variant={variant} className={className} asChild>
        <Link href={action.href} onClick={(e) => e.stopPropagation()}>
          {content}
        </Link>
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      variant={variant}
      className={className}
      disabled={action.disabled || action.busy}
      onClick={(e) => {
        e.stopPropagation();
        if (action.onClick) action.onClick();
        else if (action.kind === "view") onView?.();
      }}
    >
      {content}
    </Button>
  );
}
