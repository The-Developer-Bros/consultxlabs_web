import { faker } from "@faker-js/faker";
import type { RatingCause, ReviewTrack } from "@prisma/client";
import prisma from "../../lib/prisma";
import { trackForAppointment } from "../../lib/reviews";
import { recomputeAllConsultantRatings } from "../../lib/reviews-recompute";
import { UserWithProfiles } from "./1a-create-users";

/**
 * #1300 — one public review per (consultant, consultee) pair, on the track the
 * session was, plus one private CSAT row per held call. Ends by running the same
 * recompute production runs, so the seed leaves published scores rather than
 * NULL = suppressed. Owns its tables: re-running replaces them.
 */

// Skewed toward 4–5 the way a real marketplace corpus is; a flat 1–5 makes every
// published score shrink to the midpoint and hides the design.
const RATING_WEIGHTS = [
  { value: 1, weight: 4 },
  { value: 2, weight: 5 },
  { value: 3, weight: 11 },
  { value: 4, weight: 30 },
  { value: 5, weight: 50 },
];

const LOW_SCORE_CAUSES: RatingCause[] = [
  "CONSULTANT",
  "CONSULTANT",
  "PLATFORM_TECHNICAL",
  "SCHEDULING",
  "CONTENT",
  "OTHER",
];

const pickRating = () =>
  faker.helpers.weightedArrayElement(RATING_WEIGHTS) as 1 | 2 | 3 | 4 | 5;

type HeldSlot = {
  slotId: string;
  appointmentId: string;
  /** The booking's organisation, copied onto feedback so the org rollup sees it. */
  organizationId: string | null;
  endsAt: Date;
  track: ReviewTrack;
  ratingUnitId: string | null;
  consultantProfileId: string;
  userId: string;
  consulteeProfileId: string | null;
};

// Every past, uncancelled slot with the consultee who held it — the same shape
// `heldSlot` in lib/reviews.ts admits, minus the attendance arm that #1543 says
// never fires.
async function loadHeldSlots(now: Date): Promise<HeldSlot[]> {
  const appointments = await prisma.appointment.findMany({
    where: {
      slotsOfAppointment: {
        some: {
          endsAt: { lt: now },
          completionStatus: { in: ["UNVERIFIED", "COMPLETED"] },
        },
      },
    },
    select: {
      id: true,
      webinarId: true,
      classId: true,
      organizationId: true,
      consultation: {
        select: {
          consultationPlan: {
            select: {
              consultantProfileId: true,
              consultantProfile: { select: { userId: true } },
            },
          },
        },
      },
      subscription: {
        select: {
          subscriptionPlan: {
            select: {
              consultantProfileId: true,
              consultantProfile: { select: { userId: true } },
            },
          },
        },
      },
      webinar: {
        select: {
          webinarPlan: {
            select: {
              consultantProfileId: true,
              consultantProfile: { select: { userId: true } },
            },
          },
        },
      },
      class: {
        select: {
          classPlan: {
            select: {
              consultantProfileId: true,
              consultantProfile: { select: { userId: true } },
            },
          },
        },
      },
      slotsOfAppointment: {
        where: {
          endsAt: { lt: now },
          completionStatus: { in: ["UNVERIFIED", "COMPLETED"] },
        },
        select: {
          id: true,
          endsAt: true,
          user: {
            select: { id: true, consulteeProfile: { select: { id: true } } },
          },
        },
      },
    },
  });

  const held: HeldSlot[] = [];
  for (const a of appointments) {
    const consultantProfileId =
      a.consultation?.consultationPlan?.consultantProfileId ??
      a.subscription?.subscriptionPlan?.consultantProfileId ??
      a.webinar?.webinarPlan?.consultantProfileId ??
      a.class?.classPlan?.consultantProfileId ??
      null;
    if (!consultantProfileId) continue;
    // The slot's user list holds the consultant too (the #827 double-booking
    // guard); `appointmentRaterRole` ranks them PROVIDER, never CONSULTEE.
    const consultantUserId =
      a.consultation?.consultationPlan?.consultantProfile?.userId ??
      a.subscription?.subscriptionPlan?.consultantProfile?.userId ??
      a.webinar?.webinarPlan?.consultantProfile?.userId ??
      a.class?.classPlan?.consultantProfile?.userId ??
      null;
    const track = trackForAppointment(a);
    const ratingUnitId = a.webinarId
      ? `webinar:${a.webinarId}`
      : a.classId
        ? `class:${a.classId}`
        : null;
    for (const slot of a.slotsOfAppointment) {
      if (!slot.endsAt) continue;
      for (const u of slot.user) {
        if (u.id === consultantUserId) continue;
        held.push({
          slotId: slot.id,
          appointmentId: a.id,
          organizationId: a.organizationId,
          endsAt: slot.endsAt,
          track,
          ratingUnitId,
          consultantProfileId,
          userId: u.id,
          consulteeProfileId: u.consulteeProfile?.id ?? null,
        });
      }
    }
  }
  return held;
}

