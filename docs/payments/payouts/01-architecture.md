# Payout System Architecture

> **Moved (org/B2B side):** The organization-side documentation for payouts now lives in [`docs/enterprise/10-money-and-ledger/07-payout-pipeline.md`](../../enterprise/10-money-and-ledger/07-payout-pipeline.md) and [`06-earnings-lifecycle.md`](../../enterprise/10-money-and-ledger/06-earnings-lifecycle.md). This file keeps the consumer-marketplace (B2C) and gateway-generic details only.

> System design and component overview with diagrams

---

## High-Level Architecture

```mermaid
graph TB
    subgraph "Frontend"
        AD[Admin Dashboard]
        SD[Staff Dashboard]
        CD[Consultant Dashboard]
    end

    subgraph "API Layer"
        AA[Admin API Routes]
        SA[Staff API Routes]
        CA[Consultant API Routes]
    end

    subgraph "Service Layer"
        ES[EarningsService]
        PS[PayoutService]
        IS[InvoiceService]
    end

    subgraph "Provider Layer"
        RX[RazorpayX Payouts]
        SC[Stripe Connect]
    end

    subgraph "Automation"
        GH[GitHub Actions]
        S1[release-earnings]
        S2[create-payout-batch]
        S3[process-payouts]
    end

    subgraph "Database"
        CE[(ConsultantEarnings)]
        PO[(Payout)]
        PA[(PayoutAccount)]
        IN[(Invoice)]
    end

    subgraph "External"
        RXA[RazorpayX API]
        SCA[Stripe API]
        WH[Webhooks]
    end

    AD --> AA
    SD --> SA
    CD --> CA

    AA --> ES & PS & IS
    SA --> ES & PS
    CA --> ES

    ES --> CE
    PS --> PO & PA & CE
    IS --> IN

    PS --> RX & SC
    RX --> RXA
    SC --> SCA

    GH --> S1 & S2 & S3
    S1 --> ES
    S2 --> PS
    S3 --> PS

    RXA --> WH
    SCA --> WH
    WH --> PS

    style ES fill:#10b981,color:#fff
    style PS fill:#3b82f6,color:#fff
    style IS fill:#8b5cf6,color:#fff
    style RX fill:#6366f1,color:#fff
    style SC fill:#ec4899,color:#fff
```

---

## Service Layer

### EarningsService (`earnings-service.ts`)

Manages the consultant earnings lifecycle.

```mermaid
graph LR
    subgraph "EarningsService Functions"
        A[createEarningsFromPayment]
        B[releaseEarningsFromHold]
        C[getConsultantEarnings]
        D[refundEarnings]
        E[holdEarnings]
        F[releaseHeldEarnings]
    end

    PM[Payment Model] --> A
    A --> CE[(ConsultantEarnings)]
    B --> CE
    CE --> C
    CE --> D
    CE --> E
    E --> F
```

**Key Functions:**

| Function                    | Purpose                                 | Trigger                  |
| --------------------------- | --------------------------------------- | ------------------------ |
| `createEarningsFromPayment` | Create earnings record(s) with hold period. For WEBINAR/CLASS with collaborators, creates multi-party earnings via `calculateRevenueSplit()`. | Webhook: payment.success |
| `releaseEarningsFromHold`   | PENDING → READY after hold period       | Cron: hourly             |
| `getConsultantEarnings`     | Fetch earnings for dashboard            | API request              |
| `refundEarnings`            | Proportional or full reversal of earnings. Accepts `refundAmount`/`paymentAmount` for partial refunds. Tracks cumulative reversals via `refundedShareAmount`. Supports `forceRefund: true` for PAID earnings (lost disputes). | Webhook: refund, Cron: lost disputes |
| `holdEarnings`              | READY → HELD on dispute                 | Webhook: dispute         |
| `releaseHeldEarnings`       | HELD → READY when dispute resolved      | Admin action             |

---

### PayoutService (`payout-service.ts`)

Handles payout batch creation and processing.

