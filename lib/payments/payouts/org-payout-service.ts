/**
 * Organization Payout Service — full rewrite (#713-2 / #700 LED-4).
 *
 * Replaces the prior @arch4-stub. The service exposes three operations
 * that crons + the org-payouts route share so org-level batching has a
 * single source of truth:
 *
 *   - getOrgPayoutEligibility(orgId)
 *       Read-only check: does this org have a verified payout account
 *       and any READY OrganizationEarnings? Returns shape callers can
 *       safely render in a dashboard ("you have ₹X ready, Y rows").
 *
 *   - createOrgPayoutBatch(orgId, periodStart, periodEnd, opts?)
 *       Atomic batch creation: claim READY earnings, compute aggregated
 *       totals, write the OrganizationPayout (status DRAFT/PENDING),
 *       flip the claimed earnings to BATCHED (#837 — NOT PAID; cash has
 *       not moved yet), post through postLedgerTxn + audit log. Optionally
 *       accepts an `idempotencyKey` so cron retries become no-ops via the
 *       unique constraint.
 *
 *   - processOrgPayout(payoutId)
 *       State machine progression: PENDING → PROCESSING → COMPLETED |
 *       FAILED. Today only progresses PENDING → PROCESSING and writes
 *       the audit log + the ORG_PAYOUT journal posting; live RazorpayX /
 *       Stripe Connect submission is gated on `ENABLE_LIVE_PAYOUTS` and
 *       lands in PR-3.
 *
 *   - markOrgPayoutCompleted(payoutId)
 *       Idempotent PROCESSING → COMPLETED transition + Novu fire to the
 *       visibility roster. Called by the gateway-webhook reconciler
 *       (PR-3); kept here so the notification dispatch is co-located with
 *       the state change (closes #718 / BUG-017).
 *
 * Atomicity:
 *   - createOrgPayoutBatch acquires a Redis lock keyed by orgId so two
 *     concurrent callers (cron + UI button + manual replay) cannot both
 *     start a batch for the same org. Inside the lock the DB tx is
 *     Serializable for phantom-read safety.
 *   - The earnings claim step is a conditional UPDATE that only catches
 *     rows still NULL on `orgPayoutId` — even without the Redis lock
 *     this prevents double-claiming. The lock buys us deterministic
 *     ordering and a clean error path.
 *
 * India statutory compliance (TDS / MSME / Form15 / FIRC):
 *   - Stub helpers in lib/compliance/{tds,msme,form15} are called so
 *     downstream rows have non-null defaults. Live derivation lands in
 *     PR-2 (India compliance go-live). The cron at
 *     `jobs/compliance/derive-tds-msme.ts` (also part of PR-2) will
 *     re-derive these for any rows still on stub defaults.
 */

import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import { recordSystemError } from "@/lib/enterprise/system-events";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { PaymentGateway, PayoutStatus } from "@prisma/client";
import { acquireLock, releaseLock } from "@/lib/redis";
import { assertPayoutBalance } from "./balance-preflight";
import { computeMsmePaymentDeadline } from "@/lib/compliance/msme";
import { computeTdsForPayout } from "@/lib/compliance/tds";
// #1354 — the org rail now writes the same TDSRecord audit trail the consultant
// rail does; the FY/quarter arithmetic is shared rather than re-derived here.
import {
  getFYDateRange,
  getIndianFinancialYear,
  getIndianFYQuarter,
  recordOrgTDSDeduction,
  recordOrgTdsReversal,
} from "@/lib/payments/tax/tds-service";
import { postLedgerTxn, type Posting } from "@/lib/payments/ledger/post";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { notifyOrgPayoutCompleted } from "@/lib/novu/org-workflows";
import { getAppUrl } from "@/lib/url";
import { sumPaise } from "@/lib/payments/utils/money";

export class PayoutLockError extends Error {
  readonly code = "PAYOUT_LOCK_CONFLICT" as const;
  constructor(message?: string) {
    super(
      message ??
        "Another payout batch is being created for this organization. Please try again.",
    );
    this.name = "PayoutLockError";
  }
}

export class PayoutValidationError extends Error {
  readonly code = "PAYOUT_VALIDATION_FAILED" as const;
  constructor(
    message: string,
    public httpStatus = 409,
  ) {
    super(message);
    this.name = "PayoutValidationError";
  }
}

/**
 * #1470 — raised when an OrganizationPayout's withholding identity
 * (`amountPaise + tdsAmountPaise === netPayoutPaise`) does not hold at the
 * moment the ORG_PAYOUT journal would be written, or when any of the three
 * figures is negative (#1473 review): both leave the payout unpostable.
 *
 * `netPayoutPaise` is the host org's share BEFORE withholding and `amountPaise`
 * is what the rail actually transfers, so a payout that breaks the identity has
 * no correct posting available: any figure we picked would clear ORG_PAYABLE or
 * credit CASH by an amount the money never moved. Throwing from inside the CAS
 * transaction rolls the completion (or the reversal) back, which is safe because
 * the gateway webhook is at-least-once and the stuck-payout sweep re-drives it.
 */
export class OrgPayoutWithholdingMismatchError extends Error {
  readonly code = "ORG_PAYOUT_WITHHOLDING_MISMATCH" as const;
  constructor(
    readonly payoutId: string,
    readonly organizationId: string,
    readonly netPayoutPaise: number,
    readonly amountPaise: number,
    readonly tdsAmountPaise: number,
  ) {
    super(
      `Org payout ${payoutId} withholding identity violated: amountPaise ${amountPaise} + tdsAmountPaise ${tdsAmountPaise} !== netPayoutPaise ${netPayoutPaise}`,
    );
    this.name = "OrgPayoutWithholdingMismatchError";
  }
}

/**
 * #1470 — assert the withholding identity before either ORG_PAYOUT posting.
 * Kept as one helper so the completion and its reversal cannot drift apart.
 */
function assertOrgPayoutWithholdingIdentity(payout: {
  id: string;
  organizationId: string;
  netPayoutPaise: number;
  amountPaise: number;
  tdsAmountPaise: number | null;
}): void {
  const tds = payout.tdsAmountPaise ?? 0;
  // #1473 review — the identity on its own accepts a negative row (-100 + 0
  // === -100), and the `netPayoutPaise > 0` guard at the posting site would
  // then let the completion commit COMPLETED/PAID with no journal at all.
  // `createOrgPayoutBatch` rejects a non-positive batch and nothing else mints
  // an OrganizationPayout, so this guards a hand-edited row rather than a known
  // path — but it is the same class of silent, unpostable money as the identity
  // itself. Zero stays legal: a zero payout has nothing to post and is skipped
  // on purpose.
  const isNegative =
    payout.netPayoutPaise < 0 || payout.amountPaise < 0 || tds < 0;
  if (isNegative || payout.amountPaise + tds !== payout.netPayoutPaise) {
    throw new OrgPayoutWithholdingMismatchError(
      payout.id,
      payout.organizationId,
      payout.netPayoutPaise,
      payout.amountPaise,
      tds,
    );
  }
}

/**
 * #1470 — report a broken withholding identity. Called from the `.catch` of the
 * transaction rather than from inside it: `recordSystemError` writes through the
 * global Prisma client, and under PG_POOL_MAX=1 a global-client query issued
 * while a `$transaction` holds the only connection deadlocks (see the HLD).
 */
