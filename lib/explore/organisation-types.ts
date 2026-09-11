import type { OrgDirectoryType, OrgSizeBucket } from "@prisma/client";

/**
 * Client-safe types and constants for the organisations directory.
 *
 * Deliberately separate from `lib/data/explore-organisations.ts`: that module
 * imports `@/lib/prisma`, so importing any *value* from it in a client
 * component (`DEFAULT_ORGANISATION_FILTERS`, for instance) drags the pg driver
 * into the browser bundle and the build fails on `Can't resolve 'fs'`. Type-only
 * imports are erased and would be fine; values are not. Keeping them here makes
 * the boundary impossible to get wrong by accident.
 */

export const ORGANISATIONS_PER_PAGE = 24;

export type OrgCapabilityFilter = "host" | "sponsor" | "hybrid";

export type OrgSortOption = "nameAsc" | "nameDesc" | "expertsDesc" | "newest";

export interface IOrganisationFilters {
  search: string;
  types: OrgDirectoryType[];
  industries: string[];
  sizes: OrgSizeBucket[];
  capability: OrgCapabilityFilter | null;
  hasExperts: boolean;
  sort: OrgSortOption;
}

export const DEFAULT_ORGANISATION_FILTERS: IOrganisationFilters = {
  search: "",
  types: [],
  industries: [],
  sizes: [],
  capability: null,
  hasExperts: false,
  sort: "nameAsc",
};

export interface OrganisationListItem {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  bannerImage: string | null;
  description: string | null;
  industry: string | null;
  website: string | null;
  sizeBucket: OrgSizeBucket | null;
  directoryType: OrgDirectoryType | null;
  capability: OrgCapabilityFilter | "inert";
  isVerified: boolean;
  expertCount: number;
}

export interface OrganisationsMetadata {
  industries: { value: string; count: number }[];
  types: { value: OrgDirectoryType; count: number }[];
  sizes: { value: OrgSizeBucket; count: number }[];
  capabilities: { value: OrgCapabilityFilter; count: number }[];
  total: number;
}

export interface OrganisationsPage {
  items: OrganisationListItem[];
  total: number;
  page: number;
  totalPages: number;
}
