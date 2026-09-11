import prisma from "@/lib/prisma";
import { detectBuyerCountry, extractBuyerCountryParams } from "./buyer-country";
import { hasValidPlatformLut } from "@/lib/compliance/lut";

export interface CheckoutTaxContext {
  buyerCountry: string;
  isInternational: boolean;
  /**
   * Server-authoritative (#1230): zero-rating an international supply needs a
   * platform LUT valid for the current FY (Rule 96A). The client cannot see
   * the server-only env, so the decision is made here and the checkout math
   * keys off this flag instead of raw country — keeping client preview and
   * server charge in lockstep with determineTax/gst.ts.
   */
  exportZeroRated: boolean;
  /**
   * #1365 — the buyer's remembered GST billing state (2-digit numeric), so the
   * checkout page can pre-fill the picker and a repeat buyer is never asked
   * twice. Null is the statutory default, not a missing answer.
   */
  billingStateCode: string | null;
}

export async function resolveCheckoutTaxContext(params: {
  userId: string;
  headers: Headers;
}): Promise<CheckoutTaxContext> {
  const userRecord = await prisma.user.findUnique({
    where: { id: params.userId },
    select: {
      country: true,
      consulteeProfile: { select: { billingStateCode: true } },
    },
  });

  const headerParams = extractBuyerCountryParams(params.headers);
  const buyerCountry = detectBuyerCountry({
    userCountry: userRecord?.country,
    ...headerParams,
  });

  const isInternational = buyerCountry !== "IN";
  return {
    buyerCountry,
    isInternational,
    exportZeroRated: isInternational && hasValidPlatformLut(),
    billingStateCode: userRecord?.consulteeProfile?.billingStateCode ?? null,
  };
}
