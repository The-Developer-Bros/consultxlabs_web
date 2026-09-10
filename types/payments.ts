/**
 * Shared types for Payment, Refund, Dispute, and Earnings API responses.
 * Used by admin/staff payment, refund, payout, and dispute pages.
 */

import type { AppointmentsType } from "@prisma/client";

// ─── Payment List (admin/payments, staff/payments) ─────────────────
export interface Payment {
  id: string;
  amount: number;
  currency: string;
  description: string | null;
  receiptUrl: string | null;
  paymentMethod: string;
  paymentIntent: string;
  paymentGateway: string;
  paymentStatus: string;
  isMockPayment?: boolean;
  createdAt: string;
  appointment: {
    appointmentType: AppointmentsType;
  } | null;
  consumerInvoice?: PaymentConsumerInvoice | null;
}

// ─── B2C tax invoice (#1365) ───────────────────────────────────────
/** Summary of the statutory consumer tax invoice attached to a payment. The
 *  PDF itself is fetched from /api/payments/[paymentId]/invoice/pdf, which
 *  authorises the caller and returns a short-lived signed URL. */
export interface PaymentConsumerInvoice {
  id: string;
  invoiceNumber: string;
  issuedAt: string;
}

export interface PaymentListResponse {
  payments: Payment[];
  total: number;
  page: number;
  totalPages: number;
}

// ─── Payment Detail (admin/payments/[paymentId]) ───────────────────
export interface PaymentDetailRefund {
  id: string;
  refundId: string | null;
  /** `Refund.amountPaise`. Declaring `amount` here rendered "£NaN" on the
   *  payment detail page for every refund and dispute — see [PaymentDetailDispute]. */
  amountPaise: number;
  currency: string;
  status: string;
  reason: string | null;
  paymentGateway: string;
  createdAt: string;
}

export interface PaymentDetailDispute {
  id: string;
  /** Non-null in the schema (`@unique`), but kept nullable here so the UI
   *  keeps its existing guards; narrowing it is a separate change. */
  disputeId: string | null;
  /** `Dispute.amountPaise` — neither money model has ever had an `amount`. */
  amountPaise: number;
  currency: string;
  status: string;
  reason: string | null;
  createdAt: string;
}

export interface PaymentDetail {
  id: string;
  amount: number;
  currency: string;
  description: string | null;
  receiptUrl: string | null;
  paymentMethod: string;
  paymentIntent: string;
  paymentGateway: string;
  paymentStatus: string;
  isMockPayment?: boolean;
  expiresAt: string | null;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
  };
  appointment: {
    id: string;
    appointmentType: AppointmentsType;
  } | null;
  discountCode: {
    code: string;
    discountType: string;
    discountValue: number;
  } | null;
  refunds: PaymentDetailRefund[];
  disputes: PaymentDetailDispute[];
  consumerInvoice?: PaymentConsumerInvoice | null;
}

// ─── Refund List (admin/refunds, staff/refunds) ────────────────────
export interface Refund {
  id: string;
  refundId?: string;
  /**
   * Paise. The Prisma model calls it `amountPaise` and the money extension
   * computes it to a Number in paise; this interface used to declare
   * `amount`, which no payload has ever carried, so every refund rendered
   * as ₹NaN.
   */
  amountPaise: number;
  currency: string;
  status: string;
  reason?: string | null;
  paymentGateway?: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  payment: {
    id: string;
    paymentIntent: string;
  } | null;
}

export interface RefundListResponse {
  refunds: Refund[];
  total: number;
  // #997 secondary findings — dashboard-wide counts (unfiltered by the
  // current search/gateway), not a client-side .filter() over the page.
  stats: {
    pendingCount: number;
    succeededCount: number;
    failedCount: number;
  };
  page: number;
  limit?: number;
  totalPages: number;
}

// ─── Dispute List ──────────────────────────────────────────────────
// Deliberately absent. `Dispute` and `DisputeListResponse` used to be declared
// here as well as in types/disputes.ts, and nothing imported this copy — the
// live dispute surfaces all use types/disputes.ts. Two same-named interfaces
// over one model is how a fix lands on the copy nobody renders, so this one is
// gone rather than kept in sync.

// ─── Admin Dashboard Stats (admin/home) ────────────────────────────
export interface RecentPayment {
  id: string;
  amount: number;
  currency: string;
  paymentStatus: string;
  paymentGateway: string;
  createdAt: string;
  appointment: {
    appointmentType: AppointmentsType;
  } | null;
}

export interface RecentRefund {
  id: string;
  /**
   * `Refund` stores money in `amountPaise`, and the operator-stats query
   * selects exactly that. This interface said `amount` — a field the payload
   * has never carried — so the admin dashboard's Recent Refunds list formatted
   * `undefined` and rendered a literal "₹NaN". Same defect class the refunds
   * and disputes tables already had; the drift test now covers this one too.
   */
  amountPaise: number;
  currency: string;
  status: string;
  paymentGateway: string;
  createdAt: string;
}

export interface AdminDashboardStats {
  totalPayments: number;
  totalPaymentsValue: number;
  pendingPayments: number;
  pendingPaymentsValue: number;
  totalRefunds: number;
  totalRefundsValue: number;
  activeDisputes: number;
  totalDisputes: number;
  recentPayments: RecentPayment[];
  recentRefunds: RecentRefund[];
  gatewayStats: Record<string, { count: number }>;
}

// ─── Earnings (admin/payouts) ──────────────────────────────────────
export interface EarningsStats {
  pending: {
    count: number;
    consultantSharePaise: number;
    platformFeePaise: number;
  };
  ready: {
    count: number;
    consultantSharePaise: number;
    platformFeePaise: number;
  };
  /**
   * #837 split BATCHED out of READY. `getEarningsStats` has returned this
   * bucket ever since; this interface never declared it, so the admin earnings
   * dashboard had no way to render money that had left "Ready" and not yet
   * reached "Paid" — cleared earnings in transit, counted nowhere.
   */
  batched: {
    count: number;
    consultantSharePaise: number;
    platformFeePaise: number;
  };
  paid: {
    count: number;
    consultantSharePaise: number;
    platformFeePaise: number;
  };
  held: {
    count: number;
    consultantSharePaise: number;
    platformFeePaise: number;
  };
  refunded: {
    count: number;
    consultantSharePaise: number;
    platformFeePaise: number;
  };
  totalPlatformRevenue: number;
}

export interface Earning {
  id: string;
  consultantProfile: {
    user: { name: string; email: string };
  };
  grossAmount: number;
  platformFeePaise: number;
  consultantSharePaise: number;
  status: string;
  holdUntil: string;
  createdAt: string;
}
