/**
 * Staff Moderation Review Detail API
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { recomputeConsultantRating } from "@/lib/reviews";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { purgeReviewSurfaces } from "@/lib/data/public-cache";
import { Prisma } from "@prisma/client";
interface RouteParams {
  params: Promise<{ reviewId: string }>;
}

/**
 * DELETE /api/staff/moderation/reviews/[reviewId]
 * Delete a review (admin only)
 */
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    // Only admins can delete reviews
    if (session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { reviewId } = await params;

    const review = await prisma.consultantReview.findUnique({
      where: { id: reviewId },
      select: {
        consultantProfileId: true,
        deletedAt: true,
        deletedByUserId: true,
        consulteeProfile: { select: { userId: true } },
      },
    });

    if (!review) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    // Soft, attributed, and CAS'd in the WHERE. A takedown also lands on an
    // AUTHOR-withdrawn row (moderation wins; the author could otherwise revive
    // it), and is a no-op on a row moderation already removed. Serializable +
    // retry so the recompute cannot lose-update against a concurrent review write.
    const authorId = review.consulteeProfile.userId;
    await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const removed = await tx.consultantReview.updateMany({
            where: {
              id: reviewId,
              OR: [{ deletedAt: null }, { deletedByUserId: authorId }],
            },
            data: { deletedAt: new Date(), deletedByUserId: session.user.id },
          });
          if (removed.count === 0) return;
          await recomputeConsultantRating(tx, review.consultantProfileId);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    // #705 — the moderation paths never purged, so a removed review kept
    // rendering on the landing page and explore for up to an hour.
    purgeReviewSurfaces(review.consultantProfileId);

    return NextResponse.json({
      success: true,
      message: "Review removed and consultant rating recalculated",
    });
  } catch (error) {
    console.error("Error deleting review:", error);
    return NextResponse.json(
      { error: "Failed to delete review" },
      { status: 500 },
    );
  }
}
