import { cache } from "react";
import prisma from "@/lib/prisma";
import { toPlain } from "@/lib/data/serialize";
import { consultantPublicScalars } from "@/lib/data/consultant-public";

/**
 * Server-side data access for the four plan detail pages.
 *
 * Exports two flavors of each function:
 *  - Raw (e.g. fetchWebinarPlanDetail) — pure Prisma, no cache. Used by API routes.
 *  - Cached (e.g. getWebinarPlanDetail)  — React.cache() wrapper. Used by Server Components.
 */

// ---------------------------------------------------------------------------
// Webinar plan detail
// ---------------------------------------------------------------------------

/** Raw function — importable by API routes (no React.cache). */
export async function fetchWebinarPlanDetail(webinarPlanId: string) {
  const plan = await prisma.webinarPlan.findUnique({
    where: {
      id: webinarPlanId,
      // #781 §B — soft-deleted profiles leave public surfaces; owner relation
      // is nullable, so only plans with a soft-deleted owner become not-found.
      OR: [
        { consultantProfile: null },
        { consultantProfile: { deletedAt: null } },
      ],
    },
    include: {
      consultantProfile: {
        select: {
          ...consultantPublicScalars,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
              workExperiences: {
                select: { company: true, companyDomain: true, isCurrent: true },
                orderBy: [
                  { isCurrent: "desc" as const },
                  { startDate: "desc" as const },
                ],
                take: 3,
              },
            },
          },
          domain: true,
          subDomains: true,
          tags: true,
        },
      },
      webinars: {
        include: {
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: {
                    select: { id: true },
                  },
                },
              },
            },
          },
        },
      },
      topics: true,
      faqs: { orderBy: { order: "asc" } },
      collaborators: {
        where: { status: "ACCEPTED" as const },
        include: {
          consultantProfile: {
            select: {
              ...consultantPublicScalars,
              user: {
                select: { id: true, name: true, image: true },
              },
            },
          },
        },
      },
    },
  });
  // toPlain — extended plan rows carry an inspect symbol (see serialize.ts)
  return toPlain(plan);
}

/** Cached wrapper for Server Components. */
export const getWebinarPlanDetail = cache(fetchWebinarPlanDetail);

// ---------------------------------------------------------------------------
// Class plan detail
// ---------------------------------------------------------------------------

/** Raw function — importable by API routes (no React.cache). */
export async function fetchClassPlanDetail(classPlanId: string) {
  const plan = await prisma.classPlan.findUnique({
    where: {
      id: classPlanId,
      // #781 §B — soft-deleted profiles leave public surfaces; owner relation
      // is nullable, so only plans with a soft-deleted owner become not-found.
      OR: [
        { consultantProfile: null },
        { consultantProfile: { deletedAt: null } },
      ],
    },
    include: {
      consultantProfile: {
        select: {
          ...consultantPublicScalars,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
              workExperiences: {
                select: { company: true, companyDomain: true, isCurrent: true },
                orderBy: [
                  { isCurrent: "desc" as const },
                  { startDate: "desc" as const },
                ],
                take: 3,
              },
            },
          },
          domain: true,
          subDomains: true,
          tags: true,
        },
      },
      classes: {
        include: {
          appointments: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: {
                    select: { id: true },
                  },
                },
              },
            },
          },
        },
      },
      topics: true,
      faqs: { orderBy: { order: "asc" } },
      classContents: { orderBy: { order: "asc" } },
      collaborators: {
        where: { status: "ACCEPTED" as const },
        include: {
          consultantProfile: {
            select: {
              ...consultantPublicScalars,
              user: {
                select: { id: true, name: true, image: true },
              },
            },
          },
        },
      },
    },
  });
  // toPlain — extended plan rows carry an inspect symbol (see serialize.ts)
  return toPlain(plan);
}

/** Cached wrapper for Server Components. */
export const getClassPlanDetail = cache(fetchClassPlanDetail);

// ---------------------------------------------------------------------------
// Subscription plan detail
// ---------------------------------------------------------------------------

/**
 * Owner select shared by the subscription and consultation fetchers.
 *
 * Both are 1:1 products whose owner relation is REQUIRED (unlike webinar and
 * class, where an org can own a plan with no consultant), so neither needs the
 * nullable-owner branch the other two carry.
 */
const planOwnerSelect = {
  select: {
    ...consultantPublicScalars,
    user: {
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        workExperiences: {
          select: { company: true, companyDomain: true, isCurrent: true },
          orderBy: [
            { isCurrent: "desc" as const },
            { startDate: "desc" as const },
          ],
          take: 3,
        },
      },
    },
    domain: true,
    subDomains: true,
    tags: true,
  },
};

/** Raw function — importable by API routes (no React.cache). */
export async function fetchSubscriptionPlanDetail(subscriptionPlanId: string) {
  const plan = await prisma.subscriptionPlan.findUnique({
    where: {
      id: subscriptionPlanId,
      // #781 §B — a soft-deleted owner takes the plan off public surfaces.
      consultantProfile: { deletedAt: null },
    },
    include: {
      consultantProfile: planOwnerSelect,
      topics: true,
      faqs: { orderBy: { order: "asc" } },
      subscriptionContents: { orderBy: { order: "asc" } },
      materials: { orderBy: { order: "asc" } },
    },
  });
  // toPlain — extended plan rows carry an inspect symbol (see serialize.ts)
  return toPlain(plan);
}

/** Cached wrapper for Server Components. */
export const getSubscriptionPlanDetail = cache(fetchSubscriptionPlanDetail);

// ---------------------------------------------------------------------------
// Consultation plan detail
// ---------------------------------------------------------------------------

/** Raw function — importable by API routes (no React.cache). */
export async function fetchConsultationPlanDetail(consultationPlanId: string) {
  const plan = await prisma.consultationPlan.findUnique({
    where: {
      id: consultationPlanId,
      consultantProfile: { deletedAt: null },
    },
    include: {
      consultantProfile: planOwnerSelect,
      topics: true,
      faqs: { orderBy: { order: "asc" } },
      materials: { orderBy: { order: "asc" } },
    },
  });
  return toPlain(plan);
}

/** Cached wrapper for Server Components. */
export const getConsultationPlanDetail = cache(fetchConsultationPlanDetail);
