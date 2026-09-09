# Finance doctrine

This page states the non-negotiable invariants of the money subsystem. Anyone changing checkout, a webhook handler, a refund, a payout, or a reconciliation sweep should read it before writing code, because every rule here exists to prevent a specific way of losing or double-counting money that has already happened once in this codebase.

## One transaction holds the truth

Money truth is written in exactly one Serializable database transaction per event, and nothing downstream of that transaction is allowed to disagree with it. Checkout writes the Payment, its funding legs, and the appointment hold together under a Redis slot lock, so either all three exist or none does. A captured payment is confirmed by exactly one writer, `handlePaymentSuccess`, which posts the appointment, the earnings, and the ledger entries in the same transaction (ADR 21). Everything that happens after that commit, such as the tax invoice, the chat channel, or the confirmation email, is best effort and is re-driven by the sweeps described in `docs/payments/06-high-level-design.md` rather than by the checkout request itself.

## CAS-in-WHERE is how every state move is guarded

Every status transition on a Payment, an Appointment, a Refund, or a Payout moves through a conditional update whose `WHERE` clause repeats the money predicate, not through a plain write after a separate read. ADR 21 documents the failure this prevents directly: a payment-confirmation caller that reads `SUCCEEDED` and returns early, when a second writer set that status without running the confirmation pipeline, silently discards the appointment, the earnings, and the ledger entry for money that was actually charged. The same discipline applies to the terminal-capture race, where a payment can be captured by the gateway after the booking has already been cancelled; the auto-refund guards exist because a CAS-in-WHERE check alone cannot undo a capture, only prevent a second writer from pretending it already handled one.

## Payment confirmation has exactly one writer

`Payment.paymentStatus` is written by the confirmation pipeline and by nothing else. The webhook, the client's return from the checkout modal, the on-demand status sync, and the reconcile cron all funnel through `routeCapturedPayment`, which picks the correct handler and repeats the parity check every time, because three copies of that branch is three chances for the refund-status mapping to drift, which it did before this decision (ADR 21). A caller that is not the webhook must fetch gateway truth first, because a client-side signature proves the id pair is genuine but says nothing about the captured amount or the notes; and it must verify capture explicitly, because a signature proves authenticity, not that the money has actually moved.

## The leg-sum identity, and the carve it needed

