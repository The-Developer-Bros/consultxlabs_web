/**
 * Read-only ledger auditor.
 *
 * Walks the double-entry journal + derived balances to flag drift. #772
 * collapsed the three single-entry logs (FundingLedgerEntry, WalletEntry,
 * SettlementLedgerEntry) into the LedgerTransaction/LedgerEntry journal, so
 * the legacy mirror checks (B/C/D) are gone — their events now live as
 * balanced journal transactions, guarded by the per-txn imbalance check.
 *
 *   1. LedgerTransaction/Entry  ← the authoritative double-entry journal
 *   2. BillingAccount.walletBalance ← derived cache of the WALLET account
 *   3. OrganizationInvoice  ← ISSUED / PAID / REFUNDED status machine
 *   4. ProgramAssignment    ← per-(member, cycle) engagementsUsed counter
 *
 * Invariants we check:
 *
 *   A. For every BillingAccount:
 *      −balance(WALLET LedgerAccount) === billingAccount.walletBalance
 *      (the "wallet balance drift" check; WALLET is a credit-normal
 *      liability so amount owed = Σ CREDIT − Σ DEBIT)
 *
 *   LEDGER_TXN_IMBALANCE. For every LedgerTransaction:
 *      Σ DEBIT === Σ CREDIT (the double-entry invariant)
 *
 *   E. For every ACTIVE ProgramAssignment (periodEnd >= now):
 *      sum(usageLedgerEntry.engagementsConsumed) === programAssignment.engagementsUsed
 *      (the denormalized counter must match the immutable consumption
 *      ledger; drift means a partial-rollback bug or a manual SQL edit
 *      slipped past the atomic recordBookingUtilization() write)
 *
 *   F. For every BillingSubscription:
 *      billingSubscription.activeSeatCount ===
 *        count(active LICENSED_SEAT ProgramAssignment for that contract
 *              where periodEnd >= now)
 *      (the per-seat invoice line item depends on this counter; before
 *      issue #699 ENT-1 it had no production writer, so drift is the
 *      historical default. Run the backfill SQL migration first, then
 *      this invariant will hold.)
 *
 *   H. For every Payment:
 *      sum(PaymentLeg.amountPaise) === Payment.amount
 *      (LICENSE legs carry amountPaise=0, so the sum still works for
 *      org-license-covered bookings. The hot checkout path log-warns
 *      on mismatch; this invariant is the retroactive detector.)
 *
 *   G. For every OrganizationPayout in PENDING / APPROVED / PROCESSING /
 *      COMPLETED:
 *      sum(OrganizationEarnings.orgSharePaise - .refundedAmountPaise)
 *        for batched earnings === OrganizationPayout.netPayoutPaise
 *      (drift here means the batch claim updated earnings but didn't
 *      match the payout totals — investigate the
 *      createOrgPayoutBatch tx history. #1471: FAILED / REVERSED /
 *      CANCELLED payouts are skipped because they deliberately detach
 *      their earnings back to READY.)
 *
 *   Note: as of A3 (per-collaborator HOST-org settlement) one Payment
 *   can carry N OrganizationEarnings rows — one per (paymentId, orgId)
 *   pair, capped by the @@unique constraint. The primary expert's org
 *   gets a row whose grossAmountPaise === Payment.originalAmount; each
 *   collaborator-at-different-HOST-org gets a row whose
 *   grossAmountPaise === their slice of the consultant pool. Invariants
 *   here are payout-scoped (G aggregates per OrganizationPayout, not
 *   per Payment) so they remain correct without modification. Don't
 *   assume one OrganizationEarnings per Payment in any future invariant.
 *
 * This is READ-ONLY. It never writes to any of the audited tables. It
 * only writes its findings to `LedgerReconciliationReport`.
 *
 * Usage:
 *   import { runReconcileLedgers } from "scripts/reconcile/reconcile-ledgers";
 *   const report = await runReconcileLedgers({ scope: "full" });
 *
 *   // Or scoped to one org:
 *   await runReconcileLedgers({ scope: `org:${orgId}`, organizationId: orgId });
 */

import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { checkPaymentLegsSumToAmount } from "@/lib/payments/payment-legs";
import { ledgerBalancePaise } from "@/lib/payments/ledger/post";
import { sumPaise } from "@/lib/payments/utils/money";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import {
  applyLedgerBaseline,
  findingIdentity,
} from "@/lib/payments/ledger/baseline";

export type ReconcileScope = {
  /** Human-readable scope tag, e.g. "full" or "org:<orgId>". */
  scope: string;
  /** When present, limit the audit to a single organization. */
  organizationId?: string;
  /** Membership id that initiated this run (null for scheduled cron). */
  triggeredById?: string;
};

export type Finding = {
  kind:
    | "WALLET_BALANCE_DRIFT"
    | "EARNINGS_LEDGER_DRIFT"
    | "PROGRAM_ASSIGNMENT_ENGAGEMENTS_DRIFT"
    | "ACTIVE_SEAT_COUNT_DRIFT"
    | "PAYMENT_LEG_SUM_MISMATCH"
    | "ORG_PAYOUT_TOTAL_MISMATCH"
    | "LEDGER_TXN_IMBALANCE"
    // #775 — CREDIT_POOL money-meter: consumedPaise vs sum(UsageLedgerEntry price).
    | "CREDIT_POOL_CONSUMED_DRIFT"
    // #782 — overage state: overageCount cache vs live events; link/state integrity.
    | "OVERAGE_COUNT_DRIFT"
    | "OVERAGE_CHARGESTATUS_INTEGRITY"
    // #783 — ledger is INR-denominated; a non-INR account means a posting keyed
    // an INR-paise amount by a display currency.
    | "LEDGER_ACCOUNT_NON_INR"
    // #776 — maintained LedgerAccountBalance snapshot disagrees with the journal
    // (Σ DEBIT − Σ CREDIT), or an account with entries has no snapshot row.
    | "LEDGER_BALANCE_SNAPSHOT_DRIFT"
    // #776 §C — a fully-refunded payment whose BookingUtilization was not
    // reversed (cap leak), or a reversed utilization with no backing refund.
    | "REFUND_BOOKING_COHERENCE"
    // #776 — an OrganizationInvoice whose totalPaise != subtotalPaise + CGST +
    // SGST + IGST (a mis-totaled GST invoice is a filing defect).
    | "INVOICE_TOTAL_MISMATCH"
    // #812 — a ConsultantEarnings reversed (refundedShareAmount > 0) with no
    // REFUND ledger transaction for its payment: the reversal never hit the
    // journal (the blind spot the blocking-ledger change closes going forward;
    // this check surfaces any legacy/back-dated drift).
    | "REVERSED_EARNING_WITHOUT_REFUND_TXN"
    // #812 — a COMPLETED OrganizationPayout with no ORG_PAYOUT ledger
    // transaction: the cash left but the payable was never cleared in the journal.
    | "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN"
    // #1408 — an OrganizationPayout whose `clawbackAmountPaise` exceeds the
    // CASH DEBIT its `clawback:*` postings actually recorded. Only
    // reversePayoutClawback posts one, and it does so best-effort inside a
    // try/catch; the two other writers of `clawbackAmountPaise` (refund.ts and
    // booking-refund.ts) post nothing at all. The money row and the journal are
    // a dual write with no transaction spanning them, so this is the detector
    // for the gap — total (nothing posted) and partial (a later clawback's
    // posting lost) share the kind and differ only in `deltaPaise`.
    | "LEDGER_DUAL_WRITE_GAP"
    // #780 — a stored money value approaching/beyond Number.MAX_SAFE_INTEGER.
    // The JS boundary converts BigInt → number; past 2^53−1 that conversion
    // loses precision (and sumPaise() starts throwing mid-flight). This
    // surfaces the approach before anything crashes.
    | "MONEY_VALUE_WITHIN_SAFE_RANGE"
    // #778 §B — two ACTIVE assignments for the same (program, membership)
    // with overlapping periods double-count caps/seats. The app-level guard
    // in claimProgramAssignment prevents new ones; this is the retroactive
    // detector (exclusion constraints aren't Prisma-expressible).
    | "ASSIGNMENT_PERIOD_OVERLAP"
    // #773/#778 §G — earnings-bearing payments missing a BOOKING journal txn
    // beyond the allowed threshold (default 0 now that the splits path posts).
    | "EARNINGS_WITHOUT_BOOKING_TXN"
    // #778 §C/§G — per earnings-bearing payment, the recorded split must sum
    // back to the funded amount to the paise (proves the floor+residual
    // policy holds end-to-end).
    | "SPLIT_SUM_MISMATCH"
    // #775/#782 — CHARGE_MEMBER settlement coherence: a CHARGED event must
    // have its side-payment SUCCEEDED and the overage:<sidePaymentId> txn
    // posted; PENDING/FAILED events must have none. The capture-raced-
    // reversal case (REVERSED + no txn) self-reports via system error and
    // is deliberately not flagged here.
    | "OVERAGE_SETTLEMENT_MISMATCH";
  organizationId?: string;
  billingAccountId?: string;
  billingSubscriptionId?: string;
  invoiceId?: string;
  paymentId?: string;
  payoutId?: string;
  programAssignmentId?: string;
  // For engagements-drift + seat-count findings the values are integer
  // counts, not paise. The shared field name keeps the report row compact
  // at the cost of a small abuse of the term — units are documented in
  // each finding's `details.unit`.
  expectedPaise: number;
  actualPaise: number;
  deltaPaise: number;
  details?: Record<string, unknown>;
};