```mermaid
graph LR
    subgraph "PayoutService Functions"
        A[checkPayoutEligibility]
        B[createPayoutBatch]
        C[approvePayout]
        D[rejectPayout]
        E[processApprovedPayouts]
        F[handlePayoutWebhook]
    end

    CE[(ConsultantEarnings)] --> A
    A --> B
    B --> PO[(Payout)]
    PO --> C & D
    C --> E
    E --> RX[RazorpayX] & SC[Stripe]
    RX & SC --> WH[Webhook]
    WH --> F
    F --> PO & CE
```

**Key Functions:**

| Function                 | Purpose                                | Trigger        |
| ------------------------ | -------------------------------------- | -------------- |
| `checkPayoutEligibility` | Validate consultant can receive payout | Batch creation |
| `createPayoutBatch`      | Group READY earnings into payouts      | Cron: weekly   |
| `approvePayout`          | Admin approves pending payout          | Admin action   |
| `rejectPayout`           | Admin rejects with reason              | Admin action   |
| `processApprovedPayouts` | Send to payment provider               | Cron: weekly   |
| `handlePayoutWebhook`    | Update status from provider. Uses atomic `updateMany` with `status: { notIn: [COMPLETED, CANCELLED] }` guard for idempotency. | Webhook event  |

---

### InvoiceService (`invoice-service.ts`)

Generates GST-compliant invoices.

```mermaid
graph LR
    subgraph "InvoiceService Functions"
        A[createInvoice]
        B[createInvoiceFromPayment]
        C[getInvoiceById]
        D[getUserInvoices]
        E[getAllInvoices]
    end

    PM[Payment] --> B
    B --> A
    A --> IN[(Invoice)]
    IN --> C & D & E
```

> **Invoice PDF Fix (Mar 2026):** Credit/discount calculations in generated PDFs now use `originalAmount` (immutable, set at payment creation) instead of `amount` (mutable, can change after partial refunds). This prevents discount values from drifting when partial refunds modify the payment's `amount` field.

---

## Database Models

### Entity Relationship Diagram

```mermaid
erDiagram
    ConsultantProfile ||--o{ ConsultantEarnings : has
    ConsultantProfile ||--o{ Payout : receives
    ConsultantProfile ||--o{ PayoutAccount : owns
    Payment ||--|| ConsultantEarnings : generates
    Payment ||--o| Invoice : creates
    Payout ||--o{ ConsultantEarnings : includes
    PayoutAccount ||--o{ Payout : uses

    ConsultantEarnings {
        string id PK
        string consultantProfileId FK
        string paymentId FK
        string payoutId FK
        int grossAmount
        int platformFee
        int consultantShare
        int refundedShareAmount
        enum status
        datetime holdUntil
        datetime paidAt
    }

    Payout {
        string id PK
        string consultantProfileId FK
        enum provider
        string providerPayoutId
        int amount
        string currency
        enum status
        enum method
        string batchId
        string failureReason
        int retryCount
        datetime processedAt
        datetime approvedAt
        string approvedBy
        string idempotencyKey
    }

    PayoutAccount {
        string id PK
        string consultantProfileId FK
        enum provider
        enum accountType
        string accountHolderName
        string bankName
        string accountNumberLast4
        string ifscCode
        string upiId
        string stripeAccountId
        string razorpayContactId
        string razorpayFundAccId
        boolean isDefault
        boolean isVerified
    }

    Invoice {
        string id PK
        string paymentId FK
        string invoiceNumber
        int amount
        string currency
        enum status
        json items
        string pdfUrl
        datetime dueDate
        datetime paidAt
        int taxAmount
        float taxRate
        string hsnCode
    }
```

---

## Provider Integrations

### RazorpayX (INR Payouts)

