---
title: The money machinery — B2C and B2B on one spine
band: index
audience: sde2
status: live
last-reviewed: 2026-09-11
---

# The money machinery — B2C and B2B on one spine

> **Purpose.** One page that explains how money moves through this platform on both rails — the consumer marketplace (B2C) and the organisation layer (B2B) — with the diagrams an engineer needs to hold the whole thing in their head before touching a money path. It sits beside the [complete guide](complete-guide.md) (the narrative) and the [high-level design](../../payments/06-high-level-design.md) (four diagrams of the B2C surface); this page is the cross-rail view.
>
> **Ground truth.** Every diagram here describes the code as it is on `dev` at the `last-reviewed` date, not as an earlier design intended it. Where the two disagree the divergence is listed in [§6](#6-known-divergences) with its tracking issue rather than papered over. File references are to the line ranges verified on that date; treat them as pointers, not contracts.
>
> **Reading order.** §0 is the one-sentence model. §1 is the substrate both rails share. §2 is B2C (hard: an async gateway boundary with races). §3 is B2B (complex: a configuration space times a lifecycle times two money directions). §4 is why it stays correct without a broker. §5 is the architecture verdict.

---

## 0. The model in one sentence

**There is one checkout, one confirmation writer, and one double-entry ledger; B2C and B2B differ only in which `PaymentLeg` funds the `Payment`.** Everything downstream — earnings, payouts, TDS, refunds, credit notes, reconciliation — is shared. B2B is not a second money system; it is a second set of _legs_ on the same spine.

```mermaid
flowchart TB
  subgraph Buyer["Buyer"]
    B["consultee (B2C)  or  org member (B2B)"]
  end

  subgraph Checkout["POST /api/checkout → handleCheckout()   lib/payments/operations/checkout.ts"]
    direction TB
    S1["STEP 1  price derivation, no lock<br/>list → discount → +18% GST → −referral credits<br/>derive-checkout-amount.ts"]
    S2["STEP 2  Redis locks<br/>consultee lock → slot 30-min atoms / event lock"]
    S3["STEP 3  revalidateInsideLock<br/>plan, slot, double-book, allowlist, exclusivity"]
    S5["STEP 5  ONE Serializable transaction (withSerializableRetry)<br/>Appointment + SlotOfAppointment (isTentative = hold)<br/>Payment + PaymentLeg[]  —  Σ funding legs == amount checked at COMMIT<br/>(non-reversal, non-REFERRAL_CREDIT legs; LICENSE-only exempt — §1.2)"]
    S1 --> S2 --> S3 --> S5
  end

  B --> S1

  S5 --> RAIL{"funding rail"}

  subgraph B2C["PERSONAL rail (B2C)"]
    P1["Payment PENDING, CARD leg<br/>Razorpay order minted, 30-min expiry"]
    P2["webhook / verify-signature / reconcile"]
    P3["handlePaymentSuccess — the single writer<br/>CAS PENDING → SUCCEEDED, slots confirmed"]
    P1 --> P2 --> P3
  end

  subgraph B2B["WALLET / INVOICE / LICENSE rails (B2B)"]
    O1["Payment SUCCEEDED in the same transaction<br/>no gateway call<br/>walletDebit() · INVOICE_ACCRUAL leg · ₹0 LICENSE leg"]
  end

  RAIL -->|PERSONAL| P1
  RAIL -->|org-funded| O1

  P3 --> E
  O1 --> E

  subgraph Downstream["Shared downstream"]
    E["createEarningsFromPayment<br/>ConsultantEarnings / OrganizationEarnings<br/>LedgerTransaction  booking:paymentId"]
    PO["payout batches → RazorpayX → TDS records"]
    RF["refunds · credit notes · disputes → reversal postings"]
    RC["nightly reconciler re-derives every cache from the journal"]
    E --> PO
    E --> RF
    E --> RC
  end
```

---

## 1. The shared substrate

### 1.1 Money data model

Everything is integer paise (`BigInt` at the database, `number` in JS through the Prisma extension) and every split is basis points ([ADR 02](../70-design-decisions/02-integer-paise-and-basis-points.md)). The diagram shows the money-bearing relations only; `Payment` is the hub.

```mermaid
erDiagram
  User ||--o| ConsulteeProfile : has
  User ||--o| ConsultantProfile : has
  ConsultantProfile ||--o{ ConsultantEarnings : earns
  ConsultantProfile ||--o{ PayoutAccount : "pays out to"
  ConsultantProfile ||--o| ConsultantTaxInfo : "PAN / GSTIN"
  ConsultantEarnings }o--o| ConsultantPayout : "batched into"
  ConsultantPayout ||--o{ TDSRecord : "withholds"

  Appointment ||--o{ SlotOfAppointment : "holds (isTentative)"
  Appointment ||--o{ AppointmentParticipant : "HELD → CONFIRMED"
  Appointment }o--o| CancellationPolicy : "versioned terms"
  CancellationPolicy ||--o{ CancellationPolicyTier : "hoursBefore → refundBps"

  Appointment ||--o{ Payment : "paid by"
  Payment ||--o{ PaymentLeg : "funded by (unique per source)"
  Payment ||--o{ Refund : "reversed by"
  Payment ||--o{ Dispute : "contested by"
  Payment ||--o| ConsumerInvoice : "B2C tax invoice"
  Refund ||--o| ConsumerCreditNote : "cumulative cap"
  Dispute ||--o| ConsumerCreditNote : "on LOST"
  Payment ||--o{ ConsultantEarnings : "recognised at capture"
  Payment ||--o{ OrganizationEarnings : "host-org share"
  Payment ||--o| BookingUtilization : "B2B cap meter"
  BookingUtilization ||--o| OverageEvent : "cap breached"

  Organization ||--o| BillingAccount : "sponsor funding (fundingSource)"
  BillingAccount ||--o{ WalletTopUp : "prepaid"
  BillingAccount ||--o{ OrganizationInvoice : "postpaid rollup"
  OrganizationInvoice }o--o| PurchaseOrder : "draws down"
  Organization ||--o{ Contract : "commercial terms"
  Contract ||--o{ Program : "LICENSED_SEAT or CREDIT_POOL"
  Program ||--o{ ProgramAssignment : "per member per cycle"
  ProgramAssignment ||--o{ BookingUtilization : "consumes"
  Organization ||--o{ OrganizationEarnings : "host share"
  OrganizationEarnings }o--o| OrganizationPayout : "batched into"
  OrganizationPayout ||--o{ TDSRecord : "withholds"
  Organization ||--o{ RateCard : "platform / org / consultant bps"

  LedgerTransaction ||--|{ LedgerEntry : "2+ balanced entries"
  LedgerEntry }o--|| LedgerAccount : "kind / org / consultant / INR"
  LedgerAccount ||--o| LedgerAccountBalance : "O(1) cache"
  Payment ||--o{ LedgerTransaction : "BOOKING / REFUND"
  ConsultantPayout ||--o{ LedgerTransaction : "PAYOUT / reversal"
  OrganizationPayout ||--o{ LedgerTransaction : "ORG_PAYOUT / reversal"
```

Three fields on `Payment` divide the B2B bookkeeping: `organizationId` is a **reporting tag** (which org's member booked), `billingAccountId` is the **settlement pointer** (whose account was charged), and `billableToOrgInvoiceId` is the **rollup stamp** (which invoice absorbed the accrual; null while unbilled).

### 1.2 The database is the last line

Prisma cannot express these, so they live in `prisma/sql/*.sql` and are applied by `npm run db:sidecars` ([ADR 13](../70-design-decisions/13-postgres-native-concurrency.md), corrected in #1132). CI fails if any is missing from the live catalog.

| Sidecar                                                 | File                        | Guards                                                                                                                                                                 |
| ------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ledger_txn_balanced` (deferred constraint trigger)     | `ledger-triggers.sql`       | Σ DEBIT == Σ CREDIT per `LedgerTransaction` at COMMIT                                                                                                                  |
| `payment_legs_sum_to_amount` + `payment_amount_vs_legs` | `payment-legs-triggers.sql` | Σ non-reversal, non-`REFERRAL_CREDIT` legs == `Payment.amount`; LICENSE-only payments exempt; every `*_REVERSAL` leg negative and bounded (#1347 / #1385)              |
| `slot_no_confirmed_overlap` (GiST exclusion)            | `check-constraints.sql`     | no two non-tentative slots for one consultant overlap                                                                                                                  |
| ~30 CHECK constraints                                   | `check-constraints.sql`     | non-negative money, `wallet_nonnegative`, `po_amounts_coherent`, `rate_card_bps_sum_is_whole`, `tds_record_deductee_xor`, `overage_marginal_is_base_plus_surcharge`, … |

### 1.3 Chart of accounts and the canonical postings

Ten `LedgerAccountKind` buckets ([chart of accounts](../10-money-and-ledger/02-chart-of-accounts.md)). An account's id **is** its scope — `kind|orgId-or-_|consultantProfileId-or-_|currency` ([ADR 03](../70-design-decisions/03-deterministic-ledger-account-ids.md)) — so concurrent first postings converge by upsert and the Postgres nullable-unique trap never applies.

| Debit-normal                                       | Credit-normal                                          |
| -------------------------------------------------- | ------------------------------------------------------ |
| `CASH` — platform gateway / settlement cash        | `WALLET(org)` — prepaid balance we owe an org          |
| `ORG_RECEIVABLE(org)` — invoice-funded org owes us | `CONSULTANT_PAYABLE(cp)` — owed to a consultant        |
| `PLATFORM_PROMO` — referral credits we funded      | `ORG_PAYABLE(org)` — host-org share owed               |
| `DISCOUNT` — discount given to the buyer           | `TDS_PAYABLE` / `GST_PAYABLE` — owed to the government |
|                                                    | `PLATFORM_FEE` — recognised revenue                    |

**Worked B2C booking** — ₹1,000 list price, no discount, India, marketplace consultant (20% platform fee, `PLATFORM_FEE_PERCENTAGE`):

| Field                      | Paise    |
| -------------------------- | -------- |
| `Payment.originalAmount`   | 1,00,000 |
| `Payment.taxAmount` (18%)  | 18,000   |
| `Payment.amount` (charged) | 1,18,000 |
| `PaymentLeg CARD`          | 1,18,000 |

| Posting (idempotency key)                       | Debit                                                                                      | Credit                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `BOOKING` `booking:paymentId`                   | `CASH` 1,18,000                                                                            | `PLATFORM_FEE` 20,000 · `CONSULTANT_PAYABLE(cp)` 80,000 · `GST_PAYABLE` 18,000 |
| `PAYOUT` `payout:payoutId`                      | `CONSULTANT_PAYABLE(cp)` 80,000                                                            | `CASH` 79,920 · `TDS_PAYABLE` 80 (194-O at 0.1%, when over the FY threshold)   |
| `REFUND` (full) `refund:refundId`               | `PLATFORM_FEE` 20,000 (the plug) · `CONSULTANT_PAYABLE(cp)` 80,000 · `GST_PAYABLE` 18,000  | `CASH` 1,18,000                                                                |
| `REFUND` on LOST dispute `chargeback:disputeId` | negation of the BOOKING entries for the un-refunded fraction, residual onto `PLATFORM_FEE` |                                                                                |

**Worked B2B booking** — ₹10,000 list price, host org on the default 10/10/80 rate card, funded by the sponsor's wallet:

| Posting                           | Debit                        | Credit                                                                                                              |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `TOPUP` `topup:orderId` (earlier) | `CASH` 11,80,000             | `WALLET(org)` 11,80,000                                                                                             |
| `BOOKING` `booking:paymentId`     | `WALLET(org)` 11,80,000      | `PLATFORM_FEE` 1,00,000 · `ORG_PAYABLE(host)` 1,00,000 · `CONSULTANT_PAYABLE(cp)` 8,00,000 · `GST_PAYABLE` 1,80,000 |
| `ORG_PAYOUT` `orgpayout:payoutId` | `ORG_PAYABLE(host)` 1,00,000 | `CASH` 99,900 · `TDS_PAYABLE` 100                                                                                   |

Swap the first debit for `ORG_RECEIVABLE(org)` on the INVOICE rail (cleared later by `INVOICE_PAID` `invoicepaid:invoiceId` — `Dr CASH / Cr ORG_RECEIVABLE`), and for nothing at all on the LICENSE rail (a ₹0 leg contributes no debit; the skip is legitimate). If the expert's membership has `payoutRecipient = ORGANIZATION`, the org takes the consultant slice too: `ORG_PAYABLE` 9,00,000, `CONSULTANT_PAYABLE` 0.

Every reversal is a **new** transaction with its own key (`payout-reversal:id`, `orgpayout-reversal:id`, `topup-refund:refundId`) — never a delete. The journal is append-only; `LedgerAccountBalance`, `BillingAccount.walletBalance`, and the `*SharePaise` columns on earnings rows are caches the nightly reconciler re-derives and, for wallets, freezes on drift.

---

## 2. B2C — the consumer rail

Hard because money crosses an asynchronous boundary (Razorpay) and comes back through **four doors**, any of which can arrive first, twice, or after the booking has died.

### 2.1 Checkout

```mermaid
sequenceDiagram
  autonumber
  participant U as Browser
  participant R as /api/checkout
  participant H as handleCheckout
  participant X as Redis
  participant DB as Postgres (Serializable)
  participant RZ as Razorpay

  U->>R: POST {plan, slot, discount, clientIdempotencyKey}
  R->>R: auth, 5/min rate limit, replayByIdempotencyKey
  R->>H: handleCheckout(data, userId, buyerCountry)
  H->>DB: calculateAmountAndValidate (own tx, no lock)
  Note over H,DB: list → discount → +18% GST → −credits (≥ ₹500)<br/>no platform fee, no TDS at checkout
  H->>X: lockConsulteeBooking, then lockSlotBooking (every 30-min atom)
  H->>DB: revalidateInsideLock (plan, slot conflicts, double-book)
  alt reusable PENDING order for same user/plan/slot/amount
    H->>H: adopt it, release superseded holds
  else new order
    H->>RZ: orders.create({amount, INR, notes: {type, planId, slot, userId, organizationId, fundingSource}})
    RZ-->>H: order_…
  end
  H->>DB: BEGIN (withSerializableRetry, timeout 25 s)
  DB->>DB: Consultation PENDING + Appointment + SlotOfAppointment(isTentative=true)
  DB->>DB: Payment PENDING (amount, originalAmount, taxAmount, paymentIntent=order_…, expiresAt=+30 min)
  DB->>DB: PaymentLeg CARD = amount · REFERRAL_CREDIT leg if credits applied
  DB->>DB: discount currentUses++, credits consumed
  DB-->>H: COMMIT — payment_legs_sum_to_amount fires here
  H->>X: release locks
  H-->>U: {paymentIntent: order_…, amount}
  U->>RZ: Razorpay modal
```

Zero-amount (credit-funded) and org-funded checkouts take the `skipPayment` branch: `Payment` is created `SUCCEEDED`, participants `CONFIRMED`, and earnings run post-commit from the same request.

### 2.2 Confirmation — four doors, one writer

[ADR 21](../70-design-decisions/21-single-writer-for-payment-confirmation.md): the capture transition `PENDING → SUCCEEDED` is written by `handlePaymentSuccess` and by nothing else. Every door funnels through `routeCapturedPayment`, which repeats the parity check every time. The other writers of `Payment.paymentStatus` are narrow and never confirm a gateway payment: the `skipPayment` branch creates the row already `SUCCEEDED` (no transition), the `payment.failed` webhook handler writes `PENDING → FAILED`, and `PENDING → EXPIRED` is written by `cleanup-abandoned-payments`, by `cancelPendingCheckout`, and by the superseded-hold release inside checkout.

```mermaid
sequenceDiagram
  autonumber
  participant RZ as Razorpay
  participant WH as /api/webhooks/razorpay
  participant VS as /checkout/verify-signature
  participant VQ as /checkout/verify?sync=true
  participant CR as reconcile-payment-status (ticker)
  participant RT as routeCapturedPayment
  participant P1 as Phase 1 — Serializable tx
  participant P2 as Phase 2 — post-commit
  participant SW as sweepers

  par door 1 — webhook
    RZ->>WH: payment.captured (HMAC over raw body)
    WH->>WH: eventId = type:entityId, upsert WebhookEvent (dup → 200)
    WH-->>RZ: 200 inside 5 s
    WH->>RT: after(): processRazorpayWebhookEvent
  and door 2 — client return
    VS->>RZ: payments.fetch (signature proves id pair, not capture)
    RZ-->>VS: status = captured
    VS->>RT: routeCapturedPayment
  and door 3 — on-demand sync
    VQ->>RZ: orders.fetch + orders.fetchPayments
    VQ->>RT: routeCapturedPayment
  and door 4 — sweep
    CR->>RZ: orders.fetchPayments
    CR->>RT: routeCapturedPayment
  end

  RT->>P1: handlePaymentSuccess(orderId, notes, amountPaise, gatewayPaymentId)
  P1->>P1: findUnique(paymentIntent) · already SUCCEEDED → return (idempotent)
  P1->>P1: gateway amount ≠ Payment.amount → stamp + auto-refund
  P1->>P1: CAS updateMany WHERE paymentStatus = PENDING → SUCCEEDED, gatewayPaymentId
  Note over P1: count == 0 → terminal-capture race (EXPIRED/FAILED already) → auto-refund
  P1->>P1: confirmExistingAppointment: first-confirmed-wins recheck,<br/>slots isTentative → false (GiST guards), participants HELD → CONFIRMED,<br/>Consultation CAS {PENDING, APPROVED_PENDING_PAYMENT} → APPROVED
  P1-->>P2: COMMIT

  P2->>P2: success email
  P2->>P2: createEarningsFromPayment — own Serializable tx, posts booking:paymentId
  Note over P2: see §6 / issue 1564 — the journal is written here, not in Phase 1
  P2->>P2: referral qualify → mintConsumerInvoice → Novu → Stream channel (stamps chatChannelEnsuredAt)

  SW-->>P2: sync-payment-earnings heals SUCCEEDED ∧ earnings:none
  SW-->>P2: reconcile-orphaned-confirmations re-drives the channel step
  SW-->>WH: sweep-stuck-webhook-events replays a dead after()
```

There is no `CONFIRMED` appointment status. "Confirmed" means `Consultation.status = APPROVED` ∧ `SlotOfAppointment.isTentative = false` ∧ participants `CONFIRMED`; `SCHEDULED` is stamped later by slot allocation.

### 2.3 State machines

```mermaid
stateDiagram-v2
  direction LR
  state "Payment" as P {
    [*] --> PENDING
    PENDING --> SUCCEEDED : capture (CAS, single writer)
    PENDING --> FAILED : payment.failed
    PENDING --> EXPIRED : 30 min, cleanup-abandoned-payments
  }
```

```mermaid
stateDiagram-v2
  direction LR
  state "Earnings (consultant and org)" as E {
    [*] --> PENDING : recognised at capture, base = originalAmount
    [*] --> PENDING_TRUST : org-INVOICE sponsor still PENDING_VERIFICATION
    PENDING_TRUST --> PENDING : release-pending-trust-earnings
    PENDING --> READY : holdUntil (24 h consultation, 48 h webinar, 168 h subscription)
    PENDING --> HELD : dispute opened (preDisputeStatus kept)
    READY --> HELD : dispute opened
    HELD --> PENDING : dispute won / closed
    HELD --> READY : dispute won / closed
    HELD --> REFUNDED : dispute lost
    READY --> BATCHED : payout batch claims the row
    BATCHED --> READY : payout FAILED / CANCELLED
    BATCHED --> PAID : payout.processed
    PAID --> READY : payout REVERSED
    PAID --> REFUNDED : refund after payout (clawback)
    READY --> REFUNDED : fully refunded
    PENDING --> REFUNDED : fully refunded
  }
```

```mermaid
stateDiagram-v2
  direction LR
  state "Payout (consultant and org)" as PO {
    [*] --> PENDING : createPayoutBatch / createOrgPayoutBatch
    PENDING --> APPROVED : consultant rail, amount below ₹5,000 auto-approves
    APPROVED --> PROCESSING : processSinglePayout (CAS)
    PENDING --> PROCESSING : org rail claims directly
    PROCESSING --> COMPLETED : payout.processed webhook
    PROCESSING --> FAILED : gateway 4xx / stuck 24 h
    COMPLETED --> REVERSED : payout.reversed (inverse posting)
    PENDING --> CANCELLED
  }
```

```mermaid
stateDiagram-v2
  direction LR
  state "Refund" as RF {
    [*] --> PENDING : reserve row, refundId = pending_uuid
    PENDING --> SUCCEEDED : gateway processed → applyRefundCascade
    PENDING --> FAILED : gateway failed / 24 h unmatched
    PENDING --> CANCELLED
  }
```

`ENABLE_LIVE_PAYOUTS` is off ([ADR 11](../70-design-decisions/11-live-payout-submission-freeze.md)): batches form, TDS and MSME deadlines are computed, earnings move to `BATCHED`, and the gateway call is skipped; rows park at `PENDING`.

### 2.4 Refunds — quote, two-phase call, cascade

```mermaid
flowchart TB
  A["cancel / dispute / admin / removed seat"] --> G{"live dispute on the appointment?"}
  G -->|yes| GX["blocked — dispute-guard.ts"]
  G -->|no| Q["quoteBookingRefund<br/>tier by hoursUntilStart (default 24 h → 100%, 2 h → 50%, 0 → 0%)<br/>consultant-initiated → 100%; subscription prorated by sessions remaining<br/>cap = amount − Σ(SUCCEEDED+PENDING refunds) − Σ(LOST disputes)"]
  Q --> D{"rail by paymentIntent prefix"}
  D -->|free_| C["refundFreeCreditPayment<br/>zero-amount Refund row + reverseCreditsForPayment"]
  D -->|org_| I["refundInternalFundedPayment<br/>wallet re-credit / accrual reversal leg"]
  D -->|order_| R1["PHASE 1  Serializable: re-derive cap, Refund(PENDING) row"]
  R1 --> R2["PHASE 2  createRazorpayRefund(idempotencyKey = reservation id)"]
  R2 -->|throws| K["placeholder kept for reconcile-pending-refunds"]
  R2 --> R3["PHASE 3a  bind rfnd_ id (adopt webhook's row on P2002)"]
  R3 --> R4["PHASE 3b  Serializable: applyRefundCascade + SUCCEEDED + credits restored"]
  I --> CAS
  C --> CAS
  R4 --> CAS

  subgraph CAS["applyRefundCascade — claims Refund.cascadedAt exactly once"]
    direction TB
    S4["4  proportional leg reversal<br/>CARD via gateway · WALLET → walletCredit · accrual → negative *_REVERSAL sibling"]
    S5["5  reverseBookingUtilization (B2B seats / credits)"]
    S6["6  ConsultantEarnings.refundedShareAmount += share × ratio<br/>PAID → TDS reversal record"]
    S7["7  OrganizationEarnings clawback<br/>post-COMPLETED payout → clawbackAmountPaise"]
    S75["7.5  mintConsumerCreditNote / mintRefundCreditNote<br/>cumulative cap per invoice"]
    S76["7.6  CHARGED overage credit-back on full refund"]
    S9["9  REFUND posting refund:refundId<br/>credits the funding accounts, PLATFORM_FEE absorbs rounding<br/>imbalance rolls back the whole cascade"]
    S4 --> S5 --> S6 --> S7 --> S75 --> S76 --> S9
  end
```

Disputes: `payment.dispute.created` writes `Dispute(NEEDS_RESPONSE)` and moves earnings to `HELD` with `preDisputeStatus`; `LOST` / `CHARGE_REFUNDED` moves them to `REFUNDED`, posts the B2C chargeback negation and mints a credit note; any payout batch refuses an earning whose payment has a live dispute.

### 2.5 Tax posture

- **GST — principal supplier** ([ADR 26](../70-design-decisions/26-gst-principal-model.md)). 18% on the discounted price at checkout, `GST_PAYABLE` credited at BOOKING, the platform issues `ConsumerInvoice FAM-FY-SEQ5` with place of supply defaulting to the supplier's state under s.12(2)(b). No §52 TCS; `GstTcsBatch` and `gstr8.ts` are dormant pending CA sign-off.
- **Income tax — e-commerce operator** (194-O). 0.1% (5% without PAN) withheld at **payout**, `TDSRecord` written only when the payout reaches `COMPLETED`. The engine is `LEGACY` (₹50,000 FY threshold); the ₹5 lakh three-limb exemption sits behind `ENABLE_TDS_194O_GROSS`.
- The pairing — principal for GST, operator for income tax — is deliberate and is the first open question on the CA list. It is also why the [RBI PA memo](../40-compliance-and-data/07-rbi-payment-aggregator-posture.md) can say "not a payment aggregator": no Route, no split settlement, wallet balances are platform liabilities.

---

## 3. B2B — the organisation rails

Complex because it is a **configuration space** (capability × funding source × program type × overage) crossed with a **lifecycle** (contract → program → assignment → cycle) crossed with **two money directions** (a sponsor pays in; a host is paid out) — and every cell has to land on the same leg-sum identity and the same ledger.

### 3.1 The configuration space

```mermaid
flowchart LR
  subgraph CAP["Organization capability"]
    direction TB
    SP["SPONSOR — canSponsor<br/>pays for members"]
    HO["HOST — canHost<br/>receives a share of earnings"]
    HY["HYBRID — both"]
    IN["INERT — neither → refused"]
  end
  subgraph FS["BillingAccount.fundingSource"]
    direction TB
    F0["PERSONAL — tag only, member's card pays"]
    F1["WALLET — prepaid, debited at booking"]
    F2["INVOICE — postpaid, accrues to a monthly invoice"]
    F3["LICENSE — flat fee, ₹0 legs"]
  end
  subgraph PT["Program.type"]
    direction TB
    T1["LICENSED_SEAT — n engagements per cycle"]
    T2["CREDIT_POOL — ₹ budget per cycle"]
  end
  subgraph OV["OverageBehavior"]
    direction TB
    O1["BLOCK"]
    O2["CHARGE_ORG"]
    O3["CHARGE_MEMBER"]
  end
  CAP --> FS --> PT --> OV
```

Reachable tuples (`lib/enterprise/reachable-paths.ts`, `REACHABLE_ORG_FUNDING_PATHS`):

| Capability | Funding | Program       |
| ---------- | ------- | ------------- |
| SPONSOR    | WALLET  | CREDIT_POOL   |
| SPONSOR    | INVOICE | CREDIT_POOL   |
| SPONSOR    | INVOICE | LICENSED_SEAT |
| SPONSOR    | LICENSE | LICENSED_SEAT |
| HOST       | —       | —             |
| HYBRID     | any     | any           |

Refused at **programme-configuration time** (`overageBehaviorUnsupportedReason`), never mishandled at checkout:

| Combination                         | Why                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| WALLET × CHARGE_MEMBER              | no credit-back path exists on the wallet rail                                   |
| WALLET × CHARGE_ORG × surcharge > 0 | the whole price was debited at booking; nothing collects a surcharge afterwards |
| LICENSE × anything but BLOCK        | a ₹0 LICENSE leg plus any second leg re-arms the leg-sum trigger                |

Money configuration locks at first assignment (`Program.configLockedAt`); a change is archive + new programme. Contract terms lock once invoiced or assigned; a change is supersession (`AMENDMENT` / `RENEWAL`), the old row `TERMINATED` / `EXPIRED`, invoices keep the old `contractId`.

### 3.2 Org checkout — gates, then what each rail writes

```mermaid
flowchart TB
  M["member books with organizationId"] --> G1{"org ACTIVE or PENDING_VERIFICATION<br/>and canSponsor?"}
  G1 -->|no| X1["plain Error → 500 today (#1564)"]
  G1 --> G2{"dunning-suspended invoice?<br/>(ENABLE_DUNNING_SUSPEND)"}
  G2 -->|yes| X2["402 BILLING_SUSPENDED_DUNNING"]
  G2 --> G3{"ACTIVE membership<br/>and DPDP consent SESSION_BOOKING?"}
  G3 -->|no| X3["not a member → plain Error → 500 today (#1564)<br/>no consent → 403 CONSENT_REQUIRED"]
  G3 --> G4{"INVOICE rail: verified domain<br/>and exposure below credit limit?"}
  G4 -->|no| X4["unverified domain → 403 DOMAIN_VERIFICATION_REQUIRED (#1407)<br/>credit limit → plain Error → 500 today (#1564); re-checked inside the tx"]
  G4 --> G5{"one ACTIVE ProgramAssignment in period,<br/>programme ACTIVE, contract ACTIVE?"}
  G5 -->|no| X5["409 PROGRAM_ASSIGNMENT_INACTIVE<br/>(fail-closed: never falls back to the card)"]
  G5 --> G6{"inside the lock: consultant on the<br/>ProgramConsultantAllowlist? exclusiveEngagement?"}
  G6 -->|no| X6["plain Error → 500 today (#1564)"]
  G6 --> TX["ONE Serializable transaction"]
  TX --> U["recordBookingUtilization<br/>CAS engagementsUsed ≤ cap − n  or  consumedPaise ≤ budget − price"]
  U -->|0 rows| OVR["recordOverageAtCheckout<br/>circuit breaker: Σ marginal this cycle > maxOveragePerCyclePaise → 402 PROGRAM_CAP_EXHAUSTED"]
  U --> OK["COMMIT → createEarningsFromPayment → BOOKING posting"]
  OVR --> OK
```

| Rail     | Gateway                | `Payment.paymentStatus`          | `PaymentLeg`               | In-transaction side effect                                          | BOOKING debit            |
| -------- | ---------------------- | -------------------------------- | -------------------------- | ------------------------------------------------------------------- | ------------------------ |
| PERSONAL | Razorpay order         | `PENDING` until capture          | `CARD` = amount            | tentative hold                                                      | `Dr CASH`                |
| WALLET   | none (`org_wallet_…`)  | `SUCCEEDED`                      | `WALLET` = amount          | `walletDebit()` CAS `walletBalance ≥ amt`; refused if wallet frozen | `Dr WALLET(org)`         |
| INVOICE  | none (`org_invoice_…`) | `SUCCEEDED`                      | `INVOICE_ACCRUAL` = amount | exposure re-check                                                   | `Dr ORG_RECEIVABLE(org)` |
| LICENSE  | none (`org_license_…`) | `SUCCEEDED`, amount = full price | `LICENSE` = 0              | —                                                                   | none (₹0 leg)            |

### 3.3 Overage — the matrix that makes the refusals necessary

|                   | INVOICE rail                                                                                                                                                                     | WALLET rail                                                                    | LICENSE           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------- |
| **BLOCK**         | 402                                                                                                                                                                              | 402                                                                            | 402               |
| **CHARGE_ORG**    | carve base out of the `INVOICE_ACCRUAL` leg, add `OVERAGE_INVOICE_ACCRUAL` = marginal, `amount += surcharge`; `PENDING → ACCRUED` at rollup → `CHARGED` when the invoice is paid | already inside the debit; `OverageEvent` born `CHARGED`; surcharge > 0 refused | refused at config |
| **CHARGE_MEMBER** | side `Payment(parentPaymentId, intent overage:parent)`; member pays at `/dashboard/overage`; webhook posts `OVERAGE_MEMBER` (`Dr CASH / Cr ORG_PAYABLE`); 14-day timeout job     | refused at config                                                              | refused at config |

### 3.4 Sponsor money-in — wallet and invoice lifecycles

```mermaid
sequenceDiagram
  autonumber
  participant O as Org billing admin
  participant RZ as Razorpay
  participant WH as webhook
  participant W as wallet.ts
  participant L as Ledger
  participant CK as checkout
  participant RC as reconciler

  O->>W: initiateTopUp → WalletTopUp(PENDING, providerOrderId)
  O->>RZ: pay order (notes.type = credit_purchase)
  RZ->>WH: payment.captured
  WH->>W: confirmTopUp — stamp capturedAt outside tx, CAS PENDING → CONFIRMED
  W->>W: walletCredit — seed NULL → 0, walletBalance += amount
  W->>L: TOPUP topup:orderId — Dr CASH / Cr WALLET(org)

  CK->>W: walletDebit — CAS updateMany WHERE walletBalance ≥ amount (refused if isWalletFrozen)
  Note over CK,W: checkout transaction COMMITs here — Payment SUCCEEDED, wallet cache debited
  CK->>L: createEarningsFromPayment (post-commit, separate tx) — BOOKING booking:paymentId — Dr WALLET(org) / Cr FEE + PAYABLE + GST
  Note over CK,L: a gap between the two is paged and healed by sync-payment-earnings

  RC->>RC: nightly WALLET_BALANCE_DRIFT (cache vs journal)
  RC-->>W: freezeWalletSpend (SystemEvent) until admin unfreeze
```

```mermaid
sequenceDiagram
  autonumber
  participant CK as checkout (INVOICE rail)
  participant L as Ledger
  participant J as settle-invoice-accruals (monthly)
  participant INV as OrganizationInvoice
  participant O as Org
  participant WH as webhook
  participant D as dunning (daily)

  CK->>CK: INVOICE_ACCRUAL leg, no cash
  CK->>L: BOOKING — Dr ORG_RECEIVABLE(org) / Cr …
  J->>J: rollupOrgInvoiceAccruals (Serializable + retry)
  J->>J: Σ unbilled accrual legs (+ reversal siblings) → line items
  J->>J: GST split CGST+SGST / IGST / export · gapless OrgInvoiceCounter(org, FY)
  J->>INV: create ISSUED, dueDate = issuedAt + paymentTermsDays (60)
  J->>J: stamp Payment.billableToOrgInvoiceId · overage PENDING → ACCRUED
  Note over J,INV: issuance posts NO ledger leg — the receivable already exists from BOOKING
  O->>WH: pay (Razorpay, notes.type = invoice_payment, order id reused for idempotency)
  WH->>INV: CAS ISSUED or OVERDUE → PAID
  WH->>L: INVOICE_PAID invoicepaid:id — Dr CASH / Cr ORG_RECEIVABLE(org)
  WH->>WH: overage ACCRUED → CHARGED
  D->>INV: past dueDate: ISSUED → OVERDUE
  D->>O: 3 reminders at 7-day cadence
  D->>INV: then dunningSuspendedAt (flag-gated) → checkout answers 402
```

`PurchaseOrder.remainingAmountPaise` is CAS-decremented on the **manual** invoice route only; the automated rollup does not draw down a PO today (§6).

### 3.5 Host money-out — org earnings to org payout

```mermaid
sequenceDiagram
  autonumber
  participant E as earnings-service
  participant OE as OrganizationEarnings
  participant B as createOrgPayoutBatch (weekly)
  participant P as processOrgPayout
  participant RX as RazorpayX
  participant WH as webhook
  participant L as Ledger
  participant T as TDSRecord

  E->>E: resolveOrgSplit (ENABLE_HOST_ORGS) — oldest ACTIVE EXPERT membership at a canHost org
  E->>E: RateCard bps at payment.createdAt (default 10/10/80) · payoutRecipient = ORGANIZATION → org takes the consultant slice
  E->>OE: PENDING (or PENDING_TRUST) → READY after holdUntil

  B->>B: Redis lock org:id:payout-batch, Serializable + retry
  B->>B: placeholder OrganizationPayout(PENDING, idempotencyKey)
  B->>OE: CLAIM FIRST — updateMany READY ∧ orgPayoutId IS NULL → orgPayoutId
  B->>B: net = Σ(orgShare − refunded) > 0, single currency
  B->>B: computeTdsForPayout(net): 194-O 0.1% / 5% no PAN / s.197 cert · MSME mustPayByDate
  B->>OE: READY → BATCHED (no cash has moved)

  P->>P: ENABLE_LIVE_PAYOUTS off → stays PENDING (ADR 11)
  P->>P: on: live-dispute check, CAS PENDING → PROCESSING, COMMIT
  P->>RX: createPayout — X-Payout-Idempotency = 34-char digest of payout_id, queue_if_low_balance
  RX-->>P: 4xx → FAILED, release BATCHED → READY · 5xx → rethrow, cron retries same key

  RX->>WH: payout.processed
  WH->>WH: markOrgPayoutCompleted — ONE tx
  WH->>OE: BATCHED → PAID
  WH->>WH: assert amount + tds == net
  WH->>L: ORG_PAYOUT orgpayout:id — Dr ORG_PAYABLE(org) net / Cr CASH amount / Cr TDS_PAYABLE tds
  WH->>T: written HERE and nowhere else

  RX->>WH: payout.reversed
  WH->>WH: markOrgPayoutReversed — COMPLETED → REVERSED, inverse posting orgpayout-reversal:id, earnings PAID → READY, negative TDSRecord
```

### 3.6 The lifecycle engine moves entitlement, never money

```mermaid
flowchart LR
  C["Contract<br/>DRAFT → ACTIVE → EXPIRED / TERMINATED<br/>terms lock once invoiced or assigned"] --> PR["Program<br/>ACTIVE → PAUSED / EXPIRED / CANCELLED<br/>money config locks at first assignment"]
  PR --> A["ProgramAssignment (per member per cycle)<br/>engagementsUsed · consumedPaise · overageCount"]
  A -->|"advance-program-cycles nightly<br/>decideCycleTransition"| D{"contract ACTIVE?<br/>autoRenew?<br/>successorEnd ≤ effectiveTo?"}
  D -->|ROLL| A2["ROLLED → successor ACTIVE<br/>counters zeroed, unused entitlement vanishes"]
  D -->|CLOSE| A3["CLOSED — no successor"]
  AR["auto-renew-contracts 02:30Z<br/>claims autoRenewedAt"] --> EX["expire-contracts 03:00Z"]
```

Nothing financial happens at rollover: wallet balances never expire, invoices settle on their own monthly job, and CHARGE_ORG overage from the closing cycle settles through the next rollup.

### 3.7 Refunds on org rails

The cascade in §2.4 runs unchanged; the leg step is what differs. A `WALLET` leg re-credits the cache and the `REFUND` posting credits `WALLET(org)`. An unpaid `INVOICE_ACCRUAL` leg gets a negative `INVOICE_ACCRUAL_REVERSAL` sibling so the next rollup nets it; a paid one is handled by the org earnings clawback and a proportional credit note (`CreditNote.refundId @unique`). A `LICENSE` leg releases the seat in `reverseBookingUtilization`. Under `CHARGE_MEMBER`, the member's side payment is refunded to the member's own card post-commit and the covered portion returns on the org's rail.

---

## 4. How it stays correct without a broker

```mermaid
flowchart TB
  subgraph L["Concurrency layers (ADR 13)"]
    direction TB
    L0["L0  Postgres sidecars — ledger_txn_balanced · payment_legs_sum · GiST · CHECKs"]
    L1["L1  CAS-in-WHERE — updateMany WHERE status IN ALLOWED_FROM  (lib/enterprise/transitions.ts)"]
    L2["L2  Serializable + withSerializableRetry — multi-row invariants, P2034 only"]
    L3["L3  version column — human-edited settings rows"]
    L4["L4  Redis locks — checkout slot atoms and cron mutex ONLY, never for data"]
  end

  subgraph IN["Inbound — WebhookEvent is the inbox"]
    W1["eventId unique = type:entityId · processed / error / deferCount"]
    W2["ACK 200 inside 5 s → after() → sweep-stuck-webhook-events replays a dead callback"]
  end

  subgraph OUT["Outbound — state as outbox (ADR 27)"]
    O1["no generic outbox table: a nullable stamp on the row that owns the obligation<br/>(OutboundWebhookDelivery and FailedEmail are dedicated delivery queues with retry state)"]
    O2["Refund.cascadedAt · Appointment.chatChannelEnsuredAt · Payment.billableToOrgInvoiceId<br/>WalletTopUp.capturedAt · OutboundWebhookDelivery · FailedEmail"]
    O3["each walked by an idempotent sweeper with an HTTP twin under app/api/cleanup/*"]
  end

  subgraph SCHED["Two schedulers, one lock"]
    T1["Netlify cron-tick — every 5 min, 10 routes, limit=50, 26 s ceiling"]
    T2["GitHub Actions — ~55 workflows; sub-hourly ones fire every ~100 min (ADR 22)"]
    T3["CRON_SECRET + withCronLock — money jobs fail CLOSED when Redis is unhealthy"]
    T1 --> T3
    T2 --> T3
  end

  T3 --> O3
```

The append-only ledger is the event log; every reversal is a compensating posting with its own idempotency key; every claim happens before any computation (`createOrgPayoutBatch`, `Refund.cascadedAt`); every reconciler run is a control loop that re-derives caches from the journal.

---

## 5. Architecture verdict

Recorded so it is not re-litigated on every launch review. Full reasoning and measurements: [ADR 13](../70-design-decisions/13-postgres-native-concurrency.md), [ADR 14](../70-design-decisions/14-async-queue-posture.md), [ADR 22](../70-design-decisions/22-queue-posture-revisited-with-measurements.md), [ADR 27](../70-design-decisions/27-state-as-outbox-and-scheduled-ticker.md).

| Question                             | Answer                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Microservices?                       | **No.** The two invariants that make money correct — `payment_legs_sum_to_amount` and `ledger_txn_balanced` — fire at COMMIT of one transaction. Splitting Payment from Ledger replaces a constraint trigger with a saga on the invariant that most needs to be strict.                                                |
| Internal event bus / event sourcing? | **No.** Events exist at both edges (Razorpay in, `OutboundWebhookDelivery` + Novu out). A bus buys fan-out to multiple consumers; there is ~1 consumer per event. The ledger already is the append-only, idempotency-keyed log.                                                                                        |
| Distributed-systems patterns?        | **Already in use, in-process:** idempotent consumers, inbox with defer, state-as-outbox, sagas with compensating postings, business-level two-phase commit (`refundPayment`), CAS-in-WHERE, SSI with retry, deterministic ids, claim-before-compute, control-loop reconciliation, circuit breakers, a dead-man switch. |
| What is the scale wall?              | **Netlify** — 125 concurrent invocations, 10 s sync / 26 s function ceiling, webhooks on the same fleet as page renders. Not Postgres, not the absence of a broker.                                                                                                                                                    |
| What is the escalation?              | One worker tier (QStash, #1010), before `ENABLE_LIVE_PAYOUTS` flips. A durable workflow engine is evaluated when live payout submission meets ADR 22's own trigger.                                                                                                                                                    |
| The one EDA move worth planning?     | **CDC from `LedgerEntry` / `Payment` / `TDSRecord` to a read model** so GSTR-1, 26Q, rollups and the reconciler stop querying the OLTP pool capped at one connection per function. `launch: scale`.                                                                                                                    |

---

## 6. Known divergences

Tracked in #1564. This page describes the code; these are the places where another document, or the doctrine, says something different.

| Where                                                                             | Says                                                   | Code does                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/payments/06-high-level-design.md`, `finance/references/doctrine.md`, ADR 21 | earnings + BOOKING journal inside the single-writer tx | written in Phase 2, post-commit, in `createEarningsFromPayment`'s own transaction; healed by `sync-payment-earnings` (**P0**)                                                                                  |
| `docs/payments/06-high-level-design.md`                                           | `Appointment CONFIRMED`                                | no such status; `APPROVED` + `isTentative = false` + participant `CONFIRMED`                                                                                                                                   |
| `docs/enterprise/10-money-and-ledger/08-invoicing.md`                             | PO 3-way match on every invoice                        | manual route only; the automated rollup passes no `purchaseOrderId`                                                                                                                                            |
| `docs/enterprise/40-compliance-and-data/04-outbound-webhooks.md`                  | eight events delivered                                 | three have emitters (`invoice.issued`, `member.added`, `member.removed`)                                                                                                                                       |
| `prisma/schema.prisma` `OrgKybVerification` comment                               | INVOICE funding blocked until KYB                      | API checks the verified domain only                                                                                                                                                                            |
| `lib/enterprise/transitions.ts` org payout map                                    | `PROCESSING ← APPROVED`                                | org rail claims `PENDING → PROCESSING`; no approval gate at any amount                                                                                                                                         |
| `docs/enterprise/10-money-and-ledger/13-ledger-integrity.md`                      | fourteen finding kinds                                 | 26                                                                                                                                                                                                             |
| `docs/enterprise/10-money-and-ledger/12-payment-webhooks.md`                      | `dispute.under_review` / `action_required` unhandled   | both dispatched                                                                                                                                                                                                |
| `finance/references/doctrine.md` § business-coded refusals never surface as 500s  | every anticipated refusal carries a registered code    | six org-checkout refusals (org status, `canSponsor`, membership, invoice credit limit, allowlist, exclusivity) are plain `Error`s with no code — `classifyError` answers 500 `UNKNOWN` and Sentry sees a fault |

---

## Ground truth

`prisma/schema.prisma` · `prisma/sql/{ledger-triggers,payment-legs-triggers,check-constraints}.sql` · `lib/payments/operations/checkout.ts` · `lib/payments/pricing/derive-checkout-amount.ts` · `lib/payments/webhooks/handlers.ts` · `app/api/webhooks/razorpay-dispatch.ts` · `app/api/webhooks/utils.ts` · `lib/payments/payouts/earnings-service.ts` · `lib/payments/payouts/payout-service.ts` · `lib/payments/payouts/org-payout-service.ts` · `lib/payments/ledger/post.ts` · `lib/payments/operations/refund.ts` · `lib/payments/billing/{overage-settlement,invoice-rollup,consumer-invoice}.ts` · `lib/api/organizations/wallet.ts` · `lib/enterprise/{reachable-paths,transitions,config-lock,cycle-engine,governance}.ts` · `lib/compliance/{tds,tds-194o,gst,msme}.ts` · `netlify/functions/cron-tick.mts` · `scripts/reconcile/reconcile-ledgers.ts`.
