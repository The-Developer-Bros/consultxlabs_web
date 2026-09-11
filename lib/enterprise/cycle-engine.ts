/**
 * #779 §A — pure date-math + decision helpers for the program-cycle engine.
 *
 * No Prisma, no IO — just the math the advance-program-cycles cron leans on,
 * extracted so the month-end/clamp/roll-vs-close edges are unit-testable
 * without a DB. Mirrors the cycle-advance arithmetic in
 * generate-subscription-invoices.ts (MONTHLY/QUARTERLY/ANNUAL).
 */

import type { BillingCycle } from "@prisma/client";

/**
 * Advance a period start by one billing cycle.
 *
 * Uses JS Date month arithmetic, which clamps overflowing day-of-month to the
 * target month's last day (e.g. Jan-31 + 1 MONTHLY → Feb-28/29). We re-clamp
 * explicitly so a multi-step QUARTERLY (Aug-31 → Nov-30) doesn't carry the
 * "spilled" day forward the way naive setMonth chaining would.
 */
export function nextPeriodEnd(start: Date, cycle: BillingCycle): Date {
  const next = new Date(start);
  const day = next.getDate();
  if (cycle === "MONTHLY") next.setMonth(next.getMonth() + 1);
  else if (cycle === "QUARTERLY") next.setMonth(next.getMonth() + 3);
  else next.setFullYear(next.getFullYear() + 1); // ANNUAL

  // Month overflow guard: if the day-of-month rolled (e.g. 31 → Mar-03 because
  // Feb is short), pin to the last day of the intended month instead.
  if (next.getDate() !== day) next.setDate(0);
  return next;
}

export interface CycleDecisionInput {
  /** Successor period bounds the engine would mint (periodStart=old periodEnd). */
  successorPeriodStart: Date;
  successorPeriodEnd: Date;
  /** Governing contract — successor cannot outlive a non-null effectiveTo. */
  contractStatus: "ACTIVE" | "EXPIRED" | "TERMINATED" | "DRAFT";
  contractAutoRenew: boolean;
  contractEffectiveTo: Date | null;
}

export type CycleDecision =
  /** Mint the successor + mark old ROLLED. */
  | { action: "ROLL"; reason: "AUTORENEW" }
  /** Claim old → CLOSED; no successor. */
  | { action: "CLOSE"; reason: "CONTRACT_INACTIVE" | "AUTORENEW_OFF" | "CLAMPED" };

/**
 * Roll-vs-close decision table (#779 locked decision #3):
 *   contract not ACTIVE              → CLOSE (CONTRACT_INACTIVE)
 *   contract ACTIVE, autoRenew=false → CLOSE (AUTORENEW_OFF)
 *   successor end > effectiveTo      → CLOSE (CLAMPED)  // don't outlive the term
 *   else                             → ROLL  (AUTORENEW)
 */
export function decideCycleTransition(input: CycleDecisionInput): CycleDecision {
  if (input.contractStatus !== "ACTIVE") {
    return { action: "CLOSE", reason: "CONTRACT_INACTIVE" };
  }
  if (!input.contractAutoRenew) {
    return { action: "CLOSE", reason: "AUTORENEW_OFF" };
  }
  // Clamp: a successor whose end exceeds the contract's hard end-date would
  // bill past the term. Close instead of rolling.
  if (
    input.contractEffectiveTo !== null &&
    input.successorPeriodEnd.getTime() > input.contractEffectiveTo.getTime()
  ) {
    return { action: "CLOSE", reason: "CLAMPED" };
  }
  return { action: "ROLL", reason: "AUTORENEW" };
}

/**
 * Resolve the cycle for a program from whichever money-config it carries.
 * Exactly one of licensedSeatConfig / creditPoolConfig is set per program;
 * both null is a malformed program (caller should skip).
 */
export function resolveProgramCycle(program: {
  licensedSeatConfig: { cycle: BillingCycle } | null;
  creditPoolConfig: { cycle: BillingCycle } | null;
}): BillingCycle | null {
  return (
    program.licensedSeatConfig?.cycle ??
    program.creditPoolConfig?.cycle ??
    null
  );
}
