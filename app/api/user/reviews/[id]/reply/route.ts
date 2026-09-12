/**
 * #1300 — the consultant's right of reply.
 *
 * `ConsultantReview.replyBody` / `repliedAt` / `replyDeletedAt` have existed since
 * #705 and ADR 25 listed the right of reply as a shipped consequence. It was not:
 * the three columns had no writer, no reader and no route. This is the writer.
 *
 * It is not merely a feature. BIS IS 19000:2022 — India's standard for online
 * consumer reviews — asks that the reviewed party be able to respond, and the
 * same expectation appears in Practo's 24-hour private window and Google's and
 * Booking.com's reply affordances. A public review of a named professional with
 * no way to answer it is the one shape everybody has moved away from.
 *
 * Deliberately NOT a moderation lever. A reply cannot change the rating, cannot
 * hide the review, and cannot stop the author editing it — see the note on
 * `ConsultantReviewRevision.afterPublicReply` for why the edit mark is not
 * conditional on a reply either. The consultant gets a voice, not a veto.
 */
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";
import { purgeReviewSurfaces } from "@/lib/data/public-cache";
import { applyRateLimit, reviewWriteLimiter } from "@/lib/rate-limit";
import { MAX_TEXT_LENGTH, assertBodySize } from "@/lib/validation/limits";

const ReplySchema = z.object({
  // Trimmed and bounded like every other user-typed string here (#831). Empty is
  // rejected rather than treated as a delete: removing a reply is DELETE, and
  // conflating the two makes an accidental clear indistinguishable from intent.
  body: z
    .string()
    .trim()
    .min(1, "A reply needs something in it")
    .max(MAX_TEXT_LENGTH),
});

/** The reviewed consultant, or platform staff. Nobody else. */
async function authorizeReply(reviewId: string, userId: string, role?: string) {
  const review = await prisma.consultantReview.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      deletedAt: true,
      replyDeletedAt: true,
      replyRemovedBy: true,
      consultantProfileId: true,
      consultantProfile: { select: { userId: true } },
    },
  });
  if (!review) return { ok: false as const, status: 404 };
  // A review moderation has removed is not answerable. Replying to it would
  // publish nothing and imply the review is still there.
  if (review.deletedAt) return { ok: false as const, status: 404 };
  const isSubject = review.consultantProfile.userId === userId;
  if (!isSubject && !isPrivileged(role)) {
    return { ok: false as const, status: 403 };
  }
  return { ok: true as const, review, isSubject };
}

/** Write or replace the reply. */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    // 20 an hour, like review writes: every attempt counts, including a 409.
    const rl = await applyRateLimit(
      reviewWriteLimiter,
      `review-reply:${session.user.id}`,
    );
    if (rl) return rl;
    const tooBig = assertBodySize(req);
    if (tooBig) return tooBig;

    const { id } = await params;
    const auth = await authorizeReply(id, session.user.id, session.user.role);
    if (!auth.ok) {
      return NextResponse.json(
        {
          error:
            auth.status === 404
              ? "Review not found"
              : "Only the reviewed expert can write a reply",
        },
        { status: auth.status },
      );
    }
    // Staff may REMOVE an abusive reply; they may not author one in the
    // consultant's voice. A reply attributed to the reviewed party has to have
    // come from them.
    if (!auth.isSubject) {
      return NextResponse.json(
        { error: "Only the reviewed expert can write a reply" },
        { status: 403 },
      );
    }

    // A reply moderation removed stays removed: overwriting it would destroy the
    // evidence for the takedown. The consultant's own withdrawal is theirs to replace.
    const takenDown =
      auth.review.replyDeletedAt !== null &&
      auth.review.replyRemovedBy === "MODERATION";
    if (takenDown) {
      return NextResponse.json(
        {
          error:
            "Your previous reply was removed by our moderation team. Contact support to reply again.",
        },
        { status: 409 },
      );
    }

    const parsed = ReplySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid reply",
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400 },
      );
    }

    // Liveness AND the takedown decision in the WRITE, not only in the
    // authorization read: a staff removal landing between the two must not be
    // overwritten, nor its attribution nulled.
    const repliedAt = new Date();
    const written = await prisma.consultantReview.updateMany({
      where: {
        id,
        deletedAt: null,
        OR: [{ replyDeletedAt: null }, { replyRemovedBy: "AUTHOR" }],
      },
      data: {
        replyBody: parsed.data.body,
        repliedAt,
        replyDeletedAt: null,
        replyRemovedBy: null,
      },
    });
    // Zero rows: the review stopped being live, or staff removed the reply,
    // between the two statements. Re-read to answer with the right one.
    if (written.count === 0) {
      const now = await prisma.consultantReview.findUnique({
        where: { id },
        select: { deletedAt: true, replyDeletedAt: true },
      });
      if (now && now.deletedAt === null && now.replyDeletedAt !== null) {
        return NextResponse.json(
          {
            error:
              "Your previous reply was removed by our moderation team. Contact support to reply again.",
          },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    // The reply renders inside the review card on the profile and the landing
    // page, both cached — an unpurged reply is invisible for up to an hour.
    purgeReviewSurfaces(auth.review.consultantProfileId);

    return NextResponse.json(
      { data: { replyBody: parsed.data.body, repliedAt } },
      { status: 200 },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "reviews" } },
    );
    return NextResponse.json(
      { error: "Failed to save the reply" },
      { status: 500 },
    );
  }
}

/**
 * Soft-remove the reply.
 *
 * `replyDeletedAt` is separate from the review's own `deletedAt` precisely so
 * staff can take down an abusive reply without erasing the consumer review
 * underneath it. The body is left in place: it is the evidence for the takedown,
 * and every public read drops it via `sanitisePublicReview`.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { id } = await params;
    const auth = await authorizeReply(id, session.user.id, session.user.role);
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.status === 404 ? "Review not found" : "Forbidden" },
        { status: auth.status },
      );
    }

    // Idempotent and CAS'd: two staff acting at once cannot move the stamp twice.
    // The actor decides whether the consultant may write again; a staff takedown
    // also writes the audit row (#1562) in the same transaction.
    const actor = auth.isSubject ? "AUTHOR" : "MODERATION";
    const removed = await prisma.$transaction(async (tx) => {
      const result = await tx.consultantReview.updateMany({
        where: { id, replyDeletedAt: null, replyBody: { not: null } },
        data: { replyDeletedAt: new Date(), replyRemovedBy: actor },
      });
      if (result.count > 0 && actor === "MODERATION") {
        await tx.moderationAction.create({
          data: {
            actionType: "REVIEW_REPLY_REMOVED",
            reviewId: id,
            takenById: session.user.id,
          },
        });
      }
      return result;
    });
    if (removed.count > 0) {
      purgeReviewSurfaces(auth.review.consultantProfileId);
    }

    return NextResponse.json({ data: { removed: removed.count > 0 } });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "reviews" } },
    );
    return NextResponse.json(
      { error: "Failed to remove the reply" },
      { status: 500 },
    );
  }
}
