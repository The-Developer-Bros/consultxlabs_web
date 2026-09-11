# Post-Maintenance Recovery

Complete these steps after ending maintenance mode. Items are ordered by priority.

## 1. End Maintenance Mode

- [ ] Navigate to: Dashboard > Maintenance
- [ ] Click **"End Maintenance"**
- [ ] Verify:
  - [ ] Phase shows as OFF in the admin panel
  - [ ] Maintenance banner disappears (may take up to 60s due to polling interval)
  - [ ] Maintenance page redirects to home (polls every 30s)

**What happens automatically when you end maintenance**:

- Redis keys updated: `maintenance:phase` = `"OFF"`
- Prisma: `MaintenanceWindow` record updated with `endedAt` and `endedBy`
- BetterStack incident auto-resolved (if one was created)
- Novu "we're back" notification sent

## 2. Verify Core Connectivity

- [ ] **Database**: Hit `/api/health` and confirm `status: "healthy"`

  ```
  curl https://your-domain.com/api/health
  ```

  Expected: `{ "status": "healthy", "maintenance": { "phase": "OFF" } }`

- [ ] **Redis**: Maintenance state should read as OFF
  - This was already verified by ending maintenance, but confirm `/api/health` responds

- [ ] **Auth**: Try logging in/out in an incognito window
  - BetterAuth sessions should work normally

## 3. Check Webhook Deliveries

This is the most critical post-maintenance step for financial integrity.

- [ ] **Stripe**: Check for failed webhook deliveries
  - Path: Stripe Dashboard > Developers > Webhooks > select endpoint > Recent deliveries
  - Filter by: Status = Failed, Time = during maintenance window
  - **Action**: For any failed deliveries, click "Resend" to retry
  - Common failures: `payment_intent.succeeded` (most critical)

- [ ] **Razorpay**: Check for failed webhook deliveries
  - Path: Razorpay Dashboard > Webhooks > Recent Deliveries
  - Filter by time range covering the maintenance window
  - **Action**: Note any failed deliveries for manual reconciliation

## 4. Run Critical Reconciliation Jobs

Manually trigger these jobs in order. Use the admin system jobs dashboard or run directly:

### Priority 1: Payment Reconciliation

```bash
# Check for payments that succeeded during maintenance but have no appointment
npx tsx jobs/payments/reconcile-payment-status.ts
```

- [ ] Verify output: no "succeeded payments needing appointment creation" flagged
- [ ] If flagged: these need manual appointment creation or webhook replay

### Priority 2: Slot Reconciliation

```bash
# Fix any slot inconsistencies caused by interrupted operations
npx tsx jobs/appointments/reconcile-slot-availability.ts
```

- [ ] Verify output: no double bookings detected, no orphaned tentative flags

### Priority 3: Payment-Earnings Sync

```bash
# Ensure earnings records match payments
npx tsx jobs/earnings/sync-payment-earnings.ts
```

- [ ] Verify output: no missing earnings entries created

### Priority 4: Tentative Slot Cleanup

```bash
# Release tentative slots that may have been left by interrupted checkouts
npx tsx jobs/appointments/cleanup-tentative-slots.ts
```

- [ ] Verify output: note how many tentative slots were released

### Priority 5: Refund Reconciliation

```bash
# Sync any refund status changes that occurred during maintenance
npx tsx jobs/refunds/reconcile-pending-refunds.ts
```

- [ ] Verify output: all refund statuses synced

### Priority 6: Payout Reconciliation (if applicable)

```bash
# Only run if maintenance overlapped with payout processing (Monday 8-10 PM UTC)
npx tsx jobs/payouts/reconcile-payout-status.ts
```

- [ ] Verify output: all payout statuses match gateway state

## 5. Verify BetterStack

