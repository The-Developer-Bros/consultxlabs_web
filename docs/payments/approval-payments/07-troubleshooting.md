# Troubleshooting Guide

## Common Issues

### 1. Lock Acquisition Failures

**Symptom**: Approval requests return 409 Conflict: "Another approval is in progress"

**Possible Causes**:

- Multiple concurrent approval attempts
- Previous lock not released (rare with auto-expiry)
- Redis connection issues
- High latency to Upstash Redis

**Diagnostic Steps**:

```bash
# 1. Check Redis connectivity
curl -X POST https://your-redis.upstash.io/ping \
  -H "Authorization: Bearer YOUR_TOKEN"

# Expected: {"result":"PONG"}

# 2. Check for stuck locks
curl -X POST https://your-redis.upstash.io/keys/*-approval:* \
  -H "Authorization: Bearer YOUR_TOKEN"

# Expected: Empty array or locks with recent timestamps

# 3. Check lock TTL
curl -X POST https://your-redis.upstash.io/ttl/consultation-approval:clx123abc \
  -H "Authorization: Bearer YOUR_TOKEN"

# Expected: Number between 0-30 (seconds remaining)
```

**Solutions**:

```typescript
// Solution 1: Clear stuck locks (emergency only)
curl -X POST https://your-redis.upstash.io/flushall \
  -H "Authorization: Bearer YOUR_TOKEN"

// Solution 2: Wait for auto-expiry (30 seconds)
// Locks automatically expire after TTL

// Solution 3: Retry approval after delay
setTimeout(() => {
  approveRequest();
}, 1000); // Wait 1 second and retry
```

**Prevention**:

- Always use try-finally to release locks
- Set appropriate TTL (30s default)
- Monitor Redis health in Upstash console

---

### 2. Email Delivery Failures

**Symptom**: Emails not being sent or received

**Possible Causes**:

- Missing RESEND_API_KEY environment variable
- Invalid "from" email address (not verified in Resend)
- Recipient email bounced/blocked
- Rate limits exceeded
- Email template rendering errors

**Diagnostic Steps**:

```bash
# 1. Check environment variable
echo $RESEND_API_KEY
# Expected: re_...

# 2. Check Resend dashboard
# Go to: https://resend.com/emails
# Filter by: Last 24 hours, Status: Failed

# 3. Test email sending
curl -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Familiarise <payments@familiarise.com>",
    "to": "test@example.com",
    "subject": "Test Email",
    "html": "<p>Test</p>"
  }'
```

**Solutions**:

```typescript
// Solution 1: Verify environment variable
if (!process.env.RESEND_API_KEY) {
  console.error("RESEND_API_KEY not configured");
  // Add to .env file
}

// Solution 2: Verify sender domain in Resend
// Dashboard → Domains → Add/Verify Domain

// Solution 3: Check rate limits
// Free tier: 100 emails/month, 2/second
// Upgrade if needed

// Solution 4: Add error logging
try {
  await sendPaymentLinkEmail({ ... });
} catch (error) {
  console.error("Email error:", error);
  // Alert admin team
}
```

**Prevention**:

- Configure Resend properly before deployment
- Monitor email delivery rates
- Implement retry logic for transient failures
- Use email queuing for high volume

---

### 3. Payment Link Expiration Issues

**Symptom**: Payment links expire before 48 hours or don't expire

**Possible Causes**:

- Cleanup cron job not running
- Incorrect expiry threshold calculation
- System time/timezone issues
- Database updatedAt not updating correctly

**Diagnostic Steps**:

```bash
# 1. Check last cleanup job run
curl https://familiarise.com/api/cleanup/approval-payments

# Expected: Recent timestamp in response

# 2. Check vercel.json cron configuration
cat vercel.json | grep -A 5 "crons"

# 3. Check Vercel cron logs
# Dashboard → Deployments → Functions → Logs

# 4. Manually trigger cleanup
curl https://familiarise.com/api/cleanup/approval-payments

# Expected: {"success": true, "summary": {...}}
```

**Solutions**:

```typescript
// Solution 1: Verify cron configuration
// vercel.json
{
  "crons": [
    {
      "path": "/api/cleanup/approval-payments",
      "schedule": "0 */1 * * *"  // Every hour
    }
  ]
}

// Solution 2: Fix expiry calculation
const expiryThreshold = new Date(Date.now() - 48 * 60 * 60 * 1000);
console.log("Expiry threshold:", expiryThreshold.toISOString());

// Solution 3: Manual cleanup
// Run: curl /api/cleanup/approval-payments
// Or add admin button to trigger manually
```

