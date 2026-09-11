import prisma, { type Tx } from "@/lib/prisma";
import type {
  AppointmentsType,
  ReviewTrack,
  SlotCompletionStatus,
} from "@prisma/client";

/**
 * #705 — how many distinct RATED SESSIONS a consultant needs before their score
 * is published.
 *
 * A code constant, not a column and not an env var: this is one platform-wide
 * trust policy that has to be byte-identical in the explore sort, the profile
 * page and any structured-data `aggregateRating`. A per-consultant column would
 * invite tuning, which is exactly the gaming vector the threshold exists to
 * close, and an env var makes preview and production disagree about a number
 * users can see. Same call as MIN_COHORT in the org feedback summary.
 *
 * Five rather than Practo's ten: at launch a threshold of ten would leave
 * almost every consultant with no visible score at all, and an honest "not
 * enough yet" only helps if some consultants clear it.
 */
export const MIN_RATED_UNITS_FOR_PUBLIC_SCORE = 5;

/**
 * #1300 — the publication gate, per track.
 *
 * 1:1 counts distinct CLIENTS: a 1:1 review row is one per (consultant, client)
 * pair, so "five" means five different people — under a per-purchase model it
 * could have meant five bookings from two people.
 */
export const MIN_RATED_CLIENTS_ONE_TO_ONE = 5;

/**
 * Group counts distinct EVENTS, not attendees. Two hundred people at one webinar
 * are one data point about the consultant, and five webinars is the same
 * evidentiary bar as five clients.
 */
export const MIN_RATED_EVENTS_GROUP = 5;

/**
 * ...and an event only becomes a data point once enough of its attendees
 * answered. Without this a 200-seat webinar with two replies buys a published
 * score off two opinions. Peloton deleted its class rating outright because the
 * distribution had no variance; a response floor is the cheaper version of
 * caring about that.
 */
export const MIN_GROUP_RESPONSES_PER_EVENT = 5;

/**
 * Bayesian shrinkage: how many "average" observations a consultant is credited
 * with before their own reviews outweigh the platform mean.
 *
 * A plain average is the wrong instrument and every mature platform has migrated
 * off one — Amazon says outright that it "uses advanced models to calculate star
 * ratings, not just a simple average", IMDb shrinks toward a global mean, and
 * Etsy had to abandon a hard trailing window because low-volume sellers' scores
 * flapped. Shrinkage is what stops a 5.0 from five ratings outranking a 4.8 from
 * two hundred.
 *
 * Twelve rather than five: at the threshold itself a consultant should still be
 * pulled meaningfully toward the mean, or the gate merely relocates the problem
 * to N=5.
 */
export const SCORE_PRIOR_WEIGHT = 12;

/**
 * Recency half-life, in days. Deliberately inert at launch.
 *
 * Decay is right in principle — Uber reads the last 500 trips, Booking.com stops
 * displaying at 36 months — but it is a claim about a corpus that has enough
 * history for "old" to mean something. This one has 62 reviews and no published
 * score at all, so a live half-life would move numbers for reasons no consultant
 * could act on, and "your score fell and nothing happened" is a support ticket
 * we would be creating for ourselves.
 *
 * Ten years makes the weight effectively 1 for every row we hold, while keeping
 * the term in the arithmetic and on every `ScoringSnapshot`, so the day it is
 * lowered every previously published score is still explainable.
 */
export const SCORE_HALF_LIFE_DAYS = 3650;

/**
 * The prior used before the first `ScoringSnapshot` exists.
 *
 * Not a guess at "the average consultant": it is the midpoint of the scale, so a
 * consultant with no reviews shrinks toward neutral rather than toward flattery.
 * The moment one snapshot exists this is never read again.
 */
const BOOTSTRAP_PLATFORM_MEAN = 3;

