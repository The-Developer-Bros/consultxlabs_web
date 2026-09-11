# Refunds & Disputes Architecture

> **Moved (org/B2B side):** The organization-side documentation for this subsystem now lives in [`docs/enterprise/10-money-and-ledger/10-refunds.md`](../../enterprise/10-money-and-ledger/10-refunds.md), [`11-disputes.md`](../../enterprise/10-money-and-ledger/11-disputes.md), and [`12-payment-webhooks.md`](../../enterprise/10-money-and-ledger/12-payment-webhooks.md). This file keeps the consumer-marketplace (B2C) and gateway-generic details only.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Admin Dashboard                              │
│                    (Refund/Dispute Management)                       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          API Layer                                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │ /api/payments/  │  │ /api/payments/  │  │ /api/admin/     │     │
│  │ refunds         │  │ disputes        │  │ disputes        │     │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘     │
└───────────┼────────────────────┼────────────────────┼───────────────┘
            │                    │                    │
            ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Payment Gateway Layer                           │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    lib/payments/index.ts                     │   │
│  │        createRefund() | listRefunds() | submitEvidence()     │   │
│  └──────────────────────────┬──────────────────────────────────┘   │
│                             │                                        │
│  ┌──────────────────────────┴──────────────────────────┐           │
│  │                                                      │           │
│  ▼                                                      ▼           │
│  ┌─────────────────────┐              ┌─────────────────────┐      │
│  │ lib/payments/core/  │              │ lib/payments/core/  │      │
│  │ stripe.ts           │              │ razorpay.ts         │      │
│  │ - createStripeRefund│              │ - createRazorpay... │      │
│  │ - submitStripe...   │              │                     │      │
│  └─────────┬───────────┘              └─────────┬───────────┘      │
└────────────┼────────────────────────────────────┼───────────────────┘
             │                                    │
             ▼                                    ▼
┌─────────────────────┐              ┌─────────────────────┐
│    Stripe API       │              │   Razorpay API      │
│  - Refunds          │              │   - Refunds         │
│  - Disputes         │              │   - Disputes        │
└─────────────────────┘              └─────────────────────┘
```

---

## Component Details

### API Routes

| Route                      | File                                          | Description                        |
| -------------------------- | --------------------------------------------- | ---------------------------------- |
| `/api/payments/refunds`    | `app/api/payments/refunds/route.ts`           | Create and list refunds            |
| `/api/payments/disputes`   | `app/api/payments/disputes/route.ts`          | List disputes, submit evidence     |
| `/api/admin/disputes`      | `app/api/admin/disputes/route.ts`             | Admin disputes list with filtering |
| `/api/admin/disputes/[id]` | `app/api/admin/disputes/[disputeId]/route.ts` | Single dispute details             |

### Core Payment Libraries

| File                            | Functions                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `lib/payments/index.ts`         | Gateway abstraction: `createRefund()`, `listRefunds()`, `listDisputes()`, `submitDisputeEvidence()`   |
| `lib/payments/core/stripe.ts`   | Stripe implementation: `createStripeRefund()`, `listStripeRefunds()`, `submitStripeDisputeEvidence()` |
| `lib/payments/core/razorpay.ts` | Razorpay implementation: `createRazorpayRefund()`, `listRazorpayRefunds()`                            |

---

## Database Schema

### Refund Model

```prisma
model Refund {
  id             String         @id @default(cuid())
  amount         Int            // Amount in smallest currency unit (cents/paise)
  currency       String         @default("USD")
  reason         String?        // Optional reason for refund
  status         String         // PENDING, SUCCEEDED, FAILED, CANCELLED
  refundId       String         @unique  // Gateway-assigned refund ID
  paymentGateway PaymentGateway
  metadata       Json?          // Additional gateway-specific data
  paymentId      String
  payment        Payment        @relation(fields: [paymentId], references: [id])
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt

  @@index([paymentId])
  @@index([status])
}
```

### Dispute Model

```prisma
model Dispute {
  id                 String         @id @default(cuid())
  disputeId          String         @unique  // Gateway dispute ID (dp_xxx for Stripe)
  amount             Int            // Disputed amount
  currency           String         @default("USD")
  reason             String?        // Dispute reason (fraudulent, product_not_received, etc.)
  status             DisputeStatus  // Current dispute status
  dueBy              DateTime?      // Evidence submission deadline
  isChargeRefundable Boolean        @default(false)
  evidence           Json?          // Submitted evidence
  paymentGateway     PaymentGateway
  paymentId          String
  payment            Payment        @relation(fields: [paymentId], references: [id])
  createdAt          DateTime       @default(now())
  updatedAt          DateTime       @updatedAt

  @@index([paymentId])
  @@index([status])
}

enum DisputeStatus {
  WARNING_NEEDS_RESPONSE   // Early fraud warning
  WARNING_UNDER_REVIEW
  WARNING_CLOSED
  NEEDS_RESPONSE           // Formal dispute
  UNDER_REVIEW
  CHARGE_REFUNDED
  WON
  LOST
}
```

---

## Gateway Integration

### Stripe

**Refunds:**

- Full API support via `stripe.refunds.create()`
- Supports partial refunds
- Immediate status feedback

**Disputes:**

- Full API support via `stripe.disputes.update()`
- Evidence submission via API
- Webhook notifications for status changes

### Razorpay

**Refunds:**

- Full API support via `razorpay.payments.refund()`
- Supports partial refunds
- Status via webhooks

**Disputes:**

- NO API support for evidence submission
- Must handle via Razorpay Dashboard
- Webhook notifications only

---

## Data Flow

### Refund Creation

```
Admin Request
     │
     ▼
┌─────────────────┐
│ Validate Input  │
│ (Zod schema)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Phase 1: TX     │──── Creates PENDING refund record
│ Claim Amount    │     (prevents race conditions)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Phase 2: API    │──── Calls Stripe/Razorpay
│ Gateway Call    │     (outside transaction)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Phase 3: Update │──── Updates to SUCCEEDED/FAILED
│ Final Status    │
└────────┬────────┘
         │
         ▼
    API Response
```

### Dispute Evidence Submission

```
Admin Request
     │
     ▼
┌─────────────────┐
│ Validate Input  │
│ Check Status    │──── Reject if already resolved
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Gateway Call    │──── Submit to Stripe (outside TX)
│ (Stripe only)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Update Record   │──── Store evidence, update status
└────────┬────────┘
         │
         ▼
    API Response
```

---

## Security Considerations

1. **Authentication**: All endpoints require authenticated admin/staff session
2. **Authorization**: Role check (ADMIN or STAFF) before processing
3. **Input Validation**: Zod schemas validate all request data
4. **Gateway Secrets**: Stored in environment variables, never exposed
5. **Webhook Verification**: All webhook payloads verified with signatures

---

## Related Files

```
app/api/payments/
├── refunds/
│   └── route.ts          # Refund API (POST, GET)
└── disputes/
    └── route.ts          # Disputes API (POST, GET)

app/api/admin/disputes/
├── route.ts              # Admin disputes list
└── [disputeId]/
    └── route.ts          # Single dispute details

lib/payments/
├── index.ts              # Gateway abstraction
└── core/
    ├── stripe.ts         # Stripe implementation
    └── razorpay.ts       # Razorpay implementation

prisma/
└── schema.prisma         # Refund, Dispute models
```
