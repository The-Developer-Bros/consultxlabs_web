/**
 * A group event (webinar, class) has one Payment per attendee per appointment
 * (`@@unique([userId, appointmentId])`), so the host's view of the money is a
 * status per seat, not a list of amounts. Pure helpers, shared by the detail
 * page and the participants roster so the two cannot disagree.
 */

import type { PaymentStatus } from "@prisma/client";

export type SeatPaymentRow = {
  userId: string;
  paymentStatus: PaymentStatus | string;
  amount: bigint | number | string;
  currency: string;
  createdAt: Date | string;
};

/** Which row speaks for a seat when a user has more than one (a class). */
const STATUS_RANK: Record<string, number> = {
  SUCCEEDED: 0,
  PENDING: 1,
  FAILED: 2,
  EXPIRED: 3,
};

function rank(status: string): number {
  return STATUS_RANK[status] ?? 4;
}

export function seatPaymentsByUser<T extends SeatPaymentRow>(
  rows: readonly T[],
): Map<string, T> {
  const best = new Map<string, T>();
  for (const row of rows) {
    const current = best.get(row.userId);
    if (!current) {
      best.set(row.userId, row);
      continue;
    }
    const byRank = rank(row.paymentStatus) - rank(current.paymentStatus);
    const newer =
      new Date(row.createdAt).getTime() > new Date(current.createdAt).getTime();
    if (byRank < 0 || (byRank === 0 && newer)) best.set(row.userId, row);
  }
  return best;
}

export type SeatPaymentSummary = {
  paid: number;
  pending: number;
  lapsed: number;
  collectedPaise: number;
  currency: string;
};

export function summarizeSeatPayments(
  byUser: ReadonlyMap<string, SeatPaymentRow>,
  fallbackCurrency = "INR",
): SeatPaymentSummary {
  const summary: SeatPaymentSummary = {
    paid: 0,
    pending: 0,
    lapsed: 0,
    collectedPaise: 0,
    currency: fallbackCurrency,
  };
  for (const row of byUser.values()) {
    summary.currency = String(row.currency ?? fallbackCurrency);
    if (row.paymentStatus === "SUCCEEDED") {
      summary.paid += 1;
      summary.collectedPaise += Number(row.amount);
    } else if (row.paymentStatus === "PENDING") {
      summary.pending += 1;
    } else {
      summary.lapsed += 1;
    }
  }
  return summary;
}
