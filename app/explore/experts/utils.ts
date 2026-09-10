import type { IConsultantCardData } from "@/types/consultant";
import { SortOption } from "./components/SearchBar";
import { ReadonlyURLSearchParams } from "next/navigation";

export const CONSULTANTS_PER_PAGE = 10;

export type AffiliationType = "independent" | "agency" | null;

export interface IExpertFilters {
  domain: string | null;
  subdomain: string | null;
  tags: string[];
  experience: number;
  search: string;
  sort: SortOption;
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
  companies: string[];
  language?: string;
  affiliationType: AffiliationType;
}

export const DEFAULT_EXPERT_FILTERS: IExpertFilters = {
  domain: null,
  subdomain: null,
  tags: [],
  experience: 0,
  search: "",
  sort: "nameAsc",
  minPrice: undefined,
  maxPrice: undefined,
  minRating: undefined,
  companies: [],
  language: undefined,
  affiliationType: null,
};

export interface IExpertsMetaData {
  domains: { id: string; name: string }[];
  subdomains: { id: string; name: string; domainId: string | null }[];
  tags: { id: string; name: string; domainId: string | null }[];
  consultantMetadata: {
    totalConsultants: number;
    consultantsByDomain: {
      id: string;
      name: string;
      consultantCount: number;
    }[];
    /** Mean of the PUBLISHED per-consultant scores, 0 when none qualify. */
    averageRating: number;
    /** Denominator behind `averageRating` — published reviews across the
     *  directory. Gates whether the rating is shown at all (#1485). */
    publishedReviewCount: number;
    /** Meetings actually held across the platform — COMPLETED slots, not
     *  appointments (#1485). */
    completedSessions: number;
  };
  availableLanguages: string[];
  availableCompanies: string[];
}

export interface IConsultantsByDomain {
  /** Keyed by `domain.id` (with the literal string `"other"` as the
   *  fallback when a consultant has no domain). Renamed semantics from
   *  the previous name-keyed shape so domain renames can't break the
   *  grouped-by-domain layout. */
  [domainId: string]: IConsultantCardData[];
}

export function groupConsultantsByDomain(
  consultants: IConsultantCardData[],
): IConsultantsByDomain {
  return consultants.reduce((acc, consultant) => {
    const domainId = consultant.domain?.id || "other";
    if (!acc[domainId]) {
      acc[domainId] = [];
    }
    acc[domainId].push(consultant);
    return acc;
  }, {} as IConsultantsByDomain);
}

/** Parse a non-negative finite number from a URL param. Returns
 *  `undefined` for missing / blank / non-finite / negative values. */
function parseNumberParam(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed < 0) return undefined;
  return parsed;
}

/** Like `parseNumberParam` but floors the result to an integer. Used for
 *  filter params the API also parses as integers (`parseInt`) so the UI
 *  state and the filter we send to the API can't drift apart on
 *  values like `?experience=1.5`. */
function parseIntegerParam(raw: string | null): number | undefined {
  const parsed = parseNumberParam(raw);
  if (parsed === undefined) return undefined;
  return Math.floor(parsed);
}

const VALID_SORT_OPTIONS: ReadonlySet<SortOption> = new Set<SortOption>([
  "nameAsc",
  "nameDesc",
  "reviewCount",
  "rating",
  "trending",
  "newest",
]);

// Parse IExpertFilters from URL search params
export function filtersFromSearchParams(
  params: ReadonlyURLSearchParams,
): IExpertFilters {
  const rawSort = params.get("sort");
  const sort: SortOption =
    rawSort && VALID_SORT_OPTIONS.has(rawSort as SortOption)
      ? (rawSort as SortOption)
      : "nameAsc";

  return {
    domain: params.get("domain"),
    subdomain: params.get("subdomain"),
    // Repeated params (?tags=a&tags=b), not comma-joined, so a literal comma in
    // a tag/company name can't split one value into two bogus filter terms.
    tags: params.getAll("tags").filter(Boolean),
    // API uses parseInt — keep both sides aligned so a hand-edited
    // ?experience=1.5 doesn't make the UI show 1.5 while the API filters at 1.
    experience: parseIntegerParam(params.get("experience")) ?? 0,
    search: params.get("search") || "",
    sort,
    // Don't treat 0 as unset — the slider's "Free" state writes both
    // minPrice=0 and maxPrice=0 and reloading that bookmarkable URL
    // must round-trip to the same Free filter. The slider's isDefault
    // check at write time already coerces the all-range default to
    // undefined, so the read side doesn't need to.
    minPrice: parseNumberParam(params.get("minPrice")),
    maxPrice: parseNumberParam(params.get("maxPrice")),
    minRating: parseNumberParam(params.get("minRating")),
    companies: params.getAll("companies").filter(Boolean),
    language: params.get("language") || undefined,
    affiliationType: (params.get("affiliationType") as AffiliationType) || null,
  };
}

// Serialize IExpertFilters to URLSearchParams string
export function filtersToSearchParams(filters: IExpertFilters): string {
  const params = new URLSearchParams();
  if (filters.domain) params.set("domain", filters.domain);
  if (filters.subdomain) params.set("subdomain", filters.subdomain);
  for (const tag of filters.tags) params.append("tags", tag);
  if (filters.experience > 0)
    params.set("experience", String(filters.experience));
  if (filters.search) params.set("search", filters.search);
  if (filters.sort !== "nameAsc") params.set("sort", filters.sort);
  if (filters.minPrice !== undefined)
    params.set("minPrice", String(filters.minPrice));
  if (filters.maxPrice !== undefined)
    params.set("maxPrice", String(filters.maxPrice));
  if (filters.minRating !== undefined)
    params.set("minRating", String(filters.minRating));
  for (const company of filters.companies) params.append("companies", company);
  if (filters.language) params.set("language", filters.language);
  if (filters.affiliationType)
    params.set("affiliationType", filters.affiliationType);
  return params.toString();
}
