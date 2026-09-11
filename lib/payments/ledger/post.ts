import { reportSentryError, reportSentryMessage } from "@/lib/observability/report";
import type { PrismaLike } from "@/lib/prisma";
/**
 * #771 D1/D5 — double-entry posting helper (Batch 2 foundation).
 *
 * Every cash event posts ONE balanced LedgerTransaction: Σ(DEBIT) == Σ(CREDIT),
 * all amounts positive paise. Balances are DERIVED via `ledgerBalancePaise()` —
 * never stored. `BillingAccount.walletBalance` survives only as a cache for the
 * atomic-debit guard, asserted against balance(WALLET) by the reconcile cron.
 *
 * Accounts resolve on demand to a DETERMINISTIC id
 * (`<kind>|<orgId|_>|<membershipId|_>|<currency>`) so concurrent posts to the
 * same scope dedupe via upsert — sidestepping the Postgres nullable-unique
 * gotcha (a unique index does not dedupe NULLs).
 *
 * Idempotency: `LedgerTransaction.idempotencyKey` is `@unique`; a retry with the
 * same key is a no-op. Safe to call inside an existing `$transaction` (pass the
 * tx client). Chart of accounts + per-flow postings: see
 * `docs/enterprise/10-money-and-ledger/02-chart-of-accounts.md` + `docs/enterprise/10-money-and-ledger/03-ledger-and-postings.md`.
 */
import type {
  Currency,
  LedgerAccountKind,
  LedgerDirection,
  LedgerTransactionKind,
} from "@prisma/client";
import { sumPaise } from "@/lib/payments/utils/money";

export interface AccountRef {
  kind: LedgerAccountKind;
  /** Org-scoped accounts (WALLET, ORG_PAYABLE, ORG_RECEIVABLE). */
  organizationId?: string | null;
  /** Consultant-scoped accounts (CONSULTANT_PAYABLE). */
  consultantProfileId?: string | null;
  /**
   * #783 — the ledger is **INR-denominated**: Razorpay always settles in INR
   * (`gateway-router.ts`), `amountPaise` is INR paise, and no FX conversion
   * happens before posting. `displayCurrencyAtCheckout` is a cosmetic buyer
   * label, NOT the settlement currency. So leave this unset (→ INR) on every
   * posting — keying an account by a display currency would put INR-paise
   * amounts into a foreign-labelled account and break receivable/payable
   * clearing. Reserved for a future multi-currency ledger (see #783); the
   * `LEDGER_ACCOUNT_NON_INR` reconcile guard enforces INR-only until then.
   */
  currency?: Currency;
}

export interface Posting {
  account: AccountRef;
  direction: LedgerDirection;
  amountPaise: number;
}

export interface PostLedgerTxnInput {
  idempotencyKey: string;
  // #778 §B — typed txn kind (LedgerTransactionKind enum). Overage rides
  // existing kinds — CHARGE_ORG via INVOICE_*, CHARGE_MEMBER via its own
  // BOOKING-shaped side-charge posting (#775) — so there is no distinct OVERAGE.
  kind: LedgerTransactionKind;
  description?: string;
  paymentId?: string | null;
  invoiceId?: string | null;
  payoutId?: string | null;
  postings: Posting[];
}

export class LedgerImbalanceError extends Error {
  constructor(
    public idempotencyKey: string,
    public debitPaise: number,
    public creditPaise: number,
  ) {
    super(
      `Ledger transaction "${idempotencyKey}" unbalanced: debit=${debitPaise} credit=${creditPaise}`,
    );
    this.name = "LedgerImbalanceError";
  }
}

/** Deterministic account id for a scope. Stable across calls → upsert dedupes. */
export function ledgerAccountId(ref: AccountRef): string {
  const currency = ref.currency ?? "INR";
  return `${ref.kind}|${ref.organizationId ?? "_"}|${ref.consultantProfileId ?? "_"}|${currency}`;
}

async function resolveAccountId(
  db: PrismaLike,
  ref: AccountRef,
): Promise<string> {
  const id = ledgerAccountId(ref);
  await db.ledgerAccount.upsert({
    where: { id },
    create: {
      id,
      kind: ref.kind,
      organizationId: ref.organizationId ?? null,
      consultantProfileId: ref.consultantProfileId ?? null,
      currency: ref.currency ?? "INR",
    },
    update: {},
  });
  return id;
}

