"use client";

import { useQueryClient, type FetchQueryOptions } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { reportSentryError } from "@/lib/observability/report";

import {
  createConsultantQueries,
  createConsulteeQueries,
  schedulePrefetch,
} from "@/lib/dashboard-queries";

interface PrefetchDashboardOptions {
  consultantId?: string;
  consulteeId?: string;
  enableAggressivePrefetch?: boolean;
}

// FAQ fetcher — backs the Help tab of the shared Support surface, which both
// the consultant and consultee dashboards mount. Not a dashboard query.
export const fetchHelpFAQs = async () => {
  const { faqs } =
    await import("@/components/dashboard/shared/support/questions");
  return faqs;
};

// Static queries (FAQ, help, etc.) — exported for reuse
export const staticQueries = {
  help: {
    queryKey: ["help-faqs"],
    queryFn: fetchHelpFAQs,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false as const,
  },
};

export function usePrefetchDashboard({
  consultantId,
  consulteeId,
  enableAggressivePrefetch = true,
}: PrefetchDashboardOptions = {}) {
  const queryClient = useQueryClient();
  const prefetchedRef = useRef(new Set<string>());
  // Every delayed prefetch / throttle reset lands here so unmount can cancel
  // them — otherwise post-unmount prefetchQuery calls (and mutations on the
  // tracking Set) keep running for up to 5s after teardown. Fired handles
  // self-remove before their callback runs so the Set stays bounded no matter
  // how long the dashboard stays open.
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const trackedTimeout = useCallback((fn: () => void, delay: number) => {
    // The callback deletes its own handle first, so fired timers never
    // accumulate; unmount clears whatever is still pending.
    const handle = setTimeout(() => {
      timersRef.current.delete(handle);
      fn();
    }, delay);
    timersRef.current.add(handle);
  }, []);

  // Utility function to safely prefetch queries
  const safePrefetch = useCallback(
    async (
      queries: FetchQueryOptions[],
      priority: "high" | "medium" | "low" = "medium",
    ) => {
      const delay =
        priority === "high" ? 0 : priority === "medium" ? 500 : 1000;

      const executePrefetch = async () => {
        const results = await Promise.allSettled(
          queries.map((query) => queryClient.prefetchQuery(query)),
        );

        // allSettled swallows rejections — the outer try/catch below never
        // sees these, so they must be captured here or they vanish entirely.
        results.forEach((result, index) => {
          if (result.status === "rejected") {
            if (process.env.NODE_ENV === "development") {
              console.warn(
                `Prefetch failed for query:`,
                queries[index].queryKey,
                result.reason,
              );
            }
            reportSentryError(result.reason, {
              subsystem: "client",
              expected: true,
              extra: { queryKey: queries[index].queryKey },
            });
          }
        });
      };

      // executePrefetch itself shouldn't throw (allSettled never rejects),
      // but the delayed branch is fire-and-forget, so guard against an
      // unhandled rejection if that assumption is ever wrong.
      const runPrefetch = () =>
        executePrefetch().catch((error) => {
          reportSentryError(error, {
            subsystem: "client",
            op: "safe-prefetch-unexpected",
          });
        });

      if (delay > 0) {
        trackedTimeout(runPrefetch, delay);
      } else {
        runPrefetch();
      }
    },
    [queryClient, trackedTimeout],
  );

  // Enhanced consultant dashboard prefetching
  const prefetchAllConsultantData = useCallback(async () => {
    if (
      !consultantId ||
      prefetchedRef.current.has(`consultant-${consultantId}`)
    ) {
      return;
    }

    prefetchedRef.current.add(`consultant-${consultantId}`);
    const queries = createConsultantQueries(consultantId);

    try {
      // Priority 1: Critical data (home, appointments, details)
      await safePrefetch(
        [
          queries.dashboard,
          queries.appointments,
          queries.details,
          staticQueries.help,
        ],
        "high",
      );

      // Priority 2: Secondary data (planner). The requests tab self-fetches
      // /api/bookings/* — the old dashboard requests bundle was dead weight
      // (data never read) and has been deleted.
      safePrefetch([queries.planner], "medium");
    } catch (error) {
      console.warn("Consultant data prefetching failed:", error);
      // Best-effort dashboard prefetch — the real useQuery on the actual
      // tab still fetches on demand. Reported for volume visibility only.
      reportSentryError(error, { subsystem: "client", expected: true });
    }
  }, [consultantId, safePrefetch]);

  // Enhanced consultee dashboard prefetching
  const prefetchAllConsulteeData = useCallback(async () => {
    if (!consulteeId || prefetchedRef.current.has(`consultee-${consulteeId}`)) {
      return;
    }

    prefetchedRef.current.add(`consultee-${consulteeId}`);
    const queries = createConsulteeQueries(consulteeId);

    try {
      // All consultee data has similar priority
      await safePrefetch(
        [queries.events, queries.feedback, queries.supportTickets],
        "high",
      );
    } catch (error) {
      console.warn("Consultee data prefetching failed:", error);
      // Best-effort dashboard prefetch — see the consultant twin above.
      reportSentryError(error, { subsystem: "client", expected: true });
    }
  }, [consulteeId, safePrefetch]);

  // Smart hover prefetching for specific tabs
  const prefetchOnTabHover = useCallback(
    (tabType: string) => {
      // Prevent excessive prefetching on rapid hover events
      const throttledPrefetch = (fn: () => void) => {
        const key = `hover-${tabType}`;
        if (prefetchedRef.current.has(key)) return;

        prefetchedRef.current.add(key);
        fn();

        // Clear throttle after 5 seconds
        trackedTimeout(() => prefetchedRef.current.delete(key), 5000);
      };

      throttledPrefetch(() => {
        if (consultantId) {
          const queries = createConsultantQueries(consultantId);

          switch (tabType) {
            case "home":
              safePrefetch([queries.dashboard], "high");
              break;
            case "appointments":
              safePrefetch([queries.appointments], "high");
              break;
            case "planner":
              safePrefetch([queries.planner], "high");
              break;
            default:
              // For other tabs, prefetch consultant details as fallback
              safePrefetch([queries.details], "medium");
          }
        }

        if (consulteeId) {
          const queries = createConsulteeQueries(consulteeId);

          switch (tabType) {
            case "home":
            case "appointments":
            case "history":
              safePrefetch([queries.events], "high");
              break;
            case "feedback":
              safePrefetch([queries.feedback], "high");
              break;
          }
        }
      });
    },
    [consultantId, consulteeId, safePrefetch, trackedTimeout],
  );

  // Auto-prefetch on hook initialization when aggressive prefetching is enabled
  useEffect(() => {
    if (!enableAggressivePrefetch) return;

    // Prefetch critical data immediately when component mounts; cancel the
    // idle callbacks if we unmount first.
    const cancels: Array<() => void> = [];
    if (consultantId) {
      cancels.push(schedulePrefetch(() => prefetchAllConsultantData()));
    }
    if (consulteeId) {
      cancels.push(schedulePrefetch(() => prefetchAllConsulteeData()));
    }
    return () => cancels.forEach((cancel) => cancel());
  }, [
    consultantId,
    consulteeId,
    enableAggressivePrefetch,
    prefetchAllConsultantData,
    prefetchAllConsulteeData,
  ]);

  // Cleanup on unmount: cancel outstanding prefetch/throttle timers and clear
  // the prefetch-tracking set.
  useEffect(() => {
    const trackedSet = prefetchedRef.current;
    const timers = timersRef.current;
    return () => {
      timers.forEach((handle) => clearTimeout(handle));
      timers.clear();
      trackedSet.clear();
    };
  }, [trackedTimeout]);

  return {
    prefetchAllConsultantData,
    prefetchAllConsulteeData,
    prefetchOnTabHover,
    // Legacy compatibility
    prefetchConsultantDashboard: prefetchAllConsultantData,
    prefetchConsulteeEvents: prefetchAllConsulteeData,
  };
}