- [ ] **Check `/api/health` for BetterStack status**:

  ```bash
  curl https://familiarisenow.com/api/health
  ```

  Expected response now includes:

  ```json
  {
    "status": "healthy",
    "maintenance": { "phase": "OFF", "reason": null, "estimatedEnd": null },
    "betterstack": {
      "configured": true,
      "reachable": true,
      "monitors": [
        { "name": "https://familiarisenow.com", "status": "up" },
        { "name": "https://familiarisenow.com/api/health", "status": "up" }
      ]
    },
    "timestamp": "..."
  }
  ```

- [ ] **Verify the BetterStack incident was auto-resolved** (OFFLINE mode only):
  - Path: https://uptime.betterstack.com/team/t332379/incidents
  - The incident created when entering OFFLINE should show as "Resolved"
  - Auto-resolution happens via `DELETE /api/admin/maintenance` calling `resolveIncident(betterstackIncidentId)`

- [ ] **Verify the public status page shows "All systems operational"**:
  - Path: https://familiarise.betteruptime.com
  - Resolved incidents are reflected within 1-2 minutes

- [ ] **If the incident was NOT auto-resolved** (the `DELETE` response body shows `betterstackIncidentId: null`):
  - Incident creation failed when maintenance started, or was skipped (DEGRADED mode)
  - Resolve manually: BetterStack dashboard → Incidents → find the incident → click "Resolve"
  - Check server logs for `[BetterStack] Failed to create incident:` during the POST call

## 6. Verify Notifications

- [ ] Check that the "we're back" Novu notification was sent
  - Path: Novu dashboard > Activity feed
  - Look for the maintenance-ended notification

## 7. Monitor for Errors

- [ ] **Monitor application logs** for 30 minutes post-recovery
  - Watch for: database connection errors, Prisma query failures, unexpected 500s
  - Path: Netlify Dashboard > Deployments > Functions > Logs (or your logging provider)

- [ ] **Monitor cron job executions** for the next scheduled cycle
  - Check that the next cron job run completes successfully
  - Path: GitHub Actions > Workflows > look for green checks

- [ ] **Check error rates** in your monitoring dashboard
  - Compare error rates to pre-maintenance baseline
  - Elevated errors may indicate schema compatibility issues

## 8. Verify Cron Job Resume

- [ ] Check that cron jobs resume on their next schedule:
  - Every 15 min: `cleanup-abandoned-payments`, `cascade-refund-earnings`, `reconcile-pending-refunds`
  - Every 30 min: `reconcile-payment-status`
  - Hourly: Several jobs (see [Cron Jobs Reference](./04-cron-jobs-reference.md))
  - Verify the next scheduled run completes in GitHub Actions

## Recovery Troubleshooting

### Maintenance mode stuck (can't end)

1. Check Redis directly: Is `maintenance:phase` stuck?
2. Try the API directly:
   ```
   curl -X DELETE https://your-domain.com/api/admin/maintenance \
     -H "Cookie: <your-auth-cookie>"
   ```
3. If Redis is unreachable: The fail-open design means the site is already serving traffic. Fix Redis connection separately.

### Webhooks failed and can't be retried

1. Check the `WebhookEvent` table for failed events:
   ```sql
   SELECT * FROM "WebhookEvent"
   WHERE processed = false
   AND "createdAt" > NOW() - INTERVAL '24 hours'
   ORDER BY "createdAt" DESC;
   ```
2. For Stripe: Use the dashboard to manually resend specific events
3. For other gateways: May need to manually reconcile using the reconciliation jobs

### Appointments created with wrong data

1. Run `reconcile-slot-availability` to fix slot state
2. Check recently created appointments against payment records
3. Contact affected users if their appointment details are incorrect

### Users still see maintenance page

1. Check that Redis `maintenance:phase` is set to `"OFF"`
2. The maintenance page polls every 30 seconds -- wait for the next poll
3. Users with cached pages may need a hard refresh (Ctrl+Shift+R)
4. Check that the `/api/health` endpoint returns `phase: "OFF"`
