/**
 * PaymentLeg.sourceRef invariants per leg kind.
 *
 * Each leg on a `Payment` records one funding source. The `sourceRef`
 * column is a free-form string in Postgres, but semantically it carries
 * a different foreign key depending on `source`. This module centralises
 * the invariant so reconciliation jobs, refund flows, and audit writers
 * can join back without hunting through the schema.
 *
 * Keep this in lockstep with:
 *   - `prisma/schema.prisma` → `model PaymentLeg`
 *   - `docs/enterprise/10-money-and-ledger/09-payment-legs.md`
 *
 * If you add a new `PaymentLegSource` enum value you MUST add its
 * sourceRef semantics here so downstream reconcile code stays honest.
 */
import type { PaymentLegSource } from "@prisma/client";

/**
 * What a `sourceRef` string MUST contain, per leg kind:
 *
 *   CARD             → gateway payment id (pay_xxx for Razorpay, ch_xxx
 *                      or pi_xxx for Stripe). Used by refund handlers to
 *                      correlate webhook events to a leg.
 *   WALLET           → ProgramAssignment.id the leg is being billed to.
 *                      The wallet debit itself is a separate WalletEntry
 *                      row keyed on (billingAccountId, appointmentId);
 *                      sourceRef points at the assignment so reconcile
 *                      reports can answer "which program absorbed this
 *                      spend".
 *   REFERRAL_CREDIT  → ReferralCreditUsage.id created by
 *                      `applyCreditsToPayment`. Refund reversal reads
 *                      this to compute how many credits to restore.
 *   INVOICE_ACCRUAL          → ProgramAssignment.id that the accrual is being
 *                              rolled into. At month-end the invoice generator
 *                              groups legs by (organizationId, assignmentId) to
 *                              produce line items.
 *   OVERAGE_INVOICE_ACCRUAL  → ProgramAssignment.id (with "overage:" prefix in
 *                              sourceRef). Carries the marginal charge that
 *                              exceeds a LICENSED_SEAT cap under CHARGE_ORG.
 *                              Treated identically to INVOICE_ACCRUAL for
 *                              rollup and refund; separate source value prevents
 *                              @@unique([paymentId, source]) collision.
 *   LICENSE          → ProgramAssignment.id of the LICENSED_SEAT program
 *                      that absorbed the booking. `amountPaise === 0`
 *                      because licenses are a sunk cost at contract
 *                      time; the leg exists so every Payment still has
 *                      ≥1 leg and reconciliation can prove the booking
 *                      was lawfully fulfilled without a gateway charge.
 *   INVOICE_ACCRUAL_REVERSAL / OVERAGE_INVOICE_ACCRUAL_REVERSAL
 *                    → same sourceRef as the original sibling. #786 —
 *                      negative refund counter-entries for unbilled
 *                      accruals; one per source, partials net into it.
 */
type PaymentLegSourceRefKind =
  | "GATEWAY_PAYMENT_ID"
  | "PROGRAM_ASSIGNMENT_ID"
  | "REFERRAL_CREDIT_USAGE_ID";

export function sourceRefKindFor(
  source: PaymentLegSource,
): PaymentLegSourceRefKind {
  switch (source) {
    case "CARD":
      return "GATEWAY_PAYMENT_ID";
    case "REFERRAL_CREDIT":
      return "REFERRAL_CREDIT_USAGE_ID";
    case "WALLET":
    case "INVOICE_ACCRUAL":
    case "OVERAGE_INVOICE_ACCRUAL":
    case "INVOICE_ACCRUAL_REVERSAL":
    case "OVERAGE_INVOICE_ACCRUAL_REVERSAL":
    case "LICENSE":
      return "PROGRAM_ASSIGNMENT_ID";
    default: {
      const _exhaustive: never = source;
      throw new Error(
        `Unknown PaymentLegSource: ${_exhaustive as string} — update lib/payments/payment-legs.ts`,
      );
    }
  }
}