```mermaid
sequenceDiagram
    participant PS as PayoutService
    participant RX as RazorpayX Service
    participant API as RazorpayX API
    participant WH as Webhook Handler

    PS->>RX: processSinglePayout(payout)
    RX->>RX: getOrCreateContact()
    RX->>API: POST /contacts
    API-->>RX: contact_id

    RX->>RX: getOrCreateFundAccount()
    RX->>API: POST /fund_accounts
    API-->>RX: fund_account_id

    RX->>API: POST /payouts
    Note over API: X-Payout-Idempotency header
    API-->>RX: payout_id, status: processing

    RX-->>PS: { success, providerPayoutId }
    PS->>PS: Update Payout status

    Note over API,WH: Async webhook
    API->>WH: payout.processed / payout.failed
    WH->>PS: handlePayoutWebhook()
    PS->>PS: Update final status
```

**Fund Account Types:**

- `bank_account`: NEFT/IMPS/RTGS transfer
- `vpa`: UPI transfer (instant)

---

### Stripe Connect (International)

```mermaid
sequenceDiagram
    participant PS as PayoutService
    participant SC as Stripe Connect Service
    participant API as Stripe API
    participant WH as Webhook Handler

    Note over PS,SC: One-time: Account Onboarding
    PS->>SC: createConnectedAccount()
    SC->>API: POST /accounts
    API-->>SC: account_id

    SC->>API: POST /account_links
    API-->>SC: onboarding_url
    SC-->>PS: Redirect consultant to KYC

    Note over PS,SC: Recurring: Transfers
    PS->>SC: createTransfer(payout)
    SC->>API: POST /transfers
    Note over API: Idempotency key in header
    API-->>SC: transfer_id

    SC-->>PS: { success, providerPayoutId }

    Note over API,WH: Async webhook
    API->>WH: transfer.created / transfer.failed
    WH->>PS: handlePayoutWebhook()
```

**Account Types:**

- `express`: Stripe-hosted onboarding
- `standard`: Full Stripe dashboard access
- `custom`: Platform-controlled (not used)

---

## Automation Workflow

```mermaid
graph TB
    subgraph "Hourly"
        H1[GitHub Actions Trigger]
        H2[release-earnings.ts]
        H3[PENDING → READY]
    end

    subgraph "Weekly Monday 1:30 AM IST"
        W1[GitHub Actions Trigger]
        W2[create-payout-batch.ts]
        W3[Group READY earnings]
        W4[Create Payout records]
        W5{Amount < ₹5000?}
        W6[Auto-approve]
        W7[Pending approval]
    end

    subgraph "Weekly Monday 2:30 AM IST"
        P1[GitHub Actions Trigger]
        P2[process-payouts.ts]
        P3[Get APPROVED payouts]
        P4{Provider?}
        P5[RazorpayX]
        P6[Stripe Connect]
    end

    H1 --> H2 --> H3
    W1 --> W2 --> W3 --> W4 --> W5
    W5 -->|Yes| W6
    W5 -->|No| W7

    P1 --> P2 --> P3 --> P4
    P4 -->|Razorpay account| P5
    P4 -->|Stripe account| P6

    style H3 fill:#10b981,color:#fff
    style W6 fill:#10b981,color:#fff
    style W7 fill:#f59e0b,color:#fff
```

---

## Data Flow Summary

```mermaid
flowchart LR
    A[Payment Success] --> B[Create Earnings]
    B --> C{Hold Period}
    C -->|24-168 hrs| D[Release to READY]
    D --> E[Weekly Batch]
    E --> F{Amount Check}
    F -->|< ₹5000| G[Auto-Approve]
    F -->|>= ₹5000| H[Admin Review]
    H -->|Approve| I[APPROVED]
    H -->|Reject| J[Return to READY]
    G --> I
    I --> K[Process Payout]
    K --> L{Provider}
    L -->|INR| M[RazorpayX]
    L -->|USD/EUR| N[Stripe]
    M & N --> O[Webhook]
    O --> P{Status}
    P -->|Success| Q[COMPLETED]
    P -->|Failed| R[Retry Queue]
    Q --> S[Earnings: PAID]

    style A fill:#3b82f6,color:#fff
    style Q fill:#10b981,color:#fff
    style R fill:#ef4444,color:#fff
```

---

## Next: [02-earnings-lifecycle.md](./02-earnings-lifecycle.md)
