# API Reference

## Approval Endpoints

### PATCH /api/bookings/consultations/[consultationId]

Approve or update consultation request status.

**Request**:

```typescript
{
  status: AppointmentStatus; // APPROVED, REJECTED, etc. (renamed from `RequestStatus`)
}
```

**Response** (Payment link generated):

```json
{
  "data": {
    "id": "clx123abc",
    "status": "APPROVED_PENDING_PAYMENT",
    "requestNotes": "...[System] Payment link generated: https://...",
    "consultationPlan": { ... },
    "requestedBy": { ... },
    "appointment": null
  },
  "message": "Consultation approved. Payment link sent to user.",
  "paymentUrl": "https://checkout.stripe.com/c/pay/...",
  "requiresPayment": true,
  "paymentAmount": 100,
  "paymentCurrency": "USD"
}
```

**Response** (Payment exists):

```json
{
  "data": {
    "id": "clx123abc",
    "status": "APPROVED",
    "consultationPlan": { ... },
    "requestedBy": { ... },
    "appointment": { ... }
  }
}
```

**Response** (Duplicate/Idempotent):

```json
{
  "data": { ... },
  "message": "Approval already in progress"
}
```

**Error Responses**:

```json
// 404 Not Found
{
  "error": "Consultation not found"
}

// 409 Conflict (Lock acquisition failed)
{
  "error": "Another approval is in progress for this consultation. Please try again."
}

// 500 Internal Server Error
{
  "error": "An error occurred while updating consultation"
}
```

**Race Condition Protection**:

- Distributed lock (30s TTL)
- Serializable transaction
- Idempotency checks

**Example**:

```bash
curl -X PATCH https://familiarise.com/api/bookings/consultations/clx123abc \
  -H "Content-Type: application/json" \
  -d '{"status": "APPROVED"}'
```

---

### PATCH /api/bookings/subscriptions/[subscriptionId]

Approve or update subscription request status.

**Request**:

```typescript
{
  status: AppointmentStatus; // APPROVED, REJECTED, etc. (renamed from `RequestStatus`)
}
```

**Response** (Payment link generated):

```json
{
  "data": {
    "id": "clx456def",
    "status": "APPROVED_PENDING_PAYMENT",
    "requestNotes": "...[System] Payment link generated: https://...",
    "subscriptionPlan": { ... },
    "requestedBy": { ... },
    "appointments": []
  },
  "message": "Subscription approved. Payment link sent to user.",
  "paymentUrl": "https://checkout.stripe.com/c/pay/...",
  "requiresPayment": true,
  "paymentAmount": 500,
  "paymentCurrency": "USD"
}
```

**Response** (Payment exists):

```json
{
  "data": {
    "id": "clx456def",
    "status": "APPROVED",
    "subscriptionPlan": { ... },
    "requestedBy": { ... },
    "appointments": [ ... ]
  }
}
```

**Error Responses**: Same as consultation endpoint

---

## Dashboard Endpoints

### GET /api/dashboard/consultee/[consulteeId]/pending-payments

Fetch all pending payment links for a consultee.

**Response**:

```json
{
  "pendingPayments": [
    {
      "id": "clx123abc",
      "type": "consultation",
      "title": "30-Minute Career Consultation",
      "consultantName": "Dr. Jane Smith",
      "amount": 100,
      "currency": "USD",
      "paymentUrl": "https://checkout.stripe.com/c/pay/...",
      "approvedAt": "2025-01-13T10:00:00.000Z",
      "expiresAt": "2025-01-15T10:00:00.000Z",
      "isExpiringSoon": true
    },
    {
      "id": "clx456def",
      "type": "subscription",
      "title": "3-Month Mentorship Program",
      "consultantName": "John Doe",
      "amount": 500,
      "currency": "USD",
      "paymentUrl": "https://checkout.stripe.com/c/pay/...",
      "approvedAt": "2025-01-14T08:00:00.000Z",
      "expiresAt": "2025-01-16T08:00:00.000Z",
      "isExpiringSoon": false
    }
  ],
  "count": 2
}
```

**Fields**:

- `isExpiringSoon`: true if < 24 hours remaining
- `isExpired`: true if expiry time has passed (excluded from results)

**Example**:

```bash
curl https://familiarise.com/api/dashboard/consultee/clxConsultee123/pending-payments
```

---

### GET /api/dashboard/admin/approval-payments

Fetch all approval payments for admin monitoring.

**Response**:

```json
{
  "approvalPayments": [
    {
      "id": "clx123abc",
      "type": "consultation",
      "title": "30-Minute Career Consultation",
      "consultantName": "Dr. Jane Smith",
      "consultantEmail": "jane@example.com",
      "consulteeName": "Alice Johnson",
      "consulteeEmail": "alice@example.com",
      "amount": 100,
      "currency": "USD",
      "paymentUrl": "https://checkout.stripe.com/c/pay/...",
      "approvedAt": "2025-01-13T10:00:00.000Z",
      "expiresAt": "2025-01-15T10:00:00.000Z",
      "isExpired": true,
      "isExpiringSoon": false,
      "status": "APPROVED_PENDING_PAYMENT"
    }
  ],
  "count": 1,
  "expiredCount": 1,
  "expiringSoonCount": 0,
  "activeCount": 0
}
```