**Prevention**:

- Monitor cron job execution in Vercel dashboard
- Add alerts for cleanup failures
- Test expiry logic with different timezones
- Log all cleanup operations

---

### 4. Duplicate Payment Links

**Symptom**: Multiple payment links generated for same request

**Possible Causes**:

- Redis lock not acquired (connection failure)
- Transaction isolation level too low
- Idempotency check not working
- User double-clicking "Approve" button

**Diagnostic Steps**:

```bash
# 1. Check application logs for lock errors
grep "Failed to acquire lock" /var/log/application.log

# 2. Query database for duplicates
SELECT
  consultation_id,
  COUNT(*) as payment_count
FROM Payment
WHERE appointment_type = 'CONSULTATION'
GROUP BY consultation_id
HAVING COUNT(*) > 1;

# 3. Check Redis connection
redis-cli ping
# Expected: PONG
```

**Solutions**:

```typescript
// Solution 1: Ensure triple-layer protection is active
const result = await prisma.$transaction(async (tx) => {
  // ALWAYS check current status
  const current = await tx.consultation.findUnique({
    where: { id: consultationId },
  });

  // Idempotency check
  if (current.status === AppointmentStatus.APPROVED_PENDING_PAYMENT) {
    return { duplicate: true };
  }

  // ... proceed with payment link generation
}, {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
});

// Solution 2: Add UI debouncing
<Button
  onClick={debounce(handleApprove, 1000)}
  disabled={isApproving}
>
  Approve
</Button>

// Solution 3: Check Redis health
const health = await redis.ping();
if (health !== "PONG") {
  throw new Error("Redis unavailable");
}
```

**Prevention**:

- Monitor Redis uptime (Upstash dashboard)
- Always use Serializable transaction isolation
- Implement UI-level debouncing
- Add request ID logging for debugging

---

### 5. Webhook Processing Failures

**Symptom**: Payments succeed in Stripe but appointments not created

**Possible Causes**:

- Webhook signature verification failing
- Missing/invalid metadata in payment intent
- Database transaction errors
- Appointment creation logic errors
- Webhook endpoint timing out (> 5s)

**Diagnostic Steps**:

```bash
# 1. Check Stripe webhook logs
# Dashboard → Developers → Webhooks → Select endpoint → Events

# 2. Check application logs
grep "Webhook error" /var/log/application.log

# 3. Test webhook locally
stripe listen --forward-to localhost:3000/api/webhooks/stripe

# 4. Send test webhook
stripe trigger payment_intent.succeeded

# 5. Check webhook response times
# Expected: < 2s for success
```

**Solutions**:

```typescript
// Solution 1: Verify webhook secret
const signature = request.headers.get("stripe-signature");
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

if (!webhookSecret) {
  throw new Error("STRIPE_WEBHOOK_SECRET not configured");
}

const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);

// Solution 2: Validate metadata
const { metadata } = event.data.object;
const validation = validateWebhookMetadata(metadata);

if (!validation.success) {
  console.error("Invalid metadata:", validation.errors);
  return NextResponse.json({ received: true }); // Return 200 to prevent retries
}

// Solution 3: Add timeout handling
export const maxDuration = 10; // 10 seconds

// Solution 4: Make webhook processing async
// Return 200 OK immediately, process in background
return NextResponse.json({ received: true });

// Process asynchronously
processWebhookAsync(event).catch((error) => {
  console.error("Async webhook processing failed:", error);
  // Alert admin
});
```

**Prevention**:

- Test webhooks in development with Stripe CLI
- Monitor webhook delivery in Stripe dashboard
- Set appropriate timeout limits
- Implement idempotent webhook handlers
- Log all webhook events for debugging

---

### 6. React Query Not Refetching

**Symptom**: Dashboard shows stale payment status

**Possible Causes**:

- refetchOnWindowFocus disabled
- staleTime set too high
- Query keys not invalidated after mutations
- Network connection issues

**Diagnostic Steps**:

```typescript
// 1. Check React Query config
// providers/ReactQueryProvider.tsx
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true, // Should be true
      staleTime: 60 * 1000, // 1 minute
    },
  },
});

// 2. Check browser network tab
// Should see refetch requests when switching tabs

// 3. Check query keys
// useQuery({ queryKey: ["pending-payments", consulteeId] })
```

**Solutions**:

