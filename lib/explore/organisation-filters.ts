import type { OrgDirectoryType, OrgSizeBucket } from "@prisma/client";

import {
  appendList,
  parseBooleanParam,
  parseEnumListParam,
  parseEnumParam,
  parseNullableEnumParam,
  setIfChanged,
  type ReadonlyParams,
} from "@/lib/explore/filter-codec";
import {
  DEFAULT_ORGANISATION_FILTERS,
  type IOrganisationFilters,
  type OrgCapabilityFilter,
  type OrgSortOption,
} from "@/lib/explore/organisation-types";

export const ORG_DIRECTORY_TYPES = [
  "EXPERT_NETWORK",
  "CONSULTING_AGENCY",
  "LEARNING_INSTITUTION",
  "CORPORATE_ACADEMY",
  "OTHER",
] as const satisfies readonly OrgDirectoryType[];

export const ORG_SIZE_BUCKETS = [
  "SMALL_1_50",
  "MEDIUM_51_200",
  "LARGE_201_1000",
  "ENTERPRISE_1000_PLUS",
] as const satisfies readonly OrgSizeBucket[];

export const ORG_CAPABILITIES = [
  "host",
  "sponsor",
  "hybrid",
] as const satisfies readonly OrgCapabilityFilter[];

export const ORG_SORT_OPTIONS = [
  "nameAsc",
  "nameDesc",
  "expertsDesc",
  "newest",
] as const satisfies readonly OrgSortOption[];

export const ORG_SORT_LABEL: Record<OrgSortOption, string> = {
  nameAsc: "Name (A–Z)",
  nameDesc: "Name (Z–A)",
  expertsDesc: "Most experts",
  newest: "Newest",
};

export function orgFiltersFromSearchParams(
  params: ReadonlyParams,
): IOrganisationFilters {
  return {
    search: params.get("search") || "",
    types: parseEnumListParam(params.getAll("type"), ORG_DIRECTORY_TYPES),
    industries: params.getAll("industry").filter(Boolean),
    sizes: parseEnumListParam(params.getAll("size"), ORG_SIZE_BUCKETS),
    capability: parseNullableEnumParam(
      params.get("capability"),
      ORG_CAPABILITIES,
    ),
    hasExperts: parseBooleanParam(params.get("hasExperts")),
    sort: parseEnumParam(params.get("sort"), ORG_SORT_OPTIONS, "nameAsc"),
  };
}

export function orgFiltersToSearchParams(
  filters: IOrganisationFilters,
): string {
  const params = new URLSearchParams();
  setIfChanged(params, "search", filters.search, "");
  appendList(params, "type", filters.types);
  appendList(params, "industry", filters.industries);
  appendList(params, "size", filters.sizes);
  if (filters.capability) params.set("capability", filters.capability);
  if (filters.hasExperts) params.set("hasExperts", "true");
  setIfChanged(
    params,
    "sort",
    filters.sort,
    DEFAULT_ORGANISATION_FILTERS.sort,
  );
  return params.toString();
}

export function hasActiveOrgFilters(filters: IOrganisationFilters): boolean {
  return (
    filters.search !== "" ||
    filters.types.length > 0 ||
    filters.industries.length > 0 ||
    filters.sizes.length > 0 ||
    filters.capability !== null ||
    filters.hasExperts ||
    filters.sort !== DEFAULT_ORGANISATION_FILTERS.sort
  );
}
