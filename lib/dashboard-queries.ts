/**
 * Centralized Dashboard Query Factory
 *
 * This module provides optimized query configurations for all dashboard types.
 * Key optimizations:
 * 1. Parallel data fetching with Promise.all
 * 2. Stale-while-revalidate for instant perceived loading
 * 3. Intelligent cache management with gcTime
 * 4. Query dependencies for sequential fetching when needed
 * 5. Prefetch strategies for predictive loading
 */

import type { TConsultantDashboardResponse } from "@/types/consultant-events";
import type { TAppointment } from "@/types/appointment";
import type { TConsultantProfile } from "@/types/consultant";
import type { TConsulteeEventsResponse } from "@/types/consultee-events";
import type {
  TConsulteeProfile,
  TConsulteeProfileWithBackground,
} from "@/types/consultee";
import type {
  PlannerWebinarEvent,
  PlannerClassEvent,
} from "@/types/planner-events";
import type { RecordingData } from "@/types/recording";
import { requireJsonResponse } from "@/lib/fetch-helpers";

// =============================================================================
// Types
// =============================================================================

interface PlannerData {
  webinars: PlannerWebinarEvent[];
  classes: PlannerClassEvent[];
  participantCounts: Record<string, number>;
}

export interface ConsultantRecordingsParams {
  type?: "webinar" | "class" | null;
  page?: number;
  limit?: number;
  search?: string;
}

interface ConsultantRecordingsResponse {
  recordings: RecordingData[];
  totalPages?: number;
  total?: number;
}

// =============================================================================
// Fetch Functions
// =============================================================================

async function fetchWithErrorHandling<T>(
  url: string,
  errorPrefix: string,
): Promise<T> {
  const response = await fetch(url);
  // `requireJsonResponse` carries the status on the thrown error and refuses to
  // parse an HTML body, so a Netlify crash page or a sign-in redirect reaches
  // the dashboard as "… (HTTP 502)" rather than a JSON syntax error
  // (FAMILIARISE_WEB-1C). `statusText` is empty over HTTP/2, which is why the
  // old message ended in a colon and nothing.
  const json = (await requireJsonResponse(response, errorPrefix)) as {
    data?: T;
  } | null;
  return (json?.data ?? json) as T;
}

// Consultant fetchers
export const consultantFetchers = {
  dashboard: (consultantId: string) =>
    fetchWithErrorHandling<TConsultantDashboardResponse>(
      `/api/dashboard/consultant/${consultantId}`,
      "Dashboard fetch failed",
    ),

  appointments: (consultantId: string, orgScope?: string | null) =>
    fetchWithErrorHandling<TAppointment[]>(
      orgScope && orgScope !== "personal"
        ? `/api/slots/appointments?consultantProfileId=${consultantId}&orgScope=${encodeURIComponent(orgScope)}`
        : `/api/slots/appointments?consultantProfileId=${consultantId}`,
      "Appointments fetch failed",
    ),

  details: (consultantId: string) =>
    fetchWithErrorHandling<TConsultantProfile>(
      `/api/user/consultants/${consultantId}`,
      "Consultant details fetch failed",
    ),

  planner: (consultantId: string, orgScope?: string | null) =>
    fetchWithErrorHandling<PlannerData>(
      orgScope && orgScope !== "personal"
        ? `/api/dashboard/consultant/${consultantId}/planner?orgScope=${encodeURIComponent(orgScope)}`
        : `/api/dashboard/consultant/${consultantId}/planner`,
      "Planner fetch failed",
    ),

  documents: (consultantId: string, orgScope?: string | null) =>
    fetchWithErrorHandling<TAppointment[]>(
      orgScope && orgScope !== "personal"
        ? `/api/dashboard/consultant/${consultantId}/documents?orgScope=${encodeURIComponent(orgScope)}`
        : `/api/dashboard/consultant/${consultantId}/documents`,
      "Documents fetch failed",
    ),

  recordings: (
    consultantId: string,
    { type, page = 1, limit = 12, search }: ConsultantRecordingsParams = {},
  ) => {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    params.set("page", String(page));
    params.set("limit", String(limit));
    if (search) params.set("search", search);
    return fetchWithErrorHandling<ConsultantRecordingsResponse>(
      `/api/consultants/${consultantId}/recordings?${params.toString()}`,
      "Recordings fetch failed",
    );
  },
};

