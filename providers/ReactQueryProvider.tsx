"use client";

import React, { useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  defaultShouldDehydrateQuery,
} from "@tanstack/react-query";

// Factory so every server request gets its OWN client. A module-scope
// singleton on the server is shared across concurrent requests, so one
// user's cached query data can hydrate into another user's SSR render.
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000, // 1 minute
        gcTime: 5 * 60 * 1000, // 5 minutes (renamed from cacheTime in v5)
        retry: 2,
        // Cache-first navigation (perf RCA): the old global `true` refired
        // every mounted query on each window focus — returning to the tab
        // felt like a full reload.
        //
        // Surfaces that genuinely need freshness now opt back in per-query
        // with refetchOnWindowFocus:true — the admin home / approval-payments
        // / processing-payouts screens and PendingPaymentsWidget. They used to
        // run background refetchIntervals instead, which refreshed for nobody
        // whenever a tab sat open. Note BOTH flags below are off, so a query
        // that opts into neither never refreshes after its first load.
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        refetchOnReconnect: "always",
      },
      // Never auto-retry mutations — payment/booking writes must not silently re-fire.
      mutations: {
        retry: 0,
      },
      // Also dehydrate in-flight queries so RSC-prefetched data hydrates the client.
      dehydrate: {
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) ||
          query.state.status === "pending",
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
  if (typeof window === "undefined") {
    // Server: always a fresh client, never shared across requests.
    return makeQueryClient();
  }
  // Browser: reuse one client so React doesn't recreate it on suspense.
  if (!browserQueryClient) browserQueryClient = makeQueryClient();
  return browserQueryClient;
}

interface ReactQueryProviderProps {
  children: React.ReactNode;
}

export default function ReactQueryProvider({
  children,
}: ReactQueryProviderProps) {
  const [queryClient] = useState(getQueryClient);

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
