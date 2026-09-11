/**
 * Wallet balance helpers. The wallet is a prepaid liability we owe an org,
 * cached on `BillingAccount.walletBalance` and authoritatively recorded in
 * the double-entry journal (the org's WALLET LedgerAccount). #772 B3 removed
 * the old per-row WalletEntry log; balance movements ARE journal postings.
 *
 * Atomicity: the `walletDebit` helper uses a raw SQL
 *   `UPDATE ... WHERE walletBalance >= :amount`
 * conditional update to prevent overdraft under concurrent transactions —
 * the same pattern the old seat-helpers.ts used for acquireSeat.
 *
 * Top-up flow (Razorpay-only for v1):
 *   1. API calls `initiateTopUp` → a PENDING WalletTopUp keyed by
 *      providerOrderId (@unique). Returns the Razorpay order id to client.
 *   2. Client completes Razorpay checkout.
 *   3. Webhook calls `confirmTopUp(providerOrderId, providerPaymentId)`.
 *   4. `confirmTopUp` atomically: flips the WalletTopUp PENDING → CONFIRMED
 *      (idempotent claim), bumps walletBalance, and posts the top-up's
 *      double-entry txn (Dr CASH / Cr WALLET) — all in one transaction.
 *
 * Booking debit flow (at checkout):
 *   1. `walletDebit` atomically decrements the cached balance.
 *   2. Throws `WalletInsufficientFundsError` if balance would go negative.
 *   3. The accounting leg (Dr WALLET) posts from the settlement layer where
 *      the full fee/payable split is known (createEarningsFromPayment).
 */

import type { WalletReason } from "@prisma/client";

import prisma, { type Db, type Tx } from "@/lib/prisma";
import { postLedgerTxn } from "@/lib/payments/ledger/post";

/**
 * #1477 — an org that has run its wallet down is refusing a booking, not
 * failing at one. The stable `code` is what carries that through checkout's
 * catch (`isBusinessErrorCode`) and into the classifier, which would otherwise
 * fall back to matching prose and answer 500 "Failed to record payment
 * information" for a condition only a top-up fixes.
 *
 * `requestedPaise` is the whole shortfall we can report: the guard below is a
 * conditional `updateMany` that refuses without ever reading the row, and
 * re-reading the balance to fill in an `availablePaise` would add a query
 * inside the checkout transaction, which PG_POOL_MAX=1 serialises behind it.
 */
export class WalletInsufficientFundsError extends Error {
  public readonly code = "WALLET_INSUFFICIENT_FUNDS";
  public readonly httpStatus = 402;
  constructor(
    public billingAccountId: string,
    public requestedPaise: number,
  ) {
    super(
      `Insufficient wallet balance on billing account ${billingAccountId}: requested ${requestedPaise} paise`,
    );
    this.name = "WalletInsufficientFundsError";
  }
}

/**
 * #1459 — a `walletBalance` of NULL means "no cached balance was ever written",
 * not "zero", and arithmetic against it yields NULL rather than the new figure.
 * Only the still-NULL row matches, so this is a no-op on every account that
 * already carries a number and cannot clobber a concurrent writer's value. The
 * schema keeps the column nullable for now; a non-null default belongs to the
 * pre-MVP reset.
 */
async function seedNullWalletBalance(
  tx: Tx,
  billingAccountId: string,
): Promise<void> {
  await tx.billingAccount.updateMany({
    where: { id: billingAccountId, walletBalance: null },
    data: { walletBalance: 0 },
  });
}

/**
 * #1459 — the balance to report back is the one Postgres actually stored, so it
 * is read off the mutated row. A NULL here can no longer be a legitimate zero
 * (the seed above ran in the same transaction), so it means the arithmetic did
 * not take; coercing it with `?? 0` is exactly what let the drift go unnoticed.
 */
function readCachedBalance(
  billingAccountId: string,
  acct: { walletBalance: number | null },
): number {
  if (acct.walletBalance === null) {
    throw new Error(
      `Billing account ${billingAccountId} still has a NULL cached wallet balance after the mutation`,
    );
  }
  return acct.walletBalance;
}

