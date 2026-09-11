"use client";

import { useCallback, useMemo } from "react";
import type { ActiveFilter } from "../components/FilterChips";
import type {
  ProgramFilters,
  TopicWithCount,
} from "@/lib/explore/programs";

/**
 * Structured chip key. Replaces the old `topic-${id}` string encoding so
 * removal can dispatch off `kind` without parsing — topic ids that contain
 * hyphens (or any other separator) just work.
 */
type ProgramChipKey =
  | { kind: "topic"; id: string }
  | { kind: "language" }
  | { kind: "price" }
  | { kind: "sort" }
  | { kind: "level" }
  | { kind: "search" };

/**
 * Encode a structured chip key as a string for the shared `FilterChips`
 * display component (which expects `ActiveFilter.key: string`). Topic ids
 * are JSON-escaped so any character round-trips safely.
 */
function encodeChipKey(key: ProgramChipKey): string {
  if (key.kind === "topic") {
    return `topic:${JSON.stringify(key.id)}`;
  }
  return key.kind;
}

function decodeChipKey(encoded: string): ProgramChipKey | null {
  if (encoded.startsWith("topic:")) {
    try {
      return { kind: "topic", id: JSON.parse(encoded.slice(6)) as string };
    } catch {
      return null;
    }
  }
  switch (encoded) {
    case "language":
    case "price":
    case "sort":
    case "level":
    case "search":
      return { kind: encoded };
    default:
      return null;
  }
}

const SORT_LABELS: Record<string, string> = {
  trending: "Most Popular",
  newest: "Newest",
  "price-asc": "Price Low-High",
  "price-desc": "Price High-Low",
  "title-asc": "Title A-Z",
  "title-desc": "Title Z-A",
};

interface UseProgramFilterChipsArgs {
  filters: ProgramFilters;
  topics: TopicWithCount[];
  selectedLevel: string;
  searchTerm: string;
  /** `useCurrency().formatPrice` takes paise (smallest currency unit) —
   *  it divides by 100 internally for display. */
  formatPrice: (amountInPaise: number) => string;
  updateFilters: (partial: Partial<ProgramFilters>) => void;
  setSelectedLevel: (level: string) => void;
  /** Reset both the debounced searchTerm and the input-controlled value. */
  clearSearch: () => void;
  clearAll: () => void;
}

interface UseProgramFilterChipsResult {
  chips: ActiveFilter[];
  removeChip: (encodedKey: string) => void;
  clearAll: () => void;
}

export function useProgramFilterChips({
  filters,
  topics,
  selectedLevel,
  searchTerm,
  formatPrice,
  updateFilters,
  setSelectedLevel,
  clearSearch,
  clearAll,
}: UseProgramFilterChipsArgs): UseProgramFilterChipsResult {
  const chips = useMemo<ActiveFilter[]>(() => {
    const out: ActiveFilter[] = [];

    if (filters.topicIds && filters.topicIds.length > 0) {
      for (const id of filters.topicIds) {
        const topic = topics.find((t) => t.id === id);
        if (topic) {
          out.push({
            key: encodeChipKey({ kind: "topic", id }),
            label: "Topic",
            value: topic.name,
          });
        }
      }
    }

    if (filters.language) {
      out.push({
        key: encodeChipKey({ kind: "language" }),
        label: "Language",
        value: filters.language,
      });
    }

    if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
      const min = filters.minPrice ?? 0;
      const max = filters.maxPrice;
      const label =
        min === 0 && max === 0
          ? "Free"
          : max === undefined
            ? `${formatPrice(min)}+`
            : `${formatPrice(min)} - ${formatPrice(max)}`;
      out.push({
        key: encodeChipKey({ kind: "price" }),
        label: "Price",
        value: label,
      });
    }

    if (filters.sort) {
      out.push({
        key: encodeChipKey({ kind: "sort" }),
        label: "Sort",
        value: SORT_LABELS[filters.sort] || filters.sort,
      });
    }

    if (selectedLevel !== "all") {
      out.push({
        key: encodeChipKey({ kind: "level" }),
        label: "Level",
        value: selectedLevel,
      });
    }

    if (searchTerm) {
      out.push({
        key: encodeChipKey({ kind: "search" }),
        label: "Search",
        value: searchTerm,
      });
    }

    return out;
  }, [filters, topics, selectedLevel, searchTerm, formatPrice]);

  const removeChip = useCallback(
    (encodedKey: string) => {
      const key = decodeChipKey(encodedKey);
      if (!key) return;

      switch (key.kind) {
        case "topic":
          updateFilters({
            topicIds: filters.topicIds?.filter((id) => id !== key.id),
          });
          return;
        case "language":
          updateFilters({ language: undefined });
          return;
        case "price":
          updateFilters({ minPrice: undefined, maxPrice: undefined });
          return;
        case "sort":
          updateFilters({ sort: undefined });
          return;
        case "level":
          setSelectedLevel("all");
          return;
        case "search":
          clearSearch();
          return;
      }
    },
    [updateFilters, setSelectedLevel, clearSearch, filters.topicIds],
  );

  return { chips, removeChip, clearAll };
}
