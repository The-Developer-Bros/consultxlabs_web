"use client";

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Building2, Layers, Search, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDebouncedCallback } from "use-debounce";
import {
  DEFAULT_ORGANISATION_FILTERS,
  type IOrganisationFilters,
  type OrganisationListItem,
  type OrganisationsMetadata,
  type OrgCapabilityFilter,
  type OrgSortOption,
} from "@/lib/explore/organisation-types";
import {
  hasActiveOrgFilters,
  orgFiltersFromSearchParams,
  orgFiltersToSearchParams,
  ORG_SORT_LABEL,
  ORG_SORT_OPTIONS,
} from "@/lib/explore/organisation-filters";
import {
  ORG_DIRECTORY_TYPE_LABEL,
  ORG_PUBLIC_CAPABILITY_LABEL,
  ORG_SIZE_BUCKET_LABEL,
} from "@/lib/labels/org-labels";

import FacetCombobox from "../../components/FacetCombobox";
import FacetGroup from "../../components/FacetGroup";
import FacetRail from "../../components/FacetRail";
import FilterChips, { type ActiveFilter } from "../../components/FilterChips";
import { useUrlSyncedFilters } from "../../hooks/useUrlSyncedFilters";
import OrgCard, { OrgCardSkeleton } from "./OrgCard";

const BASE_PATH = "/explore/enterprise/organisations";

interface Props {
  metadata: OrganisationsMetadata;
  initialItems: OrganisationListItem[];
  initialTotal: number;
}