/**
 * Atomically debit a wallet. Throws WalletInsufficientFundsError if the
 * account would go negative. Must be called inside a Prisma transaction.
 */
export async function walletDebit(
  tx: Tx,
  params: {
    billingAccountId: string;
    amountPaise: number;
    reason: WalletReason;
    paymentId?: string;
    membershipId?: string;
    notes?: string;
  },
): Promise<{ balanceAfter: number }> {
  if (params.amountPaise <= 0) {
    throw new Error(
      `walletDebit requires positive amountPaise, got ${params.amountPaise}`,
    );
  }
  // #1459 — Postgres NULL + x = NULL, so a decrement on a NULL cached balance
  // silently no-ops; INVOICE-funded accounts are created with a NULL cached
  // balance. Seeding the NULL to 0 first (the WHERE matches only the NULL row,
  // so a concurrent writer is untouched) keeps the cache a real number even
  // though the gte guard below still refuses the debit on a zero balance.
  await seedNullWalletBalance(tx, params.billingAccountId);
  // Atomic conditional decrement via the ORM (no raw SQL): updateMany only matches
  // a row whose balance is already sufficient (gte excludes NULL too), so two
  // concurrent debits can't overdraw — Postgres row-locks the matched row.
  const updated = await tx.billingAccount.updateMany({
    where: {
      id: params.billingAccountId,
      walletBalance: { gte: params.amountPaise },
    },
    data: { walletBalance: { decrement: params.amountPaise } },
  });
  if (updated.count === 0) {
    throw new WalletInsufficientFundsError(
      params.billingAccountId,
      params.amountPaise,
    );
  }
  const acct = await tx.billingAccount.findUniqueOrThrow({
    where: { id: params.billingAccountId },
    select: { walletBalance: true, currency: true },
  });
  const balanceAfter = readCachedBalance(params.billingAccountId, acct);

  // #772 B3 — WalletEntry removed. The wallet-balance cache is decremented
  // above; the booking-debit's accounting leg (Dr WALLET) posts to the
  // double-entry journal from the settlement layer (createEarningsFromPayment),
  // which is also the wallet-history record.
  return { balanceAfter };
}

/**
 * Credit a wallet (top-up or refund). Same transaction semantics as debit.
 */
export async function walletCredit(
  tx: Tx,
  params: {
    billingAccountId: string;
    amountPaise: number;
    reason: WalletReason;
    paymentId?: string;
    membershipId?: string;
    notes?: string;
    providerOrderId?: string;
    providerPaymentId?: string;
  },
): Promise<{ balanceAfter: number; ownerOrgId: string }> {
  if (params.amountPaise <= 0) {
    throw new Error(
      `walletCredit requires positive amountPaise, got ${params.amountPaise}`,
    );
  }
  // #1459 — Postgres NULL + x = NULL, so an increment on a NULL cached balance
  // silently no-ops while the ledger CREDIT posts: permanent cache-vs-ledger
  // drift. INVOICE-funded accounts are created with a NULL cached balance, so
  // this is not hypothetical. Seed the NULL to 0 in the same transaction first.
  await seedNullWalletBalance(tx, params.billingAccountId);
  // Atomic increment via the ORM (no raw SQL). The seed above guarantees a
  // non-null operand, so increment is exact without a COALESCE. `update`
  // throws P2025 if the account is missing (a real error, like the old guard).
  const acct = await tx.billingAccount.update({
    where: { id: params.billingAccountId },
    data: { walletBalance: { increment: params.amountPaise } },
    select: { walletBalance: true, currency: true, ownerOrgId: true },
  });
  const balanceAfter = readCachedBalance(params.billingAccountId, acct);

  // #771 D1/D5 / #772 B3 — double-entry is now the sole record (WalletEntry
  // removed). A top-up is a complete 2-leg txn:
  // platform CASH rises and we now owe the org a WALLET balance.
  //   Dr CASH(platform)   Cr WALLET(org)
  // Booking-debit and refund WALLET legs post from the settlement / refund
  // layer (where the full split is known), not here.
  if (params.reason === "TOPUP") {
    await postLedgerTxn(tx, {
      idempotencyKey: `topup:${params.providerOrderId ?? params.paymentId ?? `${params.billingAccountId}:${balanceAfter}`}`,
      kind: "TOPUP",
      paymentId: params.paymentId ?? null,
      postings: [
        {
          // #783 — ledger is INR-only; never key accounts by acct.currency.
          account: { kind: "CASH" },
          direction: "DEBIT",
          amountPaise: params.amountPaise,
        },
        {
          account: {
            kind: "WALLET",
            organizationId: acct.ownerOrgId,
          },
          direction: "CREDIT",
          amountPaise: params.amountPaise,
        },
      ],
    });
  }

  // ownerOrgId lets the refund cascade attribute the credit to the org even
  // when the payment itself carries no organizationId (#835 — the wallet is
  // the org's money regardless of how the payment was tagged).
  return { balanceAfter, ownerOrgId: acct.ownerOrgId };
}

