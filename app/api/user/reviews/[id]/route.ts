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
            select: {
              deletedAt: true,
              rating: true,
              reviewDescription: true,
              revisionNo: true,
              repliedAt: true,
              replyDeletedAt: true,
            },
          });
          if (current?.deletedAt) throw new ModeratedReviewError();

          // #1300 — the edit trail, and the only attribution this write has.
          // `isPrivileged` admits STAFF and ADMIN into this handler, so before
          // the trail existed a staff member could rewrite the text of a consumer
          // review and the row afterwards was indistinguishable from an author
          // edit: no ModerationAction, no audit row, no `updatedById`. Under FTC
          // 16 CFR §465 that is the highest-exposure write in the subsystem.
          // `editorUserId` now records who did it, whoever they are.
          //
          // Only a changed OPINION counts. `isAnonymous` is a display choice, not
          // a change to what was said, so toggling it alone is not a revision.
          const textChanged =
            current !== null &&
            ((body.rating !== undefined && body.rating !== current.rating) ||
              (body.reviewDescription !== undefined &&
                (body.reviewDescription ?? null) !==
                  (current.reviewDescription ?? null)));
          if (textChanged && current) {
            await tx.consultantReviewRevision.create({
              data: {
                reviewId: id,
                revisionNo: current.revisionNo,
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
              ...(textChanged
                ? { revisionNo: { increment: 1 }, editedAt: new Date() }
                : {}),
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

    // #693 / #1300 — nobody hard-deletes a review any more, so an
    // already-removed row is simply gone as far as this handler is concerned.
    if (!review || review.deletedAt) {
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

    // #1300 — SOFT delete, for the author and for staff alike. This was a hard
    // `delete()`, which had two consequences the code around it argued against.
    //
    // The unique on (consultantProfileId, consulteeProfileId, track) is
    // deliberately NOT partial on `deletedAt`, so that a removed row keeps
    // occupying the slot and the same person cannot re-post the text that was
    // taken down — the comment two lines up used to say exactly that, and then
    // the next statement destroyed the row for the live case, leaving the
    // invariant holding only against reviews moderation had already removed. An
    // unlimited post/delete/re-post cycle was available to anyone.
    //
    // And a privileged caller could hard-delete ANY review, while the sibling
    // moderation route restricts even the SOFT delete to ADMIN — the stricter
    // gate sat on the safer operation. Upwork had to retire exactly this kind of
    // "remove a review" privilege after granting it.
    //
    // `deletedByUserId` is what makes the author's withdrawal revivable while a
    // moderation removal is not; see the schema comment.
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
