/**
 * GET  /api/organizations/[orgId]/webhooks
 * POST /api/organizations/[orgId]/webhooks
 *
 * Org-scoped CRUD for outbound webhook endpoints. The secret returned
 * on POST is the **only** time the caller sees the raw value — every
 * subsequent GET redacts it to a fixed marker so a compromised dashboard
 * session can't exfiltrate signing material. Rotate via the dedicated
 * `/rotate-secret` route (OWNER-only) if it's lost.
 *
 * GET is MANAGER+ (read-only view shows up on the billing dashboard's
 * Integrations card). POST is OWNER + BILLING_ADMIN per the gate
 * matrix in `docs/enterprise/00-foundations/04-roles-and-permissions.md`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  OUTBOUND_WEBHOOK_EVENTS,
  isOutboundWebhookEvent,
} from "@/lib/enterprise/outbound-webhooks/event-types";
import { generateEndpointSecret } from "@/lib/enterprise/outbound-webhooks/signing";
import { applyRateLimit, orgWebhookLimiter } from "@/lib/rate-limit";
import { rejectIfNotPublicUrl } from "@/lib/enterprise/outbound-webhooks/ssrf-guard";

const REDACTED_SECRET = "[redacted]";

/**
 * Why the URL is constrained to https:// only
 * -------------------------------------------
 * Outbound webhooks carry PII (member emails, invoice line items). A
 * plain-http URL would leak that PII over the network. The schema
 * refuses anything other than `https://` at registration time.
 *
 * Scheme is necessary but not sufficient: `assertPublicUrl` additionally
 * proves the host resolves to a publicly routable address, and runs again at
 * delivery time because DNS can be repointed after registration (#1132).
 */
const HttpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://"), {
    message: "Webhook URL must use https://",
  })
  .refine((u) => u.length <= 2048, {
    message: "Webhook URL must be ≤2048 characters",
  });

const CreateBodySchema = z.object({
  url: HttpsUrl,
  /**
   * Subset of `OUTBOUND_WEBHOOK_EVENTS`. We narrow each entry via the
   * exported type guard so unknown event types fail the Zod parse
   * (rather than silently writing junk into the eventSubscriptions
   * array that the dispatch helper would never match).
   */
  eventSubscriptions: z
    .array(z.string())
    .min(1, "Subscribe to at least one event")
    .refine((arr) => arr.every(isOutboundWebhookEvent), {
      message: `Unknown event type. Allowed: ${OUTBOUND_WEBHOOK_EVENTS.join(", ")}`,
    }),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { minimumRole: "MANAGER" });
  if (access.error) return access.error;

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { organizationId: orgId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      url: true,
      status: true,
      eventSubscriptions: true,
      failureCount: true,
      lastSuccessAt: true,
      lastFailureAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // Redact-by-construction: the SELECT above never reads `secret`, so
  // there's no value to leak even by serialization mistake.
  return NextResponse.json({
    data: endpoints.map((e) => ({ ...e, secret: REDACTED_SECRET })),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgBillingAdminOrOwner(orgId);
  if (access.error) return access.error;

  const rl = await applyRateLimit(orgWebhookLimiter, `org:${orgId}`);
  if (rl) return rl;

  const raw = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // #1132 — the URL is attacker-chosen, so it must be proven publicly routable
  // before we ever dial it. Re-checked at delivery time too, since DNS can be
  // repointed after registration.
  const blocked = await rejectIfNotPublicUrl(parsed.data.url);
  if (blocked) return blocked;

  // 32-byte secret minted ONCE; written to the DB and returned to the
  // caller verbatim. The dashboard surfaces a "copy now, you won't see
  // it again" UX so admins are nudged into storing it in their secrets
  // manager before navigating away.
  const secret = generateEndpointSecret();

  const created = await prisma.$transaction(async (tx) => {
    const endpoint = await tx.webhookEndpoint.create({
      data: {
        organizationId: orgId,
        url: parsed.data.url,
        secret,
        status: "ACTIVE",
        eventSubscriptions: parsed.data.eventSubscriptions,
        createdByMembershipId: access.member.id,
      },
    });
    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "WEBHOOK",
        action: AUDIT_ACTIONS.WEBHOOK.WEBHOOK_ENDPOINT_CREATED,
        description: `Created webhook endpoint ${endpoint.url}`,
        details: {
          endpointId: endpoint.id,
          url: endpoint.url,
          eventSubscriptions: endpoint.eventSubscriptions,
        },
      },
    });
    return endpoint;
  });

  return NextResponse.json(
    {
      endpoint: {
        id: created.id,
        url: created.url,
        status: created.status,
        eventSubscriptions: created.eventSubscriptions,
        // ONE-TIME secret reveal — see top-of-file comment.
        secret,
        createdAt: created.createdAt,
      },
    },
    { status: 201 },
  );
}
