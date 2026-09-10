# Money subsystem — high-level design in four diagrams

This page is the map a newcomer should read before any other payments document. It shows where money truth is written, what is allowed to lag behind it, and which mechanism closes each gap. Everything drawn here runs inside one Next.js application against one Postgres database and one Redis instance. There are no services, no queues and no message brokers; the domain rows themselves carry every pending obligation, and scheduled sweeps read those rows to finish the work (ADR 14, ADR 22 and ADR 27 explain why that posture was chosen over a broker).

The diagrams describe the code as it stands after the 2026-09-03 finance train (PRs #1385, #1386, #1389, #1390, #1391, #1393, #1392 and #1414). Where a box only exists because of one of those PRs, the PR number is written on it. The verdict record that motivated the train lives in [audits/2026-09-03-finance-verdicts.md](./audits/2026-09-03-finance-verdicts.md).

## 1. B2C: a consultee pays for a session

The first diagram follows a single booking from the checkout request to the moment every side effect exists. The synchronous part is one Serializable database transaction taken under a Redis slot lock; it writes the Payment, its funding legs and the appointment hold together, so either all three exist or none does. The gateway then calls back asynchronously, and the webhook row is saved before the request is acknowledged, which makes the inbound event durable: the platform can redrive the persisted row without requiring Razorpay to resend it. One writer, running in one transaction, moves the money state and posts the ledger. Everything after that commit is best effort and is re-driven by the sweeps at the bottom.

```mermaid
flowchart TB
  U["Consultee (browser)"]
  subgraph Sync["Synchronous request — one Serializable DB transaction, Redis slot lock held"]
    CO["POST /api/checkout<br/>price → discount → 18% GST → referral credits"]
    PAY["Payment PENDING (amount = gateway charge)<br/>+ PaymentLegs (Σ non-credit legs = amount, DB trigger, #1385)"]
    APPT["Appointment PENDING_PAYMENT<br/>slot hold via CAS + GiST exclusion"]
  end
  RZP[("Razorpay")]
  subgraph Inbox["Webhook inbox — at-least-once, persisted before the 200"]
    WE["WebhookEvent row<br/>(x-razorpay-event-id unique, deferCount #1391)"]
  end
  subgraph Writer["Single writer (ADR 21) — one DB transaction"]
    HS["handlePaymentSuccess"]
    P2["Payment SUCCEEDED + gatewayPaymentId (#1391)"]
    A2["Appointment CONFIRMED (CAS in WHERE)"]
    EARN["Earnings rows (consultant / platform split from the RateCard snapshot)"]
    LED["LedgerTransaction + LedgerEntry rows<br/>(double entry; trigger rejects an unbalanced transaction)"]
    AUD["SystemEvent audit row"]
  end
  subgraph After["Best effort after commit — idempotent, may fail"]
    INV["ConsumerInvoice FAM-FY-SEQ tax invoice (#1393)"]
    CH["Stream chat channel"]
    MAIL["Emails / Novu"]
  end
  subgraph Sweeps["State-as-outbox sweeps — Netlify ticker every 5 min (#1390), GitHub Actions as backstop"]
    S1["sweep-stuck-webhook-events"]
    S2["reconcile-orphaned-confirmations + channel ensure-step (#1391)"]
    S3["reconcile-payment-status (DB ↔ gateway)"]
    S4["abandoned-payments (expire PENDING)"]
    S5["gst-outward-register healer (missing invoices, #1393)"]
  end
  U --> CO --> PAY --> APPT
  PAY -- "order_id (INR asserted, #1414)" --> RZP
  U -- "pays" --> RZP -- "payment.captured" --> WE --> HS
  HS --> P2 --> A2 --> EARN --> LED --> AUD
  AUD -.-> INV
  AUD -.-> CH
  AUD -.-> MAIL
  WE -. "deferred / crashed mid-way" .-> S1 --> HS
  P2 -. "SUCCEEDED but no channel" .-> S2 --> CH
  P2 -. "SUCCEEDED but no invoice" .-> S5 --> INV
  RZP <-. "status drift" .-> S3
  PAY -. "never paid" .-> S4
```

Three guarantees follow from this shape. The buyer's money state is exact at the moment the writer commits, because the Payment, the appointment, the earnings and the ledger entries are in the same transaction. Side effects are eventually consistent and are retried by the listed sweeps where a sweep exists; the five-minute ticker cadence is the normal retry interval, not a hard completion bound. Every sweep is idempotent, so a sweep and a webhook retry racing each other cannot double-post anything.

## 2. B2C: refunds and consultant payouts

The second diagram covers money leaving the platform on the consumer side. A refund is two-phase: the Refund row reserves the amount before the gateway is called, the gateway call carries the Refund id as its idempotency key, and the ledger reversal, the earnings clawback and the credit note are written only when the gateway confirms. A consultant payout releases earnings after the hold period, batches them, and writes the TDS record only when the RazorpayX webhook says the money moved.

```mermaid
flowchart LR
  subgraph Refund["Refund — two-phase, one front door"]
    RQ["Refund quote (cancellation policy in basis points)"]
    RR["Refund row PENDING (reserves the amount)"]
    RG["Gateway refund<br/>X-Refund-Idempotency = Refund.id"]
    RW["refund.processed webhook (found by gatewayPaymentId, #1391)"]
    RL["Ledger reversal + earnings clawback<br/>+ ConsumerCreditNote FAM-CN-FY-SEQ (#1393)"]
    RS["reconcile-refunds / cascade-refund-earnings sweeps"]
  end
  subgraph Payout["Consultant payout"]
    REL["release-earnings (after the hold period)"]
    PB["ConsultantPayout batch (BATCHED)"]
    RX[("RazorpayX")]
    PW["payout webhook → PAID<br/>TDSRecord written here (s.194-O, 0.1%)"]
    TR["tds-return-draft, quarterly (#1389)<br/>Form 140 CSV; full PAN only in the private bucket"]
  end
  RQ --> RR --> RG --> RW --> RL
  RR -. "stuck" .-> RS --> RG
  REL --> PB --> RX --> PW --> TR
```

The refund path has a single front door on purpose. Every rail that can return money to a buyer, whether a cancellation, a dispute, a removed event seat or an admin action, must produce a Refund row first, so the reserve, the idempotency key and the credit note are never skipped.

## 3. B2B: an organisation funds its members

The third diagram shows what changes when an organisation pays. The checkout, the price derivation, the GST calculation, the single writer and the ledger are the same code as the consumer path. What differs is the funding leg: a wallet, a licence seat, an invoice accrual or an overage charge replaces the card, and for wallet and licence legs no gateway call happens at all. Accrued legs roll up into one organisation invoice per month, and organisations that sell on the platform receive payouts with their own TDS records.

```mermaid
flowchart TB
  subgraph Org["Organisation"]
    BA["BillingAccount<br/>rails: WALLET (prepaid) | INVOICE (net terms) | PO; currency INR only (#1414)"]
    POOL["Seat pool / credit pool → allocations per member"]
    OVR["Overage policy: BLOCK | CHARGE_MEMBER | CHARGE_ORG (circuit breaker)"]
  end
  subgraph Fund["Funding"]
    TOP["Wallet top-up → Razorpay order → capture webhook → wallet ledger entries"]
    PO["PurchaseOrder (remainingAmountPaise)"]
  end
  subgraph Book["Member books — org-funded checkout"]
    MC["Same checkout, same price derivation, same GST<br/>PaymentLeg source = WALLET / LICENSE / INVOICE_ACCRUAL / OVERAGE"]
    MP["Payment SUCCEEDED without a gateway call for wallet and licence legs<br/>same single writer, same ledger, same earnings"]
  end
  subgraph Bill["Monthly billing"]
    ROLL["consolidated-invoice-rollup<br/>INVOICE_ACCRUAL legs → one OrganizationInvoice"]
    OINV["OrganizationInvoice PDF (GST heads; IRN later)<br/>dunning; PO balance decrement in the same currency"]
    OPAY["Organisation pays → capture → invoice PAID"]
  end
  subgraph OrgPayout["Org-side revenue share (partner organisations that sell)"]
    OP["OrganizationPayout batch → RazorpayX"]
    OT["TDSRecord at COMPLETED, organisation as deductee (#1389)"]
  end
  subgraph CA["Compliance exports for the CA"]
    REG["gst-outward-register, monthly (#1393)<br/>consumer + org invoices + credit notes"]
    TDS["tds-return-draft, quarterly (#1389)<br/>consultant + organisation deductees"]
  end
  BA --> POOL --> OVR
  TOP --> BA
  PO --> BA
  POOL --> MC --> MP
  OVR --> MC
  MP --> ROLL --> OINV --> OPAY
  PO -. "gates" .-> OINV
  MP --> OP --> OT --> TDS
  OINV --> REG
```

The three axes that make enterprise finance look complicated, namely the organisation's shape, its funding source and the programme type, are product facts rather than engineering choices. The code keeps them orthogonal so that a new combination is a configuration, not a new code path.

## 4. Cross-cutting: truth, audit, schedulers and reconciliation

The last diagram separates the four layers that the first three diagrams mix together. Money truth is strongly consistent and guarded by the database itself. The audit trail is a set of append-only rows written inside the same transactions, so it cannot disagree with the money. The schedulers are the only asynchronous machinery, and they do nothing but call HTTP routes that already exist. Reconciliation has exactly four purposes, and every scheduled money job maps to one of them.

```mermaid
flowchart LR
  subgraph Truth["Money truth — strongly consistent, one transaction"]
    T1["Payment / Refund / Payout rows<br/>status moves only through the CAS-in-WHERE helpers"]
    T2["Double-entry journal: LedgerTransaction + LedgerEntry<br/>balances are derived; walletBalance is a reconciled cache"]
    T3["DB guards: leg-sum trigger, ledger-balanced trigger, CHECK sidecars"]
  end
  subgraph Audit["Audit trail — append-only rows"]
    A1["OrgAuditLog (who did what inside an organisation)"]
    A2["SystemEvent / recordSystemError (operations timeline)"]
    A3["SystemJobExecution (every cron run, its lock, its outcome)"]
    A4["WebhookEvent (raw inbound payload, retries)"]
  end
  subgraph Sched["Schedulers — no broker"]
    G["GitHub Actions cron<br/>nightly and backstop runs (sub-hourly schedules fire only every ~100 min)"]
    N["Netlify scheduled function cron-tick.mts (#1390)<br/>every 5 min, ten money routes, bounded by ?limit"]
    R["app/api/cleanup/* routes<br/>CRON_SECRET + withCronLock (fail-closed for money jobs)"]
  end
  subgraph Recon["Reconciliation — four purposes"]
    R1["DB ↔ gateway status"]
    R2["DB ↔ journal caches"]
    R3["crash-gap re-drives"]
    R4["time expiry"]
  end
  G --> R
  N --> R
  R --> Recon
  Recon --> Truth
  Truth --> Audit
```

## When this design should change

A message broker earns its place when a second, independently deployed consumer needs the same events, when inbound webhooks sustain tens of events per second, or when the application leaves a serverless host and can run a consumer process around the clock. None of those conditions holds today, and the first step when one does is an HTTP queue such as QStash driving the same cleanup routes (issue #866), not Kafka. Until then, the cost of this design is readability rather than correctness: a reader has to know the sweeps exist, which is why ADR 27 lists every one of them.
