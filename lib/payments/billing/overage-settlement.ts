/**
 * #778 elegance — checkout-time overage recording, extracted out of the (huge)
 * checkout function so the overage flow reads as one unit. The chargeStatus
 * state machine (`transitionOverage`) lives in `overage-transitions.ts` (kept
 * dependency-light); this module carries the heavier graph (computeOverage +
 * the Novu member-due notification).
 */
import { reportSentryError } from "@/lib/observability/report";
import prisma from "@/lib/prisma";
import {
  PaymentStatus,
  type Currency,
  type PaymentGateway,
  type ProgramType,
} from "@prisma/client";
import { computeOverageForBooking } from "@/lib/payments/billing/overage";
import { notifyOrgProgramOverageDue } from "@/lib/novu/org-workflows";
import { PaymentError } from "@/lib/payments/core/types";
import type { Tx } from "@/lib/prisma";
import { sumPaise } from "@/lib/payments/utils/money";

export interface RecordOverageInput {
  tx: Tx;
  programAssignmentId: string;
  /** Output of recordBookingUtilization for this booking (already metered). */
  utilization: {
    programType: ProgramType;
    engagementsConsumedDelta: number;
    engagementsUsedAfter: number;
    consumedPaiseAfter: number;
    creditBudgetPaise: number | null;
  };
  bookingPricePaise: number;
  currency: Currency;
  paymentId: string;
  userId: string;
  organizationId: string | null;
  paymentGateway: PaymentGateway;
}

/** The member-due bell, deferred until the caller's transaction has committed. */
export interface PendingOverageNotification {
  userId: string;
  programAssignmentId: string;
  marginalPaise: number;
  overageEventId: string;
}

/**
 * Record one over-cap booking. Assumes the caller already metered the booking
 * and saw `wasOverage = true` (BLOCK behaviour throws inside the metering
 * helper, never here). Resolves the configured behaviour through the pure
 * `computeOverage`, enforces the per-cycle circuit breaker, and persists the
 * OverageEvent (+ the CHARGE_MEMBER side-Payment or the CHARGE_ORG accrual leg).
 *
 * Throws `PROGRAM_CAP_EXHAUSTED` (httpStatus 402) when the circuit breaker
 * vetoes — same shape as the BLOCK path so the dashboard can explain the
 * cycle ceiling vs the per-member allocation.
 *
 * Returns the member-due bell to ring, or null when there is nothing to tell
 * anyone. The caller rings it AFTER its transaction commits — see
 * `notifyOverageDueAfterCommit`.
 */
