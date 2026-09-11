/**
 * Discount applied to a checkout session.
 * Shared across all 4 checkout pages (consultation, subscription, webinar, class).
 */
export interface AppliedDiscount {
  code: string;
  discountType: "PERCENTAGE" | "FIXED_AMOUNT";
  discountValue: number;
  discountAmount?: number;
}