**Sorting**:

1. Expired items first
2. Expiring soon items next
3. Active items by approval date (newest first)

**Example**:

```bash
curl https://familiarise.com/api/dashboard/admin/approval-payments \
  -H "Authorization: Bearer <admin-token>"
```

---

## Cleanup Endpoints

### GET /api/cleanup/approval-payments

Manually trigger cleanup of expired payment links.

**Cron Schedule**: Runs automatically every hour (0 _/1 _ \* \*)

**Response**:

```json
{
  "success": true,
  "timestamp": "2025-01-15T10:00:00.000Z",
  "summary": {
    "consultations": {
      "found": 3,
      "reverted": 3,
      "failed": 0
    },
    "subscriptions": {
      "found": 2,
      "reverted": 2,
      "failed": 0
    },
    "total": {
      "reverted": 5,
      "failed": 0
    }
  },
  "details": {
    "consultations": [
      {
        "id": "clx123abc",
        "type": "consultation",
        "success": true
      }
    ],
    "subscriptions": [
      {
        "id": "clx456def",
        "type": "subscription",
        "success": true
      }
    ]
  }
}
```

**Error Response**:

```json
{
  "success": false,
  "error": "Database connection failed",
  "timestamp": "2025-01-15T10:00:00.000Z"
}
```

**Example**:

```bash
# Manual trigger
curl https://familiarise.com/api/cleanup/approval-payments
```

---

## Payment Webhook Endpoints

### POST /api/webhooks/stripe

Handle Stripe payment webhooks.

**Events Processed**:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`

**Request** (Stripe sends):

```typescript
{
  type: "payment_intent.succeeded",
  data: {
    object: {
      id: "pi_...",
      amount: 10000,
      currency: "usd",
      status: "succeeded",
      metadata: {
        appointmentType: "CONSULTATION",
        consultationId: "clx123abc",
        planId: "clxPlan123",
        userId: "clxUser123",
        ...
      }
    }
  }
}
```

**Processing Flow**:

1. Verify Stripe signature
2. Extract payment intent ID and metadata
3. Call `handlePaymentSuccess()` or `handlePaymentFailure()`
4. Update payment status in database
5. Create appointments if needed
6. Update consultation/subscription status
7. Send email notification
8. Return 200 OK

**Response**:

```json
{
  "received": true
}
```

**Idempotency**: Safe to retry - checks payment status before processing

---

## Payment Creation Endpoint

### POST /api/payments/create-approval-payment

Create payment intent for approved consultations/subscriptions.

**Called by**: Approval endpoints (internal use)

**Request**:

```typescript
{
  userId: string;
  appointmentType: "CONSULTATION" | "SUBSCRIPTION";
  consultationId?: string;
  subscriptionId?: string;
  planId: string;
  paymentGateway: "STRIPE";
  startsAt?: string;    // renamed from `slotStartTimeInUTC`
  endsAt?: string;      // renamed from `slotEndTimeInUTC`
  schedulingPeriodStartsAt?: string;
  schedulingPeriodEndsAt?: string;
  notes?: string;
}
```

**Response**:

```json
{
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_...",
  "paymentIntentId": "pi_...",
  "amount": 10000,
  "currency": "usd"
}
```

**Example** (internal call):

```typescript
const paymentResult = await createApprovalPaymentIntent({
  userId: "clxUser123",
  appointmentType: "CONSULTATION",
  consultationId: "clx123abc",
  planId: "clxPlan123",
  paymentGateway: PaymentGateway.STRIPE,
  startsAt: "2025-01-20T14:00:00.000Z",   // renamed from `slotStartTimeInUTC`
  endsAt: "2025-01-20T14:30:00.000Z",     // renamed from `slotEndTimeInUTC`
  notes: "Career transition consultation",
});
```

---

## Rate Limiting

### Approval Endpoints

**Limits**:

- 10 requests/minute per consultation/subscription ID
- 100 requests/hour per user

**Headers**:

```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 9
X-RateLimit-Reset: 1642003200
```

**Error Response** (429 Too Many Requests):

```json
{
  "error": "Rate limit exceeded. Please try again in 60 seconds."
}
```

### Dashboard Endpoints

**Limits**:

- 60 requests/minute per user
- No burst limit

### Cleanup Endpoints

**Limits**:

- Admin only
- 1 request/minute (manual triggers)
- Cron runs automatically (not subject to rate limits)

---

## Authentication

### Required Headers

```
Authorization: Bearer <jwt-token>
Content-Type: application/json
```

### Permissions

| Endpoint                                           | Role Required              |
| -------------------------------------------------- | -------------------------- |
| PATCH /api/bookings/consultations/[id]               | CONSULTANT (owner)         |
| PATCH /api/bookings/subscriptions/[id]               | CONSULTANT (owner)         |
| GET /api/dashboard/consultee/[id]/pending-payments | CONSULTEE (owner) or ADMIN |
| GET /api/dashboard/admin/approval-payments         | ADMIN                      |
| GET /api/cleanup/approval-payments                 | ADMIN or Cron              |

---

## Error Codes

| Status Code | Meaning               | Common Cause                                 |
| ----------- | --------------------- | -------------------------------------------- |
| 400         | Bad Request           | Invalid request body or parameters           |
| 401         | Unauthorized          | Missing or invalid authentication token      |
| 403         | Forbidden             | User lacks permission for this resource      |
| 404         | Not Found             | Consultation/subscription doesn't exist      |
| 409         | Conflict              | Lock acquisition failed (concurrent request) |
| 429         | Too Many Requests     | Rate limit exceeded                          |
| 500         | Internal Server Error | Database error, payment gateway error, etc.  |

---

## Response Times

**Target Latencies** (p99):

| Endpoint                | Target  | Typical |
| ----------------------- | ------- | ------- |
| Approval (no payment)   | < 2s    | 500ms   |
| Approval (with payment) | < 3s    | 1.5s    |
| Dashboard queries       | < 500ms | 200ms   |
| Cleanup job             | < 30s   | 5s      |
| Webhooks                | < 2s    | 800ms   |

**Latency Breakdown** (approval with payment):

- Lock acquisition: 50-100ms
- Payment intent creation: 500-1000ms
- Database transaction: 200-500ms
- Email sending: 1-3s (async, doesn't block response)

---

## Idempotency

### Safe to Retry

All endpoints are idempotent and safe to retry:

1. **Approval endpoints**: Check current status before processing
2. **Webhook handlers**: Verify payment status before updating
3. **Cleanup job**: Only processes items meeting criteria

### Idempotency Keys

```bash
# Stripe automatically handles retries
curl -X POST https://api.stripe.com/v1/payment_intents \
  -H "Idempotency-Key: unique-key-123"