export async function recordOverageAtCheckout(
  input: RecordOverageInput,
): Promise<PendingOverageNotification | null> {
  const {
    tx,
    programAssignmentId,
    utilization,
    bookingPricePaise: amount,
    currency,
    paymentId,
    userId,
    organizationId,
    paymentGateway,
  } = input;

  const isCredit = utilization.programType === "CREDIT_POOL";
  const programRow = await tx.program.findFirst({
    where: { assignments: { some: { id: programAssignmentId } } },
    select: {
      licensedSeatConfig: {
        select: {
          overageBehavior: true,
          priceCapPerEngagementPaise: true,
          coveredEngagementsPerCycle: true,
          overageSurchargeBps: true,
          maxOveragePerCyclePaise: true,
        },
      },
      creditPoolConfig: {
        select: {
          overageBehavior: true,
          overageSurchargeBps: true,
          maxOveragePerCyclePaise: true,
        },
      },
    },
  });
  const lsc = programRow?.licensedSeatConfig;
  const cpc = programRow?.creditPoolConfig;

  // Cycle overage-so-far. A ProgramAssignment is per-cycle, so every
  // OverageEvent on this assignmentId is already cycle-scoped. No settledAt
  // filter (a mid-cycle invoice run stamps settledAt but must not reset the
  // breaker); excludes REVERSED/BLOCKED/FAILED so a refunded/never-collected
  // overage frees the ceiling again.
  const soFarAgg = await tx.overageEvent.aggregate({
    where: {
      programAssignmentId,
      chargeStatus: { notIn: ["REVERSED", "BLOCKED", "FAILED"] },
    },
    _sum: { marginalPaise: true },
  });
  const cycleOverageSoFarPaise = sumPaise(soFarAgg._sum.marginalPaise);

  // Drive the decision through the shared computeOverageForBooking() mapper.
  // For LICENSED_SEAT the PRE-booking engagement count is needed (the meter
  // already applied this booking's delta); for CREDIT_POOL the PRE-booking
  // consumed paise. The preview surface (#777 §C) builds the same context from
  // the assignment's current state, so the two can't drift.
  const engagementsConsumed = Math.max(1, utilization.engagementsConsumedDelta);
  const overage = computeOverageForBooking(
    isCredit
      ? {
          programType: "CREDIT_POOL",
          overageBehavior: cpc?.overageBehavior ?? "BLOCK",
          maxOveragePerCyclePaise: cpc?.maxOveragePerCyclePaise ?? null,
          cycleOverageSoFarPaise,
          overageSurchargeBps: cpc?.overageSurchargeBps ?? null,
          creditBudgetPaise: utilization.creditBudgetPaise,
          consumedPaise: utilization.consumedPaiseAfter - amount,
        }
      : {
          programType: "LICENSED_SEAT",
          overageBehavior: lsc?.overageBehavior ?? "BLOCK",
          maxOveragePerCyclePaise: lsc?.maxOveragePerCyclePaise ?? null,
          cycleOverageSoFarPaise,
          overageSurchargeBps: lsc?.overageSurchargeBps ?? null,
          coveredEngagementsPerCycle: lsc?.coveredEngagementsPerCycle ?? null,
          engagementsUsed:
            utilization.engagementsUsedAfter -
            utilization.engagementsConsumedDelta,
          priceCapPerEngagementPaise: lsc?.priceCapPerEngagementPaise ?? null,
        },
    { bookingPricePaise: amount, engagementsConsumed },
  );
  const { marginalPaise, basePaise, surchargePaise } = overage;

  // Circuit breaker: ceiling exceeded → reject the booking like BLOCK. Distinct
  // code so the dashboard can explain it's the cycle cap, not the allocation.
  if (overage.decision === "BLOCK" && overage.chargeTo === null) {
    const capExhaustedErr = Object.assign(
      new Error(
        "PROGRAM_CAP_EXHAUSTED: This booking would exceed the program's per-cycle overage ceiling. Contact your organization administrator to raise the ceiling or wait for the next cycle.",
      ),
      { httpStatus: 402, code: "PROGRAM_CAP_EXHAUSTED" },
    );
    // Modelled outcome (the circuit breaker working as designed), not a
    // fault — captured for volume/pattern visibility only.
    reportSentryError(capExhaustedErr, {
      subsystem: "payments",
      expected: true,
    });
    throw capExhaustedErr;
  }

  if (marginalPaise <= 0) return null;

  const bu = await tx.bookingUtilization.findUnique({
    where: { paymentId },
    select: { id: true },
  });
  if (!bu) return null;

  if (overage.chargeTo === "MEMBER") {
    // Instant member charge. The booking proceeds; create a parent-linked
    // PENDING side-Payment for the marginal. The gateway is NOT called inside
    // this Serializable TX — the order is minted lazily when the member opens
    // the resume-checkout surface, and the webhook flips both → CHARGED.
    // `appointmentId: null` avoids the @@unique([userId, appointmentId]) clash.
    const sideCharge = await tx.payment.create({
      data: {
        amount: marginalPaise,
        originalAmount: marginalPaise,
        taxAmount: 0,
        currency,
        paymentMethod: "CARD",
        paymentIntent: `overage:${paymentId}`,
        paymentGateway,
        paymentStatus: PaymentStatus.PENDING,
        isMockPayment: false,
        userId,
        appointmentId: null,
        organizationId,
        parentPaymentId: paymentId,
      },
    });
    const memberOverageEvent = await tx.overageEvent.create({
      data: {
        programAssignmentId,
        bookingUtilizationId: bu.id,
        overageBehavior: "CHARGE_MEMBER",
        basePaise,
        surchargePaise,
        marginalPaise,
        // Mirrors the booking currency (the side-Payment + timeout notify
        // read it back); hardcoding INR mislabels a non-INR booking.
        currency,
        chargeStatus: "PENDING",
        paymentId: sideCharge.id,
      },
    });

    // #785 — carve the over-cap pass-through (basePaise) out of the org-funded
    // parent so the org pays only coveredPaise; the member side-charge above
    // (marginalPaise) covers the over-cap portion. Without this, basePaise is
    // collected TWICE — once in the parent's base leg, once in the member charge
    // (coveredPaise + basePaise == price). INVOICE accrual carves cleanly; a
    // WALLET-funded parent would also need a balance credit-back, which is not
    // built (#715) — so #1458 added a config-time guard
    // (overageBehaviorUnsupportedReason) that refuses CHARGE_MEMBER on a WALLET
    // account, and the throw below is the fail-closed backstop for a programme
    // configured before that guard existed.
    if (basePaise > 0) {
      const parentBase = await tx.paymentLeg.findUnique({
        where: { paymentId_source: { paymentId, source: "INVOICE_ACCRUAL" } },
        select: { amountPaise: true },
      });
      // Fail closed: if there's no INVOICE_ACCRUAL leg ≥ basePaise to carve from
      // (e.g. a WALLET/LICENSE-funded parent), basePaise was already collected via
      // that funding source and the member side-charge above bills it AGAIN. The
      // credit-back path for non-invoice parents isn't built (#715), so abort the
      // tx rather than silently double-collect basePaise. Only reachable for a
      // programme saved before #1458's config guard, which now refuses the
      // combination at create and patch time.
      if (!parentBase || parentBase.amountPaise < basePaise) {
        // #1458 — a stable code and a 409 so the route answers the buyer with
        // the admin action instead of a generic 500; the operator detail stays
        // in the Sentry context below, not in the message the page renders.
        const carveErr = new PaymentError(
          "This programme charges members for bookings past its cap, which is not supported on this organisation's funding source. Ask your billing admin to switch the programme to charge the organisation, or to block over-cap bookings.",
          "OVERAGE_CHARGE_MEMBER_UNSUPPORTED",
        );
        // A genuine coverage gap (#715), not a modelled outcome — this aborts
        // a booking with real money on the line.
        reportSentryError(carveErr, {
          subsystem: "payments",
          contexts: {
            overage: {
              paymentId,
              basePaise,
              parentInvoiceAccrualPaise: parentBase
                ? parentBase.amountPaise
                : null,
            },
          },
        });
        throw carveErr;
      }
      await tx.paymentLeg.update({
        where: { paymentId_source: { paymentId, source: "INVOICE_ACCRUAL" } },
        data: { amountPaise: { decrement: basePaise } },
      });
      await tx.payment.update({
        where: { id: paymentId },
        data: { amount: { decrement: basePaise } },
      });
    }

    // Tell the member they owe the marginal + deep-link to the pay surface —
    // handed back for the caller to ring post-commit rather than rung here.
    // #1435 — the lookup this bell needs runs on the global client, and under
    // PG_POOL_MAX=1 a global-client query issued inside the transaction queues
    // behind the transaction's own connection and dies at the 3 s pg connect
    // timeout, which the .catch swallowed: the bell was lost silently.
    return {
      userId,
      programAssignmentId,
      marginalPaise,
      overageEventId: memberOverageEvent.id,
    };
  }

  if (overage.chargeTo === "ORG") {
    // #785 — the over-cap pass-through (basePaise) is ALREADY inside the base
    // INVOICE_ACCRUAL leg (coveredPaise + basePaise == price), and the rollup
    // sums BOTH leg sources into the invoice — so adding the overage leg on top
    // double-bills the org by basePaise (and breaks Σlegs == amount). Carve
    // basePaise OUT of the base leg into the explicit OVERAGE_INVOICE_ACCRUAL
    // leg; only the surcharge is genuinely-additional money (marginal == base +
    // surcharge).
    //
    // #1458 — which funding rail paid the parent decides whether the marginal is
    // new money at all, so the WALLET rail is resolved FIRST and never reaches
    // the additive branch below.
    const walletLeg = await tx.paymentLeg.findUnique({
      where: { paymentId_source: { paymentId, source: "WALLET" } },
      select: { amountPaise: true },
    });
    if (walletLeg) {
      return recordWalletCollectedOrgOverage(tx, {
        paymentId,
        programAssignmentId,
        bookingUtilizationId: bu.id,
        basePaise,
        surchargePaise,
        marginalPaise,
        currency,
      });
    }

    const baseLeg = await tx.paymentLeg.findUnique({
      where: { paymentId_source: { paymentId, source: "INVOICE_ACCRUAL" } },
      select: { amountPaise: true },
    });
    if (!baseLeg) {
      // #1458 — the old fallback treated "no base leg" as licence-funded and
      // made the overage fully additive, which cannot work on either remaining
      // rail. A LICENSE parent keeps `Payment.amount` at the full price behind a
      // deliberately ₹0 licence leg, and the leg-sum guard only excuses that
      // while the licence leg is the ONLY funding leg: adding an
      // OVERAGE_INVOICE_ACCRUAL leg re-arms the comparison and
      // `assert_payment_legs_ok` then raises at COMMIT, so the booking already
      // died with an opaque Postgres check_violation. A parent with no funding
      // leg at all means the funding seam itself drifted. Neither is fixable by
      // inflating the amount, so both refuse the booking with an error the buyer
      // can take to their admin.
      const fundingErr = new PaymentError(
        "This booking is past your programme's cap and the programme's funding source cannot be charged for the difference. Ask your billing admin to switch the programme to block over-cap bookings, or to fund it from the organisation's wallet or invoice account.",
        "OVERAGE_UNSUPPORTED_FUNDING",
      );
      // A coverage gap, not a modelled outcome: it means an operator saved a
      // programme whose overage can never be collected.
      reportSentryError(fundingErr, {
        subsystem: "payments",
        contexts: { overage: { paymentId, marginalPaise } },
      });
      throw fundingErr;
    }
    const carved = baseLeg.amountPaise >= basePaise ? basePaise : 0;
    if (carved > 0) {
      await tx.paymentLeg.update({
        where: { paymentId_source: { paymentId, source: "INVOICE_ACCRUAL" } },
        data: { amountPaise: { decrement: carved } },
      });
    }
    // OVERAGE_INVOICE_ACCRUAL (distinct source) avoids the @@unique([paymentId,
    // source]) clash with the base leg; the rollup turns the event into an
    // InvoiceLineItem (PENDING → ACCRUED → CHARGED).
    await tx.paymentLeg.create({
      data: {
        paymentId,
        source: "OVERAGE_INVOICE_ACCRUAL",
        amountPaise: marginalPaise,
        sourceRef: `overage:${programAssignmentId}`,
      },
    });
    const amountDelta = marginalPaise - carved;
    if (amountDelta > 0) {
      await tx.payment.update({
        where: { id: paymentId },
        data: { amount: { increment: amountDelta } },
      });
    }
    await tx.overageEvent.create({
      data: {
        programAssignmentId,
        bookingUtilizationId: bu.id,
        overageBehavior: "CHARGE_ORG",
        basePaise,
        surchargePaise,
        marginalPaise,
        currency,
        chargeStatus: "PENDING",
        // paymentId / invoiceLineItemId / settledAt stamped by the rollup.
      },
    });
  }

  // CHARGE_ORG bills through the monthly rollup; nobody is told anything now.
  return null;
}

