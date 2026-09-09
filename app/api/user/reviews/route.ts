import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  publicReviewSelect,
  sanitisePublicReviews,
} from "@/lib/data/review-public";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import { Prisma } from "@prisma/client";
import { notifyNewReview } from "@/lib/novu";
import { CreateReviewSchema } from "@/schemas/feedbacks";
import { apiError } from "@/lib/errors";
import { getSession } from "@/lib/auth-server";
import { purgeReviewSurfaces } from "@/lib/data/public-cache";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import {
  ModeratedReviewError,
  recomputeConsultantRating,
  resolveReviewableSession,
} from "@/lib/reviews";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const rating = searchParams.get("rating");
    const consultantId = searchParams.get("consultantId");
    const searchTerm = searchParams.get("search");

    const whereClause: Prisma.ConsultantReviewWhereInput = {};

    if (rating) {
      whereClause.rating = {
        gte: parseInt(rating), // Greater than or equal to the specified rating
      };
    }

    if (consultantId) {
      whereClause.consultantProfileId = consultantId;
    }

    // NO consulteeProfileId filter. This route is PUBLIC (middleware.ts) and
    // CDN-cached, so an unauthenticated caller could pass any profile id and
    // read back that person's reviews — including the ones they marked
    // anonymous. Stripping `consulteeProfile` from the RESPONSE does nothing
    // there: the caller supplied the identity, so the filter itself is the
    // de-anonymisation. Nothing in the app ever passed this parameter.
    // A "my reviews" surface must authenticate and derive the profile from the
    // session, not accept it from the query string.

    if (searchTerm) {
      whereClause.reviewDescription = {
        contains: searchTerm,
        mode: "insensitive",
      };
    }

    // #693 — moderation-removed reviews stay hidden
    whereClause.deletedAt = null;
    const reviews = await prisma.consultantReview.findMany({
      where: whereClause,
      take: 50,
      // The allowlist. This route is PUBLIC (middleware.ts marks it so) and its
      // response is CDN-cached, so a bare `include:` here published every
      // reviewed consultant's statutory PII AND every named reviewer's private
      // profile — `goals`, `aboutMe`, `careerStage`, `budgetPreference`.
      select: publicReviewSelect,
      orderBy: {
        rating: "desc",
      },
    });

    return NextResponse.json(
      // PUBLIC and CDN-cached: a name withheld by the reviewer must not ship
      // in the payload, or the anonymity is cosmetic.
      { data: sanitisePublicReviews(reviews) },
      {
        status: 200,
        headers: {
          "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    return apiError({ tag: "[Reviews.GET]", error });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Rate limit: 5 reviews per hour per user
    const rl = await applyRateLimit(spamLimiter, `reviews:${session.user.id}`);
    if (rl) return rl;

    const body = await req.json();
    const result = CreateReviewSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }
    const validatedData = result.data;

    // Reviews are always authored as the session user's own consultee profile.
    const sessionConsulteeProfileId = session.user.consulteeProfileId;
    if (!sessionConsulteeProfileId) {
      return NextResponse.json(
        { error: "You need a consultee profile to post a review" },
        { status: 403 },
      );
    }

    // #705 — eligibility is now per SESSION, and it is what tells us who is
    // being reviewed. One message for "not yours", "not held" and "not paid":
    // distinguishing them would leak whether an appointment exists.
    const reviewable = await resolveReviewableSession(
      sessionConsulteeProfileId,
      session.user.id,
      validatedData.appointmentId,
    );
    if (!reviewable) {
      return NextResponse.json(
        {
          error:
            "You can only review a session you attended and paid for, once it has taken place",
        },
        { status: 403 },
      );
    }

    // Create + rating recompute in one transaction so the denormalized
    // ConsultantProfile.rating (explore sort/filter) never drifts. Serializable
    // + retry so two concurrent reviews for the same consultant can't lose-update
    // the recomputed average (P2034 aborts one, retry then sees the committed row).
    const writeResult = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // A review that moderation removed cannot be edited back into
          // existence, and accepting the edit silently would tell the author it
          // was published while nothing changed on the page.
          //
          // Two candidates, deliberately. The unique is
          // (consultantProfileId, consulteeProfileId, track), and 59 legacy rows
          // predate `track` entirely. Postgres treats their NULL as distinct, so
          // inserting beside one would put two reviews from the same person on
          // the same profile. The legacy row is ADOPTED instead: it is the review
          // they already wrote, and this write stamps the track it belongs to.
          const candidates = await tx.consultantReview.findMany({
            where: {
              consultantProfileId: reviewable.consultantProfileId,
              consulteeProfileId: sessionConsulteeProfileId,
              // `in: [track, null]` is not expressible — Prisma's `in` for a
              // nullable enum rejects null in the list, because SQL `IN` cannot
              // match NULL either. The OR is the honest form of the same query.
              OR: [{ track: reviewable.track }, { track: null }],
            },
            select: {
              id: true,
              deletedAt: true,
              deletedByUserId: true,
              track: true,
              rating: true,
              reviewDescription: true,
              revisionNo: true,
              repliedAt: true,
              replyDeletedAt: true,
            },
          });
          // Prefer an exact-track row over a legacy one: if both somehow exist,
          // the tracked row is the one this product's reviews belong to.
          const existing =
            candidates.find((c) => c.track === reviewable.track) ??
            candidates[0] ??
            null;
          // #1300 — withdrawing your own review and having it moderated away
          // both set `deletedAt`, and this refused BOTH with "removed by our
          // moderation team". So a consultee who deleted their own review was
          // told, wrongly, that staff had taken it down — and because the unique
          // keeps the removed row occupying the pair, they could never write
          // another one about that person. `deletedByUserId` separates the two.
          //
          // A NULL remover on a removed row reads as moderation, which is the
          // safe direction for the legacy rows that predate the column.
          const withdrawnByAuthor =
            existing !== null &&
            existing.deletedAt !== null &&
            existing.deletedByUserId === session.user.id;
          if (existing?.deletedAt && !withdrawnByAuthor) {
            throw new ModeratedReviewError();
          }

          const include = {
            // #946 allowlist — the response goes back to the consultee who wrote
            // the review; a bare `include:` handed them the consultant's PAN and
            // bank account.
            consultantProfile: {
              select: {
                ...consultantPublicScalars,
                user: { select: { name: true } },
              },
            },
            consulteeProfile: {
              include: { user: { select: { name: true, image: true } } },
            },
          } as const;

          let created;
          if (existing) {
            // Only a changed OPINION is an edit. Re-submitting the same stars and
            // the same words is idempotent, so it must not manufacture a
            // revision or stamp `editedAt` — otherwise a double-tapped Save reads
            // as "this person keeps changing their mind".
            const textChanged =
              existing.rating !== validatedData.rating ||
              (existing.reviewDescription ?? null) !==
                (validatedData.reviewDescription ?? null);

            if (textChanged) {
              // The trail stores what the review USED to say. Appended BEFORE the
              // update, inside the same transaction, so the two cannot separate.
              await tx.consultantReviewRevision.create({
                data: {
                  reviewId: existing.id,
                  revisionNo: existing.revisionNo,
                  rating: existing.rating,
                  reviewDescription: existing.reviewDescription,
                  // Recorded for moderation context. It does NOT decide whether
                  // the public surface marks the edit — every edit is marked, or
                  // a consultant could reply to everything and brand every
                  // subsequent revision.
                  afterPublicReply:
                    existing.repliedAt !== null &&
                    existing.replyDeletedAt === null,
                  editorUserId: session.user.id,
                },
              });
            }

            created = await tx.consultantReview.update({
              where: { id: existing.id },
              data: {
                rating: validatedData.rating,
                reviewDescription: validatedData.reviewDescription,
                appointmentId: reviewable.appointmentId,
                // The session clock moves WITH `appointmentId`, because they are one
                // fact: the row would otherwise claim provenance from this session
                // while its recency weight measured a different one, or none at all
                // — a legacy row adopted here ended up with a real appointment and a
                // NULL clock, silently falling back to `createdAt` in
                // `oneToOnePoints`. Stamping it always is safe because `heldAt` is a
                // slot's `endsAt`, not `now()`: re-saving cannot refresh anybody's
                // own recency weight, and a genuinely newer session is a newer
                // conversation. Skipped when unknown, so an offline session with no
                // bounds does not erase a clock we already had.
                ...(reviewable.heldAt
                  ? { ratedSessionAt: reviewable.heldAt }
                  : {}),
                // Adopt the track when the row predates it. Never MOVE a track
                // that is already set: the unique keys on it, so a move would
                // collide with the reviewer's other review of the same person.
                ...(existing.track === null ? { track: reviewable.track } : {}),
                // ratingUnitId deliberately NOT moved. It is the event bucket the
                // group score averages within, so reassigning it on an edit
                // merges buckets that were separate and a consultant sitting on
                // the publication threshold loses their score because two people
                // revised their wording.
                isAnonymous: validatedData.isAnonymous ?? undefined,
                ...(textChanged
                  ? { revisionNo: { increment: 1 }, editedAt: new Date() }
                  : {}),
                // Reviving what you withdrew yourself is allowed and is the
                // whole point of `deletedByUserId`; a moderation removal never
                // reaches here, because the guard above threw.
                ...(withdrawnByAuthor
                  ? { deletedAt: null, deletedByUserId: null }
                  : {}),
              },
              include,
            });
          } else {
            created = await tx.consultantReview.create({
              data: {
                rating: validatedData.rating,
                reviewDescription: validatedData.reviewDescription,
                consultantProfileId: reviewable.consultantProfileId,
                consulteeProfileId: sessionConsulteeProfileId,
                appointmentId: reviewable.appointmentId,
                isAnonymous: validatedData.isAnonymous ?? false,
                track: reviewable.track,
                // Group only — see lib/reviews.ts. NULL on a 1:1 review, where
                // the review is already one data point.
                ratingUnitId: reviewable.ratingUnitId,
                // The SESSION's clock, for recency weighting. The age of the
                // conversation, not of the row: a client editing a year-old
                // review this week has not held a recent session.
                ratedSessionAt: reviewable.heldAt,
              },
              include,
            });
          }

          await recomputeConsultantRating(tx, created.consultantProfileId);

          // The write is an upsert, so the caller cannot tell a create from an
          // edit by looking at the row. `existing` is the answer and the
          // transaction already has it.
          return { review: created, isNew: !existing };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    const { review: newReview, isNew } = writeResult;

    // Only a genuinely NEW review is news. Under the upsert every edit pinged
    // the consultant again as though a fresh review had landed, so a consultee
    // refining their wording could notify them repeatedly for one opinion.
    if (isNew) {
      void notifyNewReview(newReview.consultantProfile.userId, {
        // The reviewer withheld their name from the public page; sending it to
        // the consultant in a notification would hand back exactly what the
        // flag exists to withhold, and to the one person it is kept from.
        reviewerName: newReview.isAnonymous
          ? "A verified client"
          : newReview.consulteeProfile?.user?.name || "User",
        rating: newReview.rating,
        comment: newReview.reviewDescription || undefined,
        planTitle: reviewable.title,
        // `/dashboard/consultant/reviews` never existed — the link 404'd for
        // every review ever notified. The capability router picks the viewer's
        // tree from a bare /dashboard.
        dashboardUrl: "/dashboard",
      });
    }

    // Reviews are the landing page's testimonials and they move the expert's
    // denormalized rating, which orders the directory — both surfaces are stale
    // until purged, and the landing page's window is an hour.
    purgeReviewSurfaces(newReview.consultantProfileId);

    // 201 only when something was created; an edit is a 200.
    return NextResponse.json(newReview, { status: isNew ? 201 : 200 });
  } catch (error) {
    if (error instanceof ModeratedReviewError) {
      return NextResponse.json(
        {
          error:
            "This review was removed by our moderation team and can't be edited.",
        },
        { status: 409 },
      );
    }
    // @@unique([consultantProfileId, consulteeProfileId, track]) — one per
    // consultant per product.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // Reachable only as a race: the upsert's own read-then-write can lose to
      // a concurrent insert of the same pair. Not "this session" any more —
      // the unique is per CONSULTANT, and the copy has to say so or the reader
      // goes looking for a session they never double-reviewed.
      return NextResponse.json(
        {
          error:
            "You already have a review for this expert. Reload to edit the one you have.",
        },
        { status: 409 },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    return apiError({ tag: "[Reviews.POST]", error });
  }
}
