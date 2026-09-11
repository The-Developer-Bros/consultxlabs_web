import { unstable_cache } from "next/cache";
import prisma from "@/lib/prisma";
import { readByIds } from "@/lib/data/read-by-ids";
import { toPlain } from "@/lib/data/serialize";
import type { Prisma } from "@prisma/client";
import { eventPlanDiscoverableWhere } from "@/lib/api/plans/visibility";
import { generateProgramImageUrl } from "@/lib/explore/programs";
import type {
  Program,
  ClassPlanProgram,
  WebinarPlanProgram,
  ProgramType,
  TopicWithCount,
} from "@/lib/explore/programs";

/**
 * Server-side data access for the explore programs page.
 *
 * Mirrors lib/data/explore-experts.ts pattern:
 *  - Cached functions for Server Components (curated sections)
 *  - Client hooks in app/explore/programs/hooks.ts handle infinite scroll
 */

/** Shared select for consultant profile in plan queries.
 *
 * Public explore-programs surface — explicit `select` (not bare `include`) so
 * we (a) never leak India statutory PII (panNumber, ibanOrAccount, swiftBic,
 * residencyStatus, etc.) into a client component, and (b) avoid the
 * "Decimal cannot be passed to Client Components" runtime error from
 * `tdsRate: Decimal?`. Mirrors the `ProgramConsultantProfile` shape in
 * app/explore/programs/utils.ts. */
const planConsultantInclude = {
  select: {
    rating: true,
    headline: true,
    user: {
      select: {
        name: true,
        image: true,
        workExperiences: {
          select: {
            company: true,
            companyDomain: true,
            isCurrent: true,
          },
          take: 3,
        },
      },
    },
  },
};

// #781 §B — soft-deleted profiles leave public surfaces. The owner relation is
// nullable on Webinar/ClassPlan, so keep ownerless plans and drop only plans
// whose owner is soft-deleted.
const liveConsultantWhere = {
  OR: [{ consultantProfile: null }, { consultantProfile: { deletedAt: null } }],
} satisfies Prisma.ClassPlanWhereInput & Prisma.WebinarPlanWhereInput;

// ---------------------------------------------------------------------------
// Curated programs (Featured / Trending / Newest sections)
// ---------------------------------------------------------------------------

/**
 * Trending rank step 1: last-30-day slot count per plan.
 *
 * ORM read + JS tally (no raw SQL). The earlier shape nested classes →
 * appointments → slots under every marketplace plan, so the cost scaled with
 * plans × their whole slot history. Instead read the two sides independently:
 * the discoverable plan ids, and only slots created in the window. The tally is
 * a single pass over that bounded set. Plans with no recent activity keep a
 * count of 0 and stay in the ranking — dropping them empties the Trending row
 * in a quiet window.
 *
 * The scan is shared across requests for 60s via unstable_cache; the cached
 * value is the FULL ranked id array (callers slice — passing limit as an arg
 * would key separate entries). Staleness is harmless: trending order changing
 * 60s late is invisible.
 */
/** Slot window shared by both plan families. */
const recentSlotWindow = () => {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  return { deletedAt: null, createdAt: { gte: thirtyDaysAgo } } as const;
};

/**
 * Tally plan ids, then order plans by that count. Plans absent from the tally
 * score 0 and keep their place — dropping them empties the Trending row.
 */
