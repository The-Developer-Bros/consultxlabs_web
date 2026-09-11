"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";

import type { ProgramFilters, ProgramType } from "@/lib/explore/programs";

const SEARCH_DEBOUNCE_MS = 300;
const URL_SYNC_DEBOUNCE_MS = 300;

interface UseProgramsFiltersResult {
  programType: ProgramType;
  handleTabChange: (tab: ProgramType) => void;

  /** All filters are server-side and drive the React Query refetch. */
  filters: ProgramFilters;
  updateFilters: (partial: Partial<ProgramFilters>) => void;

  /** Immediate value controlling the search input. */
  localSearchValue: string;
  onLocalSearchChange: (value: string) => void;
  selectedLevel: string;
  setSelectedLevel: (level: string) => void;

  // View preference (purely cosmetic, deliberately not in the URL)
  viewMode: "grid" | "list";
  setViewMode: (mode: "grid" | "list") => void;

  clearAll: () => void;
}

function filtersFromParams(params: URLSearchParams): ProgramFilters {
  const topicIds = params.get("topicIds");
  const minPrice = params.get("minPrice");
  const maxPrice = params.get("maxPrice");
  return {
    topicIds: topicIds ? topicIds.split(",").filter(Boolean) : undefined,
    language: params.get("language") ?? undefined,
    domainId: params.get("domainId") ?? undefined,
    sort: params.get("sort") ?? undefined,
    minPrice: minPrice !== null ? Number(minPrice) : undefined,
    maxPrice: maxPrice !== null ? Number(maxPrice) : undefined,
    search: params.get("search") ?? undefined,
    level: params.get("level") ?? undefined,
  };
}

function paramsFromFilters(
  filters: ProgramFilters,
  tab: ProgramType,
): string {
  const params = new URLSearchParams();
  if (tab !== "all") params.set("tab", tab);
  if (filters.topicIds && filters.topicIds.length > 0) {
    params.set("topicIds", filters.topicIds.join(","));
  }
  if (filters.language) params.set("language", filters.language);
  if (filters.domainId) params.set("domainId", filters.domainId);
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.minPrice !== undefined)
    params.set("minPrice", String(filters.minPrice));
  if (filters.maxPrice !== undefined)
    params.set("maxPrice", String(filters.maxPrice));
  if (filters.search) params.set("search", filters.search);
  if (filters.level && filters.level !== "all")
    params.set("level", filters.level);
  return params.toString();
}

/**
 * Owns the programs listing filter state and its URL mirror.
 *
 * Previously `search` and `level` were applied CLIENT-side by
 * `filterAndSortPrograms` over whatever infinite-scroll had already loaded, so
 * a program matching the query on a later page never showed up — the results
 * were simply wrong. Both are now server-side filters like every other, and
 * every filter is bookmarkable (only `?tab=` used to be).
 *
 * URL writes go through `window.history.replaceState` rather than
 * `router.replace`: Next 15's App Router re-renders the tree via
 * `useSearchParams` reactivity even with `{ scroll: false }`, which caused
 * mid-typing scroll-to-top jumps on the experts listing.
 */
export function useProgramsFilters(): UseProgramsFiltersResult {
  const searchParams = useSearchParams();

  const [programType, setProgramType] = useState<ProgramType>(() => {
    const tab = searchParams.get("tab");
    return (tab as ProgramType) || "all";
  });

  const [filters, setFilters] = useState<ProgramFilters>(() =>
    filtersFromParams(new URLSearchParams(searchParams.toString())),
  );

  // Immediate mirror so typing stays responsive while the query key debounces.
  const [localSearchValue, setLocalSearchValue] = useState(
    () => searchParams.get("search") ?? "",
  );
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  const debouncedSetSearch = useDebouncedCallback((value: string) => {
    setFilters((prev) => ({ ...prev, search: value || undefined }));
  }, SEARCH_DEBOUNCE_MS);

  const onLocalSearchChange = useCallback(
    (value: string) => {
      setLocalSearchValue(value);
      debouncedSetSearch(value);
    },
    [debouncedSetSearch],
  );

  const handleTabChange = useCallback((tab: ProgramType) => {
    setProgramType(tab);
  }, []);

  const updateFilters = useCallback((partial: Partial<ProgramFilters>) => {
    setFilters((prev) => ({ ...prev, ...partial }));
  }, []);

  const selectedLevel = filters.level ?? "all";
  const setSelectedLevel = useCallback((level: string) => {
    setFilters((prev) => ({
      ...prev,
      level: level === "all" ? undefined : level,
    }));
  }, []);

  const clearAll = useCallback(() => {
    setFilters({});
    setLocalSearchValue("");
  }, []);

  // Debounced URL sync so rapid filter changes coalesce into one history write.
  const urlSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (urlSyncRef.current) clearTimeout(urlSyncRef.current);
    urlSyncRef.current = setTimeout(() => {
      const qs = paramsFromFilters(filters, programType);
      // Preserve the hash — see the note in useExpertsFilters.
      const hash = window.location.hash;
      const target = `/explore/programs${qs ? `?${qs}` : ""}${hash}`;
      const current = window.location.pathname + window.location.search;
      if (target !== current) {
        window.history.replaceState(window.history.state, "", target);
      }
    }, URL_SYNC_DEBOUNCE_MS);

    return () => {
      if (urlSyncRef.current) clearTimeout(urlSyncRef.current);
    };
  }, [filters, programType]);

  // Cancel any pending debounced search on unmount.
  useEffect(() => () => debouncedSetSearch.cancel(), [debouncedSetSearch]);

  return {
    programType,
    handleTabChange,
    filters,
    updateFilters,
    localSearchValue,
    onLocalSearchChange,
    selectedLevel,
    setSelectedLevel,
    viewMode,
    setViewMode,
    clearAll,
  };
}
