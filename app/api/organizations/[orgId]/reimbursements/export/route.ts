/**
 * GET /api/organizations/[orgId]/reimbursements/export
 *
 * C4: streams a CSV of Payments tagged to the org with PERSONAL
 * fundingSource. MANAGER+ at the org.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { sumPaise } from "@/lib/payments/utils/money";
import { requireOrgAccess } from "@/lib/auth-helpers";

const QuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  userId: z.string().optional(),
});

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "reimbursements.read" });
  if (access.error) return access.error;

  const billingAccount = await prisma.billingAccount.findUnique({
    where: { ownerOrgId: orgId },
    select: { fundingSource: true },
  });
  if (!billingAccount || billingAccount.fundingSource !== "PERSONAL") {
    return NextResponse.json(
      { error: "Reimbursements export only for PERSONAL-funded orgs." },
      { status: 404 },
    );
  }

  const url = new URL(req.url);
  const filters = QuerySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    userId: url.searchParams.get("userId") ?? undefined,
  });
  if (!filters.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: filters.error.flatten() },
      { status: 400 },
    );
  }

  // Must mirror the list route's filter AND its netting exactly, or the CSV a
  // finance team actually pays from disagrees with the screen they approved.
  // See the rationale there: PaymentStatus has no REFUNDED state, so refunds
  // are netted per row rather than excluded.
  const where = {
    organizationId: orgId,
    paymentStatus: "SUCCEEDED" as const,
    deletedAt: null,
    ...(filters.data.userId && { userId: filters.data.userId }),
    ...(filters.data.from || filters.data.to
      ? {
          createdAt: {
            ...(filters.data.from && { gte: new Date(filters.data.from) }),
            ...(filters.data.to && { lte: new Date(filters.data.to) }),
          },
        }
      : {}),
  };

  const items = await prisma.payment.findMany({
    where,
    include: {
      user: { select: { id: true, name: true, email: true } },
      refunds: {
        where: { status: "SUCCEEDED" as const, deletedAt: null },
        select: { amountPaise: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 10_000, // hard ceiling; bigger exports should use the API + client-side paging
  });

  // "Amount (paise)" keeps its meaning (gross) so an existing importer reading
  // by column name is not silently repointed at a different number. The two new
  // columns are additive, and "Net reimbursable" is the one to pay.
  const header = [
    "Date",
    "Member name",
    "Member email",
    "Description",
    "Amount (paise)",
    "Refunded (paise)",
    "Net reimbursable (paise)",
    "Currency",
    "Payment ID",
    "Payment intent",
  ];
  const rows: string[] = [header.join(",")];
  for (const p of items) {
    const grossPaise = sumPaise(p.amount);
    const refundedPaise = p.refunds.reduce(
      (acc, r) => acc + sumPaise(r.amountPaise),
      0,
    );
    // Clamped for the same reason as the list route: an over-refund must not
    // become a negative deduction against the rest of the payroll run.
    const netPaise = Math.max(0, grossPaise - refundedPaise);
    rows.push(
      [
        p.createdAt.toISOString(),
        csvEscape(p.user.name ?? ""),
        csvEscape(p.user.email),
        csvEscape(p.description ?? ""),
        String(grossPaise),
        String(refundedPaise),
        String(netPaise),
        p.currency,
        p.id,
        p.paymentIntent,
      ].join(","),
    );
  }
  const csv = rows.join("\n");

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="reimbursements-${orgId}-${Date.now()}.csv"`,
    },
  });
}
