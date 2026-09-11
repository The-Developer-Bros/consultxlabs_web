import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  publicReviewSelect,
  sanitisePublicReviews,
} from "@/lib/data/review-public";
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
import { z } from "zod";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const rating = searchParams.get("rating");
    const consultantId = searchParams.get("consultantId");
    const searchTerm = searchParams.get("search");

    const whereClause: Prisma.ConsultantReviewWhereInput = {};

    if (rating !== null) {
      // `parseInt("4junk")` is 4 and `parseInt("abc")` is NaN; neither belongs
      // in a Prisma filter.
      const minRating = z.coerce.number().int().min(1).max(5).safeParse(rating);
      if (!minRating.success) {
        return NextResponse.json(
          { error: "rating must be an integer from 1 to 5" },
          { status: 400 },
        );
      }
      whereClause.rating = { gte: minRating.data };
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
          // The pair's review, whatever its track: the unique is the two-column
          // pair until #1549, so filtering on track would miss the row and 409.
          const existing = await tx.consultantReview.findFirst({
            where: {
              consultantProfileId: reviewable.consultantProfileId,
              consulteeProfileId: sessionConsulteeProfileId,
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
          // An author's withdrawal is revivable; a moderation removal is not. A
          // NULL remover on a removed row reads as moderation (fails closed).
          const withdrawnByAuthor =
            existing !== null &&
            existing.deletedAt !== null &&
            existing.deletedByUserId === session.user.id;
          if (existing?.deletedAt && !withdrawnByAuthor) {
            throw new ModeratedReviewError();
          }

          // An explicit select, never `include`: `include` returns every scalar on
          // the row, which (a) hands the author staff-only columns and (b) fails
          // with P2022 whenever the schema is pushed ahead of the deploy — the
          // documented order. Only what the notification below reads.
          const select = {
            ...publicReviewSelect,
            consultantProfile: {
              select: { userId: true, user: { select: { name: true } } },
            },
            consulteeProfile: {
              select: { user: { select: { name: true, image: true } } },
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
              // The revision number is allocated by an atomic increment on the
              // review row, never from the `existing` read: two editors who both
              // read N would otherwise both insert revision N and the loser got a
              // P2002 that `withSerializableRetry` does not retry. The increment
              // takes the row lock, so the loser aborts with P2034 and retries.
              const bumped = await tx.consultantReview.update({
                where: { id: existing.id },
                data: { revisionNo: { increment: 1 }, editedAt: new Date() },
                select: { revisionNo: true },
              });
              // The trail stores what the review USED to say.
              await tx.consultantReviewRevision.create({
                data: {
                  reviewId: existing.id,
                  revisionNo: bumped.revisionNo - 1,
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

            // Provenance moves as ONE fact — appointment, session clock, track
            // and event key together — and only when the new session is in the
            // row's own track. GROUP follows the latest event (its bucket, clock
            // and provenance then agree) until #1549 gives each event its own row;
            // a cross-track edit before #1549 changes the words and nothing else.
            const sameTrack =
              existing.track === null || existing.track === reviewable.track;
            created = await tx.consultantReview.update({
              where: { id: existing.id },
              data: {
                rating: validatedData.rating,
                reviewDescription: validatedData.reviewDescription,
                ...(sameTrack
                  ? {
                      appointmentId: reviewable.appointmentId,
                      track: reviewable.track,
                      ratingUnitId: reviewable.ratingUnitId,
                      // `heldAt` is the slot's end, never now(): re-saving cannot
                      // refresh a recency weight. Kept when unknown (offline).
                      ...(reviewable.heldAt
                        ? { ratedSessionAt: reviewable.heldAt }
                        : {}),
                    }
                  : {}),
                isAnonymous: validatedData.isAnonymous ?? undefined,
                ...(withdrawnByAuthor
                  ? { deletedAt: null, deletedByUserId: null }
                  : {}),
              },
              select,
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
              select,
            });
          }

          await recomputeConsultantRating(tx, created.consultantProfileId);

          // A revived withdrawal is news to the consultant just as a first
          // review is: the profile regains a review they were not told about.
          return { review: created, isNew: !existing || withdrawnByAuthor };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    const { review: newReview, isNew } = writeResult;

    // Only a NEW (or revived) review is news; an edit must not re-notify.
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
    // The pair unique, lost as a find-then-create race. Per consultant until
    // #1549 (then per consultant per track, per event for GROUP).
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
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
