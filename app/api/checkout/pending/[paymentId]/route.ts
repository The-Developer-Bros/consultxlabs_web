import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import { applyRateLimit, cancelPendingLimiter } from "@/lib/rate-limit";
import { cancelPendingCheckout } from "@/lib/payments/operations/cancel-pending";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";

// Serializable write-conflict shapes — P2034 plus the Prisma 7 client-engine
// message variants. Surfaces when withSerializableRetry exhausts its retries
// under heavy same-row contention (observed at 8 concurrent cancels in the
// multi-agent race validation).
function isWriteConflict(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2034"
  ) {
    return true;
  }
  return (
    error instanceof Error &&
    /write conflict|TransactionWriteConflict|deadlock/i.test(error.message)
  );
}

/**
 * #849 — release the caller's own tentative checkout hold.
 *
 * DELETE expires the caller's PENDING payment, restores referral credits,
 * deletes the tentative slots, and cancels the parent request (narrow
 * from-set — never a parent another payment already confirmed). All race
 * handling lives in `cancelPendingCheckout`.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await applyRateLimit(cancelPendingLimiter, session.user.id);
  if (rl) return rl;

  const { paymentId } = await params;

  try {
    const result = await cancelPendingCheckout({
      paymentId,
      userId: session.user.id,
    });

    if (!result.ok) {
      if (result.code === "NOT_FOUND") {
        return NextResponse.json(
          { error: "Payment not found" },
          { status: 404 },
        );
      }
      // NOT_PENDING — the webhook confirmed it, the cleanup cron expired
      // it, or a parallel cancel won.
      return NextResponse.json(
        { error: "Payment is no longer pending" },
        { status: 409 },
      );
    }

    return NextResponse.json({
      success: true,
      slotsReleased: result.slotsReleased,
    });
  } catch (error) {
    // A parent that already moved on (APPROVED/SCHEDULED) rolls the whole
    // cancellation back — surface as a conflict, not a server error.
    if (error instanceof IllegalTransitionError) {
      return NextResponse.json(
        { error: "Booking is no longer cancellable from checkout" },
        { status: 409 },
      );
    }
    // Retry-exhausted Serializable conflict: another writer (a parallel
    // cancel or the capture webhook) owns this payment right now — that is
    // a conflict outcome, not a server error. The winner's verdict stands;
    // the client refetches.
    if (isWriteConflict(error)) {
      return NextResponse.json(
        { error: "Payment is being updated concurrently — refresh and retry" },
        { status: 409 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "checkout" } });
    console.error(
      JSON.stringify({
        event: "cancel_pending_failed",
        paymentId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
    return NextResponse.json(
      { error: "Failed to cancel pending booking" },
      { status: 500 },
    );
  }
}