export type ReconcileReport = {
  id: string;
  runAt: Date;
  scope: string;
  ok: boolean;
  durationMs: number;
  summary: {
    orgsChecked: number;
    accountsChecked: number;
    assignmentsChecked: number;
    subscriptionsChecked: number;
    paymentsChecked: number;
    payoutsChecked: number;
    discrepanciesCount: number;
    earningsPaymentsWithoutBookingTxn: number;
  };
  findings: Finding[];
};

/**
 * #1408 — the clawback dual-write gap, compared on AMOUNTS rather than on the
 * presence of a posting. `clawbackAmountPaise` is a running total: a payout
 * clawed back twice whose second posting was swallowed still carries a
 * `clawback:*` transaction, so a payout-id Set reads it as clean. The CASH
 * DEBIT is the authoritative leg — it is the money that came back — so the sum
 * of those legs is what the stamped counter is measured against. Pure, so the
 * pin can drive it without standing up a whole reconciler run.
 */
export function clawbackDualWriteGapFindings(
  payouts: {
    id: string;
    organizationId: string;
    clawbackAmountPaise: number | bigint;
  }[],
  postedPaiseByPayout: Map<string, number>,
): Finding[] {
  const out: Finding[] = [];
  for (const po of payouts) {
    const expected = Number(po.clawbackAmountPaise);
    // Both columns are BigInt and `Finding` carries plain numbers, so the
    // narrowing stays. What must never happen quietly is a value that does not
    // survive it: past 2^53 the comparison below rounds, and a rounded shortfall
    // reads as `actual >= expected` — the detector would report CLEAN on a real
    // dual-write gap. Loud failure naming the row beats a suppressed finding.
    if (!Number.isSafeInteger(expected)) {
      throw new Error(
        `clawbackDualWriteGapFindings: OrganizationPayout ${po.id} has clawbackAmountPaise=${po.clawbackAmountPaise}, outside the safe-integer range — the shortfall comparison would round and could suppress a LEDGER_DUAL_WRITE_GAP.`,
      );
    }
    const actual = postedPaiseByPayout.get(po.id) ?? 0;
    // Shortfall only. A ledger that posted MORE than was stamped is the
    // opposite defect and does not belong under this kind's note.
    if (actual >= expected) continue;
    out.push({
      kind: "LEDGER_DUAL_WRITE_GAP",
      organizationId: po.organizationId,
      payoutId: po.id,
      expectedPaise: expected,
      actualPaise: actual,
      deltaPaise: expected - actual,
      details: {
        scope: "org-payout-clawback",
        note:
          actual === 0
            ? "OrganizationPayout.clawbackAmountPaise > 0 but no clawback:* ledger transaction against this payout."
            : "OrganizationPayout.clawbackAmountPaise exceeds the summed CASH DEBIT of its clawback:* postings — a later clawback's dual write was lost.",
      },
    });
  }
  return out;
}

// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: read-only auditor, lock is belt-and-braces.
export async function runReconcileLedgers(
  opts: ReconcileScope,
): Promise<ReconcileReport> {
  return withCronLock(
    "reconcile-ledgers",
    { failMode: "open", ttlMs: LONG_JOB_TTL_MS },
    () => runReconcileLedgersUnlocked(opts),
  );
}

