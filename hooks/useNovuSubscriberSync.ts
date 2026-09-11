"use client";

import { useQuery } from "@tanstack/react-query";
import { reportSentryError } from "@/lib/observability/report";
import { useSession } from "@/lib/auth-client";

/**
 * Auto-syncs the current user as a Novu subscriber.
 * Called once per dashboard session. Uses a long staleTime to avoid repeat calls.
 */
export function useNovuSubscriberSync() {
  const { data: session } = useSession();

  return useQuery({
    queryKey: ["novu-subscriber-sync", session?.user?.id],
    queryFn: async () => {
      try {
        const res = await fetch("/api/novu/subscriber", { method: "POST" });
        if (!res.ok) {
          // Carry the status so the catch can tell a 4xx business answer from
          // a real 5xx/network fault instead of tagging every failure expected.
          throw Object.assign(new Error("Failed to sync Novu subscriber"), {
            httpStatus: res.status,
          });
        }
        return await res.json();
      } catch (error) {
        const httpStatus =
          error && typeof error === "object" && "httpStatus" in error
            ? (error as { httpStatus?: number }).httpStatus
            : undefined;
        const expected =
          typeof httpStatus === "number" && httpStatus >= 400 && httpStatus < 500;
        // React Query retries this (retry: 1); a failed sync just delays
        // the subscriber row, nothing user-visible breaks. A 5xx/network
        // fault is still worth alerting on even though retry papers over it.
        reportSentryError(error, {
          subsystem: "novu",
          expected,
          extra: { httpStatus },
        });
        throw error;
      }
    },
    enabled: !!session?.user?.id && !!process.env.NEXT_PUBLIC_NOVU_APP_ID,
    staleTime: 30 * 60 * 1000, // 30 minutes
    gcTime: 60 * 60 * 1000, // 1 hour
    retry: 1,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
}