async function reportOrgPayoutWithholdingMismatch(
  err: OrgPayoutWithholdingMismatchError,
  op: string,
): Promise<void> {
  const context = {
    orgPayoutId: err.payoutId,
    organizationId: err.organizationId,
    netPayoutPaise: err.netPayoutPaise,
    amountPaise: err.amountPaise,
    tdsAmountPaise: err.tdsAmountPaise,
  };
  await recordSystemError({
    organizationId: err.organizationId,
    category: "PAYOUT",
    summary: `${err.code} — org payout journal refused: amountPaise + tdsAmountPaise does not equal netPayoutPaise`,
    err,
    context,
  }).catch(() => {});
  reportSentryError(err, {
    subsystem: "payments",
    op,
    extra: context,
  });
}

interface OrgPayoutEligibility {
  eligible: boolean;
  readyAmount: number;
  earningsCount: number;
  payoutAccountStatus: string | null;
  reason?: string;
}

export interface OrgPayoutBatchResult {
  payoutId: string;
  amountPaise: number;
  earningsCount: number;
  periodStart: Date;
  periodEnd: Date;
  alreadyExisted?: boolean;
}

export interface CreateOrgPayoutBatchOptions {
  /** Channel used to push the funds (RazorpayX is the v1 default). */
  paymentGateway?: PaymentGateway;
  /** Cron-safe duplicate guard. When set, a row with the same key
   *  short-circuits to an idempotent response instead of creating a dup. */
  idempotencyKey?: string;
  /** Free-form audit notes; surfaces on the payout's audit-log entry. */
  notes?: string;
  /** Membership id to attribute on the audit log; null for cron runs. */
  actorMembershipId?: string | null;
}

const PAYOUT_LOCK_TTL_MS = 60_000;

/**
 * Read-only eligibility probe. Safe to call from a dashboard render path.
 * Does NOT mutate any state.
 */
export async function getOrgPayoutEligibility(
  orgId: string,
): Promise<OrgPayoutEligibility> {
  const account = await prisma.organizationPayoutAccount.findUnique({
    where: { organizationId: orgId },
    select: { status: true },
  });

  if (!account) {
    return {
      eligible: false,
      readyAmount: 0,
      earningsCount: 0,
      payoutAccountStatus: null,
      reason: "No payout account configured",
    };
  }

  if (account.status !== "VERIFIED") {
    return {
      eligible: false,
      readyAmount: 0,
      earningsCount: 0,
      payoutAccountStatus: account.status,
      reason: `Payout account is ${account.status} — must be VERIFIED to receive funds`,
    };
  }

  const ready = await prisma.organizationEarnings.aggregate({
    where: {
      organizationId: orgId,
      status: "READY",
      orgPayoutId: null,
    },
    _sum: { orgSharePaise: true, refundedAmountPaise: true },
    _count: true,
  });

  const orgShareSum = sumPaise(ready._sum.orgSharePaise);
  const refundsSum = sumPaise(ready._sum.refundedAmountPaise);
  const readyAmount = orgShareSum - refundsSum;

  if (ready._count === 0 || readyAmount <= 0) {
    return {
      eligible: false,
      readyAmount: Math.max(0, readyAmount),
      earningsCount: ready._count,
      payoutAccountStatus: account.status,
      reason:
        ready._count === 0
          ? "No READY earnings to batch"
          : `Net payout would be ${readyAmount} paise after refunds — reconcile first`,
    };
  }

  return {
    eligible: true,
    readyAmount,
    earningsCount: ready._count,
    payoutAccountStatus: account.status,
  };
}

/**
 * Atomic batch creation. Acquires a Redis lock + Serializable tx so two
 * concurrent callers cannot both start a batch for the same org.
 *
 * If `idempotencyKey` is provided and a row already exists with that
 * key, returns the existing payout's identity with `alreadyExisted: true`.
 * This is the cron-safe path: a retried weekly run is a no-op.
 */