```typescript
// Solution 1: Enable refetch on window focus
refetchOnWindowFocus: true

// Solution 2: Reduce stale time
staleTime: 30 * 1000, // 30 seconds

// Solution 3: Invalidate queries after mutations
const mutation = useMutation({
  mutationFn: approveRequest,
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ["pending-payments"] });
    queryClient.invalidateQueries({ queryKey: ["admin-approval-payments"] });
  },
});

// Solution 4: Add manual refetch button
<Button onClick={() => refetch()}>
  Refresh
</Button>
```

**Prevention**:

- Configure React Query properly from start
- Use consistent query keys
- Invalidate queries after mutations
- Monitor network requests in dev tools

---

### 7. Serialization Errors

**Symptom**: "Transaction failed: could not serialize access"

**Possible Causes**:

- High concurrent approval requests
- Long-running transactions
- Complex queries with multiple joins
- Database connection pool exhausted

**Diagnostic Steps**:

```bash
# 1. Check database logs
tail -f /var/log/postgresql/postgresql.log | grep "serialization"

# 2. Check active transactions
SELECT
  pid,
  state,
  query,
  query_start
FROM pg_stat_activity
WHERE state = 'active';

# 3. Check connection pool
SELECT count(*) FROM pg_stat_activity;
# Expected: < max_connections (default 100)
```

**Solutions**:

```typescript
// Solution 1: Prisma automatically retries serialization errors
// No action needed if retries succeed

// Solution 2: Optimize transaction duration
await prisma.$transaction(async (tx) => {
  // Fetch all data first
  const data = await tx.consultation.findUnique({ ... });

  // Do processing outside transaction if possible
  const processedData = processData(data);

  // Update in single query
  await tx.consultation.update({ data: processedData });
}, {
  maxWait: 10000,   // Wait up to 10s to start
  timeout: 30000,   // Complete within 30s
});

// Solution 3: Increase max retries
prisma.$transaction(
  async (tx) => { ... },
  {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 15000,
    timeout: 45000,
  }
);

// Solution 4: Use database connection pooling
// DATABASE_URL with connection_limit parameter
postgresql://user:pass@localhost:5432/db?connection_limit=50
```

**Prevention**:

- Keep transactions short
- Fetch data efficiently (include all relations in one query)
- Use appropriate isolation level (Serializable for approval flow)
- Monitor database performance

---

### 8. Refund Race Conditions (Two-Phase Pattern)

**Symptom**: Double refunds issued, or refund exceeds available balance

**Background**: The refund API uses a two-phase pattern to prevent race conditions while avoiding long-running database transactions (which can cause connection pool exhaustion when external API calls are slow).

**How the Pattern Works**:

```
Phase 1 (Transaction - Fast):
  → Validate payment can be refunded
  → Calculate available balance (SUCCEEDED + PENDING refunds)
  → Create PENDING refund record (claims the amount)
  → Commit

Phase 2 (No Transaction):
  → Call Stripe/Razorpay API (can be slow)

Phase 3 (No Transaction):
  → Update refund to SUCCEEDED/FAILED
```

**Why This Prevents Double Refunds**:

If two concurrent requests try to refund the same payment:

1. Request A enters Phase 1, creates PENDING refund for $100
2. Request B enters Phase 1, sees PENDING refund, available balance = $0
3. Request B fails validation (insufficient balance)
4. Request A completes Phases 2 and 3

**Diagnostic Steps**:

```sql
-- Check for stuck PENDING refunds (potential failed Phase 2)
SELECT * FROM "Refund"
WHERE status = 'PENDING'
  AND "createdAt" < NOW() - INTERVAL '5 minutes';

-- Check for duplicate refunds on same payment
SELECT "paymentId", COUNT(*) as refund_count, SUM(amount) as total_refunded
FROM "Refund"
WHERE status IN ('SUCCEEDED', 'PENDING')
GROUP BY "paymentId"
HAVING COUNT(*) > 1;
```

**Solutions**:

```typescript
// If PENDING refund is stuck (gateway call failed but record exists):
// 1. Check gateway dashboard for actual refund status
// 2. If refund succeeded at gateway, update DB to SUCCEEDED
// 3. If refund failed at gateway, update DB to FAILED

// Manual reconciliation:
await prisma.refund.update({
  where: { id: stuckRefundId },
  data: {
    status: "FAILED",
    metadata: { error: "Manual reconciliation - gateway call failed" },
  },
});
```

**Related File**: `app/api/payments/refunds/route.ts`

---

### 9. Dispute Evidence Submission

**Symptom**: Evidence submission to Stripe fails or takes too long

**Background**: The disputes API moves external API calls outside of database transactions to prevent connection pool issues. Unlike refunds, dispute evidence submission doesn't have race condition risks (submitting evidence multiple times doesn't cause financial harm).