`sum(non-reversal, non-REFERRAL_CREDIT PaymentLeg.amountPaise) == Payment.amount` is enforced by the `payment_legs_sum_to_amount` constraint trigger at commit, and by the same check in the checkout code before the transaction is opened. `Payment.amount` has always meant the amount charged to the gateway after discounts, tax, and referral credits, so a `REFERRAL_CREDIT` leg records value that was already subtracted out of `amount`; including it in the sum would demand the same credit twice. That is why the identity excludes `REFERRAL_CREDIT` legs specifically, not all legs uniformly, and why a payment funded entirely by zero-value `LICENSE` legs is exempt from the comparison altogether while still being held to the reversal-pair rules. This distinction cost a live outage: the trigger read the sum literally over every non-reversal leg for months, and every credit-funded checkout since raised `check_violation` and rolled back at `COMMIT` (#1347, fixed by PR #1385).

## Double-entry journal; caches are reconciled, not authoritative

Every money movement is a `LedgerTransaction` with two or more balanced `LedgerEntry` rows, keyed by an `idempotencyKey` such as `booking:<paymentId>` or `orgpayout:<payoutId>`, so a retry of the same event can never double-post. `walletBalance` on a `BillingAccount` is a cache of the wallet's ledger entries, not a second source of truth; it is decremented and credited atomically alongside the leg that records the movement, and the reconciler treats any drift between the cache and the journal as a finding to fix, never as evidence that the cache is right. The same posture applies to the ledger's own O(1) balance snapshot: the append-only journal is authoritative, and the snapshot is a read optimisation the reconciler validates.

## Refunds are two-phase, with one front door and a cumulative cap

Every rail that can return money to a buyer, whether a cancellation, a dispute, a removed event seat, or an admin action, produces a `Refund` row first. The row reserves the amount before the gateway is called, the gateway call carries the Refund's own id as its idempotency key, and the ledger reversal, the earnings clawback, and the credit note are written only when the gateway confirms. A `ConsumerCreditNote` reverses an invoice by a cumulative cap, not a per-refund cap: `mintConsumerCreditNote` sums every note already issued against the same invoice inside the same transaction and credits at most the remainder, because a partial refund and a later lost chargeback are two independent idempotency keys against one invoice and neither one's probe should be allowed to let the pair reverse more than the platform ever charged.

## GST: the platform bills as principal supplier (ADR 26)

Checkout has always charged 18% GST on the full discounted price and credited `GST_PAYABLE` for that full amount, which is the behaviour of a supplier of record, not a facilitator. ADR 26 makes that reading explicit and locks it in: the platform issues its own numbered B2C tax invoice and credit note for every consumer supply, place of supply for a consumer defaults to the platform's own state under Section 12(2)(b) of the IGST Act when no buyer address is on record, and GST-TCS under Section 52 does not apply and is not collected under this model. Income tax stays wired the other way: the platform withholds Section 194-O as an e-commerce operator paying an e-commerce participant, a facilitator posture, so the pairing of principal-for-GST with operator-for-income-tax is deliberate and unusual, and is the first open question on the chartered-accountant list in ADR 26.

## INR-only settlement

Every rail — checkout, wallet top-up, organisation invoice, payout — settles in INR. `BillingAccount.currency` and every ledger account it touches are asserted INR at the boundaries that matter, most recently the Razorpay order-creation call itself (#1414), because a non-INR amount reaching a gateway that quotes in INR either fails loudly or, worse, succeeds at the wrong exchange rate with no reconciliation path to catch it.

## PG_POOL_MAX=1: no global-client read inside a transaction

The database pool is capped at a single connection in this deployment, so any code that opens a `$transaction` and then, inside it, issues a query through the global Prisma client rather than the transaction's own client deadlocks: the transaction holds the one connection, and the global-client read queues for a connection that will never free up until the transaction that is waiting on it times out. This was live in production checkout for a stretch (#1436, fixed by PR #1435) precisely because the bug only reproduces under the pool's real concurrency, which a local `next dev` session with its own pool does not exhibit. Every money-path change that adds a read inside a transaction must pass the transaction's own client down to it, not reach for `prisma` directly.

## Best-effort `after()` is not truth; the sweeps are

Work scheduled inside Next.js's `after()` callback, such as sending a confirmation email or provisioning a chat channel, can fail silently if the function instance is recycled mid-flight. ADR 27 formalises the fallback: the domain rows are the outbox, a nullable stamp such as `Appointment.chatChannelEnsuredAt` records whether the follow-up landed, and an idempotent sweep re-drives anything still unstamped. The Netlify scheduled ticker in `netlify/functions/cron-tick.mts` narrows the worst-case recovery window for these sweeps from roughly a hundred minutes (GitHub Actions' measured sub-hourly delivery latency) to about five minutes, without adding a broker or a new table.

## Business-coded refusals must never surface as 500s

A refusal the code anticipated, such as `PROGRAM_CAP_EXHAUSTED` when an organisation's programme budget for the cycle is exhausted, is registered in `BUSINESS_ERROR_CODES` and is rethrown unchanged through the checkout transaction's catch block so the route can answer with the correct HTTP status and a toast the buyer can act on. An unregistered refusal surfacing as a generic 500 means either a real defect went unclassified, or a modelled business outcome is being treated as a fault, which pollutes error-rate alerting with expected volume and hides the failures that are actually new.

## Sources

`docs/payments/06-high-level-design.md`, `docs/enterprise/70-design-decisions/21-single-writer-for-payment-confirmation.md`, `docs/enterprise/70-design-decisions/26-gst-principal-model.md`, `docs/enterprise/70-design-decisions/27-state-as-outbox-and-scheduled-ticker.md`, `docs/enterprise/10-money-and-ledger/09-payment-legs.md`, `docs/enterprise/10-money-and-ledger/03-ledger-and-postings.md`, `docs/payments/07-b2c-tax-invoice.md`, `docs/payments/audits/2026-09-03-finance-verdicts.md`.
