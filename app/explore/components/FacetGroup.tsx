"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { cn } from "@/utils/tailwind";

export interface FacetOption<T extends string = string> {
  value: T;
  label: string;
  /** Result count for this option. Omit when the count isn't known. */
  count?: number;
}

interface FacetGroupProps<T extends string> {
  title: string;
  icon?: React.ReactNode;
  options: FacetOption<T>[];
  selected: T[];
  onToggle: (value: T) => void;
  /** Single-select behaves like a radio: picking a new value replaces it. */
  singleSelect?: boolean;
  defaultOpen?: boolean;
  /** Options beyond this are hidden behind a "Show all" toggle. */
  collapseAfter?: number;
}

/**
 * A collapsible group of checkbox facets with result counts.
 *
 * Counts matter: NN/g's faceted-search guidance is that a filter which returns
 * zero results should say so before it's clicked, not after.
 */
export default function FacetGroup<T extends string>({
  title,
  icon,
  options,
  selected,
  onToggle,
  singleSelect = false,
  defaultOpen = true,
  collapseAfter = 6,
}: FacetGroupProps<T>) {
  const [open, setOpen] = useState(defaultOpen);
  const [expanded, setExpanded] = useState(false);

  if (options.length === 0) return null;

  const visible = expanded ? options : options.slice(0, collapseAfter);
  const hiddenCount = options.length - visible.length;

  return (
    <div className="border-b border-border pb-4 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center justify-between py-3 text-left"
      >
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
          {icon}
          {title}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="space-y-1">
          {visible.map((option) => {
            const isSelected = selected.includes(option.value);
            const isEmpty = option.count === 0 && !isSelected;
            return (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted",
                  isEmpty && "cursor-not-allowed opacity-50 hover:bg-transparent",
                )}
              >
                <input
                  type={singleSelect ? "radio" : "checkbox"}
                  checked={isSelected}
                  disabled={isEmpty}
                  onChange={() => onToggle(option.value)}
                  className="h-4 w-4 shrink-0 accent-primary"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {option.label}
                </span>
                {option.count !== undefined && (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {option.count}
                  </span>
                )}
              </label>
            );
          })}

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Show {hiddenCount} more
            </button>
          )}
          {expanded && options.length > collapseAfter && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Show less
            </button>
          )}
        </div>
      )}
    </div>
  );
}