/**
 * Initiate a top-up: creates a PENDING WalletTopUp keyed by providerOrderId
 * so the webhook can idempotently confirm.
 *
 * The `@unique` constraint on WalletTopUp.providerOrderId provides the
 * idempotency guarantee — a second POST with the same order id fails fast.
 * Unlike the old WalletEntry placeholder, the amount is stored up front so
 * confirmTopUp can assert the webhook amount matches what was authorized.
 */
export async function initiateTopUp(
  db: Tx | typeof prisma,
  params: {
    billingAccountId: string;
    amountPaise: number;
    providerOrderId: string;
    notes?: string;
  },
): Promise<void> {
  await db.walletTopUp.create({
    data: {
      billingAccountId: params.billingAccountId,
      amountPaise: params.amountPaise,
      providerOrderId: params.providerOrderId,
      status: "PENDING",
      notes: params.notes ?? "Top-up initiated; awaiting webhook",
    },
  });
}

/**
 * Confirm a top-up from a webhook. Idempotent: if the same providerOrderId
 * is confirmed twice, the second call is a no-op.
 */
export async function confirmTopUp(
  // #780 — must be the extended client; bare PrismaClient re-introduces bigint
  // money types and its tx callback type blows the structural-compare limit.
  prisma: Db,
  params: {
    providerOrderId: string;
    providerPaymentId: string;
    amountPaise: number;
  },
): Promise<{ confirmed: boolean; balanceAfter?: number }> {
  // #785 — record the gateway capture OUTSIDE the tx below so it survives a
  // ledger-post rollback. The whole confirm body is one $transaction, so a
  // walletCredit/postLedgerTxn failure reverts the CONFIRMED claim back to
  // PENDING; without this the abandoned-cleanup cron reaps the row and the
  // captured money's only trace is lost. capturedAt + providerPaymentId persist
  // so the cleanup skips it and sweep-orphaned-topup-captures can re-credit it.
  await prisma.walletTopUp.updateMany({
    where: { providerOrderId: params.providerOrderId, capturedAt: null },
    data: {
      capturedAt: new Date(),
      providerPaymentId: params.providerPaymentId,
    },
  });

  return prisma.$transaction(async (tx) => {
    // Atomic idempotent claim: flip PENDING → CONFIRMED in a single
    // conditional updateMany. Exactly one racing webhook delivery sees
    // count===1 and proceeds to credit the wallet; a redelivery (or the
    // losing race) sees count===0 and falls through to the no-op branch.
    const claim = await tx.walletTopUp.updateMany({
      where: { providerOrderId: params.providerOrderId, status: "PENDING" },
      data: {
        status: "CONFIRMED",
        providerPaymentId: params.providerPaymentId,
        confirmedAt: new Date(),
      },
    });

    if (claim.count === 0) {
      // Already confirmed by a prior delivery, or no such top-up. Return
      // the current wallet balance so the caller can surface latest state;
      // throw only if the top-up genuinely never existed.
      const existing = await tx.walletTopUp.findUnique({
        where: { providerOrderId: params.providerOrderId },
        select: { billingAccountId: true },
      });
      if (!existing) {
        throw new Error(
          `No WalletTopUp for providerOrderId=${params.providerOrderId}`,
        );
      }
      const ba = await tx.billingAccount.findUniqueOrThrow({
        where: { id: existing.billingAccountId },
        select: { walletBalance: true },
      });
      return { confirmed: false, balanceAfter: ba.walletBalance ?? 0 };
    }

    const topUp = await tx.walletTopUp.findUniqueOrThrow({
      where: { providerOrderId: params.providerOrderId },
      select: { billingAccountId: true, amountPaise: true },
    });
    // #785 — credit the AUTHORIZED amount stored at initiation, and reject a
    // webhook/sweeper whose amount disagrees. The ledger idempotency key is the
    // order id, so it dedupes the posting but NOT the amount; without this a
    // mismatched-amount delivery (or a future caller that skips the gateway
    // amount check) would credit the wallet for the wrong figure undetected.
    if (params.amountPaise !== topUp.amountPaise) {
      throw new Error(
        `Top-up amount mismatch for order ${params.providerOrderId}: ` +
          `confirm=${params.amountPaise} paise vs authorized=${topUp.amountPaise} paise`,
      );
    }
    const result = await walletCredit(tx, {
      billingAccountId: topUp.billingAccountId,
      amountPaise: topUp.amountPaise,
      reason: "TOPUP",
      providerOrderId: params.providerOrderId,
      providerPaymentId: params.providerPaymentId,
      notes: `Top-up confirmed via webhook; order=${params.providerOrderId}`,
    });
    return { confirmed: true, balanceAfter: result.balanceAfter };
  });
}

