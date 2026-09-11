"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  isUserEnrolled,
  isUserRegisteredForWebinar,
} from "@/lib/payments/utils/participants";
import {
  ITEMS_PER_PAGE,
  generateProgramImageUrl,
  type Program,
  type ProgramType,
  type ProgramFilters,
  type ClassPlanProgram,
  type WebinarPlanProgram,
} from "@/lib/explore/programs";
import {
  buildFilterParams,
  fetchPlans,
  type ClassPlanApiItem,
  type WebinarPlanApiItem,
} from "./_helpers";

interface UseProgramsOptions {
  userId?: string | null;
  filters?: ProgramFilters;
}

/**
 * Infinite query for the main "All Programs" listing on the explore
 * programs page. Combines class plans and webinar plans into a single
 * `Program[]` and tracks pagination metadata across both endpoints.
 */
export function usePrograms(
  programType: ProgramType,
  options: UseProgramsOptions = {},
) {
  const { userId, filters = {} } = options;
  const includeRegistration = !!userId;
  const filterStr = buildFilterParams(filters);

  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isLoading,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["programs", programType, userId, filterStr],
    queryFn: async ({ pageParam = 0 }) => {
      const requests = [];

      const registrationParam = includeRegistration
        ? "&includeRegistration=true"
        : "";

      if (programType === "all" || programType === "class") {
        requests.push(
          `/api/plans/classes?page=${pageParam + 1}&limit=${ITEMS_PER_PAGE}&include=classes${registrationParam}${filterStr}`,
        );
      }
      if (programType === "all" || programType === "webinar") {
        requests.push(
          `/api/plans/webinars?page=${pageParam + 1}&limit=${ITEMS_PER_PAGE}${registrationParam}${filterStr}`,
        );
      }

      const responses = await Promise.all(
        requests.map((url) => fetchPlans(url)),
      );

      let combinedPrograms: Program[] = [];
      let classMeta, webinarMeta;

      if ((programType === "all" || programType === "class") && responses[0]) {
        const classResponse = responses[0];
        classMeta = classResponse.meta;
        if (classResponse.data) {
          const formattedClasses = classResponse.data.map(
            (plan): ClassPlanProgram => {
              const typedPlan = plan as ClassPlanApiItem;
              const classes = typedPlan.classes || [];
              const appointments = classes.flatMap(
                (c) => c.appointments ?? [],
              );
              const isRegistered =
                userId && appointments.length > 0
                  ? isUserEnrolled(appointments, userId)
                  : false;

              return {
                ...typedPlan,
                classes,
                type: "class",
                imageUrl: generateProgramImageUrl(
                  typedPlan.id,
                  600,
                  400,
                  typedPlan.imageUrl,
                ),
                isRegistered,
              } as ClassPlanProgram;
            },
          );
          combinedPrograms = [...combinedPrograms, ...formattedClasses];
        }
      }

      if (programType === "all" || programType === "webinar") {
        const webinarResponseIndex = programType === "all" ? 1 : 0;
        if (responses[webinarResponseIndex]) {
          const webinarResponse = responses[webinarResponseIndex];
          webinarMeta = webinarResponse.meta;
          if (webinarResponse.data) {
            const formattedWebinars = webinarResponse.data.map(
              (plan): WebinarPlanProgram => {
                const typedPlan = plan as WebinarPlanApiItem;
                const webinars = typedPlan.webinars || [];
                const isRegistered =
                  userId && webinars.length > 0
                    ? isUserRegisteredForWebinar(webinars, userId)
                    : false;

                return {
                  ...typedPlan,
                  webinars,
                  type: "webinar",
                  imageUrl: generateProgramImageUrl(
                    typedPlan.id,
                    600,
                    400,
                    typedPlan.imageUrl,
                  ),
                  isRegistered,
                } as WebinarPlanProgram;
              },
            );
            combinedPrograms = [...combinedPrograms, ...formattedWebinars];
          }
        }
      }

      return { programs: combinedPrograms, classMeta, webinarMeta };
    },
    getNextPageParam: (lastPage, pages) => {
      let hasMoreClasses = false;
      let hasMoreWebinars = false;

      if (programType === "all" || programType === "class") {
        if (lastPage.classMeta) {
          hasMoreClasses =
            lastPage.classMeta.page < lastPage.classMeta.totalPages;
        } else if (lastPage.programs?.some((p) => p.type === "class")) {
          const classesInLastFetch = lastPage.programs.filter(
            (p) => p.type === "class",
          ).length;
          hasMoreClasses = classesInLastFetch >= ITEMS_PER_PAGE;
        }
      }

      if (programType === "all" || programType === "webinar") {
        if (lastPage.webinarMeta) {
          hasMoreWebinars =
            lastPage.webinarMeta.page < lastPage.webinarMeta.totalPages;
        } else if (lastPage.programs?.some((p) => p.type === "webinar")) {
          const webinarsInLastFetch = lastPage.programs.filter(
            (p) => p.type === "webinar",
          ).length;
          hasMoreWebinars = webinarsInLastFetch >= ITEMS_PER_PAGE;
        }
      }

      const hasMore =
        programType === "class"
          ? hasMoreClasses
          : programType === "webinar"
            ? hasMoreWebinars
            : hasMoreClasses || hasMoreWebinars;

      return hasMore ? pages.length : undefined;
    },
    initialPageParam: 0,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
  });

  const programs = useMemo(
    () => (data ? data.pages.map((d) => d.programs).flat() : []),
    [data],
  );

  return {
    programs,
    error,
    isLoading: isLoading || isFetchingNextPage,
    hasMore: hasNextPage ?? false,
    loadMore: () => fetchNextPage(),
  };
}