/** The scoring parameters, as one object, so a snapshot records exactly what ran. */
export const SCORING_PARAMS = {
  priorWeight: SCORE_PRIOR_WEIGHT,
  halfLifeDays: SCORE_HALF_LIFE_DAYS,
  minRatedClientsOneToOne: MIN_RATED_CLIENTS_ONE_TO_ONE,
  minRatedEventsGroup: MIN_RATED_EVENTS_GROUP,
  minGroupResponsesPerEvent: MIN_GROUP_RESPONSES_PER_EVENT,
} as const;

/**
 * Which reputation a booking's review belongs to.
 *
 * Keyed on the booking SHAPE, not on a stored flag: a webinar or a class is a
 * group product however few people turned up, and a consultation, subscription
 * or trial is 1:1 however long it ran.
 */
export function trackForAppointment(row: {
  webinarId: string | null;
  classId: string | null;
}): ReviewTrack {
  return row.webinarId || row.classId ? "GROUP" : "ONE_TO_ONE";
}

/**
 * Raised when the author tries to write over a review moderation has removed.
 * Accepting the edit silently would tell them it published while nothing
 * changed on the page. Both write paths raise it, so it lives here.
 */
export class ModeratedReviewError extends Error {}

/**
 * A slot counts as held when it completed, or when it is UNVERIFIED — that
 * status means "past, with no MeetingSession recorded", which is what an
 * offline session looks like. Excluding it would silently deny a review to
 * everyone whose session did not run through the video stack.
 */
export function heldSlot(userId: string) {
  return {
    deletedAt: null,
    // A call that was called off never happened, whoever joined the room
    // beforehand. Both callers already claim this exclusion in their comments;
    // only the UNVERIFIED arm actually pinned a status, so an attended slot
    // later stamped CANCELLED stayed rateable through the API.
    completionStatus: {
      notIn: ["CANCELLED", "RESCHEDULED"] as SlotCompletionStatus[],
    },
    // Not "the call happened" — "YOU were at the call". A COMPLETED slot the
    // user never joined used to qualify, so a no-show could rate a session they
    // did not attend and it fed the consultant's quality signal. Two ways in:
    OR: [
      // 1. You were demonstrably there, AND the call is over. This cannot key
      //    on `completionStatus` alone: that only flips when the
      //    call.session_ended webhook lands, which fires after the LAST
      //    participant leaves plus an inactivity timeout — so a post-call
      //    prompt keyed on it shows nothing to whoever leaves first.
      //
      //    The attendance row alone is not enough either: it is written when a
      //    participant JOINS, so on its own this qualified a slot that was
      //    still running, and a consultee could rate mid-call — moving the
      //    consultant's public ranking before the session had finished, since
      //    the review route recomputes the published score immediately.
      //    Testing `endedAt` rather than the clock keeps the property above:
      //    the host closing the room releases everyone, including whoever left
      //    first. The booked window is the fallback when nothing closed it.
      {
        AND: [
          { meetingSession: { attendances: { some: { userId } } } },
          {
            OR: [
              { meetingSession: { endedAt: { not: null } } },
              { endsAt: { lt: new Date() } },
            ],
          },
        ],
      },
      // 2. Nobody COULD have recorded it. UNVERIFIED means "past, with no
      //    MeetingSession", which is what an offline session looks like —
      //    excluding it would deny feedback to everyone who met in person.
      {
        completionStatus: "UNVERIFIED" as SlotCompletionStatus,
      },
    ],
  };
}

/** A review row, reduced to what the score needs. */
interface ScorableReview {
  rating: number;
  track: ReviewTrack | null;
  ratingUnitId: string | null;
  ratedSessionAt: Date | null;
  createdAt: Date;
}

/** The platform priors a run shrinks toward, plus the parameters it applied. */
export interface ScoringPriors {
  platformMeanOneToOne: number;
  platformMeanGroup: number;
  sampleCountOneToOne: number;
  sampleCountGroup: number;
}

