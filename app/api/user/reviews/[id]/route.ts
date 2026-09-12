import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  requireApiAuth,
  checkOwnership,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { recomputeConsultantRating, ModeratedReviewError } from "@/lib/reviews";
import {
  publicReviewSelect,
  sanitisePublicReview,
} from "@/lib/data/review-public";
import { purgeReviewSurfaces } from "@/lib/data/public-cache";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { UpdateReviewSchema } from "@/schemas/feedbacks";

// GET: Public read (for trust/SEO purposes)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const review = await prisma.consultantReview.findFirst({
      // #693 — a moderation-removed review reads as gone. In the WHERE rather
      // than a branch below, so `deletedAt` never has to be selected onto a
      // public payload to be checked.
      where: { id, deletedAt: null },
      // #1300 — the shared public allowlist. This selected
      // `consulteeProfile: { id, userId }`, so a public route returned the
      // reviewer's User id for every NAMED review; the anonymity strip only
      // nulls it for rows that asked to be anonymous. A review card needs a name
      // and an avatar, and nothing else about the person.
      select: publicReviewSelect,
    });

    if (!review) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    // This route is PUBLIC (middleware.ts prefix-matches /api/user/reviews/),
    // and review ids are enumerable from the public list endpoint. Returning
    // `consulteeProfile` unfiltered therefore handed back the reviewer's
    // userId for a review they marked anonymous — one GET per id and the whole
    // feature was cosmetic. The strip belongs on every public read, not just
    // the list.
    return NextResponse.json(sanitisePublicReview(review), { status: 200 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    console.error("Error getting review:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

// PUT: the AUTHOR edits their words. Staff never write here — a staff member
// rewriting or un-anonymising a consumer review is impersonation, however well
// it is logged; moderation removes or excludes through its own routes.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { id } = await params;

    // Fetch the review to check ownership
    const review = await prisma.consultantReview.findUnique({
      where: { id: id },
      select: {
        consulteeProfileId: true,
        consultantProfileId: true,
        deletedAt: true,
      },
    });

    // #693 — a moderation-removed review cannot be edited back into view
    if (!review || review.deletedAt) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    if (!checkOwnership(session, review.consulteeProfileId, "consultee")) {
      return forbiddenResponse("You can only update your own reviews");
    }

    const parsed = UpdateReviewSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.issues },
        { status: 400 },
      );
    }
    const body = parsed.data;

    // Update + rating recompute in one transaction — ConsultantProfile.rating
    // is denormalized for explore sort/filter and must track every mutation.
    // Serializable + retry so concurrent review writes for the same consultant
    // can't lose-update the recomputed average (P2034 aborts one, retry blocks).
    const updatedReview = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // Re-read INSIDE the transaction. The guard above ran before it
          // opened, so moderation removing the review in between let the edit
          // land on a row the public can no longer see, and the author was told
          // it published.
          const current = await tx.consultantReview.findUnique({
            where: { id: id },
            select: {
              deletedAt: true,
              rating: true,
              reviewDescription: true,
              repliedAt: true,
              replyDeletedAt: true,
            },
          });
          if (current?.deletedAt) throw new ModeratedReviewError();

          // Only a changed OPINION is a revision. `isAnonymous` is a display
          // choice, not a change to what was said.
          const textChanged =
            current !== null &&
            ((body.rating !== undefined && body.rating !== current.rating) ||
              (body.reviewDescription !== undefined &&
                (body.reviewDescription ?? null) !==
                  (current.reviewDescription ?? null)));
          if (textChanged && current) {
            // Allocated by an atomic increment, not from the read above — see the
            // POST route: the row lock turns a concurrent editor's P2002 into a
            // retried P2034.
            const bumped = await tx.consultantReview.update({
              where: { id: id },
              data: { revisionNo: { increment: 1 }, editedAt: new Date() },
              select: { revisionNo: true },
            });
            await tx.consultantReviewRevision.create({
              data: {
                reviewId: id,
                revisionNo: bumped.revisionNo - 1,
                rating: current.rating,
                reviewDescription: current.reviewDescription,
                afterPublicReply:
                  current.repliedAt !== null && current.replyDeletedAt === null,
                editorUserId: session.user.id,
              },
            });
          }

          const updated = await tx.consultantReview.update({
            where: { id: id },
            data: {
              rating: body.rating,
              reviewDescription: body.reviewDescription,
              isAnonymous: body.isAnonymous,
            },
            // Explicit select, never `include` — see the POST route.
            select: publicReviewSelect,
          });

          await recomputeConsultantRating(tx, review.consultantProfileId);

          return updated;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    purgeReviewSurfaces(review.consultantProfileId);

    return NextResponse.json(sanitisePublicReview(updatedReview), {
      status: 200,
    });
  } catch (error) {
    // The re-read inside the transaction throws this when moderation removed
    // the row mid-edit. Without a branch here it fell through to the generic
    // handler and the author was told "Internal Server Error" for what is a
    // definite, explainable answer.
    if (error instanceof ModeratedReviewError) {
      return NextResponse.json(
        {
          error:
            "This review was removed by our moderation team and can't be edited.",
        },
        { status: 409 },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    console.error("Error updating review:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

// DELETE: the AUTHOR withdraws their review (soft, revivable by them). Staff
// take a review down through /api/staff/moderation, which is attributed as such.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { id } = await params;

    // Fetch the review to check ownership
    const review = await prisma.consultantReview.findUnique({
      where: { id: id },
      select: {
        consulteeProfileId: true,
        consultantProfileId: true,
        deletedAt: true,
      },
    });

    // #693 / #1300 — nobody hard-deletes a review any more, so an
    // already-removed row is simply gone as far as this handler is concerned.
    if (!review || review.deletedAt) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    if (!checkOwnership(session, review.consulteeProfileId, "consultee")) {
      return forbiddenResponse("You can only delete your own reviews");
    }

    // Soft, never hard: the unique is not partial on `deletedAt`, so the withdrawn
    // row keeps its slot and `deletedByUserId` is what lets the author revive it.
    await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const removed = await tx.consultantReview.updateMany({
            // Idempotent and race-safe: the second of two concurrent deletes
            // writes nothing rather than overwriting the first one's timestamp
            // and its attribution.
            where: { id, deletedAt: null },
            data: { deletedAt: new Date(), deletedByUserId: session.user.id },
          });
          if (removed.count === 0) return;
          await recomputeConsultantRating(tx, review.consultantProfileId);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    purgeReviewSurfaces(review.consultantProfileId);

    return NextResponse.json(
      { message: "Review deleted successfully" },
      { status: 200 },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    console.error("Error deleting review:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
