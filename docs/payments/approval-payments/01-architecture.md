# Architecture & Technical Implementation

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Layer                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Consultant   │  │  Consultee   │  │    Admin     │          │
│  │  Dashboard   │  │  Dashboard   │  │  Dashboard   │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
└─────────┼──────────────────┼──────────────────┼─────────────────┘
          │                  │                  │
          │ React Query (Auto-refresh)          │
          │                  │                  │
┌─────────┼──────────────────┼──────────────────┼─────────────────┐
│         │     Next.js App Router (API Routes) │                 │
│  ┌──────▼───────┐  ┌──────▼───────┐  ┌──────▼───────┐          │
│  │  Approval    │  │  Pending     │  │   Admin      │          │
│  │  Endpoints   │  │  Payments    │  │   Monitor    │          │
│  └──────┬───────┘  └──────────────┘  └──────────────┘          │
│         │                                                        │
│         │                                                        │
│  ┌──────▼─────────────────────────────────────────────┐        │
│  │         Triple-Layer Protection                     │        │
│  │  ┌────────────────────────────────────────────┐    │        │
│  │  │ Layer 1: Distributed Lock (Upstash Redis) │    │        │
│  │  └──────┬─────────────────────────────────────┘    │        │
│  │         │                                            │        │
│  │  ┌──────▼─────────────────────────────────────┐    │        │
│  │  │ Layer 2: Serializable Transaction (Prisma) │    │        │
│  │  └──────┬─────────────────────────────────────┘    │        │
│  │         │                                            │        │
│  │  ┌──────▼─────────────────────────────────────┐    │        │
│  │  │ Layer 3: Idempotency Check (Application)   │    │        │
│  │  └────────────────────────────────────────────┘    │        │
│  └────────────────────────────────────────────────────┘        │
└─────────┬──────────────────────────────────────────────────────┘
          │
          │
┌─────────▼──────────────────────────────────────────────────────┐
│                    External Services                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Upstash Redis│  │  Stripe API  │  │  Resend API  │          │
│  │ (Locking)    │  │  (Payment)   │  │  (Email)     │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
          │                  │                  │
          │                  │                  │
┌─────────▼──────────────────▼──────────────────▼─────────────────┐
│                     Database Layer                              │
│  ┌──────────────────────────────────────────────────────┐      │
│  │              PostgreSQL (Prisma ORM)                 │      │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐           │      │
│  │  │Consultation│  │Subscription│  │  Payment │         │      │
│  │  └──────────┘  └──────────┘  └──────────┘           │      │
│  └──────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

### 1. Approval Request Flow

```typescript
// app/api/bookings/consultations/[consultationId]/route.ts
export async function PATCH(request, { params }) {
  const { consultationId } = await params;
  const { status } = await request.json();

  // LAYER 1: Distributed Lock
  let lock;
  if (status === AppointmentStatus.APPROVED) {  // enum renamed from `RequestStatus`
    lock = await lockConsultationApproval(consultationId, 30000);
  }

  try {
    // LAYER 2: Serializable Transaction
    const result = await prisma.$transaction(
      async (tx) => {
        // Fetch current state inside transaction
        const currentConsultation = await tx.consultation.findUnique({
          where: { id: consultationId },
        });

        // LAYER 3: Idempotency Check
        if (
          currentConsultation.status ===
          AppointmentStatus.APPROVED_PENDING_PAYMENT   // field/enum renamed from `requestStatus`/AppointmentStatus
        ) {
          return { duplicate: true };
        }

        // Check if payment exists
        const hasPayment = await checkConsultationPayment(consultationId);

        if (hasPayment) {
          // Payment exists - create appointments immediately
          await createAppointmentForConsultation(consultation);
          return { data: consultation, duplicate: false };
        } else {
          // No payment - generate payment link
          const paymentResult = await generatePaymentLink(consultation);

          // Update status to APPROVED_PENDING_PAYMENT
          const updatedConsultation = await tx.consultation.update({
            where: { id: consultationId },
            data: {
              status: AppointmentStatus.APPROVED_PENDING_PAYMENT,  // field/enum renamed
              requestNotes: `${consultation.requestNotes}\n\n[System] Payment link generated: ${paymentResult.checkoutUrl}`,
            },
          });

          // Send payment link email
          await sendPaymentLinkEmail({
            email: updatedConsultation.requestedBy.user.email,
            name: updatedConsultation.requestedBy.user.name,
            consultantName:
              updatedConsultation.consultationPlan.consultantProfile.user.name,
            appointmentType: "consultation",
            amount: paymentResult.amount,
            currency: paymentResult.currency,
            paymentUrl: paymentResult.checkoutUrl,
            expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
          });

          return { data: updatedConsultation, duplicate: false };
        }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10000,
        timeout: 30000,
      },
    );

    return NextResponse.json(result);
  } finally {
    // Always release lock
    if (lock) {
      await unlockApproval(lock);
    }
  }
}
```

