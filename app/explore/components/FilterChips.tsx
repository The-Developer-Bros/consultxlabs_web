"use client";

import { X } from "lucide-react";

export interface ActiveFilter {
  key: string;
  label: string;
  value: string;
}

interface FilterChipsProps {
  filters: ActiveFilter[];
  onRemove: (key: string) => void;
  onClearAll: () => void;
}

export default function FilterChips({
  filters,
  onRemove,
  onClearAll,
}: FilterChipsProps) {
  if (filters.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {filters.map((filter) => (
        <span
          key={filter.key}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground"
        >
          <span className="text-muted-foreground/70">{filter.label}:</span>
          <span className="text-foreground">{filter.value}</span>
          <button
            type="button"
            onClick={() => onRemove(filter.key)}
            className="rounded-full p-0.5 transition-colors hover:text-foreground"
            aria-label={`Remove ${filter.label} filter`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        Clear all
      </button>
    </div>
  );
}
