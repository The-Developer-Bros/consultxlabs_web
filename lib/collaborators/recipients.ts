import prisma, { type PrismaLike } from "@/lib/prisma";

type PlanType = "webinar" | "class";

/**
 * #1580 C-P1-5 — the user ids of a plan's ACCEPTED collaborators, for the
 * recipient lists of booking, cancellation, reschedule, reminder and
 * moderation-cancel sends. Only webinar and class plans carry any. A
 * soft-deleted (erased) profile is never a recipient. Its own module so the
 * money and cron paths do not load the service's Stream and Novu graph.
 */
export async function collaboratorUserIds(
  planType: PlanType,
  planId: string,
  db: PrismaLike = prisma,
): Promise<string[]> {
  const rows = await db.collaborator.findMany({
    where: {
      ...(planType === "webinar"
        ? { webinarPlanId: planId }
        : { classPlanId: planId }),
      status: "ACCEPTED",
      consultantProfile: { deletedAt: null },
    },
    select: { consultantProfile: { select: { userId: true } } },
  });
  return [...new Set(rows.map((row) => row.consultantProfile.userId))];
}

/** The same set keyed by an event (Webinar / Class row) rather than its plan. */
export async function collaboratorUserIdsForEvent(
  planType: PlanType,
  eventId: string,
  db: PrismaLike = prisma,
): Promise<string[]> {
  const rows = await db.collaborator.findMany({
    where: {
      ...(planType === "webinar"
        ? { webinarPlan: { webinars: { some: { id: eventId } } } }
        : { classPlan: { classes: { some: { id: eventId } } } }),
      status: "ACCEPTED",
      consultantProfile: { deletedAt: null },
    },
    select: { consultantProfile: { select: { userId: true } } },
  });
  return [...new Set(rows.map((row) => row.consultantProfile.userId))];
}
