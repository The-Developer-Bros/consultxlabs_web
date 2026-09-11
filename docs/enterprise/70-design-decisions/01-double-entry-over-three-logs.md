---
title: Double-entry journal over three single-entry logs
band: 70-design-decisions
audience: sde4
status: live
last-reviewed: 2026-06-05
---

# ADR 01 — Double-entry journal over three single-entry logs

## Context

Before the #772 cutover the schema carried three separate money logs, each
a single-entry, signed-delta table that answered exactly one question.
`FundingLedgerEntry` recorded wallet allocations (top-up, booking debit,
refund, grant) and carried a running `balanceAfterPaise`. `WalletEntry`
recorded per-row wallet history together with the gateway idempotency
keys. `SettlementLedgerEntry`, tagged by a `SettlementKind` enum, recorded
external settlements such as an invoice being issued or paid, a payout
being sent, or a refund. Each of those tables was internally coherent on
its own terms — its rows summed, its running balance advanced — and that
was precisely the problem. Nothing in the schema forced the three to agree
with each other. Reconciliation meant joining all three across JSON
columns and date heuristics and *hoping* the answer they produced for "how
much money is where" was the same. There was no structural guarantee, only
the accident of three writers having stayed in step. For a B2B platform
that owes real money to host organizations, consultants, and the tax
authority simultaneously, "the three logs probably agree" is not an
acceptable invariant for the books.

## Decision

We replaced the three logs with a single double-entry journal:
`LedgerTransaction` (one balanced cash event, with a `@unique`
`idempotencyKey` and a typed `LedgerTransactionKind`), `LedgerEntry` (one
leg of a transaction, a `direction` plus a positive `amountPaise`), and
`LedgerAccount` (the bucket money sits in, scoped to platform, org, or
consultant). The posting helper `postLedgerTxn` in
`lib/payments/ledger/post.ts` is the only sanctioned money writer. It
computes `Σ(DEBIT)` and `Σ(CREDIT)` over the postings and refuses to write
a single row unless they are equal, throwing `LedgerImbalanceError`
otherwise (`lib/payments/ledger/post.ts`, the balance check before any
`create`). Sign is carried by `direction`, never by a negative amount —
every `LedgerEntry.amountPaise` is a positive `BigInt`. Balances are
derived by summing the journal (`ledgerBalancePaise`), so "what do we owe
this org / this consultant / the government?" is a `SUM`, not a stored
authoritative column. The single commit `2911f450` re-pointed every money
writer — booking, top-up, invoice-paid, both payout paths, refunds — at
the journal in one move and deleted `FundingLedgerEntry`, `WalletEntry`,
`SettlementLedgerEntry`, and `SettlementKind`, building on the foundation
that landed one commit earlier in `71923ae4`.

The payoff is that "the books are wrong" collapses from a three-way
cross-join into a single per-transaction predicate. Because every
transaction balances and every balance is a sum of the same rows, one
invariant — `Σdebit == Σcredit` — guarantees the books tie out, and the
nightly reconciler re-proves it as the `LEDGER_TXN_IMBALANCE` check rather
than comparing three logs and guessing. The reconciliation question
changed shape, not just table count: from "do these three independent logs
happen to agree?" to "re-sum one journal."

## Alternatives considered

We considered keeping the three logs but adding a reconciliation job that
cross-checked them. This is what we already effectively had, and it lost
on the structural point: a cross-check between three independently-signed
logs can only ever report a *discrepancy after the fact*; it cannot make
agreement a property the schema enforces at write time. Three logs that
each balance internally can still disagree with each other, and no amount
of nightly comparison changes that the disagreement was always possible.

We considered a single single-entry log with a signed delta and a running
balance — essentially `FundingLedgerEntry` promoted to be the one source
of truth. It lost because a signed-delta log cannot express a transaction
that touches three or more accounts atomically (a payout that debits a
payable, credits cash, and credits TDS-payable in one event) without
inventing an ad-hoc grouping key, and even then nothing forces the legs of
one logical event to sum to zero. Double-entry's balance invariant is
exactly that grouping-and-zeroing made structural.

We considered storing an authoritative `balance` column per account and
mutating it on each event. It lost because a stored balance and an event
log can drift, and then you are back to reconciling two sources that the
schema does not force to agree — the very failure mode we were
eliminating. We derive balances instead, with one deliberate exception
(see Consequences).

## Consequences

The real cost we pay is write amplification and a maintained snapshot.
Every cash event now writes a `LedgerTransaction`, two or more
`LedgerEntry` rows, and folds the signed deltas into a
`LedgerAccountBalance` snapshot (the O(1) cache added in #776 so
dashboards and credit-limit checks don't re-scan the journal).
`postLedgerTxn` sorts account ids before locking the snapshot rows so
concurrent posts touching shared accounts like `CASH` or `PLATFORM_FEE`
acquire locks in a consistent order and don't deadlock — a subtlety that
did not exist when each log was a simple append. We also accept one
principled exception to "balances are derived":
`BillingAccount.walletBalance` survives as a cache so the booking
overdraft guard can be a single conditional `UPDATE … WHERE walletBalance
>= amount`; the reconciler asserts it against `balance(WALLET)` via
`WALLET_BALANCE_DRIFT`.

A second real cost is documentation and mental debt across the codebase:
references to the removed models linger in stale docblocks. The
`org-payout-service.ts` header, for instance, still describes writing a
`SettlementLedgerEntry`, even though `markOrgPayoutCompleted` actually
posts through `postLedgerTxn` — a comment that should be corrected but was
missed in the cutover.

The empirical gate that justified deleting the old logs was the reconciler
returning `ok: true` with zero findings across a full database reseed on
the journal (`db7d4649`). Revisit this decision only if that gate stops
being cheap to re-prove — for example, if a future multi-currency ledger
makes a single `Σdebit == Σcredit` insufficient (today the
`LEDGER_ACCOUNT_NON_INR` guard keeps the journal INR-only precisely so the
invariant stays this simple). Until then, any change that reintroduces a
parallel money log should be treated as reversing this ADR and must say so
explicitly.
