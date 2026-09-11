import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import {
  requireApiAuth,
  isPrivileged,
  checkOwnership,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { recomputeConsultantRating, ModeratedReviewError } from "@/lib/reviews";
import { stripAnonymousReviewer } from "@/lib/data/review-privacy";
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

    const review = await prisma.consultantReview.findUnique({
      where: { id: id },
      include: {
        // #946 allowlist. `consultantProfile: true` returns every scalar,
        // including panNumber / ibanOrAccount / swiftBic / udyamNumber — and
        // this route is public.
        consultantProfile: { select: consultantPublicScalars },
        consulteeProfile: { select: { id: true, userId: true } },
      },
    });

    // #693 — a moderation-removed review reads as gone
    if (!review || review.deletedAt) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    // This route is PUBLIC (middleware.ts prefix-matches /api/user/reviews/),
    // and review ids are enumerable from the public list endpoint. Returning
    // `consulteeProfile` unfiltered therefore handed back the reviewer's
    // userId for a review they marked anonymous — one GET per id and the whole
    // feature was cosmetic. The strip belongs on every public read, not just
    // the list.
    return NextResponse.json(stripAnonymousReviewer(review), { status: 200 });
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

// PUT: Requires auth + ownership
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

    // Check authorization: privileged users can update any, others only their own
    const isOwner = checkOwnership(
      session,
      review.consulteeProfileId,
      "consultee",
    );
    if (!isPrivileged(session.user.role) && !isOwner) {
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
            select: { deletedAt: true },
          });
          if (current?.deletedAt) throw new ModeratedReviewError();

          const updated = await tx.consultantReview.update({
            where: { id: id },
            data: {
              rating: body.rating,
              reviewDescription: body.reviewDescription,
              isAnonymous: body.isAnonymous,
            },
            include: {
              consultantProfile: { select: consultantPublicScalars },
              consulteeProfile: { select: { id: true, userId: true } },
            },
          });

          await recomputeConsultantRating(tx, review.consultantProfileId);

          return updated;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    purgeReviewSurfaces(review.consultantProfileId);

    return NextResponse.json(updatedReview, { status: 200 });
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

// DELETE: Requires auth + ownership
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

    // #693 — an AUTHOR must not be able to hard-delete a review moderation has
    // removed. The soft delete is the audit trail, and the unique on
    // (consultantProfileId, consulteeProfileId) is deliberately not partial on
    // deletedAt precisely so the row keeps occupying the slot: deleting it here
    // both destroyed the record and freed the pair for the same person to
    // re-post the text that was taken down. Staff keep the power.
    if (!review || (review.deletedAt && !isPrivileged(session.user.role))) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    // Check authorization: privileged users can delete any, others only their own
    const isOwner = checkOwnership(
      session,
      review.consulteeProfileId,
      "consultee",
    );
    if (!isPrivileged(session.user.role) && !isOwner) {
      return forbiddenResponse("You can only delete your own reviews");
    }

    // Delete + rating recompute in one transaction — see PUT.
    await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          await tx.consultantReview.delete({
            where: { id: id },
          });
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
