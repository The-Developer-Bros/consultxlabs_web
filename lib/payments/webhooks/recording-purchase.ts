/**
 * Replay purchase webhook settlement (#366).
 *
 * notes.type === "recording_purchase" orders are NOT Payment rows, so the
 * legacy handlePaymentSuccess family would silently no-op on them. This
 * handler flips the matching RecordingPurchase row PENDING → SUCCEEDED.
 *
 * Idempotency: keyed on gatewayOrderId (unique). A replayed capture hits the
 * already-SUCCEEDED early return. `payment.failed` marks the row FAILED only
 * from PENDING — a capture that raced ahead of the failure event wins.
 */
import prisma from "@/lib/prisma";
import * as Sentry from "@sentry/nextjs";

export async function handleRecordingPurchaseSuccess(
  orderId: string,
  gatewayPaymentId?: string,
): Promise<void> {
  const purchase = await prisma.recordingPurchase.findUnique({
    where: { gatewayOrderId: orderId },
    select: { id: true, status: true },
  });

  if (!purchase) {
    // Unknown order — log loudly; the sweeper can't re-drive what has no row.
    console.error(
      `[recording-purchase] captured order ${orderId} has no RecordingPurchase row`,
    );
    Sentry.captureMessage(
      `[recording-purchase] captured order without row: ${orderId}`,
      { level: "error", tags: { subsystem: "payments" } },
    );
    return;
  }

  if (purchase.status === "SUCCEEDED") return; // idempotent replay

  await prisma.recordingPurchase.update({
    where: { id: purchase.id },
    data: {
      status: "SUCCEEDED",
      ...(gatewayPaymentId ? { gatewayPaymentId } : {}),
    },
  });
}

export async function handleRecordingPurchaseFailure(
  orderId: string,
): Promise<void> {
  // Only PENDING → FAILED; a captured (SUCCEEDED) purchase can never be
  // flipped to FAILED by an out-of-order failure event.
  await prisma.recordingPurchase.updateMany({
    where: { gatewayOrderId: orderId, status: "PENDING" },
    data: { status: "FAILED" },
  });
}
