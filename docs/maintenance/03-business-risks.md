# Business Risks During Maintenance

## Risk Scenarios

### Scenario 1: Payment Succeeds, Appointment Creation Fails

**Trigger**: User pays 1 minute before OFFLINE mode activates. Payment gateway processes the charge. Webhook fires during DB migration.

**What happens**:

1. User clicks "Pay" -> Stripe/Razorpay creates payment intent
2. Admin activates OFFLINE mode
3. Payment gateway charges the user
4. Webhook fires to `/api/webhooks/stripe` (exempt from maintenance)
5. Webhook handler tries to create appointment via Prisma
6. DB is mid-migration -> query fails or hits wrong schema
7. **Result**: Money taken, no appointment created

**Current mitigation**: Webhooks are exempt from maintenance mode and retried by gateways. If DB is temporarily unavailable, the webhook will fail and be retried.

**Residual risk**: If the DB schema has changed (e.g., column renamed), retried webhooks will also fail. Manual reconciliation required.

### Scenario 2: Slot Reconciliation During Migration

**Trigger**: `reconcile-slot-availability` cron job runs during DB migration.

**What happens**:

1. OFFLINE mode active, DB migration running
2. Cron job fires on schedule (every hour at :15)
3. Job queries slot data from partially-migrated tables
4. Detects "anomalies" that are actually mid-migration state
5. "Fixes" slots by clearing tentative flags or marking double bookings
6. **Result**: Corrupted slot state, potential double bookings or lost reservations

**Current mitigation**: `abortIfMaintenance()` guard in every cron job exits cleanly on OFFLINE. A job already mid-run when OFFLINE activates will finish its current work (guard is entry-time only).

### Scenario 3: Abandoned Payment Cleanup During Migration

**Trigger**: `cleanup-abandoned-payments` cron job runs during migration.

**What happens**:

1. OFFLINE mode active
2. Cleanup job runs (every 15 minutes)
3. Finds payment intents >30 min old with no confirmed appointment
4. Cancels these payment intents via Stripe/Razorpay API
5. Some of these are valid payments where appointment creation was delayed by maintenance
6. **Result**: Valid payments cancelled, users charged then refunded

**Current mitigation**: `abortIfMaintenance()` guard exits on OFFLINE at job startup. Same entry-time caveat as Scenario 2.

### Scenario 4: Active Video Call Drops During OFFLINE

**Trigger**: User is in a paid consultation video call when OFFLINE mode activates.

**What happens**:

1. Consultant and consultee are in a Stream.io video call
2. Admin activates OFFLINE mode
3. Video call continues (Stream infrastructure is external)
4. User tries to share a document or take notes -> API calls fail
5. Call ends -> completion webhook tries to update DB -> may fail
6. **Result**: Session quality degraded, completion status may not be recorded

**Current mitigation**: Stream.io calls continue independently. However, any DB-dependent features during the call will fail.

### Scenario 5: Checkout During DEGRADED Mode

**Trigger**: User completes checkout while DEGRADED mode is active.

**What happens**:

1. DEGRADED mode active (banner shown but site functional)
2. User clicks "Pay" on checkout page
3. Payment intent created, user charged
4. If admin then escalates to OFFLINE for DB migration
5. Webhook fires with changed schema
6. **Result**: Payment succeeded against old schema, appointment created against new schema (or fails)

**Current mitigation**: DEGRADED mode doesn't block writes. Webhook handlers are exempt from maintenance.

### Scenario 6: Payout Processing During Maintenance

**Trigger**: `process-payouts` cron job runs during OFFLINE mode (Monday 9 PM UTC).

**What happens**:

1. Weekly payout batch was created at 8 PM
2. Admin starts OFFLINE maintenance at 8:30 PM
3. Process-payouts job fires at 9 PM
4. Job reads approved payouts from DB and sends to Stripe/Razorpay
5. If DB is mid-migration, queries may fail or return incomplete data
6. **Result**: Partial payouts, or payouts based on stale/corrupted data

**Current mitigation**: None. This is especially dangerous on Monday evenings.

## Risk Matrix

| #   | Scenario                                   | Likelihood            | Financial Impact                          | Current Mitigation             | Recommended Mitigation                           |
| --- | ------------------------------------------ | --------------------- | ----------------------------------------- | ------------------------------ | ------------------------------------------------ |
| 1   | Payment succeeds, appointment fails        | Medium                | HIGH (user charged, no service)           | Webhook retries (3 days)       | Pre-flight: block checkout 5 min before OFFLINE  |
| 2   | Slot reconciliation during migration       | Low (guard at entry)  | HIGH (corrupted slot state)               | `abortIfMaintenance()` on OFFLINE | Mid-run jobs still complete; keep settling window |
| 3   | Abandoned payment cleanup during migration | Low (guard at entry)  | MEDIUM (valid payments cancelled)         | `abortIfMaintenance()` on OFFLINE | Same entry-time caveat                           |
| 4   | Active video call quality degradation      | Low                   | LOW (session continues, features limited) | Stream external infrastructure | Pre-flight: check active calls                   |
| 5   | Checkout during DEGRADED with escalation   | Medium                | HIGH (payment/schema mismatch)            | None                           | Block writes in DEGRADED mode                    |
| 6   | Payout processing during maintenance       | Low (timing-specific) | HIGH (incorrect payouts)                  | None                           | Never schedule maintenance on Monday 8-10 PM UTC |

## Worst-Case Financial Exposure

**Per-incident estimates** (based on typical transaction volumes):

| Scenario                         | Per-Incident Cost                            | Recovery Effort                                       |
| -------------------------------- | -------------------------------------------- | ----------------------------------------------------- |
| Failed appointment after payment | INR 500-5,000 per user                       | Manual refund + reschedule (30 min/case)              |
| Corrupted slot state             | INR 0 direct, but booking failures for hours | Manual DB fix + slot reconciliation (2-4 hours)       |
| Cancelled valid payments         | INR 500-5,000 per user                       | Re-process payments + customer support (1 hour/case)  |
| Missed call completion           | INR 0 direct                                 | Manual status update (15 min/case)                    |
| Schema mismatch on checkout      | INR 500-5,000 per user                       | Manual reconciliation (1-2 hours)                     |
| Incorrect payouts                | INR 1,000-50,000+ total                      | Manual reversal + consultant communication (4+ hours) |

**Key insight**: Most risks are mitigated by keeping maintenance windows short (<1 hour) and running them during low-traffic periods (e.g., 2-4 AM IST on weekdays).

## Timing Recommendations

### Avoid These Windows

- **Monday 8-10 PM UTC** (payout processing)
- **Peak hours** (varies by user base, check analytics)
- **During active appointments** (check calendar)

### Preferred Windows

- **Weekday 2-4 AM IST** (21:30-23:30 UTC previous day) -- lowest traffic
- **Sunday 2-4 AM IST** -- no payout processing, low traffic
- **After payout processing completes** (Monday 10 PM+ UTC)
