/**
 * GET /api/organizations/[orgId]/disputes
 *
 * Per-org dispute/chargeback surface (#776 §C). Lists disputes raised against
 * org-funded payments (Payment.organizationId == orgId) so an operator can see
 * what's contested and how it was settled. Read-only and finance-gated — the
 * chargeback money-path (org-wallet-first clawback) settles server-side in the
 * gateway webhook (`handleDisputeUpdated`), not here.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

const DisputeStatusSchema = z.enum([
  "WARNING_NEEDS_RESPONSE",
  "WARNING_UNDER_REVIEW",
  "WARNING_CLOSED",
  "NEEDS_RESPONSE",
  "UNDER_REVIEW",
  "CHARGE_REFUNDED",
  "WON",
  "LOST",
  "CLOSED",
]);

const QuerySchema = z.object({
  status: DisputeStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // Finance READ surface — MANAGER+ (incl. BILLING_ADMIN), matching the
  // payouts/billing read gate and the sidebar's isFinance visibility.
  const access = await requireOrgAccess(orgId, { permission: "disputes.read" });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const q = parsed.data;

  const disputes = await prisma.dispute.findMany({
    where: {
      payment: { organizationId: orgId },
      ...(q.status && { status: q.status }),
    },
    orderBy: { createdAt: "desc" },
    take: q.limit,
    select: {
      id: true,
      disputeId: true,
      amountPaise: true,
      currency: true,
      reason: true,
      status: true,
      dueBy: true,
      createdAt: true,
      updatedAt: true,
      payment: { select: { id: true, billingAccountId: true } },
    },
  });

  return NextResponse.json({ data: disputes });
}