/**
 * Post a balanced double-entry transaction. Throws `LedgerImbalanceError` if
 * Σ(DEBIT) !== Σ(CREDIT). Idempotent on `idempotencyKey`.
 */
export async function postLedgerTxn(
  db: PrismaLike,
  input: PostLedgerTxnInput,
): Promise<{ transactionId: string; created: boolean }> {
  if (input.postings.length === 0) {
    const err = new Error(
      `postLedgerTxn "${input.idempotencyKey}": no postings`,
    );
    reportSentryError(err, { subsystem: "payments" });
    throw err;
  }
  let debit = 0;
  let credit = 0;
  for (const p of input.postings) {
    if (!Number.isInteger(p.amountPaise) || p.amountPaise <= 0) {
      const err = new Error(
        `postLedgerTxn "${input.idempotencyKey}": each posting must be a positive integer paise (got ${p.amountPaise})`,
      );
      reportSentryError(err, { subsystem: "payments" });
      throw err;
    }
    if (p.direction === "DEBIT") debit += p.amountPaise;
    else credit += p.amountPaise;
  }
  if (debit !== credit) {
    const err = new LedgerImbalanceError(input.idempotencyKey, debit, credit);
    reportSentryError(err, { subsystem: "payments" });
    throw err;
  }

  // Idempotency fast-path. `idempotencyKey @unique` is the hard guard: if two
  // callers race, the loser's create throws P2002 (and inside a tx aborts it —
  // the retried tx then hits this fast-path).
  const existing = await db.ledgerTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  });
  if (existing) {
    // Idempotency short-circuit — a retried/replayed caller hit an
    // already-posted key. The system working as designed.
    reportSentryMessage("Ledger posting idempotency short-circuit", {
      subsystem: "payments",
      expected: true,
      extra: { idempotencyKey: input.idempotencyKey, kind: input.kind },
    });
    return { transactionId: existing.id, created: false };
  }

  const accountIds = await Promise.all(
    input.postings.map((p) => resolveAccountId(db, p.account)),
  );

  let txn: { id: string };
  try {
    txn = await db.ledgerTransaction.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        description: input.description,
        paymentId: input.paymentId ?? null,
        invoiceId: input.invoiceId ?? null,
        payoutId: input.payoutId ?? null,
        entries: {
          create: input.postings.map((p, i) => ({
            accountId: accountIds[i],
            direction: p.direction,
            amountPaise: BigInt(p.amountPaise),
          })),
        },
      },
      select: { id: true },
    });
  } catch (err) {
    // The findUnique above is a fast path, not a guard: between it and this
    // create, a concurrent poster with the same key can commit. The unique
    // index is the real protection, and it surfaces as P2002.
    //
    // Previously this always propagated, so correctness depended on EVERY call
    // site being wrapped in a retry — a contract no reviewer can enforce.
    //
    // What we can do depends on whether `db` is the base client or a
    // transaction client, and the caller knows but we do not:
    //
    //   - Base client: the failed INSERT is isolated, so re-reading gives us
    //     the winner's id and this call becomes a correct no-op.
    //   - Inside a transaction: Postgres has already aborted it (Prisma takes
    //     no savepoint), so the re-read below throws 25P02 too and the original
    //     P2002 propagates.
    //
    // Be honest about what that second case buys: today EVERY caller passes a
    // `tx`, and `withSerializableRetry` retries only P2034 — so nothing retries
    // a P2002 and this rescue is unreachable in the current call graph. It is
    // here so that the guarantee lives with the function rather than depending
    // on each future call site being wrapped correctly, and so a base-client
    // caller (there is no reason there won't be one) gets the right behaviour
    // for free. It is not a claim that today's callers recover.
    //
    // Trying the read and falling back covers both without having to ask.
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "P2002"
    ) {
      try {
        const winner = await db.ledgerTransaction.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: { id: true },
        });
        if (winner) {
          // Lost-race rescue succeeded — a concurrent poster with the same
          // key committed first. Modelled outcome, not a fault.
          reportSentryMessage("Ledger posting P2002 race rescued", {
            subsystem: "payments",
            expected: true,
            extra: { idempotencyKey: input.idempotencyKey, kind: input.kind },
          });
          return { transactionId: winner.id, created: false };
        }
      } catch (rescueErr) {
        // Aborted transaction — fall through and rethrow the original P2002.
        // This inner failure is itself expected inside a tx (Postgres already
        // aborted it, so ANY further read throws 25P02) — captured for
        // pattern visibility only, not as a new fault.
        reportSentryError(rescueErr, {
          subsystem: "payments",
          expected: true,
          extra: { idempotencyKey: input.idempotencyKey },
        });
      }
    }
    // Genuine, unrecovered ledger-write failure — every caller must see this;
    // captured here so callers that don't wrap postLedgerTxn in their own
    // try/catch (some do, redundantly capturing the same error again) still
    // get visibility.
    reportSentryError(err, {
      subsystem: "payments",
      extra: { idempotencyKey: input.idempotencyKey, kind: input.kind },
    });
    throw err;
  }

  // #776 — fold this txn's postings into the maintained per-account balance
  // snapshot. Runs inside the caller's tx, so it's atomic with the journal
  // write; the idempotency fast-path above returns before any mutation, so a
  // retried key never double-applies. Multiple postings can hit the same
  // account, so aggregate the signed delta + entry count per account first.
  const deltas = new Map<string, { delta: bigint; count: bigint }>();
  input.postings.forEach((p, i) => {
    const id = accountIds[i];
    const signed = p.direction === "DEBIT" ? p.amountPaise : -p.amountPaise;
    const cur = deltas.get(id) ?? { delta: BigInt(0), count: BigInt(0) };
    cur.delta += BigInt(signed);
    cur.count += BigInt(1);
    deltas.set(id, cur);
  });
  // Sort account ids so every txn acquires LedgerAccountBalance row locks in
  // the same order — concurrent posts touching shared accounts (CASH,
  // PLATFORM_FEE) in different posting orders would otherwise deadlock.
  for (const accountId of Array.from(deltas.keys()).sort()) {
    const { delta, count } = deltas.get(accountId)!;
    await db.ledgerAccountBalance.upsert({
      where: { accountId },
      create: { accountId, balancePaise: delta, entrySeq: count },
      update: {
        balancePaise: { increment: delta },
        entrySeq: { increment: count },
      },
    });
  }

  return { transactionId: txn.id, created: true };
}