export async function createOrgPayoutBatch(
  orgId: string,
  periodStart: Date,
  periodEnd: Date,
  opts: CreateOrgPayoutBatchOptions = {},
): Promise<OrgPayoutBatchResult> {
  if (periodEnd.getTime() <= periodStart.getTime()) {
    throw new PayoutValidationError("periodEnd must be after periodStart", 400);
  }

  // Idempotency short-circuit: cheaper than acquiring the lock just to
  // bounce on the unique constraint.
  if (opts.idempotencyKey) {
    const existing = await prisma.organizationPayout.findUnique({
      where: { idempotencyKey: opts.idempotencyKey },
      select: {
        id: true,
        amountPaise: true,
        periodStart: true,
        periodEnd: true,
        earnings: { select: { id: true } },
      },
    });
    if (existing) {
      return {
        payoutId: existing.id,
        amountPaise: existing.amountPaise,
        earningsCount: existing.earnings.length,
        periodStart: existing.periodStart,
        periodEnd: existing.periodEnd,
        alreadyExisted: true,
      };
    }
  }

  const lockKey = `org:${orgId}:payout-batch`;
  const token = await acquireLock(lockKey, PAYOUT_LOCK_TTL_MS);
  if (!token) {
    throw new PayoutLockError();
  }

  try {
    const result = await withSerializableRetry(
      () =>
        prisma.$transaction(
          async (tx) => {
            const payoutAccount = await tx.organizationPayoutAccount.findUnique(
              {
                where: { organizationId: orgId },
              },
            );
            if (!payoutAccount) {
              throw new PayoutValidationError(
                "No payout account configured for this organization",
                409,
              );
            }
            if (payoutAccount.status !== "VERIFIED") {
              throw new PayoutValidationError(
                `Payout account is ${payoutAccount.status} — cannot create payouts until VERIFIED`,
                409,
              );
            }

            // Race-safe claim: create placeholder, then atomically claim
            // READY earnings into it. Same proven pattern as the
            // /api/organizations/[orgId]/payouts route.
            const created = await tx.organizationPayout.create({
              data: {
                organizationId: orgId,
                amountPaise: 0,
                currency: "INR",
                status: "PENDING",
                paymentGateway: opts.paymentGateway ?? "RAZORPAY",
                periodStart,
                periodEnd,
                grossRevenuePaise: 0,
                platformFeePaise: 0,
                refundsPaise: 0,
                netPayoutPaise: 0,
                // #1093 §3 — never null: a keyless manual payout had no replay guard.
                idempotencyKey:
                  opts.idempotencyKey ?? globalThis.crypto.randomUUID(),
                // mustPayByDate, tdsSectionApplied, tdsAmountPaise,
                // dtaaRateApplied are derived after we resolve the org's
                // MSME + PAN fields below and persisted via the second
                // update (alongside the post-TDS amount). Form 15 / FIRC
                // still populated manually until cross-border crons land.
              },
            });

            const claim = await tx.organizationEarnings.updateMany({
              where: {
                organizationId: orgId,
                status: "READY",
                orgPayoutId: null,
                createdAt: { gte: periodStart, lt: periodEnd },
              },
              data: { orgPayoutId: created.id },
            });
            if (claim.count === 0) {
              throw new PayoutValidationError(
                "No READY earnings in the requested window",
                409,
              );
            }

            const readyEarnings = await tx.organizationEarnings.findMany({
              where: { orgPayoutId: created.id },
              select: {
                id: true,
                grossAmountPaise: true,
                platformFeePaise: true,
                orgSharePaise: true,
                refundedAmountPaise: true,
                currency: true,
              },
            });
            const first = readyEarnings[0];
            if (!first) {
              throw new PayoutValidationError(
                "No READY earnings in the requested window",
                409,
              );
            }
            const mixedCurrency = readyEarnings.some(
              (e) => e.currency !== first.currency,
            );
            if (mixedCurrency) {
              throw new PayoutValidationError(
                "Cannot roll earnings in mixed currencies into a single payout. Split the window.",
                409,
              );
            }

            const totals = readyEarnings.reduce(
              (acc, e) => {
                acc.gross += e.grossAmountPaise;
                acc.platformFeePaise += e.platformFeePaise;
                acc.orgShare += e.orgSharePaise;
                acc.refunds += e.refundedAmountPaise;
                return acc;
              },
              { gross: 0, platformFeePaise: 0, orgShare: 0, refunds: 0 },
            );
            const netPayout = totals.orgShare - totals.refunds;
            if (netPayout <= 0) {
              throw new PayoutValidationError(
                `Net payout would be ${netPayout} paise — refunds exceed earnings. Reconcile first.`,
                409,
              );
            }

            // Resolve the org's India statutory metadata in one fetch and
            // use it for both TDS (PAN, residency) and the MSME payment
            // deadline (msmeStatus, writtenAgreement).
            //
            // TDS: the marketplace e-commerce-operator rate (the old §194-O,
            // now §393 of the Income-tax Act 2025 in force since 1-Apr-2026)
            // is the default for payouts to host orgs; the no-PAN higher-rate
            // fallback (old §206AA, now §397(2)) applies when PAN is missing
            // or malformed. Computed on `netPayout` (= orgShare − refunds),
            // then deducted from what we send through the gateway. The withheld
            // amount is deposited with the govt and reported quarterly on the
            // return that succeeds Form 26Q (separate cron — see
            // lib/compliance/tds.ts module docblock).
            //
            // MSME: when the host org is MICRO / SMALL we owe payment within
            // 15 / 45 days under MSMED Act §15 (the deduction-disallowance
            // teeth moved from Income-tax §43B(h) to §37(2)(g) under the 2025
            // Act); fall through to contract.paymentTermsDays for MEDIUM / NONE.
            //
            // All host orgs are assumed RESIDENT in v1. When the first
            // non-resident host org ships, extend Organization with
            // `residencyStatus` + `tdsSection` overrides and thread them in.
            const orgForCompliance = await tx.organization.findUnique({
              where: { id: orgId },
              select: {
                taxInfo: { select: { panEncrypted: true } },
                msmeInfo: {
                  select: {
                    msmeStatus: true,
                    msmeWrittenAgreementOnFile: true,
                  },
                },
              },
            });
            const tds = computeTdsForPayout({
              grossAmountPaise: netPayout,
              consultant: {
                // #768 — PAN at rest is encrypted. TDS rate derivation only
                // needs to know whether a PAN is on file (treats null as
                // higher-rate). Plaintext decrypt is deferred to Form 26Q
                // filing (admin-only flow).
                // #785 — PAN at rest is encrypted; signal presence via panOnFile
                // (passing the ciphertext as panNumber fails isValidPan → wrong 5%).
                panNumber: null,
                panOnFile: !!orgForCompliance?.taxInfo?.panEncrypted,
                residencyStatus: "RESIDENT",
                tdsSection: null,
                tdsRateBps: null,
                tdsLowerRateCert: null,
                providerCountry: null,
              },
            });
            const amountAfterTds = netPayout - tds.tdsAmountPaise;
            const mustPayByDate = computeMsmePaymentDeadline({
              invoiceDate: new Date(),
              counterpartyMsmeStatus:
                orgForCompliance?.msmeInfo?.msmeStatus ?? "NONE",
              writtenAgreement:
                orgForCompliance?.msmeInfo?.msmeWrittenAgreementOnFile ?? false,
            });

            await tx.organizationPayout.update({
              where: { id: created.id },
              data: {
                amountPaise: amountAfterTds,
                currency: first.currency,
                grossRevenuePaise: totals.gross,
                platformFeePaise: totals.platformFeePaise,
                refundsPaise: totals.refunds,
                netPayoutPaise: netPayout,
                tdsSectionApplied: tds.tdsSection,
                tdsAmountPaise: tds.tdsAmountPaise,
                // #1354 — the RATE is pinned here because this is the rate
                // actually withheld from the disbursement; rate cards are
                // effective-dated, so re-deriving it at completion could file a
                // row that disagrees with the money. `tdsRate` is a decimal
                // fraction (0.10 = 10%) and always present on a computation.
                tdsRateAppliedBps: Math.round(tds.tdsRate * 10_000),
                // The PERIOD is a different question, and this column is only
                // the batch-time audit stamp of when the batch was built. The
                // TDSRecord dates itself at the completion instant instead —
                // see markOrgPayoutCompleted.
                tdsFinancialYear: getIndianFinancialYear(),
                dtaaRateApplied:
                  tds.dtaaRateApplied !== null
                    ? new Prisma.Decimal(tds.dtaaRateApplied)
                    : null,
                mustPayByDate,
              },
            });

            // #837 E-03/E-04 — batch creation only STAGES the earnings; cash has
            // not left. Mark BATCHED, not PAID. The PAID flip moves to
            // markOrgPayoutCompleted (PROCESSING → COMPLETED), so a batch built
            // with ENABLE_LIVE_PAYOUTS off never reads as paid to auditors.
            await tx.organizationEarnings.updateMany({
              where: { orgPayoutId: created.id, status: "READY" },
              data: { status: "BATCHED" },
            });

            await tx.orgAuditLog.create({
              data: {
                organizationId: orgId,
                actorMembershipId: opts.actorMembershipId ?? null,
                category: "PAYOUT",
                action: AUDIT_ACTIONS.PAYOUT.PAYOUT_INITIATED,
                description: `Payout batch created: ${readyEarnings.length} earnings, ${amountAfterTds} paise ${first.currency} (after ${tds.tdsAmountPaise} paise TDS ${tds.tdsSection})`,
                details: {
                  payoutId: created.id,
                  earningsCount: readyEarnings.length,
                  netPayoutPaise: netPayout,
                  amountAfterTdsPaise: amountAfterTds,
                  grossPaise: totals.gross,
                  platformFeePaise: totals.platformFeePaise,
                  refundsPaise: totals.refunds,
                  tdsSection: tds.tdsSection,
                  tdsRate: tds.tdsRate,
                  // #1354 — the integer form is what the TDSRecord files under;
                  // the decimal above cannot be compared to it without rounding.
                  tdsRateBps: Math.round(tds.tdsRate * 10_000),
                  tdsAmountPaise: tds.tdsAmountPaise,
                  tdsFallback: tds.fallbackApplied,
                  tdsReason: tds.reason,
                  // #1093 §3 — echo the payout's own key; a fresh mint here would
                  // stamp the audit row with a UUID matching no payout.
                  idempotencyKey: created.idempotencyKey,
                },
              },
            });

            return {
              payoutId: created.id,
              amountPaise: amountAfterTds,
              earningsCount: readyEarnings.length,
              periodStart,
              periodEnd,
            };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 25_000,
          },
        ),
      1, // #1319 review — PAYOUT_LOCK_TTL_MS is 60 s: two 25 s attempts fit under it, four do not
    );

    return result;
  } catch (err) {
    // P2002 on idempotencyKey — a sibling cron worker landed first while
    // we were holding the lock-but-not-the-tx. Read the winner and
    // return it as-if-existing.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002" &&
      opts.idempotencyKey
    ) {
      const existing = await prisma.organizationPayout.findUnique({
        where: { idempotencyKey: opts.idempotencyKey },
        select: {
          id: true,
          amountPaise: true,
          periodStart: true,
          periodEnd: true,
          earnings: { select: { id: true } },
        },
      });
      if (existing) {
        // Lost race — a sibling worker already created this payout under the
        // same idempotency key. Modelled outcome, not a fault.
        reportSentryError(err, { subsystem: "payments", expected: true });
        return {
          payoutId: existing.id,
          amountPaise: existing.amountPaise,
          earningsCount: existing.earnings.length,
          periodStart: existing.periodStart,
          periodEnd: existing.periodEnd,
          alreadyExisted: true,
        };
      }
    }
    reportSentryError(err, { subsystem: "payments" });
    throw err;
  } finally {
    await releaseLock(lockKey, token);
  }
}