/**
 * Record a CHARGE_ORG overage on a WALLET-funded parent (#1458).
 *
 * On the wallet rail the debit taken when the booking committed is the whole
 * nominal price, so the over-cap pass-through (`basePaise`) is already in the
 * platform's hands the moment the transaction commits. There is nothing left to
 * bill: the event is born CHARGED and settled, pointing at the payment whose
 * WALLET leg collected it. Writing an OVERAGE_INVOICE_ACCRUAL leg here instead
 * would break the `Σ non-credit legs == Payment.amount` identity the DB trigger
 * enforces, and incrementing `Payment.amount` on top of it made a later
 * cancellation refund the organisation more than its wallet was ever debited.
 *
 * The surcharge is the one part the wallet debit did NOT collect, because it is
 * a markup on top of the price rather than a slice of it. No rail collects it
 * after the fact without inflating the amount again, so the booking is refused
 * rather than quietly under-collected; the config-time guard in
 * `lib/enterprise/reachable-paths.ts` is what keeps operators out of this state.
 */
async function recordWalletCollectedOrgOverage(
  tx: Tx,
  args: {
    paymentId: string;
    programAssignmentId: string;
    bookingUtilizationId: string;
    basePaise: number;
    surchargePaise: number;
    marginalPaise: number;
    currency: Currency;
  },
): Promise<null> {
  if (args.surchargePaise > 0) {
    const surchargeErr = new PaymentError(
      "This programme adds a surcharge to bookings past its cap, which a wallet-funded organisation cannot be charged for. Ask your billing admin to remove the overage surcharge or to block over-cap bookings.",
      "OVERAGE_UNSUPPORTED_FUNDING",
    );
    reportSentryError(surchargeErr, {
      subsystem: "payments",
      contexts: {
        overage: {
          paymentId: args.paymentId,
          surchargePaise: args.surchargePaise,
        },
      },
    });
    throw surchargeErr;
  }

  await tx.overageEvent.create({
    data: {
      programAssignmentId: args.programAssignmentId,
      bookingUtilizationId: args.bookingUtilizationId,
      overageBehavior: "CHARGE_ORG",
      basePaise: args.basePaise,
      surchargePaise: args.surchargePaise,
      marginalPaise: args.marginalPaise,
      currency: args.currency,
      // CHARGED is the enum's "money collected" state and the wallet debit is
      // that collection, so the event is settled at birth. It carries no
      // invoiceLineItemId because it never reaches an invoice — `paymentId` is
      // the proof of collection instead, and the reconciler's (G2) link
      // invariant accepts either.
      chargeStatus: "CHARGED",
      settledAt: new Date(),
      paymentId: args.paymentId,
    },
  });

  // Nothing is owed by anyone, so there is no bell to ring.
  return null;
}

/**
 * Ring the member-due bell for a committed overage. Fire-and-forget: a booking
 * that is already paid for must not fail because a notification did not go out.
 */
export function notifyOverageDueAfterCommit(
  pending: PendingOverageNotification,
): void {
  void prisma.programAssignment
    .findUnique({
      where: { id: pending.programAssignmentId },
      select: {
        program: {
          select: {
            name: true,
            contract: {
              select: { organization: { select: { name: true } } },
            },
          },
        },
      },
    })
    .then((ctx) => {
      if (!ctx) return;
      return notifyOrgProgramOverageDue(pending.userId, {
        orgName: ctx.program.contract.organization.name,
        programName: ctx.program.name,
        amountPaise: pending.marginalPaise,
        payUrl: `/dashboard/overage?charge=${pending.overageEventId}`,
      });
    })
    .catch((notifyErr) => {
      console.error("[notifyOrgProgramOverageDue] failed:", notifyErr);
      reportSentryError(notifyErr, {
        subsystem: "payments",
        level: "warning",
      });
    });
}
