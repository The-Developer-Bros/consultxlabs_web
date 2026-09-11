/**
 * GET /api/organizations/[orgId]/webhooks/[endpointId]/deliveries
 *
 * Paginated delivery log. MANAGER+ — the same role-floor as the
 * endpoint list because the delivery body itself can carry PII
 * (the original event payload mirrors the route that triggered it).
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

export async function GET(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; endpointId: string }>;
  },
) {
  const { orgId, endpointId } = await params;
  const access = await requireOrgAccess(orgId, { minimumRole: "MANAGER" });
  if (access.error) return access.error;

  // Verify the endpoint belongs to this org BEFORE touching the
  // delivery table — otherwise a guessed endpointId from a sibling
  // org would leak that org's delivery payloads.
  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id: endpointId, organizationId: orgId },
    select: { id: true },
  });
  if (!endpoint) {
    return NextResponse.json(
      { error: "Webhook endpoint not found" },
      { status: 404 },
    );
  }

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const perPage = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("perPage") ?? 25)),
  );

  const [total, deliveries] = await prisma.$transaction([
    prisma.outboundWebhookDelivery.count({
      where: { webhookEndpointId: endpointId },
    }),
    prisma.outboundWebhookDelivery.findMany({
      where: { webhookEndpointId: endpointId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        eventType: true,
        status: true,
        httpStatusCode: true,
        attempts: true,
        nextRetryAt: true,
        lastError: true,
        createdAt: true,
        deliveredAt: true,
        // Payload is intentionally included — operators need it to
        // diagnose receiver-side parse failures. The MANAGER role-floor
        // is the gate; below that role the row would not be readable.
        payload: true,
      },
    }),
  ]);

  return NextResponse.json({
    data: deliveries,
    meta: { total, page, perPage },
  });
}