// Consultee fetchers
export const consulteeFetchers = {
  events: (consulteeId: string, orgScope?: string | null) =>
    fetchWithErrorHandling<TConsulteeEventsResponse>(
      orgScope && orgScope !== "personal"
        ? `/api/dashboard/consultee/${consulteeId}/events?orgScope=${encodeURIComponent(orgScope)}`
        : `/api/dashboard/consultee/${consulteeId}/events`,
      "Events fetch failed",
    ),

  profile: (consulteeId: string) =>
    fetchWithErrorHandling<TConsulteeProfile>(
      `/api/user/consultees/${consulteeId}`,
      "Profile fetch failed",
    ),

  /** Same endpoint as profile but typed with education + workExperiences includes. */
  profileWithBackground: (consulteeId: string) =>
    fetchWithErrorHandling<TConsulteeProfileWithBackground>(
      `/api/user/consultees/${consulteeId}`,
      "Profile fetch failed",
    ),

  feedback: () =>
    fetchWithErrorHandling<Record<string, unknown>[]>(
      `/api/user/feedbacks`,
      "Feedback fetch failed",
    ),

  supportTickets: () =>
    fetchWithErrorHandling<Record<string, unknown>[]>(
      `/api/user/support-tickets`,
      "Support tickets fetch failed",
    ),
};

// User fetchers (shared)
const userFetchers = {
  details: (userId: string) =>
    fetchWithErrorHandling(`/api/user/${userId}`, "User details fetch failed"),
};

// =============================================================================
// Query Factories
// =============================================================================

// Stale time constants (in ms)
const STALE_TIMES = {
  INSTANT: 0, // Always refetch
  SHORT: 30 * 1000, // 30 seconds
  MEDIUM: 2 * 60 * 1000, // 2 minutes
  LONG: 5 * 60 * 1000, // 5 minutes
  STATIC: Infinity, // Never refetch
};

// Garbage collection time (how long to keep unused data)
const GC_TIME = 10 * 60 * 1000; // 10 minutes

/**
 * Consultant Dashboard Queries
 */
