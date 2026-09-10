/**
 * GET /api/organizations/[orgId]/payouts/export
 *
 * CSV export of the org's payout history — wave-4b (#1230). Machinery
 * (keyset pagination, backpressure, abort, truncation honesty, RFC-4180
 * notices, self-audit) lives in lib/csv/keyset-export.ts; this route only
 * declares its query and row shape.
 *
 * Column truth matches the wave-1 display fix: `disbursed_paise` is the
 * post-TDS cash (amountPaise), with tds/net itemized so the CSV reconciles
 * against both the ledger and the bank.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { keysetCsvStream, keysetWhere } from "@/lib/csv/keyset-export";

const PAYOUT_EXPORT_COLUMNS = 13;
const PAYOUT_EXPORT_HEADER =
  "id,status,period_start,period_end,currency,gross_paise,platform_fee_paise,refunds_paise,tds_paise,net_pre_tds_paise,disbursed_paise,processed_at,created_at\n";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  await prisma.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId: access.member.id,
      category: "PAYOUT",
      action: AUDIT_ACTIONS.PAYOUT.PAYOUT_EXPORTED,
      description: "Payout history exported to CSV",
    },
  });

  const stream = keysetCsvStream<{
    id: string;
    status: string;
    periodStart: Date;
    periodEnd: Date;
    currency: string;
    grossRevenuePaise: number;
    platformFeePaise: number;
    refundsPaise: number;
    tdsAmountPaise: number | null;
    netPayoutPaise: number;
    amountPaise: number;
    processedAt: Date | null;
    createdAt: Date;
  }>({
    columnCount: PAYOUT_EXPORT_COLUMNS,
    header: PAYOUT_EXPORT_HEADER,
    signal: req.signal,
    onError: (err, ctx) =>
      console.error("[payouts-export] stream failed", {
        organizationId: orgId,
        iterations: ctx.iterations,
        err: err instanceof Error ? err.message : String(err),
      }),
    fetchPage: async (cursor, take) => {
      const rows = await prisma.organizationPayout.findMany({
        where: keysetWhere({ organizationId: orgId }, cursor),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        select: {
          id: true,
          status: true,
          periodStart: true,
          periodEnd: true,
          currency: true,
          grossRevenuePaise: true,
          platformFeePaise: true,
          refundsPaise: true,
          tdsAmountPaise: true,
          netPayoutPaise: true,
          amountPaise: true,
          processedAt: true,
          createdAt: true,
        },
      });
      // Short page ⇒ exhausted: null closes the stream after this page is
      // emitted (see keyset-export contract).
      const last = rows.at(-1);
      return {
        rows,
        nextCursor:
          rows.length === take && last
            ? { createdAt: last.createdAt, id: last.id }
            : null,
      };
    },
    rowToCells: (r) => [
      r.id,
      r.status,
      r.periodStart?.toISOString() ?? "",
      r.periodEnd?.toISOString() ?? "",
      r.currency,
      r.grossRevenuePaise.toString(),
      r.platformFeePaise.toString(),
      r.refundsPaise.toString(),
      r.tdsAmountPaise?.toString() ?? "",
      r.netPayoutPaise.toString(),
      r.amountPaise.toString(),
      r.processedAt?.toISOString() ?? "",
      r.createdAt.toISOString(),
    ],
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payouts-${orgId}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