**Current Pattern**:

```
1. Validate dispute status (not WON/LOST/CHARGE_REFUNDED)
2. Submit evidence to Stripe (outside transaction)
3. Update dispute record in database
```

**Diagnostic Steps**:

```bash
# Check Stripe Dashboard for dispute status
# Dashboard → Payments → Disputes → Find dispute

# Check application logs for evidence submission errors
grep "Evidence submission error" /var/log/application.log
```

**Important Notes**:

- Only Stripe supports direct evidence submission via API
- Razorpay disputes must be handled via their dashboard
- Evidence submission deadlines are strict (7-14 days typically)

**Related File**: `app/api/payments/disputes/route.ts`

---

### 10. Theoretical Edge Case: Cleanup Job vs Delayed Webhook

**Symptom**: Payment marked as FAILED by cleanup job, but webhook arrives later showing payment succeeded

**Scenario**:

1. User initiates payment at T+0
2. Payment succeeds at gateway at T+1h
3. Webhook is delayed (gateway infrastructure issue)
4. Cleanup job runs at T+48h, marks payment as FAILED, reverts status to PENDING
5. Delayed webhook finally arrives at T+49h

**Why This Is Extremely Unlikely**:

- Payment gateways (Stripe/Razorpay) retry webhooks aggressively for 24-72 hours
- A 48+ hour webhook delay indicates catastrophic infrastructure failure at the gateway
- In 10+ years of Stripe usage across millions of transactions, this scenario is virtually unheard of

**Current Protections**:

```typescript
// The cleanup job re-checks status inside transaction (lines 47-55)
if (consultation.status !== AppointmentStatus.APPROVED_PENDING_PAYMENT) {
  return false; // Already processed or status changed
}
```

If the webhook already processed the payment, the status won't be `APPROVED_PENDING_PAYMENT` anymore, and cleanup will skip it.

**If This Ever Happens** (monitoring recommendation):

1. Check application logs for payments marked FAILED that later received success webhooks
2. Query: `SELECT * FROM Payment WHERE paymentStatus = 'FAILED' AND stripePaymentIntentId IN (SELECT paymentIntentId FROM successful_webhook_logs)`
3. If found, manually reconcile using the admin recovery endpoint

**Optional Future Enhancement** (not currently implemented):

```typescript
// Before marking as FAILED, verify with payment gateway
const paymentIntent = await stripe.paymentIntents.retrieve(
  payment.stripePaymentIntentId,
);
if (paymentIntent.status === "succeeded") {
  // Trigger handlePaymentSuccess instead of cleanup
  await handlePaymentSuccess(paymentIntent);
  return;
}
// Safe to proceed with cleanup
```

**Decision**: This enhancement adds API call overhead to every cleanup run. Given the near-zero probability of the edge case, we chose to monitor for occurrences rather than pre-emptively implement the fix. Revisit if any incidents are detected.

---

## Error Messages Reference

| Error Message                           | Cause                  | Solution                     |
| --------------------------------------- | ---------------------- | ---------------------------- |
| "Another approval is in progress"       | Lock already held      | Wait 30s or retry            |
| "Email service not configured"          | Missing RESEND_API_KEY | Add to .env file             |
| "Payment intent creation failed"        | Stripe API error       | Check Stripe dashboard       |
| "Transaction failed: serialization"     | Concurrent updates     | Retry automatically          |
| "Webhook signature verification failed" | Invalid webhook secret | Update STRIPE_WEBHOOK_SECRET |
| "Consultation not found"                | Invalid ID             | Check consultation exists    |
| "Lock acquisition timeout"              | Redis unreachable      | Check Upstash status         |
| "Payment link expired"                  | > 48 hours passed      | Re-approve request           |

---

## Monitoring Dashboard

### Key Metrics to Watch

```typescript
// Define alerts in monitoring tool (Datadog, Sentry, etc.)
const ALERTS = {
  // Lock acquisition failures
  lockFailureRate: {
    threshold: 5, // % of requests
    window: "5m",
    action: "Alert ops team",
  },

  // Email delivery failures
  emailFailureRate: {
    threshold: 10, // % of emails
    window: "1h",
    action: "Check Resend status",
  },

  // Approval endpoint latency
  approvalLatencyP99: {
    threshold: 5000, // 5 seconds
    window: "5m",
    action: "Investigate slow queries",
  },

  // Webhook processing errors
  webhookErrorRate: {
    threshold: 5, // % of webhooks
    window: "5m",
    action: "Check Stripe logs",
  },

  // Cleanup job failures
  cleanupJobFailures: {
    threshold: 2, // consecutive failures
    window: "2h",
    action: "Manual intervention needed",
  },
};
```