/**
 * Move a payout through its state machine. Today only progresses
 * `PENDING → PROCESSING` and writes the audit trail; live gateway
 * submission lands in PR-3 behind the `ENABLE_LIVE_PAYOUTS` flag.
 *
 * Idempotent: if the payout is not in PENDING the function logs and
 * returns the current status without throwing.
 */
export async function processOrgPayout(payoutId: string): Promise<{
  status: PayoutStatus;
  submittedToGateway: boolean;
  /** True only when THIS invocation won the PENDING→PROCESSING claim —
   * lets batch callers count real advancement instead of another worker's
   * no-op echo of the current status. */
  claimed: boolean;
}> {
  const liveEnabled = process.env.ENABLE_LIVE_PAYOUTS === "true";

  return prisma
    .$transaction(async (tx) => {
      // #785 — when live payouts are gated OFF there is no gateway submission and
      // no webhook to advance or roll back the row, so claiming PENDING→PROCESSING
      // here would zombie it in PROCESSING forever (handle-stuck-payouts only
      // queries ConsultantPayout). Leave it PENDING until the flag flips on; the
      // cron re-attempts then.
      if (!liveEnabled) {
        const current = await tx.organizationPayout.findUnique({
          where: { id: payoutId },
          select: { status: true },
        });
        if (!current) {
          throw new PayoutValidationError(`Payout ${payoutId} not found`, 404);
        }
        return {
          status: current.status,
          submittedToGateway: false,
          claimed: false,
        };
      }

      // #1020 — a payout whose earnings sit on a disputed payment must not
      // leave the building. Checked inside the claim tx (READ COMMITTED —
      // race-safety comes from the CAS claim below per ADR 13, and the
      // residual window to gateway submit is backstopped by the LOST
      // clawback); returning unclaimed keeps
      // the row PENDING so a later cron run advances it once the dispute
      // resolves. Residual window to gateway submit is backstopped by the
      // LOST-handler clawback (#1020-2).
      const disputedOrgEarning = await tx.organizationEarnings.findFirst({
        where: {
          orgPayoutId: payoutId,
          payment: {
            disputes: {
              some: { status: { notIn: DISPUTE_INACTIVE_FOR_GATING } },
            },
          },
        },
        select: { id: true },
      });
      if (disputedOrgEarning) {
        console.warn(
          `[OrgPayoutService] payout ${payoutId} blocked — an earning's payment has a live dispute`,
        );
        return {
          status: "PENDING" as PayoutStatus,
          submittedToGateway: false,
          claimed: false,
        };
      }

      const claim = await tx.organizationPayout.updateMany({
        where: { id: payoutId, status: "PENDING" },
        data: { status: "PROCESSING" },
      });
      if (claim.count === 0) {
        const current = await tx.organizationPayout.findUnique({
          where: { id: payoutId },
          select: { status: true },
        });
        if (!current) {
          throw new PayoutValidationError(`Payout ${payoutId} not found`, 404);
        }
        console.log(
          `[OrgPayoutService] processOrgPayout no-op: payout ${payoutId} status=${current.status}`,
        );
        // claimed: false — we did NOT advance the row, so the post-tx
        // submission must NOT fire (preventing double-submit on cron retry
        // of an already-PROCESSING row).
        return {
          status: current.status,
          submittedToGateway: false,
          claimed: false,
        };
      }

      const payout = await tx.organizationPayout.findUniqueOrThrow({
        where: { id: payoutId },
        select: {
          id: true,
          organizationId: true,
          amountPaise: true,
          currency: true,
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: payout.organizationId,
          actorMembershipId: null,
          category: "PAYOUT",
          action: AUDIT_ACTIONS.PAYOUT.PAYOUT_PROCESSED,
          description: `Payout ${payoutId} moved PENDING → PROCESSING`,
          details: {
            payoutId,
            amountPaise: payout.amountPaise,
            currency: payout.currency,
            liveSubmissionEnabled: liveEnabled,
          },
        },
      });

      // Live gateway submission gated on env flag. The actual RazorpayX
      // `payouts.create` call happens AFTER the tx commits — we don't want
      // the gateway side-effect inside a serializable tx (long network
      // call, possibility of double-submit on retry). Returning here marks
      // the row PROCESSING; the post-tx submission either persists the
      // gatewayPayoutId on success or rolls the row to FAILED on a 4xx.
      return {
        status: "PROCESSING" as const,
        submittedToGateway: false,
        claimed: true,
      };
    })
    .then(async (result) => {
      if (!liveEnabled || !result.claimed || result.status !== "PROCESSING") {
        // Either live disabled, or this caller didn't claim the row, or
        // the row is no longer PROCESSING — skip submission.
        return {
          status: result.status,
          submittedToGateway: result.submittedToGateway,
          claimed: result.claimed,
        };
      }

      // Post-tx submission: actual RazorpayX call. Idempotency key is
      // deterministic (`payout_<id>`) so a cron retry of the same payout
      // never creates a second gateway transfer (mandatory since
      // 2025-03-15 per RazorpayX). 4xx → mark FAILED + release earnings.
      // 5xx / network error → throw so the cron retries with the same key.
      try {
        await submitOrgPayoutToGateway(payoutId);
        return {
          status: "PROCESSING" as const,
          submittedToGateway: true,
          claimed: true,
        };
      } catch (err) {
        const cls = classifyGatewaySubmissionError(err);
        if (cls === "PERMANENT_4XX") {
          // Gateway declined the submission — an answer, not a fault.
          reportSentryError(err, { subsystem: "payments", expected: true });
          await markPayoutFailedFromSubmission(
            payoutId,
            err instanceof Error ? err.message : String(err),
          );
          // Set true because we DID submit to the gateway — the rejection
          // is recorded on the row. False would imply we early-returned
          // before any gateway call, which isn't the case.
          return {
            status: "FAILED" as PayoutStatus,
            submittedToGateway: true,
            claimed: true,
          };
        }
        // Transient — leave row in PROCESSING and re-throw so the cron
        // retries with the same idempotency key.
        reportSentryError(err, { subsystem: "payments" });
        throw err;
      }
    });
}

/**
 * Submit a payout to the live gateway. Called only when
 * `ENABLE_LIVE_PAYOUTS=true` and only AFTER `processOrgPayout` has
 * advanced the row to PROCESSING. Persists `gatewayPayoutId` +
 * `gatewayResponseRaw` on success. UTR comes later from the webhook.
 *
 * Idempotency: passes `payout_<id>` as the X-Payout-Idempotency header
 * so a duplicate call (cron retry) never creates a second transfer.
 */