/**
 * Signed balance (Σ DEBIT − Σ CREDIT) of an account, in paise. For liability
 * accounts (WALLET, *_PAYABLE) the amount owed is the negative of this (credit
 * normal); callers interpret per kind.
 *
 * #776 — reads the O(1) maintained snapshot (`LedgerAccountBalance`). Falls
 * back to the O(n) journal scan only when the snapshot row is missing (an
 * account that exists but has never been posted to via postLedgerTxn, or
 * pre-snapshot data) — that path also returns 0 for a never-posted account.
 */
export async function ledgerBalancePaise(
  db: PrismaLike,
  ref: AccountRef,
): Promise<number> {
  const id = ledgerAccountId(ref);
  const snapshot = await db.ledgerAccountBalance.findUnique({
    where: { accountId: id },
    select: { balancePaise: true },
  });
  if (snapshot) return Number(snapshot.balancePaise);

  // Defensive fallback: derive from the journal. Reachable only if a posting
  // bypassed postLedgerTxn (it shouldn't) or for an account with zero entries.
  return ledgerBalanceFromJournalPaise(db, id);
}

/**
 * Authoritative balance straight from the append-only journal — the snapshot's
 * ground truth. Used by the reconcile cron's LEDGER_BALANCE_SNAPSHOT_DRIFT
 * check and as the fallback in `ledgerBalancePaise`.
 */
export async function ledgerBalanceFromJournalPaise(
  db: PrismaLike,
  accountId: string,
): Promise<number> {
  const rows = await db.ledgerEntry.groupBy({
    by: ["direction"],
    where: { accountId },
    _sum: { amountPaise: true },
  });
  // #780 — groupBy _sum bypasses the result extension; still bigint at runtime.
  let debit = 0;
  let credit = 0;
  for (const r of rows) {
    if (r.direction === "DEBIT") debit = sumPaise(r._sum.amountPaise);
    else credit = sumPaise(r._sum.amountPaise);
  }
  return debit - credit;
}