async function runReconcileLedgersUnlocked(
  opts: ReconcileScope,
): Promise<ReconcileReport> {
  const startedAt = Date.now();
  const findings: Finding[] = [];

  const orgFilter = opts.organizationId
    ? { id: opts.organizationId }
    : undefined;

  // --- (A): per BillingAccount wallet balance vs derived WALLET account ---
  const accounts = await prisma.billingAccount.findMany({
    where: orgFilter ? { ownerOrgId: orgFilter.id } : undefined,
    select: { id: true, walletBalance: true, ownerOrgId: true, currency: true },
  });

  for (const acct of accounts) {
    // #772 B3 — WalletEntry removed; the wallet balance derives from the org's
    // WALLET LedgerAccount. WALLET is a credit-normal liability, so the amount
    // owed = Σ CREDIT − Σ DEBIT = −(signed Dr−Cr balance). The cached
    // walletBalance must equal it. (Funding-mirror check B dropped with
    // FundingLedgerEntry; the journal is the accounting source of truth, guarded
    // by the LEDGER_TXN_IMBALANCE check below.)
    const walletTotal = acct.ownerOrgId
      ? -(await ledgerBalancePaise(prisma, {
          kind: "WALLET",
          organizationId: acct.ownerOrgId,
          currency: acct.currency,
        }))
      : 0;
    const bal = acct.walletBalance ?? 0;

    if (walletTotal !== bal) {
      findings.push({
        kind: "WALLET_BALANCE_DRIFT",
        billingAccountId: acct.id,
        organizationId: acct.ownerOrgId ?? undefined,
        expectedPaise: walletTotal,
        actualPaise: bal,
        deltaPaise: bal - walletTotal,
      });
    }
  }

  // --- (C) + (D): per-Organization settlement coverage ---
  const organizations = await prisma.organization.findMany({
    where: orgFilter,
    select: { id: true },
  });

  // #772 B2 — SettlementLedgerEntry removed; settlement coverage checks (C/D)
  // dropped. INVOICE_ISSUED / INVOICE_PAID / PAYOUT events now live in the
  // double-entry journal (LedgerTransaction.kind) + OrgAuditLog. `organizations`
  // is retained for the summary count.
  void organizations.length;

  // --- (E): per ProgramAssignment engagement-counter drift ---
  // engagementsUsed is denormalized for query performance — checkout
  // reads it on every booking to evaluate the per-cycle cap. It's
  // incremented atomically inside recordBookingUtilization() in the
  // same transaction that writes the UsageLedgerEntry, so under correct
  // operation the two never drift. Drift here implies a
  // partial-rollback bug, a manual SQL fix, or a missing-ledger-write
  // code path. Scoped to ACTIVE assignments (periodEnd >= now()) — we
  // don't re-check historical cycles every run. Reversed
  // UsageLedgerEntry rows post a negative engagementsConsumed, so the
  // SUM here naturally accounts for refunds without a separate filter.
  const now = new Date();
  const liveAssignments = await prisma.programAssignment.findMany({
    where: {
      periodEnd: { gte: now },
      ...(opts.organizationId
        ? { program: { contract: { organizationId: opts.organizationId } } }
        : {}),
    },
    select: {
      id: true,
      engagementsUsed: true,
      // #775 — CREDIT_POOL money-meter counter (paise).
      consumedPaise: true,
      // #782 — over-cap booking cache.
      overageCount: true,
      program: {
        select: { type: true, contract: { select: { organizationId: true } } },
      },
    },
  });

  for (const a of liveAssignments) {
    const ledgerSum = await prisma.usageLedgerEntry.aggregate({
      where: { programAssignmentId: a.id },
      _sum: { engagementsConsumed: true, priceAtBookingPaise: true },
    });
    const ledgerTotal = ledgerSum._sum?.engagementsConsumed ?? 0;
    if (ledgerTotal !== a.engagementsUsed) {
      findings.push({
        kind: "PROGRAM_ASSIGNMENT_ENGAGEMENTS_DRIFT",
        programAssignmentId: a.id,
        organizationId: a.program.contract.organizationId,
        // The shared expected/actual fields hold engagement counts
        // here, not paise. The auditor UI keys on `kind` to render
        // units correctly.
        expectedPaise: ledgerTotal,
        actualPaise: a.engagementsUsed,
        deltaPaise: a.engagementsUsed - ledgerTotal,
        details: {
          unit: "engagements",
          note: "ProgramAssignment.engagementsUsed disagrees with sum(UsageLedgerEntry.engagementsConsumed). Investigate via the assignment's UsageLedgerEntry trail and the recordBookingUtilization() write path.",
        },
      });
    }

    // #775/#753 — CREDIT_POOL meters in paise; consumedPaise must equal the
    // (refund-netted) sum of the cycle's UsageLedgerEntry prices. Reversed
    // rows post a negative price, so the SUM accounts for refunds. Only
    // CREDIT_POOL assignments carry a money-meter (LICENSED_SEAT leaves
    // consumedPaise at 0).
    if (a.program.type === "CREDIT_POOL") {
      // #780 — aggregate _sum bypasses the result extension: bigint at runtime.
      const priceTotal = sumPaise(ledgerSum._sum?.priceAtBookingPaise);
      if (priceTotal !== a.consumedPaise) {
        findings.push({
          kind: "CREDIT_POOL_CONSUMED_DRIFT",
          programAssignmentId: a.id,
          organizationId: a.program.contract.organizationId,
          expectedPaise: priceTotal,
          actualPaise: a.consumedPaise,
          deltaPaise: a.consumedPaise - priceTotal,
          details: {
            unit: "paise",
            note: "ProgramAssignment.consumedPaise disagrees with sum(UsageLedgerEntry.priceAtBookingPaise). Investigate the CREDIT_POOL money-meter write in recordBookingUtilization()/reverseBookingUtilization().",
          },
        });
      }
    }

    // #782 — overageCount cache vs live over-cap bookings. The counter bumps on
    // each over-cap booking and decrements on full reversal (same gate that
    // flips the OverageEvent → REVERSED), so it must equal the count of
    // non-REVERSED events for the assignment. A drift of 1 typically means a
    // fully-refunded booking whose overage was already CHARGED (awaiting a
    // credit note, #716) — the counter dropped but the event stays CHARGED.
    const liveOverage = await prisma.overageEvent.count({
      where: {
        programAssignmentId: a.id,
        chargeStatus: { notIn: ["REVERSED", "BLOCKED"] },
      },
    });
    if (liveOverage !== a.overageCount) {
      findings.push({
        kind: "OVERAGE_COUNT_DRIFT",
        programAssignmentId: a.id,
        organizationId: a.program.contract.organizationId,
        expectedPaise: liveOverage,
        actualPaise: a.overageCount,
        deltaPaise: a.overageCount - liveOverage,
        details: {
          unit: "events",
          note: "ProgramAssignment.overageCount disagrees with count(OverageEvent where chargeStatus not in REVERSED/BLOCKED). Check the bump in recordBookingUtilization() vs the full-reversal decrement in reverseBookingUtilization(); a charged-then-refunded overage is the expected #716 cause.",
        },
      });
    }
  }

  // --- (G2) #782: OverageEvent link/state integrity ---
  // A CHARGE_MEMBER event that is pending/failed/charged must carry its
  // side-Payment; a CHARGE_ORG event that is accrued/charged must carry its
  // invoice line item; any CHARGED event must be settled. Violations mean the
  // transitionOverage state machine was bypassed or a write half-completed.
  const badOverage = await prisma.overageEvent.findMany({
    where: {
      ...(opts.organizationId
        ? {
            programAssignment: {
              program: { contract: { organizationId: opts.organizationId } },
            },
          }
        : {}),
      OR: [
        {
          overageBehavior: "CHARGE_MEMBER",
          chargeStatus: { in: ["PENDING", "FAILED", "CHARGED"] },
          paymentId: null,
        },
        // ACCRUED means "billed on an issued invoice", which only the rollup
        // produces and which always stamps the line item. A payment link cannot
        // stand in for it, so this branch keeps invoiceLineItemId mandatory.
        {
          overageBehavior: "CHARGE_ORG",
          chargeStatus: "ACCRUED",
          invoiceLineItemId: null,
        },
        // #1458 — a wallet-funded CHARGE_ORG overage is collected by the
        // booking's own wallet debit and never reaches an invoice, so it is born
        // CHARGED with a paymentId and no line item. That link is proof of
        // collection only when the payment behind it actually carries the WALLET
        // leg that did the collecting; any other CHARGED event with no line item
        // is still the drift this check hunts.
        {
          overageBehavior: "CHARGE_ORG",
          chargeStatus: "CHARGED",
          invoiceLineItemId: null,
          OR: [
            { paymentId: null },
            { payment: { legs: { none: { source: "WALLET" } } } },
          ],
        },
        { chargeStatus: "CHARGED", settledAt: null },
      ],
    },
    select: {
      id: true,
      overageBehavior: true,
      chargeStatus: true,
      paymentId: true,
      invoiceLineItemId: true,
      settledAt: true,
      marginalPaise: true,
      programAssignment: {
        select: {
          id: true,
          program: {
            select: { contract: { select: { organizationId: true } } },
          },
        },
      },
    },
    take: 500,
  });
  for (const ev of badOverage) {
    findings.push({
      kind: "OVERAGE_CHARGESTATUS_INTEGRITY",
      programAssignmentId: ev.programAssignment.id,
      organizationId: ev.programAssignment.program.contract.organizationId,
      expectedPaise: ev.marginalPaise,
      actualPaise: ev.marginalPaise,
      deltaPaise: 0,
      details: {
        unit: "event",
        overageEventId: ev.id,
        overageBehavior: ev.overageBehavior,
        chargeStatus: ev.chargeStatus,
        paymentId: ev.paymentId,
        invoiceLineItemId: ev.invoiceLineItemId,
        settledAt: ev.settledAt,
        note: "OverageEvent link/state invariant violated: CHARGE_MEMBER pending/failed/charged without a side-Payment, CHARGE_ORG accrued without an InvoiceLineItem, CHARGE_ORG charged with neither an InvoiceLineItem nor a booking Payment carrying the WALLET leg that collected it (#1458), or CHARGED without settledAt. Trace the transitionOverage() path that produced this state.",
      },
    });
  }

  // --- (G3) #783: ledger is INR-denominated ---
  // Razorpay settles INR and amounts post as INR paise with no FX conversion,
  // so every LedgerAccount must be INR. A non-INR account means a posting keyed
  // an INR-paise amount by a display currency (would break clearing). Holds
  // until a real multi-currency model is designed (#783).
  const nonInrAccounts = await prisma.ledgerAccount.findMany({
    where: {
      currency: { not: "INR" },
      ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
    },
    select: { id: true, kind: true, currency: true, organizationId: true },
    take: 200,
  });
  for (const acct of nonInrAccounts) {
    findings.push({
      kind: "LEDGER_ACCOUNT_NON_INR",
      organizationId: acct.organizationId ?? undefined,
      expectedPaise: 0,
      actualPaise: 0,
      deltaPaise: 0,
      details: {
        unit: "account",
        ledgerAccountId: acct.id,
        accountKind: acct.kind,
        currency: acct.currency,
        note: "Non-INR LedgerAccount: the ledger is INR-denominated (#783). A posting keyed an INR-paise amount by a display currency — fix the posting to leave AccountRef.currency unset (INR), or design the multi-currency model first.",
      },
    });
  }

  // --- (H): per Payment leg-sum invariant ---
  // The hot checkout path log-warns on mismatch (we don't break booking
  // for a leg-accounting bug); this is the retroactive detector. We only
  // walk Payments associated with org bookings — B2C card-only payments
  // have a single CARD leg whose sum is trivially equal and the read
  // would balloon for no audit value. Org legs (WALLET, INVOICE_ACCRUAL,
  // LICENSE) are the ones that benefit from a sweep.
  const paymentsWithOrgLegs = await prisma.payment.findMany({
    where: {
      organizationId: opts.organizationId ?? { not: null },
    },
    select: { id: true, amount: true, organizationId: true },
  });
  for (const p of paymentsWithOrgLegs) {
    const legs = await prisma.paymentLeg.findMany({
      where: { paymentId: p.id },
      select: { source: true, amountPaise: true },
    });
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: p.amount,
      legs,
    });
    if (mismatch) {
      findings.push({
        kind: "PAYMENT_LEG_SUM_MISMATCH",
        organizationId: p.organizationId ?? undefined,
        paymentId: p.id,
        expectedPaise: p.amount,
        actualPaise: mismatch.legSumPaise,
        deltaPaise: mismatch.deltaPaise,
        details: {
          legs: mismatch.legs,
          note: "Sum of PaymentLeg.amountPaise diverges from Payment.amount. Investigate which leg writer (checkout / wallet / referral) emitted the wrong amount.",
        },
      });
    }
  }

  // --- (F2 / #776): OrganizationInvoice total integrity ---
  // totalPaise must equal subtotalPaise + CGST + SGST + IGST. The issue-time
  // assertion in invoice-rollup.ts prevents new drift; this is the retroactive
  // sweep for legacy / manually-edited rows.
  const invoicesToCheck = await prisma.organizationInvoice.findMany({
    where: opts.organizationId ? { organizationId: opts.organizationId } : {},
    select: {
      id: true,
      organizationId: true,
      subtotalPaise: true,
      igstPaise: true,
      cgstPaise: true,
      sgstPaise: true,
      totalPaise: true,
    },
  });
  for (const inv of invoicesToCheck) {
    const expected =
      inv.subtotalPaise + inv.igstPaise + inv.cgstPaise + inv.sgstPaise;
    if (inv.totalPaise !== expected) {
      findings.push({
        kind: "INVOICE_TOTAL_MISMATCH",
        organizationId: inv.organizationId,
        expectedPaise: expected,
        actualPaise: inv.totalPaise,
        deltaPaise: inv.totalPaise - expected,
        details: {
          invoiceId: inv.id,
          note: "OrganizationInvoice.totalPaise != subtotalPaise + CGST + SGST + IGST. Check the GST split (lib/compliance/gst.ts) and the issue-time invariant in invoice-rollup.ts.",
        },
      });
    }
  }

  // --- (G): per OrganizationPayout total vs claimed earnings ---
  // The createOrgPayoutBatch tx claims READY earnings, computes totals,
  // and writes them to the payout in one go. If anything ever diverges
  // (manual SQL, partial migration, future code changes) this catches
  // the drift before the next bank transfer is initiated.
  //
  // #1471 review — scoped to the statuses where the attachment is EXPECTED to
  // hold. A FAILED payout (markOrgPayoutFailedInternal) and a REVERSED one
  // (markOrgPayoutReversed) both detach their earnings back to READY with
  // `orgPayoutId: null` on purpose, so they legitimately end up with zero
  // attached earnings against a retained `netPayoutPaise` — every one of them
  // was being reported as drift. CANCELLED is excluded for the same reason.
  // APPROVED is included with PENDING/PROCESSING/COMPLETED because the batch is
  // still live and its earnings are still claimed.
  const ATTACHMENT_EXPECTED_STATUSES = [
    "PENDING",
    "APPROVED",
    "PROCESSING",
    "COMPLETED",
  ] as const;
  const payouts = await prisma.organizationPayout.findMany({
    where: {
      status: { in: [...ATTACHMENT_EXPECTED_STATUSES] },
      ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
    },
    select: {
      id: true,
      organizationId: true,
      netPayoutPaise: true,
      earnings: {
        select: { orgSharePaise: true, refundedAmountPaise: true },
      },
    },
  });
  for (const p of payouts) {
    const expected = p.earnings.reduce(
      (acc, e) => acc + e.orgSharePaise - e.refundedAmountPaise,
      0,
    );
    if (expected !== p.netPayoutPaise) {
      findings.push({
        kind: "ORG_PAYOUT_TOTAL_MISMATCH",
        organizationId: p.organizationId,
        payoutId: p.id,
        expectedPaise: expected,
        actualPaise: p.netPayoutPaise,
        deltaPaise: p.netPayoutPaise - expected,
        details: {
          earningsCount: p.earnings.length,
          note: "OrganizationPayout.netPayoutPaise diverges from sum(orgShare - refunds) of attached earnings. Only PENDING/APPROVED/PROCESSING/COMPLETED payouts are checked: FAILED, REVERSED and CANCELLED payouts release their earnings back to READY with orgPayoutId cleared, so a zero-earnings total on those is the designed outcome, not drift (#1471).",
        },
      });
    }
  }

  // --- (F): per BillingSubscription activeSeatCount drift ---
  // activeSeatCount is denormalized from ProgramAssignment count for
  // billing-cron read efficiency (the invoice cron must compute
  // line-items in O(1) lookups across thousands of subs). It is written
  // by adjustActiveSeatCount() in lib/api/organizations/seat-count.ts on
  // assignment create/delete. Drift means a missed write or manual SQL.
  // We only count assignments whose program is currently ACTIVE — paused
  // / archived programs don't contribute to billable seats.
  const subscriptions = await prisma.billingSubscription.findMany({
    where: opts.organizationId
      ? { contract: { organizationId: opts.organizationId } }
      : undefined,
    select: {
      id: true,
      activeSeatCount: true,
      contractId: true,
      contract: {
        select: { organizationId: true },
      },
    },
  });

  for (const sub of subscriptions) {
    const expected = await prisma.programAssignment.count({
      where: {
        periodEnd: { gte: now },
        program: {
          contractId: sub.contractId,
          type: "LICENSED_SEAT",
          status: "ACTIVE",
        },
      },
    });
    if (expected !== sub.activeSeatCount) {
      findings.push({
        kind: "ACTIVE_SEAT_COUNT_DRIFT",
        organizationId: sub.contract.organizationId,
        billingSubscriptionId: sub.id,
        expectedPaise: expected,
        actualPaise: sub.activeSeatCount,
        deltaPaise: sub.activeSeatCount - expected,
        details: {
          unit: "seats",
          note: "BillingSubscription.activeSeatCount disagrees with the count of in-period LICENSED_SEAT ProgramAssignments. Re-run the backfill migration if this reflects historical drift.",
        },
      });
    }
  }

  // --- (H) #771 D1/D5 — double-entry invariant: every LedgerTransaction must
  // balance (Σ DEBIT === Σ CREDIT). postLedgerTxn enforces this at write time;
  // this nightly check catches manual SQL edits or a future writer bug. ZERO
  // findings here across a reseed is the GATE that lets the three single-entry
  // logs (Wallet/Funding/Settlement) above be safely removed (#771 cutover).
  // Global integrity check — runs on full scope only.
  if (!opts.organizationId) {
    const ledgerSums = await prisma.ledgerEntry.groupBy({
      by: ["transactionId", "direction"],
      _sum: { amountPaise: true },
    });
    const perTxn = new Map<string, { debit: number; credit: number }>();
    for (const row of ledgerSums) {
      const cur = perTxn.get(row.transactionId) ?? { debit: 0, credit: 0 };
      const amt = sumPaise(row._sum.amountPaise);
      if (row.direction === "DEBIT") cur.debit += amt;
      else cur.credit += amt;
      perTxn.set(row.transactionId, cur);
    }
    perTxn.forEach((sums, transactionId) => {
      if (sums.debit !== sums.credit) {
        findings.push({
          kind: "LEDGER_TXN_IMBALANCE",
          expectedPaise: sums.debit,
          actualPaise: sums.credit,
          deltaPaise: sums.debit - sums.credit,
          details: {
            transactionId,
            unit: "paise",
            note: "Double-entry LedgerTransaction does not balance (Σdebit ≠ Σcredit).",
          },
        });
      }
    });

    // --- (H2) #776 — LedgerAccountBalance snapshot integrity. The maintained
    // running balance is a derived cache; the journal is the source of truth.
    // Compare every account's snapshot against Σ(DEBIT) − Σ(CREDIT) from
    // entries. Catches a snapshot that drifted from a bad writer or a posting
    // that bypassed postLedgerTxn. Zero findings here on a reseed is the gate
    // that lets dashboards/credit-limit checks trust the O(1) snapshot read.
    const entrySums = await prisma.ledgerEntry.groupBy({
      by: ["accountId", "direction"],
      _sum: { amountPaise: true },
    });
    const journalByAccount = new Map<string, number>();
    for (const row of entrySums) {
      const amt = sumPaise(row._sum.amountPaise);
      const cur = journalByAccount.get(row.accountId) ?? 0;
      journalByAccount.set(
        row.accountId,
        row.direction === "DEBIT" ? cur + amt : cur - amt,
      );
    }
    const snapshots = await prisma.ledgerAccountBalance.findMany({
      select: { accountId: true, balancePaise: true },
    });
    const snapshotByAccount = new Map<string, number>(
      snapshots.map((s) => [s.accountId, s.balancePaise]),
    );
    const allAccountIds = new Set<string>(
      Array.from(journalByAccount.keys()).concat(
        Array.from(snapshotByAccount.keys()),
      ),
    );
    for (const accountId of Array.from(allAccountIds)) {
      const journal = journalByAccount.get(accountId) ?? 0;
      const snapshot = snapshotByAccount.get(accountId);
      // A missing snapshot for an account with no entries nets to 0 — fine.
      const snapshotVal = snapshot ?? 0;
      if (snapshotVal !== journal) {
        findings.push({
          kind: "LEDGER_BALANCE_SNAPSHOT_DRIFT",
          expectedPaise: journal,
          actualPaise: snapshotVal,
          deltaPaise: snapshotVal - journal,
          details: {
            ledgerAccountId: accountId,
            unit: "paise",
            snapshotMissing: snapshot === undefined,
            note: "LedgerAccountBalance snapshot disagrees with the journal-derived balance.",
          },
        });
      }
    }

    // --- (H3) #776 §C — refund ↔ utilization coherence. A fully-refunded
    // payment must have its BookingUtilization reversed (else the seat/cap
    // leaks: the member got their money back but still consumes an
    // engagement). The inverse — a reversed utilization with no SUCCEEDED
    // refund — means a seat was released for free. The reversal engine keeps
    // these in lockstep; this catches a partial-failure or a CLASS multi-
    // booking refund that skipped a child.
    const utilizations = await prisma.bookingUtilization.findMany({
      select: {
        id: true,
        paymentId: true,
        reversedAt: true,
        payment: {
          select: {
            amount: true,
            refunds: { select: { amountPaise: true, status: true } },
          },
        },
      },
    });
    for (const u of utilizations) {
      const settledRefunds = u.payment.refunds
        .filter((r) => r.status === "SUCCEEDED")
        .reduce((s, r) => s + r.amountPaise, 0);
      const fullyRefunded =
        u.payment.amount > 0 && settledRefunds >= u.payment.amount;
      const isReversed = u.reversedAt !== null;
      if (fullyRefunded && !isReversed) {
        findings.push({
          kind: "REFUND_BOOKING_COHERENCE",
          paymentId: u.paymentId,
          expectedPaise: u.payment.amount,
          actualPaise: settledRefunds,
          deltaPaise: settledRefunds - u.payment.amount,
          details: {
            bookingUtilizationId: u.id,
            unit: "paise",
            note: "Payment fully refunded but BookingUtilization not reversed (cap leak).",
          },
        });
      } else if (isReversed && settledRefunds === 0) {
        findings.push({
          kind: "REFUND_BOOKING_COHERENCE",
          paymentId: u.paymentId,
          expectedPaise: 0,
          actualPaise: u.payment.amount,
          deltaPaise: u.payment.amount,
          details: {
            bookingUtilizationId: u.id,
            unit: "paise",
            note: "BookingUtilization reversed with no SUCCEEDED refund (seat released for free).",
          },
        });
      }
    }
  }

  // --- (E2) booking-ledger drift (covered payments only) — #772 B4 ----------
  // Earnings amount columns are a reconciled cache; the journal is the source
  // of truth. For every payment that HAS a booking journal txn, the journal's
  // earnings-relevant credits (PLATFORM_FEE + CONSULTANT_PAYABLE + ORG_PAYABLE)
  // must equal the cached Earnings amounts. #776 — multi-collaborator bookings
  // now post per-collaborator CONSULTANT_PAYABLE credits (no longer deferred), so
  // they carry a BOOKING txn and are covered here; the only payments without a txn
  // are pre-#776 seed rows (counted below for visibility, not flagged).
  const bookingTxns = await prisma.ledgerTransaction.findMany({
    where: { kind: "BOOKING", paymentId: { not: null } },
    select: { id: true, paymentId: true },
  });
  const coveredPaymentIds = new Set(
    bookingTxns.map((t) => t.paymentId).filter((p): p is string => !!p),
  );
  for (const txn of bookingTxns) {
    if (!txn.paymentId) continue;
    const creditRows = await prisma.ledgerEntry.findMany({
      where: {
        transactionId: txn.id,
        direction: "CREDIT",
        account: {
          kind: { in: ["PLATFORM_FEE", "CONSULTANT_PAYABLE", "ORG_PAYABLE"] },
        },
      },
      select: { amountPaise: true },
    });
    const journalEarnings = creditRows.reduce(
      (s, r) => s + Number(r.amountPaise),
      0,
    );
    const [ce, oe] = await Promise.all([
      prisma.consultantEarnings.aggregate({
        where: { paymentId: txn.paymentId },
        _sum: { platformFeePaise: true, consultantSharePaise: true },
      }),
      prisma.organizationEarnings.aggregate({
        where: { paymentId: txn.paymentId },
        _sum: { orgSharePaise: true },
      }),
    ]);
    const cacheEarnings =
      sumPaise(ce._sum.platformFeePaise) +
      sumPaise(ce._sum.consultantSharePaise) +
      sumPaise(oe._sum.orgSharePaise);
    if (journalEarnings !== cacheEarnings) {
      findings.push({
        kind: "EARNINGS_LEDGER_DRIFT",
        paymentId: txn.paymentId,
        expectedPaise: cacheEarnings,
        actualPaise: journalEarnings,
        deltaPaise: journalEarnings - cacheEarnings,
        details: {
          unit: "paise",
          note: "Cached Earnings amounts (ConsultantEarnings.platformFee+consultantShare + OrganizationEarnings.orgShare) do not match the booking journal's PLATFORM_FEE+CONSULTANT_PAYABLE+ORG_PAYABLE credits.",
        },
      });
    }
  }

  // #773/#778 §G — earnings-bearing payments with no booking journal txn.
  // Now that the multi-collaborator path posts its own balanced booking txn,
  // this count must be ZERO: any excess over RECONCILE_UNJOURNALED_MAX
  // (env, default 0) is a finding, not an info metric — the platform must
  // never silently run partially-journaled again.
  const earningsPaymentRows = await prisma.consultantEarnings.findMany({
    select: { paymentId: true },
    distinct: ["paymentId"],
  });
  const unjournaled = earningsPaymentRows.filter(
    (e) => e.paymentId && !coveredPaymentIds.has(e.paymentId),
  );
  const earningsPaymentsWithoutBookingTxn = unjournaled.length;
  const unjournaledMax = Number(process.env.RECONCILE_UNJOURNALED_MAX ?? 0);
  if (earningsPaymentsWithoutBookingTxn > unjournaledMax) {
    findings.push({
      kind: "EARNINGS_WITHOUT_BOOKING_TXN",
      expectedPaise: unjournaledMax,
      actualPaise: earningsPaymentsWithoutBookingTxn,
      deltaPaise: earningsPaymentsWithoutBookingTxn - unjournaledMax,
      details: {
        unit: "payments",
        samplePaymentIds: unjournaled.slice(0, 10).map((e) => e.paymentId),
        note: "Earnings-bearing payments missing a BOOKING ledger transaction exceed the allowed threshold (#773).",
      },
    });
  }

  // #812 — a reversed earning with no REFUND ledger transaction. The new
  // blocking-ledger behaviour prevents this going forward (a refund that can't
  // post a balanced journal rolls back), but the check surfaces any legacy or
  // back-dated divergence the nightly run should page on. #813 — batched into a
  // single REFUND-txn findMany + Set membership (was a per-row findFirst loop),
  // matching the (E2) pattern above.
  const reversedEarnings = await prisma.consultantEarnings.findMany({
    where: {
      refundedShareAmount: { gt: 0 },
      ...(opts.organizationId
        ? { payment: { organizationId: opts.organizationId } }
        : {}),
    },
    select: {
      id: true,
      paymentId: true,
      refundedShareAmount: true,
      payment: { select: { organizationId: true } },
    },
  });
  const reversedPaymentIds = reversedEarnings
    .map((r) => r.paymentId)
    .filter((p): p is string => !!p);
  const refundTxns = await prisma.ledgerTransaction.findMany({
    where: { kind: "REFUND", paymentId: { in: reversedPaymentIds } },
    select: { paymentId: true },
  });
  const refundedPaymentIds = new Set(
    refundTxns.map((t) => t.paymentId).filter((p): p is string => !!p),
  );
  for (const rev of reversedEarnings) {
    if (!rev.paymentId) continue;
    if (!refundedPaymentIds.has(rev.paymentId)) {
      findings.push({
        kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
        paymentId: rev.paymentId,
        organizationId: rev.payment?.organizationId ?? undefined,
        expectedPaise: rev.refundedShareAmount,
        actualPaise: 0,
        deltaPaise: rev.refundedShareAmount,
        details: {
          consultantEarningsId: rev.id,
          note: "ConsultantEarnings.refundedShareAmount > 0 but no REFUND ledger transaction for this payment.",
        },
      });
    }
  }

  // #812 — a COMPLETED OrganizationPayout with no ORG_PAYOUT ledger transaction:
  // the cash left but the payable was never cleared in the journal. #813 —
  // batched via a Set keyed on the ORIGINAL posting's idempotencyKey
  // (`orgpayout:<id>`, matching org-payout-service); a plain {kind,payoutId} would
  // be satisfied by the #812 REVERSAL posting (`orgpayout-reversal:<id>`), which
  // shares kind+payoutId and would mask a missing original.
  const completedPayouts = await prisma.organizationPayout.findMany({
    where: {
      status: "COMPLETED",
      ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
    },
    select: { id: true, organizationId: true, netPayoutPaise: true },
  });
  const orgPayoutTxns = await prisma.ledgerTransaction.findMany({
    where: {
      idempotencyKey: {
        in: completedPayouts.map((po) => `orgpayout:${po.id}`),
      },
    },
    select: { idempotencyKey: true },
  });
  const orgPayoutTxnKeys = new Set(orgPayoutTxns.map((t) => t.idempotencyKey));
  for (const po of completedPayouts) {
    if (!orgPayoutTxnKeys.has(`orgpayout:${po.id}`)) {
      findings.push({
        kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
        organizationId: po.organizationId,
        payoutId: po.id,
        expectedPaise: po.netPayoutPaise,
        actualPaise: 0,
        deltaPaise: po.netPayoutPaise,
        details: {
          scope: "org",
          note: "OrganizationPayout.status=COMPLETED but no ORG_PAYOUT ledger transaction.",
        },
      });
    }
  }

  // #1408 — the clawback dual-write. A refund against an already-paid org
  // payout stamps `clawbackAmountPaise` on the payout and writes an audit row,
  // but the matching `Dr CASH / Cr ORG_PAYABLE` reversal is a separate write:
  // reversePayoutClawback posts it inside a try/catch that swallows the
  // failure, and refund.ts / booking-refund.ts never post it at all. The
  // stamped payout then claims cash was recovered that the journal has never
  // seen. Matched on the soft link plus the `clawback:` key prefix because the
  // full key embeds the refund id, which the payout row does not carry — and
  // compared on summed amounts, not presence, since the counter is cumulative
  // and a second clawback's lost posting hides behind the first one's.
  {
    const clawedBackPayouts = await prisma.organizationPayout.findMany({
      where: {
        clawbackAmountPaise: { gt: 0 },
        ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
      },
      select: { id: true, organizationId: true, clawbackAmountPaise: true },
    });
    if (clawedBackPayouts.length > 0) {
      // Chunked IN to stay under the bind-param cap, like the sibling lookups
      // below; a full-scope run can carry more payout ids than one statement.
      const CLAWBACK_CHUNK = 5_000;
      const clawbackPostedByPayout = new Map<string, number>();
      for (let i = 0; i < clawedBackPayouts.length; i += CLAWBACK_CHUNK) {
        const clawbackTxns = await prisma.ledgerTransaction.findMany({
          where: {
            payoutId: {
              in: clawedBackPayouts
                .slice(i, i + CLAWBACK_CHUNK)
                .map((po) => po.id),
            },
            idempotencyKey: { startsWith: "clawback:" },
          },
          select: {
            payoutId: true,
            entries: {
              where: { direction: "DEBIT", account: { kind: "CASH" } },
              select: { amountPaise: true },
            },
          },
        });
        for (const t of clawbackTxns) {
          if (!t.payoutId) continue;
          const posted = t.entries.reduce((sum, e) => {
            // Same reasoning as the detector's guard: a leg that does not
            // survive the narrowing would under-report the posted side, which
            // manufactures a phantom gap or hides a real one.
            const paise = Number(e.amountPaise);
            if (!Number.isSafeInteger(paise)) {
              throw new Error(
                `clawback posting for payout ${t.payoutId} has amountPaise=${e.amountPaise}, outside the safe-integer range.`,
              );
            }
            return sum + paise;
          }, 0);
          clawbackPostedByPayout.set(
            t.payoutId,
            (clawbackPostedByPayout.get(t.payoutId) ?? 0) + posted,
          );
        }
      }
      findings.push(
        ...clawbackDualWriteGapFindings(
          clawedBackPayouts,
          clawbackPostedByPayout,
        ),
      );
    }
  }

  // #813 — parallel coverage for consultant payouts: a COMPLETED ConsultantPayout
  // must carry its original PAYOUT posting (`payout:<id>`). Same Set-membership
  // shape; keyed on idempotencyKey so the #813 reversal posting
  // (`payout-reversal:<id>`) can't mask a missing original. (ConsultantPayout is
  // not org-scoped, so no organizationId; org-filtered runs skip this check.)
  if (!opts.organizationId) {
    // amount>0 only: the completion posting is skipped for a zero-amount payout
    // (no cash moved), so a zero-amount COMPLETED row legitimately has no txn.
    const completedConsultantPayouts = await prisma.consultantPayout.findMany({
      where: { status: "COMPLETED", amount: { gt: 0 } },
      select: { id: true, amount: true },
    });
    const consultantPayoutTxns = await prisma.ledgerTransaction.findMany({
      where: {
        idempotencyKey: {
          in: completedConsultantPayouts.map((p) => `payout:${p.id}`),
        },
      },
      select: { idempotencyKey: true },
    });
    const consultantPayoutTxnKeys = new Set(
      consultantPayoutTxns.map((t) => t.idempotencyKey),
    );
    for (const p of completedConsultantPayouts) {
      if (!consultantPayoutTxnKeys.has(`payout:${p.id}`)) {
        findings.push({
          kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
          payoutId: p.id,
          expectedPaise: p.amount,
          actualPaise: 0,
          deltaPaise: p.amount,
          details: {
            scope: "consultant",
            note: "ConsultantPayout.status=COMPLETED but no PAYOUT ledger transaction.",
          },
        });
      }
    }
  }

  // --- (P) #778 §C/§G — split-sums-to-the-paise. Per earnings-bearing
  // payment: Σ CE.platformFee + Σ CE.consultantShare + Σ OE.orgShare ==
  // payment.originalAmount exactly (#773 netting model: settled collaborators
  // store NET share + their org-card fee slice, so the allocation columns
  // partition the gross with no overlap). Allocation columns never change on
  // refund (refundedShareAmount is separate), so this holds for refunded
  // payments too.
  {
    const ceAgg = await prisma.consultantEarnings.groupBy({
      by: ["paymentId"],
      _sum: { platformFeePaise: true, consultantSharePaise: true },
      ...(opts.organizationId
        ? { where: { payment: { organizationId: opts.organizationId } } }
        : {}),
    });
    const paymentIdsWithCe = ceAgg
      .map((r) => r.paymentId)
      .filter((p): p is string => !!p);
    // Review fix — no giant `IN` lists (Postgres caps bind params at 65,535):
    // the org-earnings sum takes the same org filter as ceAgg and joins via
    // the map; the gross lookup chunks its ids.
    const oeAgg = await prisma.organizationEarnings.groupBy({
      by: ["paymentId"],
      _sum: { orgSharePaise: true },
      ...(opts.organizationId
        ? { where: { payment: { organizationId: opts.organizationId } } }
        : {}),
    });
    const oeByPayment = new Map(
      oeAgg.map((r) => [r.paymentId, sumPaise(r._sum.orgSharePaise)]),
    );
    const grossById = new Map<
      string,
      { id: string; originalAmount: number; organizationId: string | null }
    >();
    const CHUNK = 5_000;
    for (let i = 0; i < paymentIdsWithCe.length; i += CHUNK) {
      const rows = await prisma.payment.findMany({
        where: { id: { in: paymentIdsWithCe.slice(i, i + CHUNK) } },
        select: { id: true, originalAmount: true, organizationId: true },
      });
      for (const p of rows) grossById.set(p.id, p);
    }
    for (const row of ceAgg) {
      if (!row.paymentId) continue;
      const p = grossById.get(row.paymentId);
      if (!p) continue;
      const splitSum =
        sumPaise(row._sum.platformFeePaise) +
        sumPaise(row._sum.consultantSharePaise) +
        (oeByPayment.get(row.paymentId) ?? 0);
      if (splitSum !== p.originalAmount) {
        findings.push({
          kind: "SPLIT_SUM_MISMATCH",
          paymentId: p.id,
          organizationId: p.organizationId ?? undefined,
          expectedPaise: p.originalAmount,
          actualPaise: splitSum,
          deltaPaise: splitSum - p.originalAmount,
          details: {
            unit: "paise",
            note: "Σ(platform fee + consultant shares + org shares) diverges from Payment.originalAmount — a split leaked or minted paise (#778 §C).",
          },
        });
      }
    }
  }

  // --- (Q) #775/#782 — CHARGE_MEMBER overage settlement coherence (the
  // exact semantics from the 2026-06-10 overage audit). settledAt is the
  // "first settlement milestone", which differs per behavior — CHARGE_ORG
  // stamps at ACCRUED (issued invoice), CHARGE_MEMBER at CHARGED (collected).
  {
    const memberEvents = await prisma.overageEvent.findMany({
      where: { overageBehavior: "CHARGE_MEMBER" },
      select: {
        id: true,
        chargeStatus: true,
        marginalPaise: true,
        paymentId: true,
        settledAt: true,
        payment: {
          select: {
            paymentStatus: true,
            amount: true,
            parentPaymentId: true,
            organizationId: true,
          },
        },
      },
    });
    const sideIds = memberEvents
      .map((e) => e.paymentId)
      .filter((p): p is string => !!p);
    // Review-fix class — chunked IN to stay under the bind-param cap.
    const txnKeys = new Set<string>();
    const TXN_CHUNK = 5_000;
    for (let i = 0; i < sideIds.length; i += TXN_CHUNK) {
      const overageTxns = await prisma.ledgerTransaction.findMany({
        where: {
          idempotencyKey: {
            in: sideIds.slice(i, i + TXN_CHUNK).map((id) => `overage:${id}`),
          },
        },
        select: { idempotencyKey: true },
      });
      for (const t of overageTxns) txnKeys.add(t.idempotencyKey);
    }
    for (const ev of memberEvents) {
      const hasTxn = !!ev.paymentId && txnKeys.has(`overage:${ev.paymentId}`);
      const flag = (note: string) =>
        findings.push({
          kind: "OVERAGE_SETTLEMENT_MISMATCH",
          paymentId: ev.paymentId ?? undefined,
          organizationId: ev.payment?.organizationId ?? undefined,
          expectedPaise: ev.marginalPaise,
          actualPaise: ev.payment?.amount ?? 0,
          deltaPaise: (ev.payment?.amount ?? 0) - ev.marginalPaise,
          details: {
            overageEventId: ev.id,
            chargeStatus: ev.chargeStatus,
            unit: "paise",
            note,
          },
        });
      if (ev.chargeStatus === "CHARGED") {
        if (!ev.paymentId || ev.payment?.paymentStatus !== "SUCCEEDED") {
          flag("CHARGED member overage without a SUCCEEDED side-payment.");
        } else if (!hasTxn) {
          flag(
            "CHARGED member overage but no overage:<sidePaymentId> ledger txn — ORG_PAYABLE was never credited.",
          );
        } else if (ev.payment.amount !== ev.marginalPaise) {
          flag("Side-payment amount diverges from the event's marginalPaise.");
        } else if (!ev.settledAt) {
          flag("CHARGED member overage missing settledAt.");
        }
      } else if (
        (ev.chargeStatus === "PENDING" || ev.chargeStatus === "FAILED") &&
        hasTxn
      ) {
        flag(
          "Un-collected member overage has an overage ledger txn — money posted without a CHARGED event.",
        );
      }
    }
  }

  // --- (O) #778 §B — no two ACTIVE assignments for the same (program,
  // membership) may overlap in period. Sort-then-sweep per group; the row
  // count is bounded by live assignments so the in-memory pass is cheap.
  {
    const active = await prisma.programAssignment.findMany({
      where: { status: "ACTIVE" },
      select: {
        id: true,
        programId: true,
        membershipId: true,
        periodStart: true,
        periodEnd: true,
      },
      orderBy: [
        { programId: "asc" },
        { membershipId: "asc" },
        { periodStart: "asc" },
      ],
    });
    // Review fix — track the MAX periodEnd seen in the group, not just the
    // previous row: one long cycle overlapping several later short ones would
    // otherwise only flag the first (prev resets to the short row).
    let maxEnd: (typeof active)[number] | null = null;
    for (const a of active) {
      if (
        maxEnd &&
        maxEnd.programId === a.programId &&
        maxEnd.membershipId === a.membershipId
      ) {
        if (maxEnd.periodEnd.getTime() > a.periodStart.getTime()) {
          findings.push({
            kind: "ASSIGNMENT_PERIOD_OVERLAP",
            programAssignmentId: a.id,
            expectedPaise: 0,
            actualPaise: 0,
            deltaPaise: 0,
            details: {
              unit: "none",
              overlapsAssignmentId: maxEnd.id,
              programId: a.programId,
              membershipId: a.membershipId,
              note: "Two ACTIVE assignments overlap for the same (program, membership) — caps/seats double-count.",
            },
          });
        }
        if (a.periodEnd.getTime() > maxEnd.periodEnd.getTime()) {
          maxEnd = a;
        }
      } else {
        maxEnd = a;
      }
    }
  }

  // --- (M) #780 — money values within Number safe range. Aggregate _max reads
  // bypass the boundary extension, so compare as bigint — sumPaise() would
  // throw on exactly the values this check exists to report.
  {
    const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);
    const maxima: Array<[string, bigint | number | null]> = [
      [
        "Payment.amount",
        (await prisma.payment.aggregate({ _max: { amount: true } }))._max
          .amount,
      ],
      [
        "LedgerEntry.amountPaise",
        (await prisma.ledgerEntry.aggregate({ _max: { amountPaise: true } }))
          ._max.amountPaise,
      ],
      [
        "OrganizationInvoice.totalPaise",
        (
          await prisma.organizationInvoice.aggregate({
            _max: { totalPaise: true },
          })
        )._max.totalPaise,
      ],
      [
        "OrganizationPayout.amountPaise",
        (
          await prisma.organizationPayout.aggregate({
            _max: { amountPaise: true },
          })
        )._max.amountPaise,
      ],
      [
        "ConsultantPayout.amount",
        (await prisma.consultantPayout.aggregate({ _max: { amount: true } }))
          ._max.amount,
      ],
      [
        "BillingAccount.walletBalance",
        (
          await prisma.billingAccount.aggregate({
            _max: { walletBalance: true },
          })
        )._max.walletBalance,
      ],
    ];
    for (const [column, raw] of maxima) {
      if (raw === null || raw === undefined) continue;
      const v = typeof raw === "bigint" ? raw : BigInt(Math.trunc(raw));
      if (v > SAFE_MAX) {
        findings.push({
          kind: "MONEY_VALUE_WITHIN_SAFE_RANGE",
          expectedPaise: Number.MAX_SAFE_INTEGER,
          actualPaise: Number(v), // imprecise past 2^53 — exact value in details
          deltaPaise: Number(v - SAFE_MAX),
          details: {
            column,
            rawValue: v.toString(),
            unit: "paise",
            note: "Money value exceeds Number.MAX_SAFE_INTEGER — the bigint→number boundary loses precision here.",
          },
        });
      }
    }
  }

  const durationMs = Date.now() - startedAt;

  // Known, entity-specific, time-boxed drift does not fail the run. Everything
  // is still reported and persisted — the split only decides whether ops gets
  // paged. See lib/payments/ledger/baseline.ts for why a permanently-red
  // reconciler is worse than a slightly narrower one.
  const { active, baselined, expired } = applyLedgerBaseline(
    findings,
    new Date(),
  );
  if (baselined.length > 0) {
    console.log(
      `ℹ️  ${baselined.length} finding(s) matched the known-drift baseline and did not fail this run:`,
    );
    for (const f of baselined) console.log(`   · ${findingIdentity(f)}`);
  }
  if (expired.length > 0) {
    console.log(
      `⚠️  ${expired.length} baseline entr(ies) have EXPIRED — their findings now count again:`,
    );
    for (const e of expired) {
      console.log(`   · ${e.kind}:${e.entityId} (expired ${e.expires})`);
    }
  }
  const ok = active.length === 0;

  const summary = {
    orgsChecked: organizations.length,
    accountsChecked: accounts.length,
    assignmentsChecked: liveAssignments.length,
    subscriptionsChecked: subscriptions.length,
    paymentsChecked: paymentsWithOrgLegs.length,
    payoutsChecked: payouts.length,
    discrepanciesCount: findings.length,
    /** Findings that failed this run (baselined ones excluded). */
    activeDiscrepanciesCount: active.length,
    baselinedDiscrepanciesCount: baselined.length,
    earningsPaymentsWithoutBookingTxn,
  };

  const report = await prisma.ledgerReconciliationReport.create({
    data: {
      scope: opts.scope,
      ok,
      durationMs,
      summary: summary as unknown as Prisma.InputJsonValue,
      findings: findings as unknown as Prisma.InputJsonValue,
      triggeredById: opts.triggeredById ?? null,
    },
  });

  return {
    id: report.id,
    runAt: report.runAt,
    scope: report.scope,
    ok: report.ok,
    durationMs: report.durationMs,
    summary,
    findings,
  };
}