async function submitOrgPayoutToGateway(payoutId: string): Promise<void> {
  const payout = await prisma.organizationPayout.findUniqueOrThrow({
    where: { id: payoutId },
    select: {
      id: true,
      organizationId: true,
      amountPaise: true,
      currency: true,
      paymentGateway: true,
      payoutReference: true,
    },
  });

  if (payout.paymentGateway !== "RAZORPAY") {
    // Stripe Connect path is deferred to Phase 2; the row stays in
    // PROCESSING until that lands. Don't throw — let the cron retry
    // visibility surface it.
    console.warn(
      `[OrgPayoutService] payout ${payoutId} gateway=${payout.paymentGateway} not yet supported`,
    );
    return;
  }

  // Account lookup is a separate query (the row's own organizationId is
  // the unique key on OrganizationPayoutAccount). Keeps the service
  // callable in unit tests that mock the two as independent spies.
  const account = await prisma.organizationPayoutAccount.findUnique({
    where: { organizationId: payout.organizationId },
    select: {
      status: true,
      razorpayContactId: true,
      razorpayFundAccountId: true,
    },
  });
  const fundAccountId = account?.razorpayFundAccountId ?? null;
  if (!fundAccountId) {
    throw new PayoutValidationError(
      `Payout ${payoutId}: organization has no razorpayFundAccountId on its payout account`,
      400,
    );
  }
  // CR #1234 r3.5 — a fund-account ID alone is not consent to move money:
  // the PUT flow replaces ids while a fresh penny-drop is still in flight
  // (row back at PENDING_VERIFICATION). Only a VERIFIED account may submit.
  if (account?.status !== "VERIFIED") {
    throw new PayoutValidationError(
      `Payout ${payoutId}: organization payout account is ${account?.status ?? "missing"}, not VERIFIED — refusing to submit`,
      409,
    );
  }

  const { getRazorpayPayoutsService } = await import("./razorpay-payouts");
  const sdk = getRazorpayPayoutsService();
  const idempotencyKey = sdk.generateIdempotencyKey(payoutId);
  const mode = sdk.determinePayoutMode(payout.amountPaise, "bank_account");

  // #863 — don't submit a high-value NEFT the RazorpayX balance can't cover.
  // Leaves the row in PROCESSING for the reconcile cron to retry once funded
  // (same posture as the Stripe-deferred return above). Fails open on unknown.
  const preflight = await assertPayoutBalance(payout.amountPaise);
  if (!preflight.ok) {
    console.warn(
      `[OrgPayoutService] Holding payout ${payoutId} — ${preflight.reason}`,
    );
    return;
  }

  const response = await sdk.createPayout({
    fundAccountId,
    amount: payout.amountPaise,
    currency: payout.currency,
    mode,
    purpose: "payout",
    referenceId: payoutId,
    narration: `Familiarise org payout ${payoutId}`,
    queueIfLowBalance: true,
    idempotencyKey,
  });

  await prisma.organizationPayout.update({
    where: { id: payoutId },
    data: {
      gatewayPayoutId: response.id,
      gatewayResponseRaw: response as unknown as Prisma.JsonObject,
    },
  });
}

/**
 * Classify a RazorpayX SDK error as permanent (4xx — bank/data
 * rejection, never retry) vs transient (5xx / network — let the cron
 * retry with the same idempotency key).
 *
 * The SDK wraps fetch and throws a generic Error without HTTP-status
 * detail, so we sniff the message. Default is TRANSIENT so we never
 * silently drop a legitimate retry.
 */
function classifyGatewaySubmissionError(
  err: unknown,
): "PERMANENT_4XX" | "TRANSIENT_OR_UNKNOWN" {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    msg.includes("400") ||
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("422") ||
    msg.includes("invalid") ||
    msg.includes("bad request")
  ) {
    return "PERMANENT_4XX";
  }
  return "TRANSIENT_OR_UNKNOWN";
}

/**
 * Roll a PROCESSING payout to FAILED after a 4xx submission rejection.
 * Releases the underlying earnings back to READY so the next batch
 * picks them up. Does NOT fire Novu — the operator-facing audit log
 * is enough; the consultant-facing notification only fires for
 * webhook-time failures (where real money was at risk).
 */
async function markPayoutFailedFromSubmission(
  payoutId: string,
  reason: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claim = await tx.organizationPayout.updateMany({
      where: { id: payoutId, status: "PROCESSING" },
      data: {
        status: "FAILED",
        failureReason: reason.slice(0, 500),
        failedAt: new Date(),
      },
    });
    if (claim.count === 0) return;

    // Release earnings back to READY so they're eligible for the next batch.
    // #837 — a submission-rejected payout is pre-COMPLETED, so its earnings are
    // BATCHED (never reached PAID).
    await tx.organizationEarnings.updateMany({
      where: { orgPayoutId: payoutId, status: "BATCHED" },
      data: { status: "READY", orgPayoutId: null },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationId: (
          await tx.organizationPayout.findUniqueOrThrow({
            where: { id: payoutId },
            select: { organizationId: true },
          })
        ).organizationId,
        actorMembershipId: null,
        category: "PAYOUT",
        action: AUDIT_ACTIONS.PAYOUT.PAYOUT_FAILED,
        description: `Payout ${payoutId} submission rejected by gateway (4xx)`,
        details: { payoutId, reason: reason.slice(0, 500) },
      },
    });
  });
}

/**
 * #850 — batch driver over `processOrgPayout` for every PENDING org payout
 * (ported from the deleted scripts/payouts/process-payouts.ts CLI loop so
 * the weekly GH job keeps advancing org payouts). Errors against a single
 * payout never abort the rest of the run.
 */
export interface OrgProcessingResult {
  scanned: number;
  advanced: number;
  errors: string[];
}

export async function processPendingOrgPayouts(): Promise<OrgProcessingResult> {
  const result: OrgProcessingResult = { scanned: 0, advanced: 0, errors: [] };

  // String literals — PayoutStatus is an `import type` in this module.
  const pending = await prisma.organizationPayout.findMany({
    where: { status: "PENDING" },
    select: { id: true },
  });
  result.scanned = pending.length;

  for (const p of pending) {
    try {
      const out = await processOrgPayout(p.id);
      // Count only claims THIS run won — a status echo of a row another
      // worker already moved to PROCESSING is not our advancement.
      if (out.claimed) {
        result.advanced++;
      }
    } catch (err) {
      reportSentryError(err, { subsystem: "payments" });
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`OrgPayout ${p.id}: ${message}`);
    }
  }

  const redrive = await redriveStaleProcessingOrgPayouts();
  result.scanned += redrive.scanned;
  result.advanced += redrive.advanced;
  result.errors.push(...redrive.errors);

  return result;
}

/**
 * Re-drive stale PROCESSING org payouts — the actor the transient-error
 * contract ("leave row in PROCESSING and re-throw so the cron retries with
 * the same idempotency key") was missing: this driver scanned PENDING only,
 * so a single 5xx (or a balance-hold / Stripe-deferred early return) stranded
 * the row in PROCESSING forever with no recovery path except a webhook that
 * may never come.
 *
 * Two shapes:
 *   * gatewayPayoutId null — submission never confirmed. Resubmit through
 *     submitOrgPayoutToGateway; the deterministic X-Payout-Idempotency key
 *     makes RazorpayX return the ORIGINAL payout if the first attempt landed,
 *     so this can never double-disburse.
 *   * gatewayPayoutId set — submitted but confirmation lost. Poll the gateway
 *     once and route through the mark* handlers (first-writer CAS), covering
 *     the lost-webhook case where the org's money arrived while the row sat
 *     in PROCESSING.
 */
const ORG_PROCESSING_REDRIVE_AFTER_MS = 60 * 60 * 1000; // 1h

