import { cn } from "@/utils/tailwind";
import type { StatusBadgeStyle } from "@/lib/labels/session-labels";

interface StatusBadgeProps extends StatusBadgeStyle {
  /** Render the leading status dot when the style provides one. */
  withDot?: boolean;
  size?: "sm" | "md";
}

/**
 * Pill renderer for the `lib/labels/session-labels.ts` maps. Consumers
 * resolve a style via the per-enum helpers and spread it here:
 *
 *   <StatusBadge {...appointmentStatusBadge(booking.status)} />
 *
 * Keeping the renderer dumb (label + classes in, span out) means every
 * status pill across the consultant/consultee dashboards shares one
 * geometry, and colour semantics live in exactly one module.
 */
export function StatusBadge({
  label,
  className,
  dotClassName,
  withDot = false,
  size = "md",
}: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap",
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-0.5 text-xs",
        className,
      )}
    >
      {withDot && dotClassName && (
        <span
          className={cn("h-1.5 w-1.5 rounded-full shrink-0", dotClassName)}
          aria-hidden
        />
      )}
      {label}
    </span>
  );
}
