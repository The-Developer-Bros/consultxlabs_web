/**
 * POST /api/organizations/[orgId]/webhooks/[endpointId]/rotate-secret
 *
 * Mints a fresh 32-byte secret for the endpoint and returns it ONCE.
 * The prior secret is stashed and `secretRotatedAt` is stamped so the
 * worker dual-signs deliveries with BOTH secrets for a 24h grace
 * window (see signing.ts / worker.ts) — receivers stay green while they
 * roll their env var. Use case: a leaked secret, or rotation hygiene on
 * a compliance schedule.
 *
 * OWNER-only on purpose — rotating the secret is sensitive from the
 * integrator's perspective (the 24h dual-sign window softens the
 * cutover, but their verification code still must adopt the new secret
 * before the window closes), so we want the gate to be the
 * highest-trust role. BILLING_ADMIN can pause/disable but not rotate.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { generateEndpointSecret } from "@/lib/enterprise/outbound-webhooks/signing";
import { applyRateLimit, orgWebhookLimiter } from "@/lib/rate-limit";

export async function POST(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; endpointId: string }>;
  },
) {
  const { orgId, endpointId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const rl = await applyRateLimit(orgWebhookLimiter, `org:${orgId}`);
  if (rl) return rl;

  const newSecret = generateEndpointSecret();

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.webhookEndpoint.findFirst({
        where: { id: endpointId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("Webhook endpoint not found"), {
          httpStatus: 404,
        });
      }
      const next = await tx.webhookEndpoint.update({
        where: { id: endpointId },
        data: {
          secret: newSecret,
          // NOTE: holds the previous secret VALUE (not a hash) during the
          // rotation grace window so the worker can dual-sign; field name
          // is legacy — rename at the next schema reset. #768
          previousSecretHash: current.secret,
          secretRotatedAt: new Date(),
        },
      });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "WEBHOOK",
          action: AUDIT_ACTIONS.WEBHOOK.WEBHOOK_SECRET_ROTATED,
          description: `Rotated secret for webhook endpoint ${current.url}`,
          details: { endpointId, url: current.url, graceWindowHours: 24 },
        },
      });
      return next;
    });

    return NextResponse.json({
      endpoint: {
        id: updated.id,
        url: updated.url,
        status: updated.status,
        secret: newSecret,
        updatedAt: updated.updatedAt,
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