async function redriveStaleProcessingOrgPayouts(): Promise<OrgProcessingResult> {
  const result: OrgProcessingResult = { scanned: 0, advanced: 0, errors: [] };
  const staleBefore = new Date(Date.now() - ORG_PROCESSING_REDRIVE_AFTER_MS);
  const stale = await prisma.organizationPayout.findMany({
    where: { status: "PROCESSING", updatedAt: { lt: staleBefore } },
    select: { id: true, gatewayPayoutId: true, paymentGateway: true },
    orderBy: { updatedAt: "asc" },
    take: 100,
  });
  result.scanned = stale.length;

  for (const p of stale) {
    try {
      if (p.paymentGateway !== "RAZORPAY") continue; // Stripe rail deferred

      if (!p.gatewayPayoutId) {
        await submitOrgPayoutToGateway(p.id);
        result.advanced++;
        continue;
      }

      const { getRazorpayPayoutsService } = await import("./razorpay-payouts");
      const sdk = getRazorpayPayoutsService();
      const remote = await sdk.fetchPayout(p.gatewayPayoutId);
      switch (remote.status) {
        case "processed":
          await markOrgPayoutCompleted(p.id);
          result.advanced++;
          break;
        case "failed":
          await markOrgPayoutFailed(
            p.id,
            remote.failureReason ?? "Gateway reports the payout failed",
          );
          result.advanced++;
          break;
        case "cancelled":
        case "rejected":
          await markOrgPayoutFailed(
            p.id,
            `Gateway reports the payout ${remote.status}`,
          );
          result.advanced++;
          break;
        case "reversed":
          await markOrgPayoutReversed(
            p.id,
            "Gateway reports the payout reversed",
          );
          result.advanced++;
          break;
        default:
          // queued/pending/processing — still in flight; leave for the next run.
          break;
      }
    } catch (err) {
      // #1205-triage — PERMANENT rejections must terminate the row, not sit
      // in PROCESSING forever: the redrive would retry a data rejection
      // every hour indefinitely while its BATCHED earnings stay locked.
      const message = err instanceof Error ? err.message : String(err);
      if (
        classifyGatewaySubmissionError(err) === "PERMANENT_4XX" ||
        err instanceof PayoutValidationError
      ) {
        await markOrgPayoutFailed(p.id, `redrive rejected: ${message}`);
        result.advanced++;
        continue;
      }
      reportSentryError(err, { subsystem: "payments" });
      result.errors.push(`OrgPayout redrive ${p.id}: ${message}`);
    }
  }

  return result;
}

/**
 * Idempotent PROCESSING → COMPLETED transition for an OrganizationPayout.
 *
 * Called by the gateway-webhook reconciler that PR-3 wires up; the
 * notification fire is intentionally co-located with the state change so
 * future call sites cannot forget to dispatch (#718 / BUG-017 root cause).
 *
 * Idempotency: the conditional updateMany only progresses rows still in
 * PROCESSING. A duplicate webhook delivery returns `wasNoOp: true` and
 * the notification is NOT re-sent.
 *
 * Notification: fired AFTER the transaction commits so a rolled-back
 * transition cannot page the visibility roster. `notifyOrgPayoutCompleted`
 * is non-throwing per its own contract.
 */
export async function markOrgPayoutCompleted(payoutId: string): Promise<{
  wasNoOp: boolean;
  status: PayoutStatus;
}> {
  // #1470 — the promise is held in a local so the `.catch` below is a separate
  // statement: chaining it onto `prisma.$transaction(...)` re-indents the whole
  // callback and buries the money change in whitespace.
  const completion = prisma.$transaction(async (tx) => {
    const claim = await tx.organizationPayout.updateMany({
      where: { id: payoutId, status: "PROCESSING" },
      data: { status: "COMPLETED", processedAt: new Date() },
    });
    if (claim.count === 0) {
      const current = await tx.organizationPayout.findUnique({
        where: { id: payoutId },
        select: { status: true },
      });
      if (!current) {
        throw new PayoutValidationError(`Payout ${payoutId} not found`, 404);
      }
      console.log(
        `[OrgPayoutService] markOrgPayoutCompleted no-op: payout ${payoutId} status=${current.status}`,
      );
      return {
        wasNoOp: true,
        status: current.status,
        notify: null,
        missingTdsRate: null,
      };
    }

    const payout = await tx.organizationPayout.findUniqueOrThrow({
      where: { id: payoutId },
      select: {
        id: true,
        organizationId: true,
        netPayoutPaise: true,
        // #1470 — the CASH leg is sized from what the rail actually sent, which
        // is this column, not netPayoutPaise.
        amountPaise: true,
        tdsAmountPaise: true,
        // #1354 — the rate and section the completion-time TDSRecord files
        // under, both pinned at batch time (see createOrgPayoutBatch). The
        // period is NOT read from the payout; see below.
        tdsRateAppliedBps: true,
        tdsSectionApplied: true,
        currency: true,
        organization: { select: { name: true } },
      },
    });

    // #837 E-03/E-04 — cash has now actually moved (COMPLETED + UTR). This is
    // the ONLY place org earnings become PAID; createOrgPayoutBatch staged them
    // as BATCHED.
    await tx.organizationEarnings.updateMany({
      where: { orgPayoutId: payoutId, status: "BATCHED" },
      data: { status: "PAID" },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationId: payout.organizationId,
        actorMembershipId: null,
        category: "PAYOUT",
        action: AUDIT_ACTIONS.PAYOUT.PAYOUT_COMPLETED,
        description: `Payout ${payoutId} moved PROCESSING → COMPLETED`,
        details: {
          payoutId,
          netPayoutPaise: payout.netPayoutPaise,
          currency: payout.currency,
        },
      },
    });

    // #771 D1/D5 — double-entry (dual-write): settle the host org's payable.
    //   Dr ORG_PAYABLE (pre-withholding share, netPayoutPaise)
    //     Cr CASH (what the rail transferred, amountPaise)
    //     Cr TDS_PAYABLE (withheld, tdsAmountPaise)
    // #1470 — this used to debit `netPayoutPaise + tds` and credit CASH
    // `netPayoutPaise`. That balances, so the trigger accepted it, but it
    // cleared the payable and credited cash by one TDS amount too much on every
    // org payout. The identity below is what makes the three legs tie out.
    const orgTds = payout.tdsAmountPaise ?? 0;
    assertOrgPayoutWithholdingIdentity(payout);
    if (payout.netPayoutPaise > 0) {
      // #783 — ledger is INR-only; never key accounts by the payout's settlement
      // currency (would orphan INR paise in a foreign-labelled account). Matches
      // the consultant payout postings, which already omit currency.
      const orgPostings: Posting[] = [
        {
          account: {
            kind: "ORG_PAYABLE",
            organizationId: payout.organizationId,
          },
          direction: "DEBIT",
          amountPaise: payout.netPayoutPaise,
        },
        {
          account: { kind: "CASH" },
          direction: "CREDIT",
          amountPaise: payout.amountPaise,
        },
      ];
      if (orgTds > 0) {
        orgPostings.push({
          account: { kind: "TDS_PAYABLE" },
          direction: "CREDIT",
          amountPaise: orgTds,
        });
      }
      await postLedgerTxn(tx, {
        idempotencyKey: `orgpayout:${payoutId}`,
        kind: "ORG_PAYOUT",
        payoutId,
        postings: orgPostings,
      });
    }

    // #1354 — the statutory audit row is written HERE and nowhere else. #837
    // E-03/E-04: a batch that never completes never withheld anything, so a
    // TDSRecord created at batch time would put money on the quarterly return
    // that the government was never paid.
    // #1354 — `tdsRateAppliedBps` is nullable only because it was added after
    // some payouts had already been batched, and those rows are its entire
    // population; pre-MVP data is reset before launch so nothing is backfilled,
    // and every payout batched from this PR onwards carries the rate. Rather
    // than let `TDSRecord.tdsRateBps` go nullable (or reconstruct the rate from
    // tdsAmountPaise/gross, which cannot invert the floor in computeTdsForPayout)
    // the missed filing row is reported loudly below — a durable guard that
    // costs the schema nothing.
    const orgTdsRateBps = payout.tdsRateAppliedBps;
    const hasOrgTdsRate = orgTdsRateBps !== null && orgTdsRateBps > 0;
    if (orgTds > 0 && hasOrgTdsRate) {
      // Delete-then-write, matching the consultant rail: a payout can go
      // COMPLETED after having been FAILED and re-batched, and the org unique
      // (organizationId, FY, quarter, orgPayoutId, isReversal) would otherwise
      // reject the second insert. Reversal rows are keyed isReversal=true and
      // are not touched by an unqualified delete on a fresh completion.
      await tx.tDSRecord.deleteMany({
        where: { orgPayoutId: payoutId, isReversal: false },
      });

      // #1354 — TDS on a payout is dated at PAYMENT, so both halves of the
      // period come from the completion instant. Taking the year from the
      // batch-time stamp and the quarter from "now" is how a late-March batch
      // that settles in April files FY 2025-26 quarter 1, a period that does
      // not exist. `OrganizationPayout.tdsFinancialYear` stays what it is: an
      // audit stamp of when the batch was built.
      const financialYear = getIndianFinancialYear();
      const quarter = getIndianFYQuarter();
      const { start, end } = getFYDateRange(financialYear);
      // The return reports the GROSS amount credited, not the cash that left.
      // #1470 — `netPayoutPaise` IS that gross figure: it is the org share
      // before withholding, and it is the base `computeTdsForPayout` was given.
      // Adding `tdsAmountPaise` on top (as this did) counted the withholding
      // twice. So: sum of `netPayoutPaise` over every other COMPLETED payout to
      // this org in the FY, plus this one's.
      const priorCompleted = await tx.organizationPayout.aggregate({
        where: {
          organizationId: payout.organizationId,
          status: "COMPLETED",
          processedAt: { gte: start, lt: end },
          id: { not: payoutId },
        },
        _sum: { netPayoutPaise: true },
      });
      const cumulativeAmountCredited =
        sumPaise(priorCompleted._sum.netPayoutPaise) + payout.netPayoutPaise;

      await recordOrgTDSDeduction({
        organizationId: payout.organizationId,
        financialYear,
        tdsDeducted: orgTds,
        tdsRateBps: orgTdsRateBps,
        cumulativeAmountCredited,
        orgPayoutId: payoutId,
        quarter,
        tdsSection: payout.tdsSectionApplied ?? undefined,
        db: tx,
      });
    }

    return {
      wasNoOp: false,
      status: "COMPLETED" as PayoutStatus,
      notify: {
        organizationId: payout.organizationId,
        orgName: payout.organization.name,
        netPayoutPaise: payout.netPayoutPaise,
        currency: payout.currency,
      },
      // Reported AFTER the commit: the withholding is already deposited to
      // TDS_PAYABLE and the completion must stand, so this is an alert, never
      // a rollback.
      missingTdsRate:
        orgTds > 0 && !hasOrgTdsRate
          ? { organizationId: payout.organizationId, tdsAmountPaise: orgTds }
          : null,
    };
  });
  // #1470 — the withholding-identity guard fires INSIDE the transaction so the
  // CAS rolls back; the durable report has to happen out here, after the
  // connection is free (PG_POOL_MAX=1).
  const result = await completion.catch(async (err: unknown) => {
    if (err instanceof OrgPayoutWithholdingMismatchError) {
      await reportOrgPayoutWithholdingMismatch(err, "markOrgPayoutCompleted");
    }
    throw err;
  });

  if (result.missingTdsRate) {
    const summary =
      "org payout completed with withheld TDS but no applied rate; TDSRecord not written";
    const context = {
      orgPayoutId: payoutId,
      organizationId: result.missingTdsRate.organizationId,
      tdsAmountPaise: result.missingTdsRate.tdsAmountPaise,
    };
    // Never throws by contract, and the `.catch` keeps a failed sink from
    // turning a settled payout into an error for the webhook caller.
    await recordSystemError({
      organizationId: result.missingTdsRate.organizationId,
      category: "PAYOUT",
      summary: `ORG_PAYOUT_TDS_RATE_MISSING — ${summary}`,
      err: new Error(summary),
      context,
    }).catch(() => {});
    reportSentryMessage(summary, {
      subsystem: "payments",
      op: "markOrgPayoutCompleted",
      level: "warning",
      extra: context,
    });
  }

  if (result.notify) {
    await notifyOrgPayoutCompleted(result.notify.organizationId, {
      orgName: result.notify.orgName,
      payoutId,
      amountPaise: result.notify.netPayoutPaise,
      currency: result.notify.currency,
      dashboardUrl: `${getAppUrl()}/dashboard/organization/${result.notify.organizationId}/payouts`,
    });
  }

  return { wasNoOp: result.wasNoOp, status: result.status };
}

