"use client";

import { useQuery } from "@tanstack/react-query";
import type { ProgramType, TopicWithCount } from "@/lib/explore/programs";
import { fetchTopics } from "./_helpers";

/**
 * Fetch the topic-with-count list for the category grid.
 *
 * Accepts an optional `initialData` so the RSC `page.tsx` can pre-warm
 * the React Query cache for the default `planType === "all"` query key.
 */
export function useTopicsWithCount(
  planType: ProgramType = "all",
  initialData?: TopicWithCount[],
) {
  const { data, isLoading } = useQuery({
    queryKey: ["topics-with-count", planType],
    initialData,
    queryFn: async () => {
      const res = await fetchTopics(
        `/api/topics?withProgramCount=true&planType=${planType}`,
      );
      return res.data || [];
    },
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  return { topics: data || [], isLoading };
}
