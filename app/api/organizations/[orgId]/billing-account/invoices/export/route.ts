/**
 * GET /api/organizations/[orgId]/billing-account/invoices/export
 *
 * CSV export of the org's invoice register — wave-4b parity with the
 * payouts exporter (#1230). GST columns are itemized (IGST/CGST/SGST) so
 * finance reconciles straight against GSTR-1. Machinery lives in
 * lib/csv/keyset-export.ts.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { keysetCsvStream, keysetWhere } from "@/lib/csv/keyset-export";

const INVOICE_EXPORT_COLUMNS = 14;
const INVOICE_EXPORT_HEADER =
  "invoice_number,status,currency,subtotal_paise,igst_paise,cgst_paise,sgst_paise,total_paise,issued_at,due_date,paid_at,purchase_order_id,contract_id,id\n";

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
      category: "INVOICE",
      action: AUDIT_ACTIONS.INVOICE.INVOICE_EXPORTED,
      description: "Invoice register exported to CSV",
    },
  });

  const stream = keysetCsvStream<{
    id: string;
    invoiceNumber: string;
    status: string;
    displayCurrency: string;
    subtotalPaise: number;
    igstPaise: number;
    cgstPaise: number;
    sgstPaise: number;
    totalPaise: number;
    issuedAt: Date | null;
    dueDate: Date | null;
    paidAt: Date | null;
    purchaseOrderId: string | null;
    contractId: string | null;
    createdAt: Date;
  }>({
    columnCount: INVOICE_EXPORT_COLUMNS,
    header: INVOICE_EXPORT_HEADER,
    signal: req.signal,
    onError: (err, ctx) =>
      console.error("[invoices-export] stream failed", {
        organizationId: orgId,
        iterations: ctx.iterations,
        err: err instanceof Error ? err.message : String(err),
      }),
    fetchPage: async (cursor, take) => {
      const rows = await prisma.organizationInvoice.findMany({
        where: keysetWhere({ organizationId: orgId }, cursor),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          displayCurrency: true,
          subtotalPaise: true,
          igstPaise: true,
          cgstPaise: true,
          sgstPaise: true,
          totalPaise: true,
          issuedAt: true,
          dueDate: true,
          paidAt: true,
          purchaseOrderId: true,
          contractId: true,
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
      r.invoiceNumber,
      r.status,
      r.displayCurrency,
      r.subtotalPaise.toString(),
      r.igstPaise.toString(),
      r.cgstPaise.toString(),
      r.sgstPaise.toString(),
      r.totalPaise.toString(),
      r.issuedAt?.toISOString() ?? "",
      r.dueDate?.toISOString() ?? "",
      r.paidAt?.toISOString() ?? "",
      r.purchaseOrderId ?? "",
      r.contractId ?? "",
      r.id,
    ],
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="invoices-${orgId}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