/**
 * A1+A8: shared internal helper for the "payout failed at the gateway"
 * and "payout reversed by the bank" code paths. Both reach this — the
 * `kind` parameter only changes the audit description and the Novu
 * payload; the state-machine effect is identical (PROCESSING → FAILED,
 * release earnings to READY, fire Novu).
 */
async function markOrgPayoutFailedInternal(
  payoutId: string,
  reason: string,
  kind: "FAILED" | "REVERSED",
): Promise<{ wasNoOp: boolean; status: PayoutStatus }> {
  const result = await prisma.$transaction(async (tx) => {
    const claim = await tx.organizationPayout.updateMany({
      where: { id: payoutId, status: "PROCESSING" },
      data: {
        status: "FAILED",
        failureReason: reason.slice(0, 500),
        failedAt: new Date(),
      },
    });
    if (claim.count === 0) {
      const current = await tx.organizationPayout.findUnique({
        where: { id: payoutId },
        select: { status: true },
      });
      if (!current) {
        throw new PayoutValidationError(`Payout ${payoutId} not found`, 404);
      }
      console.log(
        `[OrgPayoutService] markOrgPayoutFailedInternal no-op: payout ${payoutId} status=${current.status}`,
      );
      return { wasNoOp: true, status: current.status, notify: null };
    }

    // Release the underlying earnings back to READY so the next batch
    // sees them. This is the inverse of the createOrgPayoutBatch claim.
    // #837 — a PROCESSING→FAILED payout's earnings are BATCHED (never PAID).
    await tx.organizationEarnings.updateMany({
      where: { orgPayoutId: payoutId, status: "BATCHED" },
      data: { status: "READY", orgPayoutId: null },
    });

    // #1354 — defensive: a PROCESSING→FAILED payout never disbursed, so it
    // never withheld. Nothing should have written a deduction row yet, because
    // that happens only at COMPLETED, but if one somehow exists it must not
    // reach the quarterly return, so delete it here.
    // The tdsAmountPaise/tdsRateAppliedBps/tdsFinancialYear columns are
    // deliberately LEFT SET (the consultant rail clears its equivalents): they
    // are the batch-time record of what was computed, and markOrgPayoutReversed
    // sizes its reversing ledger posting from tdsAmountPaise.
    await tx.tDSRecord.deleteMany({
      where: { orgPayoutId: payoutId, isReversal: false },
    });

    const payout = await tx.organizationPayout.findUniqueOrThrow({
      where: { id: payoutId },
      select: {
        id: true,
        organizationId: true,
        netPayoutPaise: true,
        currency: true,
        organization: { select: { name: true } },
      },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationId: payout.organizationId,
        actorMembershipId: null,
        category: "PAYOUT",
        action:
          kind === "REVERSED"
            ? AUDIT_ACTIONS.PAYOUT.PAYOUT_REVERSED
            : AUDIT_ACTIONS.PAYOUT.PAYOUT_FAILED,
        description:
          kind === "REVERSED"
            ? `Payout ${payoutId} reversed by gateway: ${reason.slice(0, 200)}`
            : `Payout ${payoutId} failed at gateway: ${reason.slice(0, 200)}`,
        details: { payoutId, kind, reason: reason.slice(0, 500) },
      },
    });

    return {
      wasNoOp: false,
      status: "FAILED" as PayoutStatus,
      notify: {
        organizationId: payout.organizationId,
        orgName: payout.organization.name,
        netPayoutPaise: payout.netPayoutPaise,
        currency: payout.currency,
      },
    };
  });

  if (result.notify) {
    const { notifyOrgPayoutFailed } = await import("@/lib/novu/org-workflows");
    await notifyOrgPayoutFailed(result.notify.organizationId, {
      orgName: result.notify.orgName,
      payoutId,
      amountPaise: result.notify.netPayoutPaise,
      currency: result.notify.currency,
      reason: reason.slice(0, 200),
      kind,
      dashboardUrl: `${getAppUrl()}/dashboard/organization/${result.notify.organizationId}/payouts`,
    });
  }

  return { wasNoOp: result.wasNoOp, status: result.status };
}

