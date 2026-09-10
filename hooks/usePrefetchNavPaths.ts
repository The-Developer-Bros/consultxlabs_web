"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { schedulePrefetch } from "@/lib/dashboard-queries";

/**
 * Warm the RSC payloads for a shell's top nav destinations.
 *
 * Without this, the first click on any tab waits a full RSC round trip once
 * the client Router Cache window (`staleTimes.dynamic`, 30s) has lapsed —
 * most visible on org/org-workspace trees whose ~20 sidebar links previously
 * had no warming at all (admin/staff did this via OperatorDashboardShell).
 *
 * `router.prefetch` performs a partial prefetch (up to the nearest
 * loading.tsx boundary), so this warms chrome + skeletons cheaply on idle;
 * page data still streams on click per its own caching config.
 *
 * Idempotent per mount: keyed on the joined path list, cancelled on unmount
 * via `schedulePrefetch`'s cancel function (#1242).
 */
export function usePrefetchNavPaths(paths: string[], delay = 3000): void {
  const router = useRouter();
  // Dedupe: callers may build lists programmatically; a repeated path would
  // otherwise schedule duplicate router.prefetch calls.
  const prefetchKey = [...new Set(paths)].join("|");

  useEffect(() => {
    if (!prefetchKey) return;
    const targets = prefetchKey.split("|");
    const cancel = schedulePrefetch(() => {
      // App Router dedupes concurrent prefetches for the same path.
      targets.forEach((p) => router.prefetch(p));
    }, delay);
    return cancel;
  }, [prefetchKey, router, delay]);
}
