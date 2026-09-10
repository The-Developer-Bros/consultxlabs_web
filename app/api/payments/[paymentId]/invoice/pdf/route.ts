/**
 * GET /api/payments/[paymentId]/invoice/pdf — #1365
 *
 * The buyer's copy of their B2C tax invoice. Auth, rate limiting, the
 * fail-closed supplier gate, the 24-hour render cache and the redirect to a
 * signed URL all live in `serveConsumerPdf`, which the credit-note route
 * shares; this file only says which row to load, how to render it, and where
 * to stamp the cache.
 *
 * Access is the payment's own buyer, or an ADMIN/STAFF operator handling a
 * support request. There is no org membership to lean on here, so ownership is
 * the whole rule.
 */

import { type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  renderConsumerInvoicePdf,
  type ConsumerInvoicePdfData,
} from "@/lib/pdf/invoice-renderer";
import { serveConsumerPdf } from "@/lib/pdf/serve-consumer-pdf";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  const { paymentId } = await params;

  return serveConsumerPdf({
    event: "consumer_invoice_pdf_render_failed",
    logContext: { paymentId },
    failureMessage: "Failed to generate the tax invoice PDF",
    load: async () => {
      const invoice = await prisma.consumerInvoice.findUnique({
        where: { paymentId },
        select: {
          id: true,
          userId: true,
          invoiceNumber: true,
          issuedAt: true,
          supplyDate: true,
          currency: true,
          sacCode: true,
          taxRateBps: true,
          taxableValuePaise: true,
          cgstPaise: true,
          sgstPaise: true,
          igstPaise: true,
          totalPaise: true,
          placeOfSupply: true,
          placeOfSupplySource: true,
          supplierName: true,
          supplierGstin: true,
          supplierAddress: true,
          supplierStateCode: true,
          buyerName: true,
          buyerEmail: true,
          buyerAddress: true,
          buyerStateCode: true,
          pdfStoragePath: true,
          pdfGeneratedAt: true,
        },
      });
      return invoice ? { ...invoice, ownerUserId: invoice.userId } : null;
    },
    render: (invoice) => {
      // Rendered from the row's own stored snapshot, not from live supplier or
      // buyer records — a tax invoice must keep saying what it said on the day
      // it was issued.
      const data: ConsumerInvoicePdfData = {
        invoiceNumber: invoice.invoiceNumber,
        issuedAt: invoice.issuedAt,
        supplyDate: invoice.supplyDate,
        currency: invoice.currency,
        sacCode: invoice.sacCode,
        taxRateBps: invoice.taxRateBps,
        taxableValuePaise: invoice.taxableValuePaise,
        cgstPaise: invoice.cgstPaise,
        sgstPaise: invoice.sgstPaise,
        igstPaise: invoice.igstPaise,
        totalPaise: invoice.totalPaise,
        placeOfSupply: invoice.placeOfSupply,
        placeOfSupplySource: invoice.placeOfSupplySource,
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
      return renderConsumerInvoicePdf(data);
    },
    stamp: async ({ id, pdfStoragePath, pdfGeneratedAt }) => {
      await prisma.consumerInvoice.update({
        where: { id },
        data: { pdfStoragePath, pdfGeneratedAt },
      });
    },
  });
}
