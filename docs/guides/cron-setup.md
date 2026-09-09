# Cron Job Setup for Abandoned Payment Cleanup

## Overview

This document explains how to set up automated cleanup of abandoned payments in the system.

## Running the Netlify scheduled ticker locally

`netlify/functions/cron-tick.mts` is the scheduled function that drives the ten latency-sensitive `/api/cleanup/*` sweeps every five minutes in production, because GitHub Actions was measured delivering a sub-hourly schedule roughly once every hundred minutes rather than on its declared cadence (ADR 22, ADR 27). It needs two environment variables to do anything: `CRON_SECRET`, the same bearer token every `/api/cleanup/*` route already requires, and either `URL` (which Netlify sets automatically in every deployed context) or its local override, `CRON_TICK_BASE_URL`, pointed at wherever the Next app is actually listening.

Netlify never fires a scheduled function on its declared cadence in local development, and a scheduled function cannot be invoked directly by URL either, so `netlify dev` alone will not produce a tick. Start `next dev` (or `netlify dev`, which manages one for you) with `CRON_TICK_BASE_URL` pointed at wherever it is listening, then invoke the function once through the CLI and read the same `{ event: "cron-tick", ok, lockHeld, failed, durationMs }` body it logs in production:

```bash
CRON_SECRET=your-local-secret \
CRON_TICK_BASE_URL=http://localhost:8888 \
netlify dev
```

```bash
netlify functions:invoke cron-tick
```

A `lockHeld` entry for a target means `withCronLock` is already held by another run of that job — expected under a concurrent GitHub Actions run, and not a failure. A `failed` entry means the route answered something other than `200`, `207` or `409`, which is worth investigating the same way any other cleanup-route failure is.

## Cleanup Endpoint

**URL**: `/api/cleanup/abandoned-payments`  
**Method**: `POST`  
**Auth**: Requires `CRON_SECRET` environment variable

## Environment Variables

Add to your `.env` file:

```bash
# Required for cron job authentication
CRON_SECRET=your-secure-random-string-here
```

## Deployment-Specific Setup

### 1. Vercel Cron Jobs

Create `vercel.json` in project root:

```json
{
  "crons": [
    {
      "path": "/api/cleanup/abandoned-payments",
      "schedule": "*/15 * * * *"
    }
  ]
}
```

### 2. External Cron Service (cron-job.org, EasyCron, etc.)

Setup a webhook that calls:

```bash
curl -X POST https://your-domain.com/api/cleanup/abandoned-payments \
  -H "Authorization: Bearer YOUR_CRON_SECRET" \
  -H "Content-Type: application/json"
```

**Recommended Schedule**: Every 15 minutes (`*/15 * * * *`)

### 3. GitHub Actions (Alternative)

Create `.github/workflows/cleanup.yml`:

```yaml
name: Cleanup Abandoned Payments

on:
  schedule:
    - cron: "*/15 * * * *" # Every 15 minutes
  workflow_dispatch: # Allow manual trigger

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - name: Call cleanup endpoint
        run: |
          curl -X POST ${{ secrets.APP_URL }}/api/cleanup/abandoned-payments \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            -H "Content-Type: application/json"
```

## How It Works

### Detection Logic

The cleanup job identifies abandoned appointments by:

1. **Age Check**: Appointments created more than 30 minutes ago
2. **Status Check**: Has tentative slots (`isTentative: true`)
3. **Payment Check**: Has pending payments (`paymentStatus: "PENDING"`)

### Cleanup Process

For each abandoned appointment:

1. **Cancel Payment Intent**: Calls payment gateway to cancel the payment intent
2. **Update Payment Status**: Marks payment as `FAILED` in database
3. **Remove Appointment Data**:
   - **Webinars/Classes**: Only removes tentative slot connections
   - **Consultations/Subscriptions**: Deletes entire appointment chain

### Error Handling

- **Payment Gateway Errors**: Logged but don't stop cleanup process
- **Database Errors**: Individual appointment failures are logged, others continue
- **Rollback Handling**: Each appointment cleanup is wrapped in a transaction

## Monitoring

### Success Response

```json
{
  "success": true,
  "cleanedCount": 5,
  "totalFound": 5,
  "errors": []
}
```

### Error Response

```json
{
  "success": true,
  "cleanedCount": 3,
  "totalFound": 5,
  "errors": [
    "Failed to cleanup appointment abc123: Payment intent not found",
    "Failed to cleanup appointment def456: Database connection timeout"
  ]
}
```

## Testing

### Manual Testing

```bash
# Set environment variable
export CRON_SECRET="your-test-secret"

# Call the endpoint
curl -X POST http://localhost:3000/api/cleanup/abandoned-payments \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json"
```

### Creating Test Data

1. Start a checkout process but don't complete payment
2. Wait 30+ minutes
3. Run cleanup job
4. Verify appointment is removed from database

## Security Considerations

1. **Secret Protection**: Never expose `CRON_SECRET` in logs or client-side code
2. **Rate Limiting**: Endpoint should only be called by authorized cron services
3. **Logging**: Cleanup activities are logged for audit purposes
4. **Rollback Safety**: All operations are wrapped in database transactions

## Troubleshooting

### Common Issues

1. **Unauthorized 401**: Check `CRON_SECRET` environment variable
2. **Payment Gateway Errors**: Verify API keys and webhook configurations
3. **Database Timeouts**: Consider reducing batch size or increasing timeout
4. **Missing Appointments**: Check if webhooks are processing payments correctly

### Monitoring Queries

Check for abandoned appointments:

```sql
SELECT a.id, a.createdAt, p.paymentStatus, s.isTentative
FROM "Appointment" a
JOIN "Payment" p ON p.appointmentId = a.id
JOIN "SlotOfAppointment" s ON s.appointmentId = a.id
WHERE a.createdAt < NOW() - INTERVAL '30 minutes'
  AND p.paymentStatus = 'PENDING'
  AND s.isTentative = true;
```

## Backup Strategy

Before implementing:

1. **Database Backup**: Ensure regular backups are in place
2. **Test Environment**: Test cleanup logic in staging first
3. **Gradual Rollout**: Start with longer timeout (e.g., 60 minutes) then reduce
4. **Monitoring**: Set up alerts for cleanup job failures
