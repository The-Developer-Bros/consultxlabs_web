/**
 * GET /api/payments/[paymentId]/credit-note/[creditNoteId]/pdf — #1365
 *
 * The buyer's copy of the s.34 credit note that reverses their tax invoice
 * after a refund or a lost chargeback. It shares `serveConsumerPdf` with the
 * invoice route, so the two documents are served under identical auth, rate
 * limiting, supplier-gate and caching rules by construction.
 *
 * The credit note is nested under the payment so it cannot be enumerated by id
 * alone — the note must belong to that payment's invoice.
 */

import { type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  renderConsumerCreditNotePdf,
  type ConsumerCreditNotePdfData,
} from "@/lib/pdf/credit-note-renderer";
import { serveConsumerPdf } from "@/lib/pdf/serve-consumer-pdf";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ paymentId: string; creditNoteId: string }> },
) {
  const { paymentId, creditNoteId } = await params;

  return serveConsumerPdf({
    event: "consumer_credit_note_pdf_render_failed",
    logContext: { paymentId, creditNoteId },
    failureMessage: "Failed to generate the credit note PDF",
    load: async () => {
      const creditNote = await prisma.consumerCreditNote.findFirst({
        where: { id: creditNoteId, consumerInvoice: { paymentId } },
        select: {
          id: true,
          creditNoteNumber: true,
          issuedAt: true,
          reason: true,
          taxableValuePaise: true,
          cgstPaise: true,
          sgstPaise: true,
          igstPaise: true,
          totalPaise: true,
          pdfStoragePath: true,
          pdfGeneratedAt: true,
          consumerInvoice: {
            select: {
              userId: true,
              invoiceNumber: true,
              issuedAt: true,
              currency: true,
              sacCode: true,
              taxRateBps: true,
              placeOfSupply: true,
              supplierName: true,
              supplierGstin: true,
              supplierAddress: true,
              supplierStateCode: true,
              buyerName: true,
              buyerEmail: true,
              buyerAddress: true,
              buyerStateCode: true,
            },
          },
        },
      });
      return creditNote
        ? { ...creditNote, ownerUserId: creditNote.consumerInvoice.userId }
        : null;
    },
    render: (creditNote) => {
      const invoice = creditNote.consumerInvoice;
      const data: ConsumerCreditNotePdfData = {
        creditNoteNumber: creditNote.creditNoteNumber,
        issuedAt: creditNote.issuedAt,
        reason: creditNote.reason,
        currency: invoice.currency,
        taxableValuePaise: creditNote.taxableValuePaise,
        cgstPaise: creditNote.cgstPaise,
        sgstPaise: creditNote.sgstPaise,
        igstPaise: creditNote.igstPaise,
        totalPaise: creditNote.totalPaise,
        originalInvoiceNumber: invoice.invoiceNumber,
        originalInvoiceDate: invoice.issuedAt,
        placeOfSupply: invoice.placeOfSupply,
        sacCode: invoice.sacCode,
        // The rate comes off the ORIGINAL invoice, never a current constant: a
        // note issued after a rate change still reverses the rate that was
        // charged.
        taxRateBps: invoice.taxRateBps,
        supplier: {
          name: invoice.supplierName,
          gstin: invoice.supplierGstin,
          address: invoice.supplierAddress,
          stateCode: invoice.supplierStateCode,
        },
        buyer: {
          name: invoice.buyerName,
          email: invoice.buyerEmail,
          address: invoice.buyerAddress,
          stateCode: invoice.buyerStateCode,
        },
      };
      return renderConsumerCreditNotePdf(data);
    },
    stamp: async ({ id, pdfStoragePath, pdfGeneratedAt }) => {
      await prisma.consumerCreditNote.update({
        where: { id },
        data: { pdfStoragePath, pdfGeneratedAt },
      });
    },
  });
}