```

### Deduplication Window

- Distributed locks: 30 seconds
- Database checks: Within transaction
- Webhook events: Stripe deduplicates for 24 hours

---

## Webhooks

### Stripe Webhook Configuration

**Endpoint**: `https://familiarise.com/api/webhooks/stripe`

**Events to Subscribe**:

```
payment_intent.succeeded
payment_intent.payment_failed
```

**Webhook Signature Verification**:

```typescript
const signature = request.headers.get("stripe-signature");
const event = stripe.webhooks.constructEvent(
  rawBody,
  signature,
  process.env.STRIPE_WEBHOOK_SECRET,
);
```

### Webhook Retry Policy

Stripe retries failed webhooks:

- Immediately
- After 1 hour
- After 3 hours
- After 6 hours
- After 12 hours
- After 24 hours

**Important**: Endpoint must return 200 OK quickly (< 5s) to avoid retries

---

## Testing

### Test Approval Flow

```bash
# 1. Approve consultation
curl -X PATCH http://localhost:3000/api/bookings/consultations/test-id \
  -H "Content-Type: application/json" \
  -d '{"status": "APPROVED"}'

# 2. Check pending payments
curl http://localhost:3000/api/dashboard/consultee/test-consultee/pending-payments

# 3. Simulate payment success (test webhook)
curl -X POST http://localhost:3000/api/webhooks/stripe \
  -H "Content-Type: application/json" \
  -d '{
    "type": "payment_intent.succeeded",
    "data": {
      "object": {
        "id": "pi_test_123",
        "metadata": {
          "appointmentType": "CONSULTATION",
          "consultationId": "test-id"
        }
      }
    }
  }'
```

### Test Cleanup Job

```bash
# Trigger manual cleanup
curl http://localhost:3000/api/cleanup/approval-payments
```

---

## Monitoring

### Health Check Endpoints

```bash
# API health
curl https://familiarise.com/api/health

# Database health
curl https://familiarise.com/api/health/db

# Redis health
curl https://familiarise.com/api/health/redis
```

### Metrics to Monitor

1. **Approval success rate**: % of approvals completed without errors
2. **Lock acquisition failures**: Count of 409 Conflict responses
3. **Payment link generation time**: p50, p95, p99 latencies
4. **Email delivery rate**: % of emails successfully sent
5. **Cleanup job success rate**: % of expired items successfully reverted
6. **Webhook processing time**: p99 latency for payment webhooks

### Logging

All endpoints log:

- Request ID
- User ID
- Action performed
- Duration
- Success/failure
- Error details (if any)

Example:

```
[2025-01-15 10:00:00] INFO: Approval requested
  requestId: req_abc123
  consultationId: clx123abc
  userId: clxUser123
  status: APPROVED

[2025-01-15 10:00:01] INFO: Lock acquired
  consultationId: clx123abc
  duration: 87ms

[2025-01-15 10:00:02] INFO: Payment link generated
  consultationId: clx123abc
  amount: 100
  currency: USD
  duration: 1243ms

[2025-01-15 10:00:03] INFO: Email sent
  consultationId: clx123abc
  email: user@example.com
  duration: 2107ms

[2025-01-15 10:00:03] INFO: Approval completed
  consultationId: clx123abc
  totalDuration: 2456ms
  status: success
```