function rankPlansByCount(
  plans: { id: string; createdAt: Date }[],
  planIds: (string | null | undefined)[],
): string[] {
  const counts = new Map<string, number>();
  for (const id of planIds) {
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return plans
    .sort(
      (a, b) =>
        (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    )
    .map((p) => p.id);
}

const getTrendingClassPlanIds = unstable_cache(
  async (): Promise<string[]> => {
    const [plans, slots] = await Promise.all([
      prisma.classPlan.findMany({
        where: { ...eventPlanDiscoverableWhere(), ...liveConsultantWhere }, // #726
        select: { id: true, createdAt: true },
      }),
      prisma.slotOfAppointment.findMany({
        where: {
          ...recentSlotWindow(),
          appointment: { deletedAt: null, classId: { not: null } },
        },
        select: {
          appointment: { select: { class: { select: { classPlanId: true } } } },
        },
      }),
    ]);
    return rankPlansByCount(
      plans,
      slots.map((s) => s.appointment?.class?.classPlanId),
    );
  },
  ["trending-class-plan-ids"],
  { revalidate: 60 },
);

const getTrendingWebinarPlanIds = unstable_cache(
  async (): Promise<string[]> => {
    const [plans, slots] = await Promise.all([
      prisma.webinarPlan.findMany({
        where: { ...eventPlanDiscoverableWhere(), ...liveConsultantWhere }, // #726
        select: { id: true, createdAt: true },
      }),
      prisma.slotOfAppointment.findMany({
        where: {
          ...recentSlotWindow(),
          appointment: { deletedAt: null, webinarId: { not: null } },
        },
        select: {
          appointment: {
            select: { webinar: { select: { webinarPlanId: true } } },
          },
        },
      }),
    ]);
    return rankPlansByCount(
      plans,
      slots.map((s) => s.appointment?.webinar?.webinarPlanId),
    );
  },
  ["trending-webinar-plan-ids"],
  { revalidate: 60 },
);

/**
 * Fetch curated programs for server-rendered sections.
 * Combines class plans + webinar plans, normalizes into Program[].
 */
export const getCuratedPrograms = unstable_cache(
  async (
    programType: ProgramType,
    sort: "trending" | "newest",
    limit: number = 8,
  ): Promise<Program[]> => {
    const programs: Program[] = [];

    // Build orderBy for non-trending sorts
    const orderBy =
      sort === "newest" ? { createdAt: "desc" as const } : undefined;

    // Fetch class plans
    if (programType === "all" || programType === "class") {
      let classPlans;

      if (sort === "trending") {
        // Trending: rank by recent enrollment count (last 30 days) — the
        // ranking scan is shared across requests via unstable_cache above.
        // The cache holds the FULL ranked list (no limit arg): unstable_cache
        // keys include fn args, so per-limit entries would each pay the scan;
        // slicing here lets every caller share one entry.
        const sortedIds = (await getTrendingClassPlanIds()).slice(0, limit);

        // No enrollments in the window means no ranked ids — see readByIds for
        // why that is not free. (#1121)
        classPlans = await readByIds(sortedIds, () =>
          prisma.classPlan.findMany({
            where: {
              id: { in: sortedIds },
              ...eventPlanDiscoverableWhere(),
              ...liveConsultantWhere,
            }, // #726
            include: {
              consultantProfile: planConsultantInclude,
              topics: true,
              classContents: true,
              classes: true,
            },
          }),
        );

        // Re-sort to match ranking order
        const idOrder = new Map(sortedIds.map((id, i) => [id, i]));
        classPlans.sort(
          (a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0),
        );
      } else {
        classPlans = await prisma.classPlan.findMany({
          where: { ...eventPlanDiscoverableWhere(), ...liveConsultantWhere }, // #726
          include: {
            consultantProfile: planConsultantInclude,
            topics: true,
            classContents: true,
            classes: true,
          },
          ...(orderBy && { orderBy }),
          take: limit,
        });
      }

      programs.push(
        ...classPlans.map(
          (plan): ClassPlanProgram => ({
            ...plan,
            classes: plan.classes || [],
            type: "class",
            imageUrl: generateProgramImageUrl(plan.id, 600, 400, plan.imageUrl),
          }),
        ),
      );
    }

    // Fetch webinar plans
    if (programType === "all" || programType === "webinar") {
      let webinarPlans;

      if (sort === "trending") {
        // Shared 60s ranking cache — full list, sliced per caller (see the
        // class-plan twin above for why no limit arg).
        const sortedIds = (await getTrendingWebinarPlanIds()).slice(0, limit);

        // Empty-`in` guard, same reasoning as the class-plan twin above. (#1121)
        webinarPlans = await readByIds(sortedIds, () =>
          prisma.webinarPlan.findMany({
            where: {
              id: { in: sortedIds },
              ...eventPlanDiscoverableWhere(),
              ...liveConsultantWhere,
            }, // #726
            include: {
              consultantProfile: planConsultantInclude,
              topics: true,
            },
          }),
        );

        const idOrder = new Map(sortedIds.map((id, i) => [id, i]));
        webinarPlans.sort(
          (a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0),
        );
      } else {
        webinarPlans = await prisma.webinarPlan.findMany({
          where: { ...eventPlanDiscoverableWhere(), ...liveConsultantWhere }, // #726
          include: {
            consultantProfile: planConsultantInclude,
            topics: true,
          },
          ...(orderBy && { orderBy }),
          take: limit,
        });
      }

      programs.push(
        ...webinarPlans.map(
          (plan): WebinarPlanProgram => ({
            ...plan,
            webinars: [],
            type: "webinar",
            imageUrl: generateProgramImageUrl(plan.id, 600, 400, plan.imageUrl),
          }),
        ),
      );
    }

    // For newest with combined results, re-sort by createdAt
    if (sort === "newest" && programType === "all") {
      programs.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    }

    // toPlain — extended plan rows carry an inspect symbol (see serialize.ts)
    return toPlain(programs.slice(0, limit));
  },
  ["curated-programs"],
  { revalidate: 120, tags: ["programs"] },
);

// ---------------------------------------------------------------------------
// Topics with program counts (for category grid)
// ---------------------------------------------------------------------------

export const getTopicsWithCount = unstable_cache(
  async (planType: ProgramType = "all"): Promise<TopicWithCount[]> => {
    const topics = await prisma.topic.findMany({
      include: {
        _count: {
          select: {
            // #726 — category counts must exclude ORG_ONLY plans too
            // #781 §B — and plans whose owner is soft-deleted
            ...(planType === "all" || planType === "class"
              ? {
                  classPlans: {
                    where: {
                      ...eventPlanDiscoverableWhere(),
                      ...liveConsultantWhere,
                    },
                  },
                }
              : {}),
            ...(planType === "all" || planType === "webinar"
              ? {
                  webinarPlans: {
                    where: {
                      ...eventPlanDiscoverableWhere(),
                      ...liveConsultantWhere,
                    },
                  },
                }
              : {}),
          },
        },
      },
      orderBy: { name: "asc" },
    });

    return topics
      .map((topic) => {
        const count = topic._count;
        let programCount = 0;
        if (planType === "class") {
          programCount = count.classPlans ?? 0;
        } else if (planType === "webinar") {
          programCount = count.webinarPlans ?? 0;
        } else {
          programCount = (count.classPlans ?? 0) + (count.webinarPlans ?? 0);
        }
        return { id: topic.id, name: topic.name, programCount };
      })
      .filter((t) => t.programCount > 0)
      .sort((a, b) => b.programCount - a.programCount);
  },
  ["topics-with-count"],
  { revalidate: 300, tags: ["programs"] },
);
