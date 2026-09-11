"use client";

/**
 * The legend the slot grids never had.
 *
 * Three surfaces coloured cells in four different states and none of them said
 * what the colours meant — a consultant seeing a yellow cell had to guess
 * whether it was bookable. Driven off SLOT_STATUS_TOKENS, so a new state cannot
 * be introduced without appearing here.
 */

import { cn } from "@/utils/tailwind";
import {
  SLOT_STATUS_TOKENS,
  type SlotStatusKey,
} from "@/lib/scheduling/slot-status-tokens";

interface SlotStatusLegendProps {
  keys: SlotStatusKey[];
  className?: string;
}

export function SlotStatusLegend({
  keys,
  className,
}: Readonly<SlotStatusLegendProps>) {
  return (
    <ul
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-2", className)}
      aria-label="What the colours mean"
    >
      {keys.map((key) => {
        const token = SLOT_STATUS_TOKENS[key];
        return (
          <li
            key={key}
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            title={token.hint}
          >
            {/* No border-COLOUR of its own: `swatchClassName` carries the
                cell's, and a hardcoded one here would win or lose by
                stylesheet order rather than by intent (#1064). */}
            <span
              aria-hidden
              className={cn(
                "h-3 w-3 shrink-0 rounded-sm border",
                token.swatchClassName,
              )}
            />
            {token.label}
          </li>
        );
      })}
    </ul>
  );
}
