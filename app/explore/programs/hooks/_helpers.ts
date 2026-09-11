// Internal helpers + API types shared between the programs query hooks.
// Not exported from the `hooks/` barrel — consumers should call the hooks
// instead of these primitives directly.

import type {
  ApiMeta,
  ClassInstance,
  ProgramFilters,
  TopicWithCount,
} from "@/lib/explore/programs";

interface WebinarWithAppointment {
  appointment?: {
    slotsOfAppointment?: { user?: { id: string }[] }[];
  } | null;
}

export interface ClassPlanApiItem {
  id: string;
  classes?: ClassInstance[];
  imageUrl?: string | null;
}

export interface WebinarPlanApiItem {
  id: string;
  webinars?: WebinarWithAppointment[];
  imageUrl?: string | null;
}

type PlanApiItem = ClassPlanApiItem | WebinarPlanApiItem;

export interface PlanApiResponse {
  data?: PlanApiItem[];
  meta?: ApiMeta;
}

export interface TopicsApiResponse {
  data?: TopicWithCount[];
}

/** Build a query string suffix from a `ProgramFilters` object. Returns
 *  `&topicIds=...` (with leading ampersand) so callers can append it to
 *  an existing querystring without worrying about whether to use `?` or
 *  `&`. Returns an empty string when no filters are set. */
export function buildFilterParams(filters: ProgramFilters): string {
  const params = new URLSearchParams();
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
  const str = params.toString();
  return str ? `&${str}` : "";
}

export const fetchPlans = (url: string): Promise<PlanApiResponse> =>
  fetch(url).then((res) => res.json());

export const fetchTopics = (url: string): Promise<TopicsApiResponse> =>
  fetch(url).then((res) => res.json());