/**
 * Typed builder for a PaymentLeg input. Callers pass the `source` plus
 * a strongly-typed discriminated ref; the builder converts it to the
 * flat `{ source, amountPaise, sourceRef }` shape that Prisma expects
 * while keeping the semantic mapping enforced at compile time.
 *
 * Usage:
 *   makeLeg({ source: "CARD",    amountPaise: 150000, gatewayPaymentId: "pay_x" })
 *   makeLeg({ source: "WALLET",  amountPaise:  50000, programAssignmentId: "asg_x" })
 *   makeLeg({ source: "LICENSE", amountPaise:      0, programAssignmentId: "asg_x" })
 */
type PaymentLegInput =
  | {
      source: "CARD";
      amountPaise: number;
      gatewayPaymentId: string;
    }
  | {
      source: "REFERRAL_CREDIT";
      amountPaise: number;
      referralCreditUsageId: string;
    }
  | {
      source:
        | "WALLET"
        | "INVOICE_ACCRUAL"
        | "OVERAGE_INVOICE_ACCRUAL"
        | "LICENSE";
      amountPaise: number;
      programAssignmentId: string;
    };

export function makeLeg(input: PaymentLegInput): {
  source: PaymentLegSource;
  amountPaise: number;
  sourceRef: string;
} {
  switch (input.source) {
    case "CARD":
      return {
        source: "CARD",
        amountPaise: input.amountPaise,
        sourceRef: input.gatewayPaymentId,
      };
    case "REFERRAL_CREDIT":
      return {
        source: "REFERRAL_CREDIT",
        amountPaise: input.amountPaise,
        sourceRef: input.referralCreditUsageId,
      };
    case "WALLET":
    case "INVOICE_ACCRUAL":
    case "OVERAGE_INVOICE_ACCRUAL":
    case "LICENSE":
      return {
        source: input.source,
        amountPaise: input.amountPaise,
        sourceRef: input.programAssignmentId,
      };
  }
}

/**
 * #786 — reversal sources net against their original sibling. The map is
 * the single place that knows the pairing; refund + reconcile + rollup
 * readers all derive from it.
 */
export const REVERSAL_LEG_PAIRS = {
  INVOICE_ACCRUAL_REVERSAL: "INVOICE_ACCRUAL",
  OVERAGE_INVOICE_ACCRUAL_REVERSAL: "OVERAGE_INVOICE_ACCRUAL",
} as const satisfies Partial<Record<PaymentLegSource, PaymentLegSource>>;

export function isReversalLegSource(
  source: PaymentLegSource,
): source is keyof typeof REVERSAL_LEG_PAIRS {
  return source in REVERSAL_LEG_PAIRS;
}

/**
 * Per-payment funding identity:
 * `Σ(non-reversal, non-REFERRAL_CREDIT legs.amountPaise) === Payment.amount`.
 *
 * #1347 — `Payment.amount` is the gateway charge (after discounts + tax −
 * credits), so a REFERRAL_CREDIT leg is value the platform has ALREADY netted
 * out of `amount`; summing it back in double-counts the credit and every
 * credit-funded checkout dies at COMMIT on the DB constraint. The credit leg
 * still exists — it is the `PLATFORM_PROMO` debit in the booking journal — it
 * just is not part of the funding that has to add up to `amount`.
 *
 * `LICENSE` legs intentionally carry `amountPaise = 0` (the cost is
 * absorbed at contract time) — they're still part of the sum and the
 * math holds. For org-sponsored flows a single non-zero leg (WALLET or
 * INVOICE_ACCRUAL) equals `Payment.amount`.
 *
 * #786 — `*_REVERSAL` legs are negative refund counter-entries. They are
 * excluded from the funding sum (originals stay immutable and still sum to
 * `Payment.amount`); instead each reversal must (a) be negative and (b)
 * never exceed its original sibling in magnitude.
 *
 * Returns `null` when the invariant holds, or a `PaymentLegSumMismatch`
 * payload describing the drift otherwise. Callers pick policy: hard
 * throw for tests + reconciliation jobs, structured log for hot paths
 * where breaking checkout is worse than surfacing a warning.
 */
