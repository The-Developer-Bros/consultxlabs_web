"use client";

import { useQuery } from "@tanstack/react-query";
import {
  generateProgramImageUrl,
  type Program,
  type ProgramType,
  type ClassPlanProgram,
  type WebinarPlanProgram,
} from "@/lib/explore/programs";
import {
  fetchPlans,
  type ClassPlanApiItem,
  type PlanApiResponse,
  type WebinarPlanApiItem,
} from "./_helpers";

/**
 * Fetch a small curated set of programs for the trending / newest rows
 * on the explore programs page.
 *
 * Accepts an optional `initialData` so the RSC `page.tsx` can pre-warm
 * the React Query cache for the default `programType === "all"` query
 * key — first paint after navigation no longer waits on a client fetch.
 * Tab switches still trigger normal client refetches.
 */
export function useCuratedPrograms(
  programType: ProgramType,
  sort: string,
  limit: number = 8,
  initialData?: Program[],
) {
  const { data, isLoading } = useQuery({
    queryKey: ["curated-programs", programType, sort, limit],
    initialData,
    queryFn: async () => {
      const requests: Promise<PlanApiResponse>[] = [];

      if (programType === "all" || programType === "class") {
        requests.push(
          fetchPlans(
            `/api/plans/classes?page=1&limit=${limit}&include=classes&sort=${sort}`,
          ),
        );
      }
      if (programType === "all" || programType === "webinar") {
        requests.push(
          fetchPlans(`/api/plans/webinars?page=1&limit=${limit}&sort=${sort}`),
        );
      }

      const responses = await Promise.all(requests);
      const programs: Program[] = [];

      if (
        (programType === "all" || programType === "class") &&
        responses[0]?.data
      ) {
        programs.push(
          ...responses[0].data.map((plan): ClassPlanProgram => {
            const typedPlan = plan as ClassPlanApiItem;
            return {
              ...typedPlan,
              classes: typedPlan.classes || [],
              type: "class",
              imageUrl: generateProgramImageUrl(
                typedPlan.id,
                600,
                400,
                typedPlan.imageUrl,
              ),
            } as ClassPlanProgram;
          }),
        );
      }

      const webIdx = programType === "all" ? 1 : 0;
      if (
        (programType === "all" || programType === "webinar") &&
        responses[webIdx]?.data
      ) {
        programs.push(
          ...responses[webIdx].data.map((plan): WebinarPlanProgram => {
            const typedPlan = plan as WebinarPlanApiItem;
            return {
              ...typedPlan,
              webinars: typedPlan.webinars || [],
              type: "webinar",
              imageUrl: generateProgramImageUrl(
                typedPlan.id,
                600,
                400,
                typedPlan.imageUrl,
              ),
            } as WebinarPlanProgram;
          }),
        );
      }

      // For trending, re-sort combined results; for newest, sort by createdAt
      if (sort === "newest") {
        programs.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
      }

      return programs.slice(0, limit);
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  });

  return { programs: data || [], isLoading };
}
