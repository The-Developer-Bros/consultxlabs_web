"use client";

import { useCallback, useMemo } from "react";
import type { ActiveFilter } from "@/app/explore/components/FilterChips";
import type { IExpertFilters, IExpertsMetaData } from "../utils";

/**
 * Structured chip key. Replaces the old `tag-${tagName}` /
 * `company-${companyName}` string encoding so removal can dispatch off
 * `kind` without parsing — names with hyphens etc. just work.
 */
type ChipKey =
  | { kind: "domain" }
  | { kind: "subdomain" }
  | { kind: "tag"; value: string }
  | { kind: "experience" }
  | { kind: "price" }
  | { kind: "minRating" }
  | { kind: "company"; value: string }
  | { kind: "language" }
  | { kind: "search" }
  | { kind: "sort" };

/**
 * Encode a structured chip key as a string for the shared `FilterChips`
 * display component, which is also used by the programs page and expects
 * `ActiveFilter.key: string`. Tag/company values are JSON-escaped so any
 * character (hyphens, slashes, colons, etc.) round-trips safely.
 */
function encodeChipKey(key: ChipKey): string {
  switch (key.kind) {
    case "tag":
      return `tag:${JSON.stringify(key.value)}`;
    case "company":
      return `company:${JSON.stringify(key.value)}`;
    default:
      return key.kind;
  }
}

/** Inverse of `encodeChipKey` — used by the FilterChips removal callback. */
function decodeChipKey(encoded: string): ChipKey | null {
  if (encoded.startsWith("tag:")) {
    try {
      return { kind: "tag", value: JSON.parse(encoded.slice(4)) as string };
    } catch {
      return null;
    }
  }
  if (encoded.startsWith("company:")) {
    try {
      return {
        kind: "company",
        value: JSON.parse(encoded.slice(8)) as string,
      };
    } catch {
      return null;
    }
  }
  switch (encoded) {
    case "domain":
    case "subdomain":
    case "experience":
    case "price":
    case "minRating":
    case "language":
    case "search":
    case "sort":
      return { kind: encoded };
    default:
      return null;
  }
}

const SORT_LABELS: Record<string, string> = {
  nameDesc: "Name (Z-A)",
  reviewCount: "Most Reviews",
  rating: "Highest Rating",
  trending: "Trending",
  newest: "Newest",
};

interface UseExpertFilterChipsResult {
  chips: ActiveFilter[];
  removeChip: (encodedKey: string) => void;
  clearAll: () => void;
}

export function useExpertFilterChips(
  filters: IExpertFilters,
  metadata: IExpertsMetaData | null,
  updateFilters: (partial: Partial<IExpertFilters>) => void,
  clearFilters: () => void,
  /** `useCurrency().formatPrice` takes paise (smallest currency unit) —
   *  it divides by 100 internally for display. */
  formatPrice: (amountInPaise: number) => string,
): UseExpertFilterChipsResult {
  const chips = useMemo<ActiveFilter[]>(() => {
    const out: ActiveFilter[] = [];

    if (filters.domain) {
      const domain = metadata?.domains.find((d) => d.id === filters.domain);
      if (domain) {
        out.push({
          key: encodeChipKey({ kind: "domain" }),
          label: "Domain",
          value: domain.name,
        });
      }
    }

    if (filters.subdomain) {
      const sub = metadata?.subdomains.find((s) => s.id === filters.subdomain);
      if (sub) {
        out.push({
          key: encodeChipKey({ kind: "subdomain" }),
          label: "Subdomain",
          value: sub.name,
        });
      }
    }

    for (const tag of filters.tags) {
      out.push({
        key: encodeChipKey({ kind: "tag", value: tag }),
        label: "Tag",
        value: tag,
      });
    }

    if (filters.experience > 0) {
      out.push({
        key: encodeChipKey({ kind: "experience" }),
        label: "Experience",
        value: `${filters.experience}+ years`,
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

    if (filters.minRating !== undefined) {
      out.push({
        key: encodeChipKey({ kind: "minRating" }),
        label: "Rating",
        value: `${filters.minRating}+ stars`,
      });
    }

    for (const company of filters.companies) {
      out.push({
        key: encodeChipKey({ kind: "company", value: company }),
        label: "Company",
        value: company,
      });
    }

    if (filters.language) {
      out.push({
        key: encodeChipKey({ kind: "language" }),
        label: "Language",
        value: filters.language,
      });
    }

    if (filters.search) {
      out.push({
        key: encodeChipKey({ kind: "search" }),
        label: "Search",
        value: filters.search,
      });
    }

    if (filters.sort !== "nameAsc") {
      out.push({
        key: encodeChipKey({ kind: "sort" }),
        label: "Sort",
        value: SORT_LABELS[filters.sort] || filters.sort,
      });
    }

    return out;
  }, [filters, metadata, formatPrice]);

  const removeChip = useCallback(
    (encodedKey: string) => {
      const key = decodeChipKey(encodedKey);
      if (!key) return;

      switch (key.kind) {
        case "domain":
          updateFilters({ domain: null, subdomain: null, tags: [] });
          return;
        case "subdomain":
          updateFilters({ subdomain: null });
          return;
        case "tag":
          updateFilters({
            tags: filters.tags.filter((t) => t !== key.value),
          });
          return;
        case "experience":
          updateFilters({ experience: 0 });
          return;
        case "price":
          updateFilters({ minPrice: undefined, maxPrice: undefined });
          return;
        case "minRating":
          updateFilters({ minRating: undefined });
          return;
        case "company":
          updateFilters({
            companies: filters.companies.filter((c) => c !== key.value),
          });
          return;
        case "language":
          updateFilters({ language: undefined });
          return;
        case "search":
          updateFilters({ search: "" });
          return;
        case "sort":
          updateFilters({ sort: "nameAsc" });
          return;
      }
    },
    [updateFilters, filters.tags, filters.companies],
  );

  return { chips, removeChip, clearAll: clearFilters };
}
