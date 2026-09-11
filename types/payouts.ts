/**
 * Shared types for Payout API responses.
 * Used by admin/payouts (pending, processing, completed) and staff/payouts pages.
 */

export interface Payout {
  id: string;
  consultantName: string;
  consultantEmail: string;
  amount: number;
  currency: string;
  method: string;
  provider: string;
  earningsCount: number;
  createdAt: string;
  status: string;
  batchId?: string;
  // No `providerPayoutId`: getOperatorPayouts hand-maps the row and does not
  // return it, and no section renders it. Declaring an optional field the
  // producer never sends is indistinguishable from a real absence, so it
  // reads as "this payout has no gateway id" rather than "we never asked".
  approvedAt?: string;
  approvedBy?: string;
  processedAt?: string;
  failureReason?: string;
  /** #863 — MSME §43B(h) statutory pay-by date; null for non-MSME vendors. */
  mustPayByDate?: string | null;
}
