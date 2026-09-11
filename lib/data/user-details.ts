import prisma from "@/lib/prisma";

/**
 * The logged-in user's own record, as the dashboard layout consumes it.
 *
 * Extracted from GET /api/user/[id] so the server layout can PREFETCH it. The
 * consultant dashboard layout is a client component that returns
 * `PersonalDashboardShellSkeleton` instead of `children` while its queries are
 * loading — always true during SSR — so no dashboard markup reached the HTML
 * at all (measured on #1103: no `<h1`, no nav, FCP ~6s). Hydrating this query
 * is enough to open that gate, because the guard is
 * `(...loading) && !consultantData && !userDetails`.
 *
 * Deliberately NOT the consultant-details query, which carries public/private
 * access levels, #726 plan-visibility filtering and PII narrowing — replicating
 * that for a prefetch is how #946 happened. This one is the viewer's own row.
 *
 * Callers MUST authorize first: the route checks `session.user.id === id ||
 * ADMIN`, and the layout only ever asks for the session user's own id.
 */
export function getUserDetails(id: string) {
  return prisma.user.findUnique({
    where: { id: id },
    include: {
      // Professional background at User level
      workExperiences: {
        orderBy: [{ isCurrent: "desc" }, { startDate: "desc" }],
      },
      education: {
        orderBy: { endYear: "desc" },
      },
      certifications: {
        orderBy: { issueDate: "desc" },
      },
      consultantProfile: {
        select: {
          id: true,
          description: true,
          experience: true,
          rating: true,
          domainId: true,
          // New fields
          headline: true,
          websiteUrl: true,
          twitterUrl: true,
          githubUrl: true,
          videoIntroUrl: true,
          languages: true,
          toolsAndTechnologies: true,
          mentoringStyle: true,
          sessionTypes: true,
          profileCompletionPercentage: true,
          isVerified: true,
          totalMenteesHelped: true,
        },
      },
      consulteeProfile: {
        select: {
          id: true,
          aboutMe: true,
          preferredLanguage: true,
          goals: true,
          careerStage: true,
          skillsToDevelop: true,
          budgetPreference: true,
        },
      },
      staffProfile: {
        select: {
          id: true,
          department: true,
          position: true,
        },
      },
      adminProfile: {
        select: {
          id: true,
          notes: true,
        },
      },
    },
  });
}