/** One track's answer. */
interface TrackScore {
  /** Shrunk, decay-weighted. NULL below the publication threshold. */
  published: number | null;
  /** The plain arithmetic mean of the qualifying data points — what a
   *  consultant gets if they average their own cards by hand. Staff-facing, and
   *  the only way to answer "why is my score 4.1 when every review says 5". */
  raw: number | null;
  /** Data points: distinct clients for 1:1, qualifying events for group. */
  count: number;
  /** Sum of the decay weights. Stale in exact lockstep with `published`, so the
   *  pair is always internally consistent. */
  effectiveSample: number | null;
}

/**
 * Recency weight for one data point. `0.5 ** (age / halfLife)`.
 *
 * At the launch half-life this is indistinguishable from 1 for every row we
 * hold — see SCORE_HALF_LIFE_DAYS for why that is deliberate — but the term is
 * in the arithmetic and on every snapshot, so lowering it later does not
 * invalidate scores that were already published.
 */
function decayWeight(at: Date, now: Date, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now.getTime() - at.getTime()) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Round to two decimals, the precision every surface renders. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Shrink a set of weighted observations toward a prior.
 *
 * `(Σ(wᵢ·rᵢ) + m·C) / (Σwᵢ + m)` — IMDb's structure. With no observations it
 * returns the prior, which is why a consultant with nothing is never 0.0: a zero
 * is a claim, and an absent score is the truth.
 */
function shrink(
  points: { rating: number; weight: number }[],
  priorMean: number,
  priorWeight: number,
): number {
  const w = points.reduce((sum, p) => sum + p.weight, 0);
  const wr = points.reduce((sum, p) => sum + p.weight * p.rating, 0);
  return (wr + priorWeight * priorMean) / (w + priorWeight);
}

function scoreTrack(
  points: { rating: number; weight: number }[],
  priorMean: number,
  minCount: number,
): TrackScore {
  if (points.length === 0) {
    return { published: null, raw: null, count: 0, effectiveSample: null };
  }
  const effectiveSample = points.reduce((sum, p) => sum + p.weight, 0);
  const raw = points.reduce((sum, p) => sum + p.rating, 0) / points.length;
  const shrunk = shrink(points, priorMean, SCORE_PRIOR_WEIGHT);
  return {
    published: points.length >= minCount ? round2(shrunk) : null,
    raw: round2(raw),
    count: points.length,
    effectiveSample: round2(effectiveSample),
  };
}

/**
 * The 1:1 track: one review IS one data point, because a 1:1 row is one per
 * client. No bucket key needed — that is the simplification the split buys.
 */
function oneToOnePoints(
  rows: ScorableReview[],
  now: Date,
  halfLifeDays: number,
) {
  return rows
    .filter((r) => r.track === "ONE_TO_ONE")
    .map((r) => ({
      rating: r.rating,
      weight: decayWeight(r.ratedSessionAt ?? r.createdAt, now, halfLifeDays),
    }));
}

/**
 * The group track: one EVENT is one data point, and only once enough of its
 * attendees answered.
 *
 * This is the half nobody publishes a method for. Weighting per attendee
 * systematically punishes whoever fills the room; weighting per event lets a
 * three-person class outvote a two-hundred-person one. Neither is defensible as
 * a blend with 1:1 work, which is why the two live apart — and within the group
 * track, one-event-one-vote plus a response floor is the honest compromise: the
 * floor is what stops a 200-seat webinar with two replies counting at all.
 *
 * The event's age is its NEWEST rated session, so a long-running class series is
 * not aged out by its first cohort.
 */
