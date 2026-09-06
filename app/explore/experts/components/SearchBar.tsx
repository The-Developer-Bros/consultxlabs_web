"use client";

import { memo, useEffect, useState } from "react";
import { useDebouncedCallback } from "use-debounce";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search } from "lucide-react";

export type SortOption =
  | "nameAsc"
  | "nameDesc"
  | "reviewCount"
  | "rating"
  | "trending"
  | "newest";

interface SearchBarProps {
  onSearch: (value: string) => void;
  onSort: (option: SortOption) => void;
  sortBy: SortOption;
  initialSearch?: string;
}

/**
 * Controlled search input.
 *
 * - `localValue` is updated synchronously on every keystroke so typing
 *   feels instant.
 * - `onSearch` propagation to the parent is debounced by 300 ms so the
 *   `filters.search` mutation (which becomes a React Query key change)
 *   only fires once per typing burst. Without this debounce the
 *   listing would refetch `/api/user/consultants` on every keystroke.
 * - `localValue` re-syncs from `initialSearch` whenever the parent's
 *   value changes (e.g. clearing the Search chip / clear-all) so the
 *   input doesn't get stuck on stale text.
 *
 * The parent's `useExpertsFilters` hook still debounces the URL mirror
 * separately; that's an independent concern (URL writes vs filter
 * state mutations).
 */
function SearchBarImpl({
  onSearch,
  onSort,
  sortBy,
  initialSearch = "",
}: SearchBarProps) {
  const [localValue, setLocalValue] = useState(initialSearch);

  // Re-sync local input from parent state. Necessary so external
  // mutations (filter chip removal, clear all, URL hydration) clear
  // the input — without this useEffect, useState only initializes
  // once and the input would stay stuck on the initial value.
  useEffect(() => {
    setLocalValue(initialSearch);
  }, [initialSearch]);

  const debouncedOnSearch = useDebouncedCallback((value: string) => {
    onSearch(value);
  }, 300);

  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-11 rounded-xl border-border bg-card pl-10 pr-3 text-sm"
          placeholder="Search experts by name, skill, or specialty…"
          type="search"
          value={localValue}
          onChange={(e) => {
            setLocalValue(e.target.value);
            debouncedOnSearch(e.target.value);
          }}
        />
      </div>

      <Select
        value={sortBy}
        onValueChange={(value) => onSort(value as SortOption)}
      >
        <SelectTrigger
          className="h-11 w-[168px] rounded-xl border-border bg-card"
          aria-label="Sort experts"
        >
          <SelectValue placeholder="Sort by" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="nameAsc">Name (A-Z)</SelectItem>
          <SelectItem value="nameDesc">Name (Z-A)</SelectItem>
          <SelectItem value="reviewCount">Most Reviews</SelectItem>
          <SelectItem value="rating">Highest Rating</SelectItem>
          <SelectItem value="trending">Trending</SelectItem>
          <SelectItem value="newest">Newest</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export const SearchBar = memo(SearchBarImpl);
