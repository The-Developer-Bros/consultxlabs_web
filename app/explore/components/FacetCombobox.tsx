"use client";

import { Check, ChevronsUpDown, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/utils/tailwind";

import type { FacetOption } from "./FacetGroup";

interface FacetComboboxProps<T extends string> {
  label: string;
  placeholder?: string;
  options: FacetOption<T>[];
  selected: T[];
  onToggle: (value: T) => void;
  onClear?: () => void;
  disabled?: boolean;
  disabledHint?: string;
}

/**
 * Multi-select autocomplete for large facet sets (tags, companies, industries,
 * topics).
 *
 * Replaces three near-identical hand-rolled implementations — an `<input>` plus
 * an absolutely-positioned `<div>` and a `mousedown` outside-click listener —
 * that were duplicated across the experts and programs filter panels. Radix
 * Popover was already a dependency but had no component wrapping it; it brings
 * focus trapping, escape-to-close and outside-click dismissal for free.
 */
export default function FacetCombobox<T extends string>({
  label,
  placeholder = "Search…",
  options,
  selected,
  onToggle,
  onClear,
  disabled = false,
  disabledHint,
}: FacetComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => option.label.toLowerCase().includes(q));
  }, [options, query]);

  const selectedOptions = useMemo(
    () => options.filter((option) => selected.includes(option.value)),
    [options, selected],
  );

  return (
    <div className="border-b border-border pb-4 last:border-b-0">
      <div className="flex items-center justify-between py-3">
        <span className="text-sm font-semibold text-foreground">{label}</span>
        {selected.length > 0 && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild disabled={disabled}>
          <button
            type="button"
            aria-expanded={open}
            aria-haspopup="listbox"
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm transition-colors",
              disabled
                ? "cursor-not-allowed opacity-50"
                : "hover:border-foreground/30",
            )}
          >
            <span className="truncate text-muted-foreground">
              {disabled && disabledHint
                ? disabledHint
                : selected.length > 0
                  ? `${selected.length} selected`
                  : placeholder}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>

        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-2">
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={placeholder}
            className="mb-2 h-9"
          />
          <div className="max-h-56 overflow-y-auto" role="listbox">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                No matches
              </p>
            ) : (
              filtered.map((option) => {
                const isSelected = selected.includes(option.value);
                // Match FacetGroup: a zero-count option leads to a known-empty
                // result set, so don't offer it — unless it's already applied,
                // which must stay removable.
                const isEmpty = option.count === 0 && !isSelected;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={isEmpty}
                    onClick={() => onToggle(option.value)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                      isEmpty &&
                        "cursor-not-allowed opacity-50 hover:bg-transparent",
                    )}
                  >
                    <Check
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        isSelected ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {option.label}
                    </span>
                    {option.count !== undefined && (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {option.count}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>

      {selectedOptions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {selectedOptions.map((option) => (
            <span
              key={option.value}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {option.label}
              <button
                type="button"
                onClick={() => onToggle(option.value)}
                aria-label={`Remove ${option.label}`}
                className="rounded-full p-0.5 transition-colors hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