function groupPoints(rows: ScorableReview[], now: Date, halfLifeDays: number) {
  const byEvent = new Map<string, { ratings: number[]; newest: Date }>();
  for (const r of rows) {
    // A GROUP review with no event key cannot be attributed to an event, so it
    // cannot be one data point about one. Legacy rows land here and are skipped
    // rather than guessed at.
    if (r.track !== "GROUP" || !r.ratingUnitId) continue;
    const at = r.ratedSessionAt ?? r.createdAt;
    const acc = byEvent.get(r.ratingUnitId);
    if (acc) {
      acc.ratings.push(r.rating);
      if (at > acc.newest) acc.newest = at;
    } else {
      byEvent.set(r.ratingUnitId, { ratings: [r.rating], newest: at });
    }
  }
  return [...byEvent.values()]
    .filter((e) => e.ratings.length >= MIN_GROUP_RESPONSES_PER_EVENT)
    .map((e) => ({
      rating: e.ratings.reduce((a, b) => a + b, 0) / e.ratings.length,
      weight: decayWeight(e.newest, now, halfLifeDays),
    }));
}

/** The exact delegate methods scoring touches. Narrow on purpose: the dry run
 *  in lib/reviews-recompute.ts stubs `consultantProfile.update` against this
 *  type, so a new dependency here fails the build there, not an operator's
 *  pre-flight against production data. */
export type ScoringTx = {
  consultantReview: Pick<Tx["consultantReview"], "findMany">;
  scoringSnapshot: Pick<Tx["scoringSnapshot"], "findFirst">;
  consultantProfile: Pick<Tx["consultantProfile"], "update">;
};

/**
 * The priors in force. Reads the newest `ScoringSnapshot`, so a review mutation
 * shrinks toward the same mean the last full run used rather than recomputing
 * the whole corpus on every star.
 *
 * Before the first snapshot exists there is nothing to read, and the bootstrap
 * prior is the midpoint of the scale — no snapshot is pinned in that case,
 * because a run that invented its own priors must not claim to be reproducible.
 */
export async function currentScoringPriors(tx: ScoringTx): Promise<{
  priors: ScoringPriors;
  snapshotId: string | null;
}> {
  const latest = await tx.scoringSnapshot.findFirst({
    orderBy: { computedAt: "desc" },
    select: {
      id: true,
      platformMeanOneToOne: true,
      platformMeanGroup: true,
      sampleCountOneToOne: true,
      sampleCountGroup: true,
    },
  });
  if (!latest) {
    return {
      priors: {
        platformMeanOneToOne: BOOTSTRAP_PLATFORM_MEAN,
        platformMeanGroup: BOOTSTRAP_PLATFORM_MEAN,
        sampleCountOneToOne: 0,
        sampleCountGroup: 0,
      },
      snapshotId: null,
    };
  }
  const { id, ...priors } = latest;
  return { priors, snapshotId: id };
}

/**
 * The platform priors, over the whole corpus, for one run.
 *
 * The mean each track is shrunk toward has to be measured the same way the track
 * itself is scored, or shrinkage pulls toward a number that does not describe the
 * same population: 1:1 averages review rows, group averages QUALIFYING EVENT
 * means. A track with no qualifying data falls back to the midpoint of the scale
 * rather than to a borrowed mean from the other track — the two are different
 * products and neither is evidence about the other.
 */
