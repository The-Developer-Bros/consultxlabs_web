import prisma from "../../lib/prisma";
import { config } from "./config";

/**
 * Authored-but-not-live group sessions — WebinarStatus/ClassStatus DRAFT.
 *
 * A draft is defined by the absence of a session, not by a flag: the authoring
 * route creates the instance without an appointment when no scheduled time was
 * given, and DRAFT is what keeps that half-written offering off the marketplace
 * and out of every detail page but the owner's. Seeding the status onto a
 * booked instance would therefore be a contradiction, so these rows carry no
 * appointment at all and 6a excludes DRAFT from the statuses it picks.
 *
 * Without them nothing local exercises the owner-preview branch of
 * isPlanViewable, the draft badge on the planner cards, or the publish step.
 */
const NUM_DRAFT_WEBINARS = config.volumes.draftSessions.webinar;
const NUM_DRAFT_CLASSES = config.volumes.draftSessions.class;

export async function createDraftSessions(): Promise<void> {
  console.log(
    `Creating ${NUM_DRAFT_WEBINARS} draft webinars and ${NUM_DRAFT_CLASSES} draft classes...`,
  );

  const webinarPlans = await prisma.webinarPlan.findMany({
    where: { archivedAt: null, consultantProfileId: { not: null } },
    select: { id: true, maxParticipants: true },
    orderBy: { createdAt: "asc" },
    take: NUM_DRAFT_WEBINARS,
  });

  const classPlans = await prisma.classPlan.findMany({
    where: { archivedAt: null, consultantProfileId: { not: null } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: NUM_DRAFT_CLASSES,
  });

  if (webinarPlans.length === 0 && classPlans.length === 0) {
    console.warn("No live webinar or class plans found — skipping drafts.");
    return;
  }

  let webinarsCreated = 0;
  for (const [index, plan] of webinarPlans.entries()) {
    await prisma.webinar.create({
      data: {
        status: "DRAFT",
        webinarPlan: { connect: { id: plan.id } },
        // Every other draft retunes capacity for this one session, so the
        // per-instance override has a row where it differs from the plan.
        maxParticipants:
          index % 2 === 0 ? Math.max(5, plan.maxParticipants - 10) : null,
      },
    });
    webinarsCreated += 1;
  }

  let classesCreated = 0;
  for (const [index, plan] of classPlans.entries()) {
    await prisma.class.create({
      data: {
        status: "DRAFT",
        classPlan: { connect: { id: plan.id } },
        // A draft cohort has not picked its dates yet — that is precisely what
        // it is still missing, and why it cannot be published.
        schedulingPeriodStartsAt: null,
        schedulingPeriodEndsAt: null,
        maxParticipants: index % 2 === 0 ? 12 : null,
      },
    });
    classesCreated += 1;
  }

  console.log(
    `Created ${webinarsCreated} draft webinars and ${classesCreated} draft classes`,
  );
}