### 2. Webhook Payment Flow

```typescript
// lib/payments/webhooks/handlers.ts
export async function handlePaymentSuccess(paymentIntentId, metadata) {
  return await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
    });

    // Idempotency check
    if (payment.paymentStatus === PaymentStatus.SUCCEEDED) {
      console.log(`Payment ${paymentIntentId} already processed.`);
      return;
    }

    // Update payment status
    await tx.payment.update({
      where: { id: payment.id },
      data: { paymentStatus: PaymentStatus.SUCCEEDED },
    });

    // Create or confirm appointment
    let appointment;
    if (payment.appointmentId) {
      appointment = await tx.appointment.findUnique({
        where: { id: payment.appointmentId },
      });
    } else {
      appointment = await createAppointmentFromWebhook(tx, metadata, payment);
    }

    // Confirm appointment and update consultation/subscription status
    await confirmExistingAppointment(tx, appointment.id);

    // Send success email
    await sendPaymentSuccessNotification(
      tx,
      payment,
      appointment.id,
      metadata.appointmentType,
    );
  });
}
```

## Database Schema

### Consultation Table

```prisma
model Consultation {
  id                  String        @id @default(cuid())
  status              AppointmentStatus @default(PENDING)  // renamed from `requestStatus`/AppointmentStatus
  requestNotes        String?       @db.Text
  consultationPlan    ConsultationPlan @relation(...)
  requestedBy         ConsulteeProfile @relation(...)
  appointment         Appointment?
  createdAt           DateTime      @default(now())
  updatedAt           DateTime      @updatedAt
}
```

### Subscription Table

```prisma
model Subscription {
  id                       String        @id @default(cuid())
  status                   AppointmentStatus @default(PENDING)  // renamed from `requestStatus`/AppointmentStatus
  requestNotes             String?       @db.Text
  schedulingPeriodStartsAt DateTime?
  schedulingPeriodEndsAt   DateTime?
  subscriptionPlan         SubscriptionPlan @relation(...)
  requestedBy              ConsulteeProfile @relation(...)
  appointments             Appointment[]
  createdAt                DateTime      @default(now())
  updatedAt                DateTime      @updatedAt
}
```

### AppointmentStatus Enum

> **Rename note:** The enum was `AppointmentStatus` and the DB column was `status`; after the terminology-unification refactor both are renamed to `AppointmentStatus` / `status`. The values are unchanged.

```prisma
enum AppointmentStatus {
  PENDING                    // Initial state
  APPROVED_PENDING_PAYMENT   // Approved, awaiting payment
  APPROVED                   // Paid and confirmed
  SCHEDULED                  // Session time confirmed
  COMPLETED                  // Session held
  REJECTED                   // Declined
  CANCELLED                  // Cancelled
  EXPIRED                    // Payment window lapsed
}
```

### Guarded Transitions — `REQUEST_ALLOWED_FROM`

**File:** `lib/booking/transitions.ts` lines 33–42.

The allowed-from set is baked directly into every `UPDATE` statement's `WHERE` clause (`status: { in: allowedFrom }`), so an illegal transition matches zero rows instead of corrupting state. There is no separate pre-check that can race the write.

```typescript
// lib/booking/transitions.ts
export const REQUEST_ALLOWED_FROM: Record<AppointmentStatus, AppointmentStatus[]> = {
  PENDING:                  ["APPROVED_PENDING_PAYMENT"],
  APPROVED:                 ["PENDING", "APPROVED_PENDING_PAYMENT"],
  APPROVED_PENDING_PAYMENT: ["PENDING", "APPROVED"],
  SCHEDULED:                ["APPROVED", "APPROVED_PENDING_PAYMENT"],
  COMPLETED:                ["APPROVED", "SCHEDULED"],
  REJECTED:                 ["PENDING", "APPROVED_PENDING_PAYMENT"],
  CANCELLED:                ["PENDING", "APPROVED", "APPROVED_PENDING_PAYMENT", "SCHEDULED"],
  EXPIRED:                  ["PENDING", "APPROVED_PENDING_PAYMENT"],
};
```

**`APPROVED_PENDING_PAYMENT` semantics:** This state marks a consultation/subscription that a consultant has approved *before* the consultee has paid. The payment link is generated at this point. If the consultee cancels (via `DELETE /api/checkout/pending/[paymentId]`), the `fromIn` is narrowed to `["PENDING", "APPROVED_PENDING_PAYMENT"]` — an `APPROVED` parent (post-payment) blocks the cancel and the Serializable transaction rolls back. An `APPROVED` parent means payment already succeeded; the cancel-pending path is the wrong tool.

## Concurrency Handling

### Why Triple-Layer Protection?

