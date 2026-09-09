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
import { applyRateLimit, spamLimiter } from "@/lib/rate-limit";
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

    const rl = await applyRateLimit(
      spamLimiter,
      `review-reply:${session.user.id}`,
    );
    if (rl) return rl;
    const tooBig = assertBodySize(req);
    if (tooBig) return tooBig;

    const { id } = await params;
    const auth = await authorizeReply(id, session.user.id, session.user.role);
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.status === 404 ? "Review not found" : "Forbidden" },
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

    const parsed = ReplySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid reply",
          details: parsed.error.flatten().fieldErrors,
        },
        { status: 400 },
      );
    }

    // The liveness predicate goes in the WRITE, not only in the authorization
    // read. `authorizeReply` checked `deletedAt` a moment ago and the `update`
    // keyed on the id alone, so a review soft-deleted in between still got its
    // reply saved and a 200 — answering success for a reply that publishes
    // nothing, on a review the reader is being told is still there. `updateMany`
    // so the check and the write are one statement; the same shape DELETE below
    // already uses.
    const repliedAt = new Date();
    const written = await prisma.consultantReview.updateMany({
      where: { id, deletedAt: null },
      data: {
        replyBody: parsed.data.body,
        repliedAt,
        // Replacing a reply staff had removed un-removes it, which is correct:
        // the takedown was of the previous text. Their next removal is one call
        // away, and the alternative — a permanent ban on replying — is a
        // punishment nobody chose.
        replyDeletedAt: null,
      },
    });
    // Zero rows means the review stopped being live between the two statements.
    // 404 and not 409, matching what `authorizeReply` would have answered a
    // moment earlier: there is nothing to retry against.
    if (written.count === 0) {
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

    // Idempotent: removing an already-removed reply is a no-op, not a 409. The
    // CAS is in the WHERE so two staff acting at once cannot move the stamp
    // twice and lose the earlier removal time.
    const removed = await prisma.consultantReview.updateMany({
      where: { id, replyDeletedAt: null, replyBody: { not: null } },
      data: { replyDeletedAt: new Date() },
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
