/**
 * GET /api/organizations/[orgId]/billing-account/credit-notes/[creditNoteId]/pdf
 *
 * Renders a CGST s.34 credit note as a PDF on demand (#1230). Credit notes
 * are immutable once issued and carry no storage-cache columns, so this
 * renders fresh per request — volumes are refund-shaped (low), unlike
 * invoices where the Supabase cache earns its keep.
 *
 * Auth: MAINTAINER+ ("MANAGER") mirroring the invoice PDF route.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  renderOrgCreditNotePdf,
  type CreditNotePdfData,
} from "@/lib/pdf/credit-note-renderer";
import { getPlatformSupplier } from "@/lib/pdf/supplier";

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; creditNoteId: string }>;
  },
) {
  const { orgId, creditNoteId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  // Fail-closed supplier identity — no fabricated GSTIN fallback (#1132).
  const supplier = getPlatformSupplier();
  if (!supplier) {
    return NextResponse.json(
      {
        error:
          "PLATFORM_GSTIN is not configured; the platform cannot issue statutory documents.",
        code: "SUPPLIER_GSTIN_UNCONFIGURED",
      },
      { status: 503 },
    );
  }

  const creditNote = await prisma.creditNote.findFirst({
    where: { id: creditNoteId, organizationId: orgId },
    include: {
      organization: {
        select: {
          name: true,
          billingEmail: true,
          taxInfo: { select: { gstin: true } },
        },
      },
      invoice: { select: { invoiceNumber: true, issuedAt: true } },
    },
  });
  if (!creditNote) {
    return NextResponse.json({ error: "Credit note not found" }, { status: 404 });
  }

  // DRAFT credit notes aren't legally issued — same posture as invoices.
  if (creditNote.status === "DRAFT") {
    return NextResponse.json(
      {
        error: "Credit note is still in DRAFT. Issue it before generating a PDF.",
        code: "CREDIT_NOTE_NOT_ISSUED",
      },
      { status: 409 },
    );
  }

  const data: CreditNotePdfData = {
    creditNoteNumber: creditNote.creditNoteNumber,
    issuedAt: creditNote.issuedAt ?? creditNote.createdAt,
    reason: creditNote.reason,
    displayCurrency: "INR",
    subtotalPaise: Number(creditNote.subtotalPaise),
    igstPaise: Number(creditNote.igstPaise),
    cgstPaise: Number(creditNote.cgstPaise),
    sgstPaise: Number(creditNote.sgstPaise),
    totalPaise: Number(creditNote.totalPaise),
    originalInvoiceNumber: creditNote.invoice?.invoiceNumber ?? null,
    originalInvoiceDate: creditNote.invoice?.issuedAt ?? null,
    org: {
      name: creditNote.organization.name,
      gstin: creditNote.organization.taxInfo?.gstin ?? null,
      billingEmail: creditNote.organization.billingEmail,
      address: null,
    },
    supplier,
  };

  try {
    const buffer = await renderOrgCreditNotePdf(data);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${creditNote.creditNoteNumber}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { subsystem: "enterprise", component: "credit-note-pdf" },
    });
    return NextResponse.json(
      { error: "Failed to render credit note PDF" },
      { status: 500 },
    );
  }
}