async function createReviews(held: HeldSlot[]): Promise<number> {
  // One review per pair, on the LAST session that pair held.
  const latestByPair = new Map<string, HeldSlot>();
  for (const h of held) {
    if (!h.consulteeProfileId) continue;
    const key = `${h.consultantProfileId}:${h.consulteeProfileId}`;
    const prev = latestByPair.get(key);
    if (!prev || h.endsAt > prev.endsAt) latestByPair.set(key, h);
  }

  // Every held pair reviews. Small mode holds at most five 1:1 clients and two
  // past group events per consultant, so any drop-out leaves nobody published.
  let created = 0;
  for (const h of latestByPair.values()) {
    const rating = pickRating();
    const createdAt = faker.date.between({ from: h.endsAt, to: new Date() });
    const edited = faker.datatype.boolean({ probability: 0.1 });
    const replied = faker.datatype.boolean({ probability: 0.25 });
    const repliedAt = replied
      ? faker.date.between({ from: createdAt, to: new Date() })
      : null;

    const review = await prisma.consultantReview.create({
      data: {
        rating,
        reviewDescription: faker.lorem.paragraph(),
        consultantProfileId: h.consultantProfileId,
        consulteeProfileId: h.consulteeProfileId!,
        appointmentId: h.appointmentId,
        track: h.track,
        ratingUnitId: h.ratingUnitId,
        ratedSessionAt: h.endsAt,
        isAnonymous: faker.datatype.boolean({ probability: 0.2 }),
        ratingCause:
          rating <= 2 ? faker.helpers.arrayElement(LOW_SCORE_CAUSES) : null,
        replyBody: replied ? faker.lorem.sentences(2) : null,
        repliedAt,
        revisionNo: edited ? 2 : 1,
        editedAt: edited
          ? faker.date.between({ from: createdAt, to: new Date() })
          : null,
        createdAt,
      },
      select: { id: true, editedAt: true },
    });

    if (edited && review.editedAt) {
      await prisma.consultantReviewRevision.create({
        data: {
          reviewId: review.id,
          revisionNo: 1,
          rating: pickRating(),
          reviewDescription: faker.lorem.paragraph(),
          supersededAt: review.editedAt,
          afterPublicReply: repliedAt !== null && review.editedAt > repliedAt,
        },
      });
    }
    created++;
  }
  return created;
}

async function createAppointmentFeedback(held: HeldSlot[]): Promise<number> {
  // One private rating per (call, user), from roughly half the calls held.
  const seen = new Set<string>();
  const rows = [];
  for (const h of held) {
    const key = `${h.slotId}:${h.userId}`;
    if (seen.has(key) || !faker.datatype.boolean({ probability: 0.5 }))
      continue;
    seen.add(key);
    const rating = pickRating();
    rows.push({
      slotOfAppointmentId: h.slotId,
      appointmentId: h.appointmentId,
      organizationId: h.organizationId,
      userId: h.userId,
      rating,
      comment: faker.datatype.boolean({ probability: 0.6 })
        ? faker.lorem.sentence()
        : null,
      raterRole: "CONSULTEE" as const,
      ratingCause:
        rating <= 2 ? faker.helpers.arrayElement(LOW_SCORE_CAUSES) : null,
      createdAt: faker.date.between({ from: h.endsAt, to: new Date() }),
    });
  }
  const { count } = await prisma.appointmentFeedback.createMany({ data: rows });
  return count;
}

export async function createConsultantReviews(consultants: UserWithProfiles[]) {
  console.log(`Creating consultant reviews and per-call feedback...`);
  const now = new Date();

  await prisma.consultantReviewRevision.deleteMany({});
  await prisma.consultantReview.deleteMany({});
  await prisma.appointmentFeedback.deleteMany({});

  const held = await loadHeldSlots(now);
  const reviews = await createReviews(held);
  const feedback = await createAppointmentFeedback(held);
  console.log(
    `Created ${reviews} consultant reviews and ${feedback} feedback rows from ${held.length} held slots across ${consultants.length} consultants`,
  );

  const result = await recomputeAllConsultantRatings({ now });
  const published = await prisma.consultantProfile.count({
    where: {
      OR: [
        { publishedRatingOneToOne: { not: null } },
        { publishedRatingGroup: { not: null } },
      ],
    },
  });
  console.log(
    `Recomputed ${result.recomputed}/${result.profiles} profiles; ${published} now publish a score` +
      (result.failed.length ? `; ${result.failed.length} FAILED` : ""),
  );
  if (result.failed.length) console.error(result.failed);
}
