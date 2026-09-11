/**
 * EarningStatus transition guard (#700 LED-2).
 *
 * Lives in its own file so consumers (incl. tests) can import the
 * predicate without dragging in earnings-service.ts' transitive
 * Stream / Razorpay / collaborator dependencies.
 *
 * Once an earning row hits `PAID`, the only lawful next status is
 * `REFUNDED` (via the controlled `refundEarnings(forceRefund: true)`
 * pathway, which writes a TDS reversal row in the same tx). Anything
 * else — back to PENDING/HELD/READY, or a sideways flip to a phantom
 * value — would silently rewrite history on a row that has already
 * triggered a real bank transfer + a TDS deduction.
 *
 * Callers that mutate ConsultantEarnings.status or
 * OrganizationEarnings.status MUST call this guard first.
 */

import { reportSentryError } from "@/lib/observability/report";
import { EarningStatus } from "@prisma/client";

export class IllegalEarningStatusTransitionError extends Error {
  constructor(
    public from: EarningStatus,
    public to: EarningStatus,
    public earningsId: string,
  ) {
    super(
      `Illegal EarningStatus transition for ${earningsId}: ${from} → ${to}. PAID earnings may only transition to REFUNDED via refundEarnings(forceRefund:true).`,
    );
    this.name = "IllegalEarningStatusTransitionError";
  }
}

export function assertEarningStatusTransitionLegal(
  earningsId: string,
  from: EarningStatus,
  to: EarningStatus,
): void {
  if (from === EarningStatus.PAID && to !== EarningStatus.REFUNDED) {
    const err = new IllegalEarningStatusTransitionError(from, to, earningsId);
    // Unlike a CAS lost-race (an expected outcome of concurrent writers),
    // this guard isn't a compare-and-swap — it's asserting a business
    // invariant on money that has already moved (a real bank transfer + TDS
    // deduction). Firing means a caller bug or state corruption, not a
    // routine race, so it stays a fault.
    reportSentryError(err, { subsystem: "payments", expected: false });
    throw err;
  }
  // REFUNDED is terminal — once refunded, no further status mutations.
  if (from === EarningStatus.REFUNDED) {
    const err = new IllegalEarningStatusTransitionError(from, to, earningsId);
    reportSentryError(err, { subsystem: "payments", expected: false });
    throw err;
  }
}
