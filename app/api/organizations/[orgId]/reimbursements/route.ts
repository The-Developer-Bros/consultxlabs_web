/**
 * GET /api/organizations/[orgId]/reimbursements
 *
 * C4: lists Payments tagged to the org where the org's BillingAccount
 * is on PERSONAL fundingSource — i.e., members paid out of pocket and
 * the org needs a reimbursement report. MANAGER+ at the org.
 *
 * Returns rows + per-member totals in INR paise. CSV export lives at
 * `/export/route.ts`.
 *
 * Query params:
 *   - `from`, `to` — ISO date range (inclusive)
 *   - `userId` — filter to a single member
 *   - `page`, `perPage` — pagination
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { parsePagination } from "@/lib/enterprise/validators";
import { sumPaise } from "@/lib/payments/utils/money";

const QuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  userId: z.string().optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "reimbursements.read" });
  if (access.error) return access.error;

  // Conditional render: only orgs whose BillingAccount.fundingSource is
  // PERSONAL get reimbursement views. Other funding modes (WALLET,
  // INVOICE, LICENSE) settle through their own dashboards.
  const billingAccount = await prisma.billingAccount.findUnique({
    where: { ownerOrgId: orgId },
    select: { fundingSource: true },
  });
  if (!billingAccount || billingAccount.fundingSource !== "PERSONAL") {
    return NextResponse.json(
      {
        error:
          "Reimbursements view is only available for organizations on PERSONAL funding.",
      },
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
  const pagination = parsePagination(url);

  // `PaymentStatus` has no REFUNDED state (PENDING/SUCCEEDED/FAILED/EXPIRED)
  // — refunds live in the separate `Refund` model and never touch
  // `paymentStatus`, so filtering on SUCCEEDED alone once put fully refunded
  // bookings on the payroll report and the org reimbursed cash the member had
  // already been given back.
  //
  // Dropping every refunded row fixed that but broke the other direction: a
  // ₹1,000 payment with a ₹100 refund reimbursed ₹0 rather than ₹900. Both are
  // wrong, so the report nets instead. Refunds stay in the query and each row
  // carries `refundedPaise` and `netReimbursablePaise`.
  //
  // Fully refunded rows are KEPT, at a net of zero, rather than filtered out.
  // Netting cannot be expressed in a Prisma `where` (it compares an aggregate
  // to a column), so removing them would mean post-filtering a paginated page
  // and returning short pages. Showing them at ₹0 also makes the report
  // self-explanatory: finance sees the payment, the refund and the zero,
  // instead of a row that silently isn't there.
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

  const succeededRefunds = {
    where: { status: "SUCCEEDED" as const, deletedAt: null },
    select: { amountPaise: true },
  };

  /** Gross, refunded and net for one payment, all in paise. */
  function netOf(payment: {
    amount: bigint | number;
    refunds: { amountPaise: bigint | number }[];
  }) {
    const grossPaise = sumPaise(payment.amount);
    const refundedPaise = payment.refunds.reduce(
      (acc, r) => acc + sumPaise(r.amountPaise),
      0,
    );
    // Clamped: an over-refund would otherwise make the row a negative
    // deduction against the rest of the payroll run.
    const netReimbursablePaise = Math.max(0, grossPaise - refundedPaise);
    return { grossPaise, refundedPaise, netReimbursablePaise };
  }

  const [total, pageRows, rollupRows] = await prisma.$transaction([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true } },
        refunds: succeededRefunds,
      },
      orderBy: { createdAt: "desc" },
      take: pagination.pageSize,
      skip: (pagination.page - 1) * pagination.pageSize,
    }),
    // The roll-up replaces the old aggregate + groupBy pair. Those summed
    // `Payment.amount`, which is now the wrong number — the payable figure is
    // net of refunds, and no Prisma aggregate spans the two tables. It reads
    // three scalars per row over the same filtered set the groupBy already
    // scanned.
    prisma.payment.findMany({
      where,
      select: {
        amount: true,
        refunds: succeededRefunds,
        user: { select: { id: true, name: true, email: true } },
      },
    }),
  ]);

  const items = pageRows.map((p) => ({ ...p, ...netOf(p) }));

  let totalPaise = 0;
  let totalRefundedPaise = 0;
  let totalNetPaise = 0;
  const perMember = new Map<
    string,
    {
      userId: string;
      name: string | null;
      email: string | null;
      totalPaise: number;
      refundedPaise: number;
      netReimbursablePaise: number;
      paymentCount: number;
    }
  >();

  for (const row of rollupRows) {
    const { grossPaise, refundedPaise, netReimbursablePaise } = netOf(row);
    totalPaise += grossPaise;
    totalRefundedPaise += refundedPaise;
    totalNetPaise += netReimbursablePaise;

    const entry = perMember.get(row.user.id) ?? {
      userId: row.user.id,
      name: row.user.name,
      email: row.user.email,
      totalPaise: 0,
      refundedPaise: 0,
      netReimbursablePaise: 0,
      paymentCount: 0,
    };
    entry.totalPaise += grossPaise;
    entry.refundedPaise += refundedPaise;
    entry.netReimbursablePaise += netReimbursablePaise;
    entry.paymentCount += 1;
    perMember.set(row.user.id, entry);
  }

  return NextResponse.json({
    items,
    total,
    page: pagination.page,
    perPage: pagination.pageSize,
    // `totalPaise` stays the gross so existing readers keep their meaning;
    // `totalNetPaise` is the figure payroll should actually transfer.
    totalPaise,
    totalRefundedPaise,
    totalNetPaise,
    byMember: Array.from(perMember.values()).sort(
      (a, b) => b.netReimbursablePaise - a.netReimbursablePaise,
    ),
  });
}