### Health Check Endpoints

```bash
# Overall API health
curl https://familiarise.com/api/health
# Expected: {"status": "ok"}

# Database health
curl https://familiarise.com/api/health/db
# Expected: {"status": "ok", "latency": 50}

# Redis health
curl https://familiarise.com/api/health/redis
# Expected: {"status": "ok", "latency": 100}

# Email service health
curl https://familiarise.com/api/health/email
# Expected: {"status": "ok", "configured": true}
```

---

## Debug Mode

### Enable Verbose Logging

```typescript
// Set environment variable
DEBUG=payment:*

// Or in code
if (process.env.DEBUG) {
  console.log("🔍 DEBUG: Lock acquisition attempt", {
    consultationId,
    timestamp: new Date().toISOString(),
  });

  console.log("🔍 DEBUG: Transaction started", {
    isolationLevel: "Serializable",
  });

  console.log("🔍 DEBUG: Payment intent created", {
    paymentIntentId,
    amount,
    currency,
  });
}
```

### Trace Requests

```typescript
// Add request ID to all logs
import { v4 as uuidv4 } from "uuid";

const requestId = uuidv4();

console.log(`[${requestId}] Approval request started`);
console.log(`[${requestId}] Lock acquired`);
console.log(`[${requestId}] Payment link generated`);
console.log(`[${requestId}] Email sent`);
console.log(`[${requestId}] Approval completed`);
```

---

## Emergency Procedures

### 1. Mass Payment Link Expiry

**Scenario**: Cleanup job failed, hundreds of expired links

**Procedure**:

```bash
# 1. Manual cleanup trigger
curl https://familiarise.com/api/cleanup/approval-payments

# 2. Check results
# Response should show:
# {
#   "success": true,
#   "summary": {
#     "total": { "reverted": 150, "failed": 0 }
#   }
# }

# 3. If failures, investigate logs
# Check: /var/log/application.log

# 4. Re-run cleanup if needed
curl https://familiarise.com/api/cleanup/approval-payments

# 5. Notify affected consultees
# Send bulk email with instructions
```

### 2. Redis Outage

**Scenario**: Upstash Redis is down

**Immediate Actions**:

```typescript
// 1. Disable distributed locking temporarily
const LOCK_DISABLED = process.env.EMERGENCY_DISABLE_LOCKS === "true";

if (!LOCK_DISABLED) {
  lock = await lockConsultationApproval(consultationId);
}

// 2. Rely on database transaction isolation
// Serializable transactions provide protection

// 3. Monitor for duplicate payments
// Check database for multiple payment intents per consultation

// 4. Once Redis is restored, re-enable locks
// Remove EMERGENCY_DISABLE_LOCKS env var
```

### 3. Email Service Outage

**Scenario**: Resend API is down

**Immediate Actions**:

```typescript
// 1. Payment links still generated (don't block on email)
// Emails are sent in try-catch, won't throw

// 2. Retrieve payment URLs from database
SELECT
  id,
  request_notes
FROM Consultation
WHERE request_status = 'APPROVED_PENDING_PAYMENT'
  AND updated_at > NOW() - INTERVAL '48 hours';

// 3. Extract payment URLs from requestNotes
// Format: "[System] Payment link generated: https://..."

// 4. Send emails manually once service is restored
// Or provide URLs to consultees via dashboard
```

---

## Contact & Support

### Internal Team

- **DevOps**: ops@familiarise.com (for Redis/deployment issues)
- **Backend**: backend@familiarise.com (for API/database issues)
- **Frontend**: frontend@familiarise.com (for UI/React Query issues)

### External Services

- **Upstash Support**: https://upstash.com/docs
- **Resend Support**: https://resend.com/docs
- **Stripe Support**: https://support.stripe.com

### Escalation Path

1. Check this troubleshooting guide
2. Check application logs
3. Check external service status pages
4. Contact internal team via Slack #engineering
5. If urgent, page on-call engineer
6. If critical outage, escalate to CTO

---

## Additional Resources

- [Architecture Documentation](./01-architecture.md)
- [API Reference](./02-api-reference.md)
- [Testing Guide](./06-testing.md)
- [Distributed Locking Details](./04-distributed-locking.md)
- [Email Notifications](./05-email-notifications.md)
- [Cron Schedules](./03-cron-schedules.md)
