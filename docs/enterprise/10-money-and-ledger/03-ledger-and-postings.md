---
title: Ledger & postings
band: 10-money-and-ledger
audience: sde3
status: live
last-reviewed: 2026-06-05
---

# Ledger & postings

**What this covers:** the double-entry journal in detail — the `postLedgerTxn()` API, the balance invariant, idempotency, immutability, and the **exact legs every money flow posts**, transcribed from code. This is the reference the rest of the money band cites.

> Replaces the old "three-ledger discipline" doc. The three single-entry logs it described (`FundingLedgerEntry` / `WalletEntry` / `SettlementLedgerEntry`) were collapsed into this one journal by **#772** — see [money model overview](01-money-model-overview.md) for the why.

---

## 1. The three tables

```mermaid
erDiagram
  LedgerAccount   ||--o{ LedgerEntry       : "has many"
  LedgerTransaction ||--o{ LedgerEntry     : "has 2+"

  LedgerAccount {
    string id PK "kind|org|consultant|currency"
    LedgerAccountKind kind
    string organizationId FK "nullable"
    string consultantProfileId FK "nullable"
    Currency currency
  }
  LedgerTransaction {
    string id PK
    string idempotencyKey UK "e.g. booking:<paymentId>"
    LedgerTransactionKind kind "BOOKING | TOPUP | OVERAGE_MEMBER | ..."
    string paymentId FK "nullable soft-link"
    string invoiceId FK "nullable soft-link"
    string payoutId FK "nullable soft-link"
    datetime postedAt
  }
  LedgerEntry {
    string id PK
    string transactionId FK
    string accountId FK
    LedgerDirection direction "DEBIT | CREDIT"
    bigint amountPaise "always positive"
    datetime createdAt
  }
```