/**
 * A1+A8: webhook-time PROCESSING → FAILED transition. Called when the
 * gateway sends `payout.failed` or `payout.rejected`. Releases earnings
 * to READY and fires `org-payout-failed` Novu workflow.
 */
export async function markOrgPayoutFailed(
  payoutId: string,
  reason: string,
): Promise<{ wasNoOp: boolean; status: PayoutStatus }> {
  return markOrgPayoutFailedInternal(payoutId, reason, "FAILED");
}

/**
 * A1+A8: webhook-time PROCESSING → FAILED transition for `payout.reversed`.
 * Behaviorally identical to `markOrgPayoutFailed` in v1; the audit log
 * and Novu payload distinguish the two so future ops can chase them
 * differently (a reversal often means the consultant's bank rejected
 * the credit and the org's account holder name needs an update).
 */
export async function markOrgPayoutReversed(
  payoutId: string,
  reason: string,
): Promise<{ wasNoOp: boolean; status: PayoutStatus }> {
  // #812 — a `payout.reversed` can arrive in two states:
  //   • PROCESSING — the gateway bounced before settlement; no money left, so
  //     this is the FAILED path (release earnings to READY). Handled by the
  //     shared internal which claims PROCESSING rows.
  //   • COMPLETED — the bank returned the funds AFTER the ORG_PAYOUT posting and
  //     CASH already left. Previously this was a SILENT NO-OP (the internal only
  //     claims PROCESSING): the payable stayed cleared, the cash stayed out, the
  //     earnings stayed PAID. We now post a REVERSING ORG_PAYOUT (the exact
  //     inverse of the original), re-open the earnings, and set REVERSED.
  const reversalCompletion = prisma.$transaction(async (tx) => {
    const claim = await tx.organizationPayout.updateMany({
      where: { id: payoutId, status: "COMPLETED" },
      data: {
        status: "REVERSED",
        failureReason: reason.slice(0, 500),
        failedAt: new Date(),
      },
    });
    if (claim.count === 0) return { claimed: false, notify: null };

    const payout = await tx.organizationPayout.findUniqueOrThrow({
      where: { id: payoutId },
      select: {
        id: true,
        organizationId: true,
        netPayoutPaise: true,
        // #1470 — the CASH leg of the original posting was sized from this, so
        // the mirror must be too.
        amountPaise: true,
        tdsAmountPaise: true,
        currency: true,
        organization: { select: { name: true } },
      },
    });

    // Re-open the earnings this payout had claimed so a future batch re-pays them.
    await tx.organizationEarnings.updateMany({
      where: { orgPayoutId: payoutId, status: "PAID" },
      data: { status: "READY", orgPayoutId: null },
    });

    // Reverse the ORG_PAYOUT posting exactly: the original is
    //   Dr ORG_PAYABLE (netPayoutPaise)  Cr CASH (amountPaise)
    //   Cr TDS_PAYABLE (tdsAmountPaise)
    // so the reversal brings the cash back and re-opens the payable. (The TDS
    // *remittance* to the government is a separate flow; reversing TDS_PAYABLE
    // here only un-does this payout's accrual, which is correct for a bounce.)
    // #1470 — this mirror was written against the old, wrong completion legs,
    // which is why a reversal still netted to zero while a payout that stayed
    // COMPLETED kept the overstatement.
    const orgTds = payout.tdsAmountPaise ?? 0;
    assertOrgPayoutWithholdingIdentity(payout);
    if (payout.netPayoutPaise > 0) {
      // #783 — INR-only ledger; the reversal keys the same INR accounts as the
      // original posting (which now omits currency) so the pair nets to zero.
      const reversal: Posting[] = [
        {
          account: { kind: "CASH" },
          direction: "DEBIT",
          amountPaise: payout.amountPaise,
        },
        {
          account: {
            kind: "ORG_PAYABLE",
            organizationId: payout.organizationId,
          },
          direction: "CREDIT",
          amountPaise: payout.netPayoutPaise,
        },
      ];
      if (orgTds > 0) {
        reversal.push({
          account: { kind: "TDS_PAYABLE" },
          direction: "DEBIT",
          amountPaise: orgTds,
        });
      }
      await postLedgerTxn(tx, {
        idempotencyKey: `orgpayout-reversal:${payoutId}`,
        kind: "ORG_PAYOUT",
        payoutId,
        postings: reversal,
      });
    }

    // #1354 — the bank returned the money, so the withholding that rode on it
    // never happened either. Net it out of the quarter with a negative
    // TDSRecord + the TdsAdjustment the return exports as a revised line; the
    // helper caps against prior reversals so a redelivered webhook cannot
    // reverse twice.
    await recordOrgTdsReversal(tx, {
      orgPayoutId: payoutId,
      organizationId: payout.organizationId,
      reversalBasis: { kind: "FULL" },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationId: payout.organizationId,
        actorMembershipId: null,
        category: "PAYOUT",
        action: AUDIT_ACTIONS.PAYOUT.PAYOUT_REVERSED,
        description: `Payout ${payoutId} reversed by bank after completion: ${reason.slice(0, 200)}`,
        details: {
          payoutId,
          kind: "REVERSED",
          reversedFrom: "COMPLETED",
          reason: reason.slice(0, 500),
        },
      },
    });

    return {
      claimed: true,
      notify: {
        organizationId: payout.organizationId,
        orgName: payout.organization.name,
        netPayoutPaise: payout.netPayoutPaise,
        currency: payout.currency,
      },
    };
  });
  // #1470 — same shape as markOrgPayoutCompleted: the guard throws inside the
  // transaction so the REVERSED claim rolls back, and the durable report runs
  // once the single pooled connection is free.
  const completedResult = await reversalCompletion.catch(
    async (err: unknown) => {
      if (err instanceof OrgPayoutWithholdingMismatchError) {
        await reportOrgPayoutWithholdingMismatch(err, "markOrgPayoutReversed");
      }
      throw err;
    },
  );

  if (completedResult.claimed) {
    if (completedResult.notify) {
      const { notifyOrgPayoutFailed } =
        await import("@/lib/novu/org-workflows");
      // #813 — fire-and-forget: awaiting let a Novu failure throw out of the
      // committed tx, failing the webhook delivery whose redelivery then no-ops
      // (state already REVERSED) → the notification was permanently lost.
      void notifyOrgPayoutFailed(completedResult.notify.organizationId, {
        orgName: completedResult.notify.orgName,
        payoutId,
        amountPaise: completedResult.notify.netPayoutPaise,
        currency: completedResult.notify.currency,
        reason: reason.slice(0, 200),
        kind: "REVERSED",
        dashboardUrl: `${getAppUrl()}/dashboard/organization/${completedResult.notify.organizationId}/payouts`,
      }).catch((e) => {
        reportSentryError(e, { subsystem: "payments" });
        console.error("[org-payout] REVERSED notify failed:", e);
      });
    }
    return { wasNoOp: false, status: "REVERSED" as PayoutStatus };
  }

  // Not COMPLETED — fall through to the PROCESSING→FAILED path (money never left).
  return markOrgPayoutFailedInternal(payoutId, reason, "REVERSED");
}