export type PaymentLegSumMismatch = {
  paymentAmountPaise: number;
  legSumPaise: number;
  deltaPaise: number;
  legs: Array<{ source: PaymentLegSource; amountPaise: number }>;
  /** Distinguishes a funding-sum drift from a reversal-pair violation. */
  reason: "FUNDING_SUM_DRIFT" | "REVERSAL_PAIR_VIOLATION";
};

export function checkPaymentLegsSumToAmount(args: {
  paymentAmountPaise: number;
  legs: Array<{ source: PaymentLegSource; amountPaise: number }>;
}): PaymentLegSumMismatch | null {
  const originals = args.legs.filter((l) => !isReversalLegSource(l.source));

  // E2E-audit fix — LICENSE-funded bookings are fully absorbed by the
  // contract: the funding leg is deliberately ₹0 while Payment.amount stays
  // at full price, so Σlegs === amount is structurally false for every one
  // of them. Treating that as a mismatch made the checkout warn AND emitted
  // a guaranteed nightly PAYMENT_LEG_SUM_MISMATCH finding per license
  // booking — drowning real WALLET/INVOICE drift in by-design noise. Skip
  // the sum test when the only original legs are zero-value LICENSE legs.
  const nonLicenseOriginals = originals.filter(
    (l) => !(l.source === "LICENSE" && l.amountPaise === 0),
  );
  // #1347 — the carve suppresses the SUM COMPARISON only, never the
  // reversal-pair checks below. Returning early here let a positive or
  // over-large *_REVERSAL leg pass the checker on a licence-only payment while
  // `assert_payment_legs_ok` still raised on it at COMMIT, so runtime and
  // database reached opposite verdicts about the same rows.
  const licenseOnly = nonLicenseOriginals.length === 0 && originals.length > 0;

  // #1347 — the credit is platform-funded and already netted out of
  // Payment.amount; counting it here would demand it twice over.
  const legSum = originals
    .filter((l) => l.source !== "REFERRAL_CREDIT")
    .reduce((acc, leg) => acc + leg.amountPaise, 0);
  if (!licenseOnly && legSum !== args.paymentAmountPaise) {
    return {
      paymentAmountPaise: args.paymentAmountPaise,
      legSumPaise: legSum,
      deltaPaise: legSum - args.paymentAmountPaise,
      legs: args.legs,
      reason: "FUNDING_SUM_DRIFT",
    };
  }
  for (const leg of args.legs) {
    if (!isReversalLegSource(leg.source)) continue;
    const sibling = args.legs
      .filter(
        (l) =>
          l.source ===
          REVERSAL_LEG_PAIRS[leg.source as keyof typeof REVERSAL_LEG_PAIRS],
      )
      .reduce((acc, l) => acc + l.amountPaise, 0);
    // #1347 — `>= 0`, not `> 0`: a zero reversal is an orphan counter-entry
    // with no economic content, and `assert_payment_legs_ok` rejects it. The
    // checker read zero as benign, so the two reached opposite verdicts on the
    // one value neither writer emits (refund.ts skips `reverse <= 0`).
    if (leg.amountPaise >= 0 || -leg.amountPaise > sibling) {
      return {
        paymentAmountPaise: args.paymentAmountPaise,
        legSumPaise: legSum,
        deltaPaise: leg.amountPaise,
        legs: args.legs,
        reason: "REVERSAL_PAIR_VIOLATION",
      };
    }
  }
  return null;
}

/**
 * Hard-throwing sibling of `checkPaymentLegsSumToAmount`. Use in tests
 * and in reconciliation / settlement jobs where the invariant MUST hold
 * before the job continues. Do not use in the hot checkout path — a
 * production false-positive there would break booking for real users.
 */
export function assertPaymentLegsSumToAmount(args: {
  paymentAmountPaise: number;
  legs: Array<{ source: PaymentLegSource; amountPaise: number }>;
}): void {
  const mismatch = checkPaymentLegsSumToAmount(args);
  if (!mismatch) return;
  throw new Error(
    `PaymentLeg sum invariant violated: expected ${mismatch.paymentAmountPaise} paise but legs sum to ${mismatch.legSumPaise} (delta ${mismatch.deltaPaise}). Legs: ${JSON.stringify(mismatch.legs)}`,
  );
}