- `LedgerAccount` — a bucket; id is its [deterministic scope string](02-chart-of-accounts.md).
- `LedgerTransaction` — one balanced cash event. `idempotencyKey @unique` is the dedupe anchor; `kind` is a **typed `LedgerTransactionKind` enum** (#778 §B made it an enum — a free-string typo like `"BOOKNG"` used to silently break reconcile's `groupBy`; now it's a compile error); `paymentId`/`invoiceId`/`payoutId` are optional indexed soft-links for tracing.
- `LedgerEntry` — one leg. `amountPaise` is a **positive** `BigInt`; the sign lives in `direction`.

---

## 2. `postLedgerTxn()` — the only way money is recorded

```ts
postLedgerTxn(db, {
  idempotencyKey: "booking:pay_123",
  kind: "BOOKING",
  paymentId: "pay_123",
  postings: [ /* { account, direction, amountPaise }, ... */ ],
}): Promise<{ transactionId: string; created: boolean }>
```

What it guarantees (`lib/payments/ledger/post.ts`):

1. **Positive integers only.** Each posting's `amountPaise` must be a positive integer — non-integer or `<= 0` throws.
2. **Balance or bust.** It sums DEBIT and CREDIT legs; if `Σdebit !== Σcredit` it throws `LedgerImbalanceError` and writes nothing.
3. **Idempotent on `idempotencyKey`.** A fast-path `findUnique` returns `{ created: false }` for a repeat key. The `@unique` constraint is the hard guard underneath: if two callers race, the loser's insert hits `P2002`, aborts its transaction, and the retry lands on the fast-path. **Redeliveries and retries are safe.**
4. **Composable in a `$transaction`.** Pass the tx client (`tx`) and the posting joins the caller's atomic unit — so the money leg and the business write (claim a top-up, mark a payout paid) commit together or not at all.
5. **Accounts resolve on demand.** Each posting's `AccountRef` is upserted to its deterministic id, so callers never pre-create accounts.

`ledgerBalancePaise(db, ref)` is the read side: it groups the account's entries by direction and returns `Number(Σdebit − Σcredit)` — the **signed** balance. Interpret the sign per the account's normal side ([chart of accounts](02-chart-of-accounts.md)).

```mermaid
flowchart TD
  A["cash event<br/>(top-up, booking, payout, refund…)"] --> B["build postings[]<br/>{account, direction, amountPaise}"]
  B --> C{"all amounts<br/>positive integers?"}
  C -- no --> X1["throw — nothing written"]
  C -- yes --> D{"Σdebit == Σcredit?"}
  D -- no --> X2["LedgerImbalanceError"]
  D -- yes --> E{"idempotencyKey<br/>already exists?"}
  E -- yes --> F["return {created:false}<br/>(no-op)"]
  E -- no --> G["upsert accounts →<br/>create LedgerTransaction + entries"]
  G --> H["return {created:true}"]
```

---

## 3. The posting vocabulary (`kind`)

`kind` is a value of the `LedgerTransactionKind` enum, paired with a structured `idempotencyKey`. The enum (verbatim) is `BOOKING · TOPUP · TOPUP_REFUND · INVOICE_ISSUED · INVOICE_PAID · PAYOUT · ORG_PAYOUT · REFUND · OVERAGE_MEMBER · GRANT`:

| `kind` | `idempotencyKey` | Posted by |
| --- | --- | --- |
| `TOPUP` | `topup:<providerOrderId>` | `walletCredit()` — `lib/api/organizations/wallet.ts` |
| `BOOKING` | `booking:<paymentId>` | `createEarningsFromPayment()` — `lib/payments/payouts/earnings-service.ts` |
| `INVOICE_PAID` | `invoicepaid:<invoiceId>` | invoice-paid webhook — `app/api/webhooks/utils.ts` |
| `TOPUP_REFUND` | `topup-refund:<providerPaymentId>` | refund webhook — `app/api/webhooks/utils.ts` |
| `REFUND` | `refund:<refundId>` | refund cascade — `lib/payments/operations/refund.ts` |
| `PAYOUT` | `payout:<payoutId>` | consultant payout — `lib/payments/payouts/payout-service.ts` |
| `ORG_PAYOUT` | `orgpayout:<payoutId>` | host-org payout — `lib/payments/payouts/org-payout-service.ts` |
| `OVERAGE_MEMBER` | `overage:<sideChargePaymentId>` | CHARGE_MEMBER overage settle — `lib/payments/webhooks/overage-handlers.ts` (see [§4.8](#48-member-overage--overage_member)) |

**`INVOICE_ISSUED` and `GRANT` are declared but post no journal leg today.** Invoice *issuance* posts nothing — the receivable was already accrued in the booking transaction (`ORG_RECEIVABLE` debit from the `INVOICE_ACCRUAL` leg), so issuance just rolls accrued bookings into an `OrganizationInvoice` and writes an `OrgAuditLog` row; **payment** is what clears the receivable.

**There is no `OVERAGE` kind.** Overage money rides existing kinds (#778 §B): a **CHARGE_ORG** overage is billed through the normal invoice path (its marginal is an `OVERAGE_INVOICE_ACCRUAL` leg → `ORG_RECEIVABLE`, cleared by `INVOICE_PAID`), and a **CHARGE_MEMBER** overage settles as its own `BOOKING`-shaped side-charge — `OVERAGE_MEMBER` is the kind reserved for that member side-payment. See [booking → earnings](05-booking-to-earnings.md) for the overage flow.

---

## 4. The postings, flow by flow

All amounts are paise; every block balances (`Σdebit == Σcredit`).

### 4.1 Top-up — `TOPUP` (`topup:<orderId>`)
Org pays cash; we now owe it wallet spending power.
```
Dr CASH(platform)        amount
   Cr WALLET(org)        amount
```

### 4.2 Booking — `BOOKING` (`booking:<paymentId>`)
The funding legs of the checkout become debits; the fee/payable/tax split becomes credits. The debit side is assembled from the payment's `PaymentLeg` rows ([payment legs](09-payment-legs.md)):

```
Dr CASH(platform)            sum of CARD legs
Dr WALLET(org)               sum of WALLET legs
Dr ORG_RECEIVABLE(org)       sum of INVOICE_ACCRUAL + OVERAGE_INVOICE_ACCRUAL legs
Dr PLATFORM_PROMO            sum of REFERRAL_CREDIT legs
Dr DISCOUNT                  max(0, originalAmount + taxAmount − Σ(funding-leg debits))
   Cr PLATFORM_FEE           platform fee
   Cr CONSULTANT_PAYABLE(consultant)   total consultant pool
   Cr ORG_PAYABLE(org)       org share (only if > 0)
   Cr GST_PAYABLE            tax amount
```
`LICENSE` legs carry `amountPaise = 0` (no money moves — the seat is pre-paid), so they contribute nothing. The `DISCOUNT` plug is the platform-absorbed gap basing on **Σ(funding-leg debits)**, not `Payment.amount`: a `REFERRAL_CREDIT` leg funds the booking (debited as `PLATFORM_PROMO`) yet is excluded from `amount` (which is post-credit), so basing DISCOUNT on `amount` would double-count the credit and imbalance the posting (#776; see §5b). **Only single-consultant bookings post this transaction inline**; multi-collaborator bookings defer the journal (tracked coverage gap **#773**) — see [booking → earnings](05-booking-to-earnings.md).

> **Example — a Wipro INVOICE booking.** When a Wipro-sponsored learner books past their LICENSED_SEAT coverage, the `ORG_RECEIVABLE(wipro)` debit equals the `INVOICE_ACCRUAL` leg (no cash moves at booking — Wipro pays at month-end). Because two concurrent disjoint-slot Wipro bookings take *different* per-slot locks, the contract's credit-limit ceiling has to be re-checked **inside** the Serializable booking tx, not just before it — otherwise both could straddle the limit. That in-tx re-check (`ab241b0a`, #785 B6) is what makes SSI abort the loser of a racing pair so the retry sees the sibling's committed accrual. See [concurrency & idempotency](../30-programs-and-lifecycle/01-concurrency-and-idempotency.md) for the in-tx-revalidation pattern, and §5b.

### 4.3 Invoice paid — `INVOICE_PAID` (`invoicepaid:<invoiceId>`)
The org settles its NET-NN invoice; the receivable accrued at booking clears.
```
Dr CASH(platform)            invoice total
   Cr ORG_RECEIVABLE(org)    invoice total
```

### 4.4 Consultant payout — `PAYOUT` (`payout:<payoutId>`)
We pay what we owed the consultant; TDS is withheld for the government.
```
Dr CONSULTANT_PAYABLE(consultant)   net + TDS
   Cr CASH(platform)                net paid
   Cr TDS_PAYABLE                   TDS withheld (only if > 0)
```

### 4.5 Host-org payout — `ORG_PAYOUT` (`orgpayout:<payoutId>`)
The host-org mirror of 4.4.
```
Dr ORG_PAYABLE(org)          netPayoutPaise   (pre-withholding org share)
   Cr CASH(platform)         amountPaise      (what the rail transferred)
   Cr TDS_PAYABLE            tdsAmountPaise   (withheld, only if > 0)
```

`OrganizationPayout.netPayoutPaise` is the pre-withholding figure and `amountPaise` is the post-withholding one, so `amountPaise + tdsAmountPaise` must equal `netPayoutPaise` for these legs to be right. `markOrgPayoutCompleted` asserts exactly that before posting and throws — rolling the completion back rather than journalling a guess — when it does not hold (#1470). The same assertion also refuses a payout whose figures are negative, because the equation alone accepts one (minus one lakh plus nothing does equal minus one lakh) and the posting is skipped for anything that is not greater than zero, which would let such a row settle with no journal at all. `markOrgPayoutReversed` posts the exact mirror, `Dr CASH amountPaise` and `Dr TDS_PAYABLE tdsAmountPaise` against `Cr ORG_PAYABLE netPayoutPaise`, under the same assertion. See the [payout pipeline](07-payout-pipeline.md) for the history: the earlier shape debited the payable at `net + TDS` and credited cash at `net`, which balanced and so passed every write-time check while overstating both sides by the withholding.

### 4.6 Top-up refund — `TOPUP_REFUND` (`topup-refund:<providerPaymentId>`)
A confirmed top-up is refunded; the IOU shrinks, cash returns to the gateway. Exact reverse of 4.1.
```
Dr WALLET(org)               refund amount (clamped to original top-up)
   Cr CASH(platform)         refund amount
```

### 4.7 Booking refund — `REFUND` (`refund:<refundId>`)
A booking is refunded (fully or partially). The original booking legs are reversed **proportionally**: the fee/payable/GST credits become debits, and the funding legs become credits. `PLATFORM_FEE` carries the balancing *plug* so the set ties out.
```
Dr PLATFORM_FEE              platform plug (funding − consultant − org − GST share)
Dr CONSULTANT_PAYABLE(owner) refunded consultant share
Dr ORG_PAYABLE(org)          refunded org share
Dr GST_PAYABLE               refunded GST share
   Cr CASH / WALLET / ORG_RECEIVABLE / PLATFORM_PROMO   the original funding legs, prorated
```
Posted only when the debit side balances to the refunded funding total (a guard in `refund.ts`); a partial/edge case that wouldn't balance is skipped and logged rather than written half-formed. The whole reversal block is wrapped so a ledger imbalance can never block the customer refund (gateway money may already have moved) — the failure is logged + paged and the reconciler's `EARNINGS_LEDGER_DRIFT` / `LEDGER_TXN_IMBALANCE` catch any divergence.

### 4.8 Member overage — `OVERAGE_MEMBER` (`overage:<sideChargePaymentId>`)
A `CHARGE_MEMBER` program booked past its cap creates a parent-linked side-`Payment` at checkout; when the member settles it via the resume-checkout surface, the gateway webhook posts the **org-relief** transaction (`lib/payments/webhooks/overage-handlers.ts`). The booking already charged the org the full price and paid the consultant once, so the member's marginal *relieves* the org:
```
Dr CASH(platform)        side-charge amount   (the member's card)
   Cr ORG_PAYABLE(org)   side-charge amount   (a credit the org realises in settlement)
```
The side-`Payment` carries a single `CARD` leg (`sourceRef` = gateway order id), and the same webhook flips the `OverageEvent` `PENDING → CHARGED`. There is **no separate overage debit on the parent** — checkout already carved the over-cap pass-through (`basePaise`) out of the parent's funding leg so the member isn't double-charged (#785); see [booking → earnings](05-booking-to-earnings.md). (How a buyer org nets this `ORG_PAYABLE` credit against its wallet/invoice is a tracked refinement, #775; the journal stays balanced regardless.)

---

## 5. Invariants

1. **Balanced.** Enforced at write (`postLedgerTxn`) and re-proved nightly (`LEDGER_TXN_IMBALANCE`).
2. **Immutable.** `LedgerEntry.transactionId` is `onDelete: Restrict` — postings are never deleted or updated. A wrong posting is corrected by a **counter-transaction**, not an edit (that's what `REFUND`/`TOPUP_REFUND` are).
3. **Positive amounts only.** Sign is `direction`, never a negative `amountPaise`.
4. **One event, one key.** Every flow's `idempotencyKey` is derived from a stable upstream id, so at-least-once webhooks and cron retries collapse to one posting. See [concurrency & idempotency](../30-programs-and-lifecycle/01-concurrency-and-idempotency.md).
5. **INR-denominated (#783).** Razorpay settles in INR, `amountPaise` is INR paise, and no FX conversion happens before posting — `displayCurrencyAtCheckout` is a cosmetic buyer label, not the settlement currency. So every posting leaves `AccountRef.currency` unset (→ `INR`); keying an account by a display currency would file INR-paise amounts into a foreign-labelled account and break receivable/payable clearing. The reconciler's `LEDGER_ACCOUNT_NON_INR` check enforces this until a real multi-currency ledger is designed.

## 5a. Design decisions & trade-offs

- **Positive amounts + a `direction` enum, never a signed amount.** A signed `amountPaise` would let a single column carry both "add" and "subtract", but it also lets a typo (a stray `-`) silently invert a posting that still *looks* balanced. Splitting sign into `direction` makes the balance check a pure `Σdebit == Σcredit` over magnitudes and makes a malformed amount (`<= 0`) a hard throw. The cost is callers must pick `DEBIT`/`CREDIT` explicitly; the benefit is no posting can be sign-wrong yet pass.
- **Immutable journal + counter-transactions, never edits.** `LedgerEntry.transactionId` is `onDelete: Restrict`; a wrong posting is corrected by posting its reverse (`REFUND`/`TOPUP_REFUND`), not by `UPDATE`. This keeps the journal append-only and auditable (every correction is itself a dated, balanced event) at the cost of more rows. An editable ledger would be smaller and unauditable — the wrong trade for money.
- **Typed `kind` enum over a free string (#778 §B).** `kind` was a free string; a typo like `"BOOKNG"` silently broke reconcile's `groupBy` (the mistyped transaction just vanished from the aggregation). Making `LedgerTransactionKind` an enum turns that into a compile error. Cost: adding a flow is now a schema change; benefit: no silent reconciliation hole.
- **Maintained O(1) balance snapshot over scan-on-read (#776).** `ledgerBalancePaise()` reads a 1:1 `LedgerAccountBalance` snapshot folded inside the same transaction as the journal write, instead of summing every entry on each read. The append-only journal stays the source of truth; the snapshot is a cache the reconciler validates (`LEDGER_BALANCE_SNAPSHOT_DRIFT`). Cost: one more write per posting + one more invariant; benefit: balance reads don't degrade as the journal grows.

## 5b. What this design survived

- **The silently-dropped DISCOUNT plug on referral-funded bookings (`d335901e`, #776 / #785 review).** The booking `DISCOUNT` leg is the platform-absorbed gap between gross (`originalAmount + taxAmount`) and the funding actually applied. It was computed as `originalAmount + tax − Payment.amount` — but a `REFERRAL_CREDIT` leg funds the booking (debited as `PLATFORM_PROMO`) and is *already excluded* from `Payment.amount` (which is the post-credit figure). So the credit was counted **twice** (once as `PLATFORM_PROMO`, once inside `DISCOUNT`), the posting failed `Σdebit == Σcredit`, and `postLedgerTxn` threw — which meant the *entire booking transaction was silently dropped* for any referral-funded booking. The fix bases the plug on `Σ(funding-leg debits)` (`fundingDebitTotal`) instead of `Payment.amount`, so the credit is counted once. This is why §4.2 is emphatic that the `DISCOUNT` plug bases on the funding-leg sum.
- **The refund reversal that must never block a customer refund (refund.ts, §4.7).** Gateway money may already have moved by the time the ledger reversal runs, so the whole reversal block is wrapped: a `LedgerImbalanceError` on an edge-case partial is logged + paged, the customer refund still completes, and the reconciler's `EARNINGS_LEDGER_DRIFT` / `LEDGER_TXN_IMBALANCE` catch any divergence. The design explicitly trades "perfectly-balanced books at this instant" for "never trap a customer's money behind a bookkeeping bug" — the reconciler is the backstop that makes that safe.

## 6. What NOT to do

- **Don't read a balance from a column.** Sum the journal via `ledgerBalancePaise()` (the one cache, `walletBalance`, is the documented exception in [money model overview](01-money-model-overview.md) §4).
- **Don't post an unbalanced set** "to fix later" — there is no later; it throws.
- **Don't delete or update a `LedgerEntry`.** Post a counter-transaction.
- **Don't invent a `kind`** outside the `LedgerTransactionKind` enum — adding a value is a schema change, paired with a structured `idempotencyKey` in the vocabulary table above (the enum makes a stray string a compile error, not a silent reconcile break).
- **Don't post in a non-INR currency** — leave `AccountRef.currency` unset (§5.5).

---

## Balance reads — maintained snapshot (#776)

`ledgerBalancePaise()` reads an O(1) maintained running balance
(`LedgerAccountBalance`, keyed 1:1 by the deterministic account id) rather than
scanning every entry. `postLedgerTxn` folds each posting's signed delta
(`+DEBIT` / `−CREDIT`) into the snapshot **inside the same transaction** as the
journal write; the idempotency fast-path returns before any mutation, so a
retried key never double-applies. The append-only `LedgerEntry` journal stays
the source of truth — the snapshot is a derived cache the reconcile cron
validates (`LEDGER_BALANCE_SNAPSHOT_DRIFT`, [ledger-integrity](13-ledger-integrity.md)).
`ledgerBalanceFromJournalPaise()` is the authoritative fallback (and the
reconcile check's ground truth). No backfill — a fresh seed posts through
`postLedgerTxn`, so snapshots populate as money moves.

### Related docs
- [Money model overview](01-money-model-overview.md) · [Chart of accounts](02-chart-of-accounts.md) — the principles and buckets this doc applies.
- [Wallet & top-ups](04-wallet-and-topups.md) · [Booking → earnings](05-booking-to-earnings.md) · [Payout pipeline](07-payout-pipeline.md) · [Invoicing](08-invoicing.md) — each flow in narrative.
- [Payment legs](09-payment-legs.md) — how the booking debit side is assembled.
- [Ledger integrity](13-ledger-integrity.md) — the reconciler.
- Ground truth: `lib/payments/ledger/post.ts`; posting call sites in `earnings-service.ts`, `wallet.ts`, `org-payout-service.ts`, `payout-service.ts`, `refund.ts`, `app/api/webhooks/utils.ts`.