export async function computePlatformPriors(
  db: Pick<Tx, "consultantReview">,
): Promise<ScoringPriors> {
  const live = { deletedAt: null, excludedFromAggregateAt: null } as const;
  const [one, groupEvents] = await Promise.all([
    db.consultantReview.aggregate({
      where: { ...live, track: "ONE_TO_ONE" },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    db.consultantReview.groupBy({
      by: ["ratingUnitId"],
      where: { ...live, track: "GROUP", ratingUnitId: { not: null } },
      _avg: { rating: true },
      _count: { _all: true },
    }),
  ]);
  const qualifying = groupEvents.filter(
    (e) => e._count._all >= MIN_GROUP_RESPONSES_PER_EVENT,
  );
  const groupMean = qualifying.length
    ? qualifying.reduce((sum, e) => sum + (e._avg.rating ?? 0), 0) /
      qualifying.length
    : null;
  return {
    platformMeanOneToOne: one._avg.rating ?? BOOTSTRAP_PLATFORM_MEAN,
    sampleCountOneToOne: one._count._all,
    platformMeanGroup: groupMean ?? BOOTSTRAP_PLATFORM_MEAN,
    sampleCountGroup: qualifying.length,
  };
}

/**
 * Recompute the denormalized rating columns on ConsultantProfile.
 *
 * TWO published scores, because a twelve-session 1:1 engagement and a 200-seat
 * webinar are different products bought by different people and averaging them
 * tells a buyer of either one nothing. Airbnb shows a listing rating beside a
 * host rating for the same reason.
 *
 * The legacy `rating` / `publishedRating` / `ratingUnitCount` / `reviewCount`
 * columns are still written, from the same rows, so every existing reader keeps
 * working while the surfaces move over. They are computed here rather than by a
 * second query: `ratingUnitId` is now NULL on 1:1 reviews, so each of those is
 * its own unit, which is what the old legacy-fold branch already did for
 * pre-#705 rows. Same numbers, one read instead of two.
 *
 * Every create/update/delete must call this inside a Serializable transaction
 * with retry — it is a read-then-write over rows two concurrent reviewers both
 * touch, so at READ COMMITTED the second write overwrites an average computed
 * without the first review and the published score stays wrong.
 */
export async function recomputeConsultantRating(
  tx: ScoringTx,
  consultantProfileId: string,
  /** Supplied by the full recompute so every profile in a run shares one prior;
   *  omitted by mutation paths, which read the newest snapshot. */
  run?: { priors: ScoringPriors; snapshotId: string | null; now?: Date },
): Promise<void> {
  const now = run?.now ?? new Date();
  const { priors, snapshotId } = run ?? (await currentScoringPriors(tx));

  // Live rows. An excluded row (#1300 ratings protection) still renders on the
  // profile, so it stays in `reviewCount`; it just leaves the arithmetic.
  const liveRows = await tx.consultantReview.findMany({
    where: { consultantProfileId, deletedAt: null },
    select: {
      rating: true,
      track: true,
      ratingUnitId: true,
      ratedSessionAt: true,
      createdAt: true,
      excludedFromAggregateAt: true,
    },
  });
  const rows: ScorableReview[] = liveRows.filter(
    (r) => r.excludedFromAggregateAt === null,
  );

  const half = SCORE_HALF_LIFE_DAYS;
  const one = scoreTrack(
    oneToOnePoints(rows, now, half),
    priors.platformMeanOneToOne,
    MIN_RATED_CLIENTS_ONE_TO_ONE,
  );
  const group = scoreTrack(
    groupPoints(rows, now, half),
    priors.platformMeanGroup,
    MIN_RATED_EVENTS_GROUP,
  );

  // The legacy blended columns, kept in step for readers that have not moved.
  // One unit per NULL-`ratingUnitId` row, one per distinct event key.
  const legacyUnits = new Map<string, number[]>();
  let legacySoloSum = 0;
  let legacySoloCount = 0;
  for (const r of rows) {
    if (r.ratingUnitId) {
      const acc = legacyUnits.get(r.ratingUnitId);
      if (acc) acc.push(r.rating);
      else legacyUnits.set(r.ratingUnitId, [r.rating]);
    } else {
      legacySoloSum += r.rating;
      legacySoloCount += 1;
    }
  }
  const legacyUnitMeans = [...legacyUnits.values()].map(
    (rs) => rs.reduce((a, b) => a + b, 0) / rs.length,
  );
  const legacyUnitCount = legacyUnitMeans.length + legacySoloCount;
  const legacyMean = legacyUnitCount
    ? round2(
        (legacyUnitMeans.reduce((a, b) => a + b, 0) + legacySoloSum) /
          legacyUnitCount,
      )
    : 0;

  await tx.consultantProfile.update({
    where: { id: consultantProfileId },
    data: {
      publishedRatingOneToOne: one.published,
      publishedRatingGroup: group.published,
      ratedClientsOneToOne: one.count,
      ratedEventsGroup: group.count,
      rawRatingOneToOne: one.raw,
      rawRatingGroup: group.raw,
      effectiveSampleOneToOne: one.effectiveSample,
      effectiveSampleGroup: group.effectiveSample,
      scoringSnapshotId: snapshotId,
      rating: legacyMean,
      ratingUnitCount: legacyUnitCount,
      reviewCount: liveRows.length,
      publishedRating:
        legacyUnitCount >= MIN_RATED_UNITS_FOR_PUBLIC_SCORE ? legacyMean : null,
      ratingAggregatedAt: now,
    },
  });
}

/** One session a consultee is entitled to review. */
export interface ReviewableSession {
  appointmentId: string;
  consultantProfileId: string;
  /** Whose profile this review lands on — the card says the name, because that
   *  is who the user thinks they are reviewing. */
  consultantName: string | null;
  /** Which reputation a review of this session lands in. */
  track: ReviewTrack;
  /** The group EVENT this rating folds into. NULL on a 1:1 session, where a
   *  review is already one data point and there is nothing to collapse. */
  ratingUnitId: string | null;
  appointmentType: AppointmentsType;
  title: string;
  heldAt: Date | null;
  /** This consultee's own review of this session, if they have written one. */
  existingReview: {
    id: string;
    rating: number;
    reviewDescription: string | null;
  } | null;
}

type AppointmentRow = Awaited<
  ReturnType<typeof loadReviewableAppointments>
>[number];

function loadReviewableAppointments(
  consulteeProfileId: string,
  userId: string,
  appointmentId?: string,
  /**
   * Narrows the ARMS, not the page. `take: 50` applies before any caller-side
   * filter, so selecting a consultant afterwards returned nothing whenever the
   * qualifying session with them fell outside the consultee's 50 newest
   * bookings — and ProfileReviewComposer reads an empty list as "not
   * eligible", so an active client could neither post nor edit their review.
   */
  consultantProfileId?: string,
) {
  return prisma.appointment.findMany({
    where: {
      ...(appointmentId ? { id: appointmentId } : {}),
      deletedAt: null,
      OR: [
        // 1:1 arms — the wrapper IS the relationship, so ownership is the gate.
        {
          consultation: {
            requestedById: consulteeProfileId,
            ...(consultantProfileId
              ? { consultationPlan: { consultantProfileId } }
              : {}),
          },
          slotsOfAppointment: { some: heldSlot(userId) },
        },
        {
          subscription: {
            requestedById: consulteeProfileId,
            ...(consultantProfileId
              ? { subscriptionPlan: { consultantProfileId } }
              : {}),
          },
          slotsOfAppointment: { some: heldSlot(userId) },
        },
        {
          trialSession: {
            consulteeProfileId,
            status: { in: ["COMPLETED", "CONVERTED"] },
            ...(consultantProfileId ? { consultantProfileId } : {}),
          },
          slotsOfAppointment: { some: heldSlot(userId) },
        },
        // Group arms — there is no Attendee model: registration IS the m:n
        // between the user and every slot of the shared appointment. A paid
        // seat is required as well, so a cancelled or comped registration
        // cannot buy a review.
        {
          webinarId: { not: null },
          ...(consultantProfileId
            ? { webinar: { webinarPlan: { consultantProfileId } } }
            : {}),
          slotsOfAppointment: {
            some: { ...heldSlot(userId), user: { some: { id: userId } } },
          },
          payment: { some: { userId, paymentStatus: "SUCCEEDED" } },
        },
        {
          classId: { not: null },
          ...(consultantProfileId
            ? { class: { classPlan: { consultantProfileId } } }
            : {}),
          slotsOfAppointment: {
            some: { ...heldSlot(userId), user: { some: { id: userId } } },
          },
          payment: { some: { userId, paymentStatus: "SUCCEEDED" } },
        },
      ],
    },
    select: {
      id: true,
      appointmentType: true,
      webinarId: true,
      classId: true,
      organizationId: true,
      consultation: {
        select: {
          consultationPlan: {
            select: {
              title: true,
              consultantProfileId: true,
              consultantProfile: {
                select: { user: { select: { name: true } } },
              },
            },
          },
        },
      },
      subscription: {
        select: {
          subscriptionPlan: {
            select: {
              title: true,
              consultantProfileId: true,
              consultantProfile: {
                select: { user: { select: { name: true } } },
              },
            },
          },
        },
      },
      trialSession: {
        select: {
          consultantProfileId: true,
          consultantProfile: { select: { user: { select: { name: true } } } },
        },
      },
      webinar: {
        select: {
          webinarPlan: {
            select: {
              title: true,
              consultantProfileId: true,
              consultantProfile: {
                select: { user: { select: { name: true } } },
              },
            },
          },
        },
      },
      class: {
        select: {
          classPlan: {
            select: {
              title: true,
              consultantProfileId: true,
              consultantProfile: {
                select: { user: { select: { name: true } } },
              },
            },
          },
        },
      },
      slotsOfAppointment: {
        where: heldSlot(userId),
        select: { endsAt: true },
        orderBy: { endsAt: "desc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
    take: appointmentId ? 1 : 50,
  });
}

/**
 * Derive the consultant and the rating unit for one appointment.
 *
 * The unit is NOT a session-type discriminator: a WEBINAR shares one
 * Appointment across every attendee, but a CLASS mints one per enrolment, so
 * grouping by type alone would collapse every class a consultant ever ran into
 * a single data point — worse than the imbalance being fixed.
 */
type ExistingReview = {
  id: string;
  rating: number;
  reviewDescription: string | null;
  isAnonymous: boolean;
};

function describe(
  row: AppointmentRow,
  reviewByConsultant: Map<string, ExistingReview>,
): ReviewableSession | null {
  const consultantProfileId =
    row.consultation?.consultationPlan?.consultantProfileId ??
    row.subscription?.subscriptionPlan?.consultantProfileId ??
    row.trialSession?.consultantProfileId ??
    row.webinar?.webinarPlan?.consultantProfileId ??
    row.class?.classPlan?.consultantProfileId ??
    null;
  // Group plans may carry no consultant at all; there is nobody to review.
  if (!consultantProfileId) return null;

  const track = trackForAppointment(row);
  // Group only. A 1:1 review is one data point by construction now, so a bucket
  // key for it would be a column that always holds exactly one row.
  const ratingUnitId = row.webinarId
    ? `webinar:${row.webinarId}`
    : row.classId
      ? `class:${row.classId}`
      : null;

  return {
    appointmentId: row.id,
    consultantProfileId,
    consultantName:
      row.consultation?.consultationPlan?.consultantProfile?.user?.name ??
      row.subscription?.subscriptionPlan?.consultantProfile?.user?.name ??
      row.trialSession?.consultantProfile?.user?.name ??
      row.webinar?.webinarPlan?.consultantProfile?.user?.name ??
      row.class?.classPlan?.consultantProfile?.user?.name ??
      null,
    track,
    ratingUnitId,
    appointmentType: row.appointmentType,
    title:
      row.consultation?.consultationPlan?.title ??
      row.subscription?.subscriptionPlan?.title ??
      row.webinar?.webinarPlan?.title ??
      row.class?.classPlan?.title ??
      "Session",
    heldAt: row.slotsOfAppointment[0]?.endsAt ?? null,
    // Keyed on the CONSULTANT, not this appointment. The review is one per
    // person now, so it may well hang off a different booking — looking it up
    // through the appointment made the card say "Post review" to someone who
    // had already written one, and lose their text.
    existingReview: reviewByConsultant.get(consultantProfileId) ?? null,
  };
}

/** This consultee's existing review of each of the given consultants.
 *
 *  Keyed by consultant alone while the unique is the pair. #1549 keys 1:1 by
 *  (consultant, track) and GROUP by (consultant, event). */
async function reviewsByConsultant(
  consulteeProfileId: string,
  consultantProfileIds: string[],
): Promise<Map<string, ExistingReview>> {
  if (consultantProfileIds.length === 0) return new Map();
  const rows = await prisma.consultantReview.findMany({
    where: {
      consulteeProfileId,
      deletedAt: null,
      consultantProfileId: { in: consultantProfileIds },
    },
    select: {
      id: true,
      rating: true,
      reviewDescription: true,
      isAnonymous: true,
      consultantProfileId: true,
      track: true,
    },
  });
  return new Map(
    rows.map(({ consultantProfileId, track: _track, ...r }) => [
      consultantProfileId,
      r,
    ]),
  );
}

/**
 * Grid E: an org-hosted engagement — the booking's own organisation's EXPERT,
 * paid through the organisation, delivering to its member — is internal, not a
 * marketplace transaction, and publishes no review. Decided at #1300 (rule 8);
 * this is the enforcement. Current membership stands in for the booking-time
 * fact until #1554 snapshots the deliverer.
 */
async function orgHostedAppointmentIds(
  rows: {
    id: string;
    organizationId: string | null;
    consultantProfileId: string;
  }[],
): Promise<Set<string>> {
  const scoped = rows.filter((r) => r.organizationId !== null);
  if (scoped.length === 0) return new Set();
  const hosted = await prisma.membership.findMany({
    where: {
      role: "EXPERT",
      status: "ACTIVE",
      payoutRecipient: "ORGANIZATION",
      OR: scoped.map((r) => ({
        organizationId: r.organizationId!,
        consultantProfileId: r.consultantProfileId,
      })),
    },
    select: { organizationId: true, consultantProfileId: true },
  });
  const key = (org: string, consultant: string) => `${org}:${consultant}`;
  const hostedKeys = new Set(
    hosted.map((m) => key(m.organizationId, m.consultantProfileId!)),
  );
  return new Set(
    scoped
      .filter((r) =>
        hostedKeys.has(key(r.organizationId!, r.consultantProfileId)),
      )
      .map((r) => r.id),
  );
}

/** Resolve a batch of appointment rows into reviewable sessions. */
async function describeAll(
  rows: AppointmentRow[],
  consulteeProfileId: string,
): Promise<ReviewableSession[]> {
  const described = rows
    .map((row) => ({ row, session: describe(row, new Map()) }))
    .filter(
      (d): d is { row: AppointmentRow; session: ReviewableSession } =>
        d.session !== null,
    );
  const hostedIds = await orgHostedAppointmentIds(
    described.map(({ row, session }) => ({
      id: row.id,
      organizationId: row.organizationId,
      consultantProfileId: session.consultantProfileId,
    })),
  );
  const eligible = described.filter(({ row }) => !hostedIds.has(row.id));
  const consultantIds = [
    ...new Set(eligible.map(({ session }) => session.consultantProfileId)),
  ];
  const byConsultant = await reviewsByConsultant(
    consulteeProfileId,
    consultantIds,
  );
  return eligible
    .map(({ row }) => describe(row, byConsultant))
    .filter((s): s is ReviewableSession => s !== null);
}

/** Every session this consultee may review, newest first. */
export async function listReviewableSessions(
  consulteeProfileId: string,
  userId: string,
  consultantProfileId?: string,
): Promise<ReviewableSession[]> {
  const rows = await loadReviewableAppointments(
    consulteeProfileId,
    userId,
    undefined,
    consultantProfileId,
  );
  return describeAll(rows, consulteeProfileId);
}

/**
 * Eligibility for ONE session. Null means "not yours, not held, or not paid" —
 * the caller turns that into a 403 without saying which, since the distinction
 * would leak whether an appointment exists.
 */
export async function resolveReviewableSession(
  consulteeProfileId: string,
  userId: string,
  appointmentId: string,
): Promise<ReviewableSession | null> {
  const rows = await loadReviewableAppointments(
    consulteeProfileId,
    userId,
    appointmentId,
  );
  return (await describeAll(rows, consulteeProfileId))[0] ?? null;
}