| Layer                        | Purpose                                       | Protection Against                           | Trade-off                                   |
| ---------------------------- | --------------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| **Distributed Lock**         | Prevent concurrent approvals across instances | Multiple API servers processing same request | Adds 50-100ms latency                       |
| **Serializable Transaction** | Ensure database-level isolation               | Race conditions within transaction           | May cause serialization errors (auto-retry) |
| **Idempotency Check**        | Application-level duplicate detection         | Network retries, user double-clicks          | Requires careful state management           |

### Race Condition Scenarios

#### Scenario 1: Concurrent Approval Clicks

```
Time  Instance A                    Instance B
T0    User clicks "Approve" ────►   [Request arrives]
T1    Acquire lock ✓                Attempt lock (WAIT)
T2    Check status: PENDING          [Blocked on lock]
T3    Generate payment link          [Still blocked]
T4    Update status: APPROVED_...    [Still blocked]
T5    Release lock                   [Lock acquired]
T6                                   Check status: APPROVED_PENDING_PAYMENT
T7                                   Return "Already processing" (duplicate: true)
T8                                   Release lock
```

#### Scenario 2: Payment Webhook Race

```
Time  Webhook 1                     Webhook 2
T0    payment.succeeded ────►       payment.succeeded ────►
T1    Start transaction              Start transaction
T2    Check status: SUCCEEDED?       Check status: SUCCEEDED?
      NO                             NO
T3    Update to SUCCEEDED ✓          [Blocked - waiting for T1's commit]
T4    Create appointments            [Still blocked]
T5    Commit                         [Transaction starts]
T6                                   Check status: SUCCEEDED? YES
T7                                   Return early (already processed)
T8                                   Commit (no changes)
```

## Error Handling

### Lock Acquisition Failure

```typescript
try {
  lock = await lockConsultationApproval(consultationId, 30000);
} catch (error) {
  return NextResponse.json(
    { error: "Another approval is in progress. Please try again." },
    { status: 409 }, // HTTP 409 Conflict
  );
}
```

### Transaction Serialization Error

```typescript
// Prisma automatically retries serialization errors
// But we also have custom retry logic in the transaction settings
{
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 10000,  // Wait up to 10s for transaction to start
  timeout: 30000,  // Transaction must complete within 30s
}
```

### Email Delivery Failure

```typescript
// Emails are sent inside transaction but failures don't block payment processing
try {
  await sendPaymentLinkEmail({ ... });
} catch (error) {
  // Log error but don't throw - payment link was still generated
  console.error("Failed to send payment link email:", error);
}
```

## Performance Optimizations

### 1. **Connection Pooling**

```typescript
// lib/redis.ts uses connection pooling
const redlock = new Redlock([redis], {
  driftFactor: 0.01,
  retryCount: 3,
  retryDelay: 200,
  retryJitter: 200,
});
```

### 2. **Query Optimization**

```typescript
// Fetch all related data in single query
const consultation = await tx.consultation.findUnique({
  where: { id: consultationId },
  include: {
    consultationPlan: {
      include: {
        consultantProfile: { include: { user: true } },
      },
    },
    requestedBy: { include: { user: true } },
    appointment: { include: { payment: true } },
  },
});
```

### 3. **React Query Caching**

```typescript
// providers/ReactQueryProvider.tsx
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000, // Cache for 1 minute
      gcTime: 5 * 60 * 1000, // Garbage collect after 5 minutes
      refetchOnWindowFocus: true, // Refresh when user returns
    },
  },
});
```

## Monitoring & Observability

### Logging Strategy

```typescript
// Log levels and contexts
console.log(`✅ Payment ${paymentIntentId} processed successfully`); // Success
console.warn(`Payment link expires soon: ${consultationId}`); // Warning
console.error(`Failed to acquire lock for ${consultationId}`); // Error
```

### Metrics to Monitor

1. **Lock Acquisition Time**: Average time to acquire Redis lock
2. **Transaction Duration**: Time from start to commit
3. **Email Delivery Rate**: Success rate of email sends
4. **Payment Expiry Rate**: % of payment links that expire unpaid
5. **Duplicate Detection Rate**: How often idempotency checks prevent duplicates

### Health Checks

- **Redis**: Monitor Upstash dashboard for connection errors
- **Database**: Track transaction serialization failures
- **Email**: Monitor Resend dashboard for bounces/failures
- **Payment**: Track Stripe webhook delivery success

## Scalability Considerations

### Horizontal Scaling

- **Distributed locks** enable multiple Next.js instances to coordinate
- **Stateless API routes** allow load balancing across instances
- **React Query** reduces server load through client-side caching

### Vertical Scaling Limits

- **Redis TTL**: 30-second lock timeout limits concurrent approvals
- **Transaction timeout**: 30-second transaction limit for complex appointment creation
- **Email rate limits**: Resend API has rate limits per account tier

### Future Enhancements

1. **Lock-free optimistic concurrency**: Use database version fields
2. **Event sourcing**: Append-only event log for audit trail
3. **Message queue**: Decouple email sending from approval flow
4. **CDN caching**: Cache static payment link pages
