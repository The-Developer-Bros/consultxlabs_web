"use client";

import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { reportSentryError } from "@/lib/observability/report";
import { useSession } from "@/lib/auth-client";

/** Re-render on the browser's own connectivity events, so `enabled` can't latch. */
function subscribeToConnectivity(notify: () => void): () => void {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
}

/**
 * Auto-syncs the current user as a Novu subscriber.
 * Called once per dashboard session. Uses a long staleTime to avoid repeat calls.
 */
export function useNovuSubscriberSync() {
  const { data: session } = useSession();

  // React Query's `networkMode: "online"` already pauses a fetch while offline,
  // but its `onlineManager` starts at `online = true` and only ever flips on the
  // window online/offline EVENTS — it never reads `navigator.onLine`. So a tab
  // opened while already offline sails past that guard and fires the request,
  // which is one of the ways this hook produced `TypeError: Failed to fetch`
  // (FAMILIARISE_WEB-1D). Reading the flag directly closes that opening.
  const isOnline = useSyncExternalStore(
    subscribeToConnectivity,
    () => navigator.onLine !== false,
    () => true,
  );

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
        // No status at all means the request never got an answer: a dropped
        // connection, a tab navigating away mid-flight, a captive portal. React
        // Query retries it and nothing user-visible breaks, so it is noise
        // rather than a fault and used to page as `TypeError: Failed to fetch`
        // at error level (FAMILIARISE_WEB-1D). A real answer still reports:
        // 4xx is a modelled outcome, 5xx is worth alerting on even though the
        // retry papers over it.
        if (typeof httpStatus === "number") {
          reportSentryError(error, {
            subsystem: "novu",
            op: "subscriber.sync",
            expected: httpStatus >= 400 && httpStatus < 500,
            level: "warning",
            extra: { httpStatus },
          });
        }
        throw error;
      }
    },
    enabled:
      isOnline && !!session?.user?.id && !!process.env.NEXT_PUBLIC_NOVU_APP_ID,
    staleTime: 30 * 60 * 1000, // 30 minutes
    gcTime: 60 * 60 * 1000, // 1 hour
    retry: 1,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
}