/**
 * Attach a running balance to one page of wallet-ledger rows.
 *
 * The client's ledger table has always had a "Balance" column, but no endpoint
 * ever produced the field it reads. Because the client validates the payload
 * with a required `z.number()`, the miss did not degrade to "₹NaN" — it threw,
 * so the whole Wallet tab sat on its loading state forever for any org that had
 * ever moved money. Computing it here is what makes the column real.
 *
 * `rows` must be newest-first, and `balanceAfterNewestRow` is the account
 * balance immediately after the first row in `rows` — which for a paginated
 * view is the whole-journal balance minus every delta newer than this page.
 * Walking backwards from there is what makes page 2 agree with page 1.
 *
 * Derived from the journal rather than `BillingAccount.walletBalance`: that
 * column is a cache the reconciler checks against exactly this sum, so
 * anchoring on it would let a drift hide instead of showing up as a ledger
 * whose oldest row does not land where it should.
 */
export function withRunningBalance<T extends { deltaPaise: number }>(
  rows: readonly T[],
  balanceAfterNewestRow: number,
): (T & { balanceAfter: number })[] {
  let running = balanceAfterNewestRow;
  return rows.map((row) => {
    const balanceAfter = running;
    running -= row.deltaPaise;
    return { ...row, balanceAfter };
  });
}

/** Signed paise total for ledger rows: CREDIT adds, DEBIT subtracts.
 *  Asserts the safe-integer range like `sumPaise` — an unguarded BigInt sum
 *  silently loses precision past 2^53 instead of failing loudly. */
export function signedDeltaPaise(
  rows: readonly { direction: string; amountPaise: bigint | number }[],
): number {
  let total = 0;
  for (const r of rows) {
    const amount =
      typeof r.amountPaise === "bigint" ? Number(r.amountPaise) : r.amountPaise;
    if (!Number.isSafeInteger(amount)) {
      throw new Error(
        `signedDeltaPaise: amount ${r.amountPaise} exceeds the safe integer range`,
      );
    }
    total += r.direction === "CREDIT" ? amount : -amount;
    // Validate the RUNNING total too: a later debit can bring an imprecise
    // sum back into range after precision was already lost mid-accumulation.
    if (!Number.isSafeInteger(total)) {
      throw new Error(
        `signedDeltaPaise: intermediate total ${total} exceeds the safe integer range`,
      );
    }
  }
  return total;
}
