import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { previewOverageForBooking } from "@/lib/payments/billing/overage-preview";
import type { CoveredPlanType } from "@prisma/client";

/**
 * #777 §C — advisory pre-checkout overage preview. Any ACTIVE member can ask
 * "will booking this plan via this org breach my cap, and what does it cost?".
 *
 * The price is read SERVER-SIDE from the plan (no client-supplied amount, no
 * paise/rupee ambiguity); it's the plan's list price, so the preview is a safe
 * (slight over-) estimate vs the post-discount charge. The authoritative charge
 * is still computed at checkout by `recordOverageAtCheckout`.
 */
const QuerySchema = z.object({
  planType: z.enum(["CONSULTATION", "CLASS", "WEBINAR", "SUBSCRIPTION"]),
  planId: z.string().min(1),
  sessions: z.coerce.number().int().min(1).max(1000).default(1),
});

async function planListPricePaise(
  planType: CoveredPlanType,
  planId: string,
): Promise<number | null> {
  switch (planType) {
    case "CONSULTATION":
      return (
        (
          await prisma.consultationPlan.findUnique({
            where: { id: planId },
            select: { price: true },
          })
        )?.price ?? null
      );
    case "SUBSCRIPTION":
      return (
        (
          await prisma.subscriptionPlan.findUnique({
            where: { id: planId },
            select: { price: true },
          })
        )?.price ?? null
      );
    case "WEBINAR":
      return (
        (
          await prisma.webinarPlan.findUnique({
            where: { id: planId },
            select: { price: true },
          })
        )?.price ?? null
      );
    case "CLASS":
      return (
        (
          await prisma.classPlan.findUnique({
            where: { id: planId },
            select: { price: true },
          })
        )?.price ?? null
      );
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    planType: url.searchParams.get("planType"),
    planId: url.searchParams.get("planId"),
    sessions: url.searchParams.get("sessions") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid preview params", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const pricePaise = await planListPricePaise(
    parsed.data.planType,
    parsed.data.planId,
  );
  if (pricePaise == null) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  const result = await previewOverageForBooking({
    organizationId: orgId,
    membershipId: access.member.id,
    coveredPlanType: parsed.data.planType,
    bookingPricePaise: pricePaise,
    engagementsConsumed: parsed.data.sessions,
  });

  return NextResponse.json(result);
}