interface OrgsResponse {
  data: OrganisationListItem[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export default function OrganisationsInteractiveContent({
  metadata,
  initialItems,
  initialTotal,
}: Props) {
  const { filters, updateFilters, clearFilters } =
    useUrlSyncedFilters<IOrganisationFilters>({
      basePath: BASE_PATH,
      defaults: DEFAULT_ORGANISATION_FILTERS,
      fromSearchParams: orgFiltersFromSearchParams,
      toSearchParams: orgFiltersToSearchParams,
    });

  // Local mirror so typing stays responsive while the query key debounces.
  const [searchInput, setSearchInput] = useState(filters.search);
  const pushSearch = useDebouncedCallback((value: string) => {
    updateFilters({ search: value });
  }, 300);

  const queryString = orgFiltersToSearchParams(filters);
  const isDefaultView = !hasActiveOrgFilters(filters);

  const { data, isFetching, isPending } = useQuery<OrgsResponse>({
    queryKey: ["organisations", queryString],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/public?${queryString}`);
      if (!res.ok) throw new Error("Failed to load organisations");
      return res.json();
    },
    // The RSC already rendered the unfiltered first page; don't refetch it.
    //
    // Seeded ONLY when the server actually returned rows. The RSC read no longer
    // degrades to an empty page on a cold-connect timeout — since #1119 it throws
    // and this component never renders — so the guard no longer has a degraded
    // case to repair. It is kept because seeding an empty list as initialData
    // marks it fresh for staleTime, so the client would never refetch and a
    // genuinely-empty-right-now directory would stay stuck on "No organisations
    // match these filters". Falling through to a normal fetch costs one request.
    initialData:
      isDefaultView && initialItems.length > 0
        ? {
            data: initialItems,
            meta: {
              total: initialTotal,
              page: 1,
              limit: initialItems.length,
              totalPages: 1,
            },
          }
        : undefined,
    placeholderData: keepPreviousData,
    staleTime: 2 * 60 * 1000,
  });

  const orgs = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  const toggleIn = useCallback(
    <T extends string>(list: T[], value: T): T[] =>
      list.includes(value)
        ? list.filter((item) => item !== value)
        : [...list, value],
    [],
  );

  const activeChips = useMemo<ActiveFilter[]>(() => {
    const chips: ActiveFilter[] = [];
    if (filters.search)
      chips.push({ key: "search", label: "Search", value: filters.search });
    for (const type of filters.types) {
      chips.push({
        key: `type:${type}`,
        label: "Type",
        value: ORG_DIRECTORY_TYPE_LABEL[type],
      });
    }
    for (const industry of filters.industries) {
      chips.push({
        key: `industry:${industry}`,
        label: "Industry",
        value: industry,
      });
    }
    for (const size of filters.sizes) {
      chips.push({
        key: `size:${size}`,
        label: "Size",
        value: ORG_SIZE_BUCKET_LABEL[size],
      });
    }
    if (filters.capability) {
      chips.push({
        key: "capability",
        label: "Role",
        value: ORG_PUBLIC_CAPABILITY_LABEL[filters.capability],
      });
    }
    if (filters.hasExperts) {
      chips.push({
        key: "hasExperts",
        label: "Has experts",
        value: "Yes",
      });
    }
    return chips;
  }, [filters]);

  const removeChip = useCallback(
    (key: string) => {
      // Split on the FIRST colon only — industry values legitimately contain
      // colons, and a greedy split would corrupt the removal target.
      const separator = key.indexOf(":");
      const kind = separator === -1 ? key : key.slice(0, separator);
      const value = separator === -1 ? "" : key.slice(separator + 1);
      switch (kind) {
        case "search":
          pushSearch.cancel();
          setSearchInput("");
          updateFilters({ search: "" });
          break;
        case "type":
          updateFilters({
            types: filters.types.filter((item) => item !== value),
          });
          break;
        case "industry":
          updateFilters({
            industries: filters.industries.filter((item) => item !== value),
          });
          break;
        case "size":
          updateFilters({
            sizes: filters.sizes.filter((item) => item !== value),
          });
          break;
        case "capability":
          updateFilters({ capability: null });
          break;
        case "hasExperts":
          updateFilters({ hasExperts: false });
          break;
      }
    },
    [filters, updateFilters, pushSearch],
  );

  const handleClearAll = useCallback(() => {
    // Cancel the in-flight debounce, or it lands ~300ms later and writes the
    // pre-clear search term back over the cleared state.
    pushSearch.cancel();
    setSearchInput("");
    clearFilters();
  }, [clearFilters, pushSearch]);

  useEffect(() => () => pushSearch.cancel(), [pushSearch]);

  const facets = (
    <>
      <FacetGroup
        title="Type"
        icon={<Layers className="h-3.5 w-3.5 text-muted-foreground" />}
        options={metadata.types.map((entry) => ({
          value: entry.value,
          label: ORG_DIRECTORY_TYPE_LABEL[entry.value],
          count: entry.count,
        }))}
        selected={filters.types}
        onToggle={(value) =>
          updateFilters({ types: toggleIn(filters.types, value) })
        }
      />

      <FacetGroup
        title="What they do"
        icon={<Users className="h-3.5 w-3.5 text-muted-foreground" />}
        singleSelect
        options={metadata.capabilities.map((entry) => ({
          value: entry.value,
          label: ORG_PUBLIC_CAPABILITY_LABEL[entry.value],
          count: entry.count,
        }))}
        selected={filters.capability ? [filters.capability] : []}
        onToggle={(value) =>
          updateFilters({
            capability: filters.capability === value ? null : value,
          })
        }
      />

      <FacetCombobox
        label="Industry"
        placeholder="Search industries…"
        options={metadata.industries.map((entry) => ({
          value: entry.value,
          label: entry.value,
          count: entry.count,
        }))}
        selected={filters.industries}
        onToggle={(value) =>
          updateFilters({ industries: toggleIn(filters.industries, value) })
        }
        onClear={() => updateFilters({ industries: [] })}
      />

      <FacetGroup
        title="Size"
        icon={<Building2 className="h-3.5 w-3.5 text-muted-foreground" />}
        options={metadata.sizes.map((entry) => ({
          value: entry.value,
          label: ORG_SIZE_BUCKET_LABEL[entry.value],
          count: entry.count,
        }))}
        selected={filters.sizes}
        onToggle={(value) =>
          updateFilters({ sizes: toggleIn(filters.sizes, value) })
        }
      />

      <div className="py-3">
        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={filters.hasExperts}
            onChange={(event) =>
              updateFilters({ hasExperts: event.target.checked })
            }
            className="h-4 w-4 accent-primary"
          />
          <span className="text-sm text-foreground">
            Only show organisations with experts
          </span>
        </label>
      </div>
    </>
  );

  return (
    <section className="py-10 md:py-16">
      <div className="mx-auto max-w-[1400px] px-4 md:px-8">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[260px_1fr]">
          <FacetRail
            activeCount={activeChips.length}
            onClearAll={handleClearAll}
            resultSummary={`${total} result${total !== 1 ? "s" : ""}`}
          >
            {facets}
          </FacetRail>

          <div className="min-w-0">
            {/* Search + sort */}
            <div className="mb-5 flex flex-col gap-3 sm:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(event) => {
                    setSearchInput(event.target.value);
                    pushSearch(event.target.value);
                  }}
                  placeholder="Search organisations by name, industry, or description…"
                  className="h-11 pl-9"
                  aria-label="Search organisations"
                />
              </div>
              <Select
                value={filters.sort}
                onValueChange={(value) =>
                  updateFilters({ sort: value as OrgSortOption })
                }
              >
                <SelectTrigger className="h-11 sm:w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ORG_SORT_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {ORG_SORT_LABEL[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {activeChips.length > 0 && (
              <div className="mb-5">
                <FilterChips
                  filters={activeChips}
                  onRemove={removeChip}
                  onClearAll={handleClearAll}
                />
              </div>
            )}

            <p className="mb-4 hidden text-sm text-muted-foreground lg:block">
              {total} organisation{total !== 1 ? "s" : ""}
            </p>

            {/* Landing on a filtered URL has no initialData, so without this
                guard the first paint claimed "no organisations match" before
                the request had even resolved. */}
            {isPending ? (
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 6 }).map((_, index) => (
                  <OrgCardSkeleton key={index} />
                ))}
              </div>
            ) : orgs.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-card py-24 text-center">
                <Building2 className="mb-4 h-12 w-12 text-muted-foreground/70" />
                <p className="text-lg font-medium text-muted-foreground">
                  No organisations match these filters
                </p>
                <p className="mt-1 text-sm text-muted-foreground/70">
                  {activeChips.length > 0 ? (
                    <button
                      onClick={handleClearAll}
                      className="underline transition-colors hover:text-foreground"
                    >
                      Clear all filters
                    </button>
                  ) : (
                    "Organisations can opt in to marketplace discovery from their settings."
                  )}
                </p>
              </div>
            ) : (
              <div
                className={`grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 ${
                  isFetching ? "opacity-60 transition-opacity" : ""
                }`}
              >
                {orgs.map((org) => (
                  <OrgCard key={org.id} org={org} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export function OrganisationsGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, index) => (
        <OrgCardSkeleton key={index} />
      ))}
    </div>
  );
}
