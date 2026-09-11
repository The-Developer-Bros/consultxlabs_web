/**
 * POST /api/organizations/[orgId]/webhooks/[endpointId]/deliveries/[deliveryId]/redeliver
 *
 * Re-queues an existing delivery row by flipping its status back to
 * PENDING and clearing the failure metadata. The worker picks it up on
 * the next tick.
 *
 * Why we copy the existing payload, not snapshot the live event
 * --------------------------------------------------------------
 * The event-at-original-creation is the deliverable contract. Replaying
 * the SAME payload (signed with the current secret) is the integrator's
 * expected recovery path: "your receiver was down at 03:00 UTC, click
 * Replay to push the original body through." Re-snapshotting the live
 * entity would carry whatever drift has happened in the interim (an
 * invoice that was later voided, a member that was then suspended)
 * which is not what the receiver originally subscribed to.
 *
 * Why OWNER + BILLING_ADMIN (not MANAGER): replaying a webhook fires
 * external side effects in the receiver — finance-team or owner scope.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { applyRateLimit, orgWebhookLimiter } from "@/lib/rate-limit";

export async function POST(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{
      orgId: string;
      endpointId: string;
      deliveryId: string;
    }>;
  },
) {
  const { orgId, endpointId, deliveryId } = await params;
  const access = await requireOrgBillingAdminOrOwner(orgId);
  if (access.error) return access.error;

  const rl = await applyRateLimit(orgWebhookLimiter, `org:${orgId}`);
  if (rl) return rl;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const delivery = await tx.outboundWebhookDelivery.findFirst({
        where: { id: deliveryId, webhookEndpointId: endpointId },
        include: {
          endpoint: { select: { organizationId: true, status: true } },
        },
      });
      if (!delivery || delivery.endpoint.organizationId !== orgId) {
        throw Object.assign(new Error("Delivery not found"), {
          httpStatus: 404,
        });
      }
      if (delivery.endpoint.status !== "ACTIVE") {
        // Refuse to replay against an explicitly-paused endpoint —
        // the worker would just abort it again with the same FAILED
        // status. Better to surface the operator-actionable error here.
        throw Object.assign(
          new Error(
            "Cannot replay a delivery whose endpoint is not ACTIVE. Resume the endpoint first.",
          ),
          { httpStatus: 409 },
        );
      }
      // CAS — only settled rows may be replayed. PENDING is already queued,
      // RETRY already has a slot, and resetting an IN_FLIGHT row mid-delivery
      // would double-send and orphan the worker's claim.
      const requeued = await tx.outboundWebhookDelivery.updateMany({
        where: {
          id: deliveryId,
          status: { in: ["SUCCESS", "FAILED", "DEAD_LETTER"] },
        },
        // Reset attempt counters + clear retry slot so the worker
        // treats this as a fresh PENDING row at the next tick.
        data: {
          status: "PENDING",
          attempts: 0,
          nextRetryAt: null,
          lastError: null,
          httpStatusCode: null,
          signature: null,
          deliveredAt: null,
        },
      });
      if (requeued.count === 0) {
        throw Object.assign(
          new Error(
            "Delivery is already queued or in flight — only settled (success/failed/dead-letter) deliveries can be replayed.",
          ),
          { httpStatus: 409 },
        );
      }
      const next = await tx.outboundWebhookDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "WEBHOOK",
          action: AUDIT_ACTIONS.WEBHOOK.WEBHOOK_DELIVERY_REDELIVERED,
          description: `Re-queued delivery ${deliveryId} (event ${delivery.eventType})`,
          details: { deliveryId, endpointId, eventType: delivery.eventType },
        },
      });
      return next;
    });
    return NextResponse.json({
      delivery: {
        id: updated.id,
        status: updated.status,
      },
    });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      return NextResponse.json(
        { error: err.message },
        { status: (err as { httpStatus?: number }).httpStatus ?? 500 },
      );
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    throw err;
  }
}