export function createConsultantQueries(
  consultantId: string,
  /**
   * B1-personal-retrofit: org-scope filter for the consultant's
   * requests / planner / documents queries. Threaded into queryKey
   * so swap-flips invalidate the cache.
   */
  orgScope?: string | null,
) {
  const scopeKey = orgScope ?? "personal";
  return {
    // Primary data for home dashboard
    dashboard: {
      queryKey: ["consultant-dashboard", consultantId] as const,
      queryFn: () => consultantFetchers.dashboard(consultantId),
      staleTime: STALE_TIMES.MEDIUM,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Appointments with all statuses
    appointments: {
      queryKey: ["consultant-appointments", consultantId, scopeKey] as const,
      queryFn: () => consultantFetchers.appointments(consultantId, orgScope),
      staleTime: STALE_TIMES.SHORT,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Consultant profile details
    details: {
      queryKey: ["consultant-details", consultantId] as const,
      queryFn: () => consultantFetchers.details(consultantId),
      staleTime: STALE_TIMES.LONG,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Planner/calendar data
    planner: {
      queryKey: ["consultant-planner", consultantId, scopeKey] as const,
      queryFn: () => consultantFetchers.planner(consultantId, orgScope),
      // Slot freshness without realtime: a booking/cancellation made in another
      // tab, on another device, or by another user shows up when this view
      // regains focus. Reconnect refetch is already global (ReactQueryProvider).
      staleTime: STALE_TIMES.SHORT,
      gcTime: GC_TIME,
      retry: 2,
      refetchOnWindowFocus: true,
    },

    // Documents for review
    documents: {
      queryKey: ["consultant-documents", consultantId, scopeKey] as const,
      queryFn: () => consultantFetchers.documents(consultantId, orgScope),
      staleTime: STALE_TIMES.MEDIUM,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Recordings (server-paginated). Unlike its static siblings this entry
    // is a function: page/type/search come from component state, and each
    // combination must be its own cache entry. The recordings endpoint is
    // personal-pinned server-side (#1166 ORG-6), so the key never varies by
    // scope and scopeKey is deliberately absent from it.
    recordings: (params: ConsultantRecordingsParams = {}) => ({
      queryKey: [
        "consultant-recordings",
        consultantId,
        params.type ?? "all",
        params.page ?? 1,
        params.search ?? "",
      ] as const,
      queryFn: () => consultantFetchers.recordings(consultantId, params),
      staleTime: STALE_TIMES.SHORT,
      gcTime: GC_TIME,
      retry: 2,
    }),
  };
}

/**
 * Consultee Dashboard Queries
 */
export function createConsulteeQueries(
  consulteeId: string,
  /**
   * B1-personal-retrofit: org-scope filter for the events query.
   * Pass `personal` (default) | `<orgId>` | `all`. Threaded into the
   * queryKey so swap-flips invalidate the cache.
   */
  orgScope?: string | null,
) {
  const scopeKey = orgScope ?? "personal";
  return {
    // All events (appointments, subscriptions, classes, webinars)
    events: {
      queryKey: ["consultee-events", consulteeId, scopeKey] as const,
      queryFn: () => consulteeFetchers.events(consulteeId, orgScope),
      // Slot freshness without realtime: a slot relinquished/rebooked elsewhere
      // shows up when this view regains focus (reconnect refetch is global).
      staleTime: STALE_TIMES.SHORT,
      gcTime: GC_TIME,
      retry: 2,
      refetchOnWindowFocus: true,
    },

    // Same dataset as `events`, tuned for the Home tab: the SSR-dehydrated
    // seed must survive first paint without an immediate refetch waterfall,
    // and a background tab regaining focus while the user reads their
    // overview shouldn't churn the list. Appointments keeps the fresher
    // `events` config above — same key base, different refresh posture.
    // Keep this paired with `events`: if you change one's queryKey shape,
    // change both (the server seed pins the key base).
    eventsHome: {
      queryKey: ["consultee-events", consulteeId, scopeKey] as const,
      queryFn: () => consulteeFetchers.events(consulteeId, orgScope),
      staleTime: 60_000,
      gcTime: GC_TIME,
      retry: 2,
      refetchOnWindowFocus: false,
    },

    // Consultee profile
    profile: {
      queryKey: ["consultee-profile", consulteeId] as const,
      queryFn: () => consulteeFetchers.profile(consulteeId),
      staleTime: STALE_TIMES.LONG,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Feedback data
    feedback: {
      queryKey: ["consultee-feedback"] as const,
      queryFn: () => consulteeFetchers.feedback(),
      staleTime: STALE_TIMES.MEDIUM,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Support tickets
    supportTickets: {
      queryKey: ["consultee-support-tickets"] as const,
      queryFn: () => consulteeFetchers.supportTickets(),
      staleTime: STALE_TIMES.MEDIUM,
      gcTime: GC_TIME,
      retry: 2,
    },

    // Settings (uses same endpoint as profile, typed with education/work includes)
    settings: {
      queryKey: ["consultee-settings", consulteeId] as const,
      queryFn: () => consulteeFetchers.profileWithBackground(consulteeId),
      staleTime: STALE_TIMES.LONG,
      gcTime: GC_TIME,
      retry: 2,
    },
  };
}

/**
 * User Queries (shared across all dashboards)
 */
export function createUserQueries(userId: string) {
  return {
    details: {
      queryKey: ["user-details", userId] as const,
      queryFn: () => userFetchers.details(userId),
      staleTime: STALE_TIMES.LONG,
      gcTime: GC_TIME,
      retry: 2,
    },
  };
}

// =============================================================================
// Prefetch Utilities
// =============================================================================

/**
 * Schedule prefetch using requestIdleCallback when available.
 * Returns a cancel function so callers (hooks with teardown) can retract the
 * callback if they unmount before the idle slot fires.
 */
export function schedulePrefetch(
  callback: () => void,
  timeout = 2000,
): () => void {
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    const handle = window.requestIdleCallback(callback, { timeout });
    return () => window.cancelIdleCallback?.(handle);
  }
  const timer = setTimeout(callback, 100);
  return () => clearTimeout(timer);
}
