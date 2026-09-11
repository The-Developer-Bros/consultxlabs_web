# Pre-Maintenance Checklist

Complete this checklist before activating maintenance mode. Items are ordered by priority.

## 1. Assess the Situation

- [ ] **Determine maintenance type**: What work requires maintenance mode?
  - Cosmetic/CSS changes -> No maintenance needed
  - Config/env changes -> DEGRADED may suffice
  - Non-DB code deployment -> DEGRADED
  - DB migration (additive: new tables/columns) -> OFFLINE (short)
  - DB migration (destructive: rename/drop) -> OFFLINE (extended)
  - Major framework upgrade -> OFFLINE
  - Infrastructure change (Redis, Supabase) -> OFFLINE

- [ ] **Estimate duration**: How long will the maintenance window be?
  - <15 minutes: Low risk, webhook retries cover it
  - 15-60 minutes: Medium risk, follow full checklist
  - > 60 minutes: High risk, consider off-peak timing and extended notifications

## 2. Check Active Sessions

- [ ] **Check active video calls**: Open Stream.io dashboard and look for active calls
  - If calls are active, wait for them to end or notify participants
  - Video calls are NOT terminated by maintenance mode

- [ ] **Check upcoming appointments**: Review the next 4 hours of scheduled appointments
  - Path: Admin Dashboard > Appointments
  - If appointments are within the maintenance window, notify affected users
  - Consider: appointments during OFFLINE will be inaccessible

## 3. Check Financial State

- [ ] **Check pending payments**: Look for in-progress payment intents
  - Path: Admin Dashboard > Payments (filter: PENDING status)
  - If users are mid-checkout, wait 5-10 minutes for completion
  - Payment intents in progress may succeed and fire webhooks during maintenance

- [ ] **Check payout schedule**: Is today Monday?
  - Payout batch creation: Monday 8 PM UTC
  - Payout processing: Monday 9 PM UTC
  - **Never schedule OFFLINE maintenance on Monday 8-10 PM UTC**

- [ ] **Check pending refunds**: Any refunds in progress?
  - Active refunds may complete and fire webhooks during maintenance
  - This is safe (webhooks are exempt) but note for post-maintenance verification

## 4. Notify Users

- [ ] **Post an announcement** via the admin announcements feature
  - Include: What's happening, estimated duration, what to expect
  - Example: "Familiarise will be undergoing scheduled maintenance from [time] to [time]. During this time, the platform will be temporarily unavailable. Any in-progress sessions will not be affected."

- [ ] **Consider email notification** for users with upcoming appointments
  - Only if maintenance window overlaps with scheduled appointments

## 5. Prepare Maintenance Settings

- [ ] **Write a clear reason message** for the maintenance banner/page
  - Users see this message -- keep it professional and informative
  - Example: "We're upgrading our systems to serve you better. We'll be back shortly."

- [ ] **Set estimated end time (ETA)**
  - Add buffer: if you expect 30 min, set ETA to 45-60 min
  - Users see this on the maintenance page
  - Better to be early than late

- [ ] **Choose the correct phase**:
  - **DEGRADED**: Use when the database is NOT being modified. Site stays functional with a warning banner. Good for deployments, config changes, non-DB work.
  - **OFFLINE**: Use when the database IS being modified (migrations, schema changes). Full site block with maintenance page.

## 6. Prepare Bypass Access

- [ ] **Note the bypass secret** that will be generated when maintenance activates
  - The secret is shown in the admin maintenance controls after activation
  - Use it via header (`x-maintenance-bypass: <secret>`) or cookie (`maintenance_bypass=<secret>`)
  - Share with any team members who need access during maintenance

## 6.5. Verify BetterStack Is Ready

This step ensures the public status page stays in sync when you enter OFFLINE mode.

- [ ] **Confirm `BETTERSTACK_API_KEY` is set**:

  ```bash
  curl https://familiarisenow.com/api/health
  ```

  Expected: `"betterstack": { "configured": true, "reachable": true, "monitors": [...] }`
  - If `configured: false` → env var is missing; add it and redeploy before proceeding
  - If `reachable: false` → API key is wrong or BetterStack is unreachable

- [ ] **Verify both monitors show "Up"** at https://uptime.betterstack.com/team/t332379
  - `familiarisenow.com` → Up
  - `familiarisenow.com/api/health` → Up
  - If either is already down, investigate before activating maintenance

- [ ] **Check the public status page** is accessible: https://familiarise.betteruptime.com
  - Should show "All systems operational"
  - If it shows an active incident already, investigate before proceeding

> **Note**: BetterStack incidents are only auto-created for OFFLINE mode, not DEGRADED.

## 7. Timing Considerations

### Preferred Times

- **Best**: Weekday 2-4 AM IST (21:30-23:30 UTC previous day)
- **Good**: Sunday 2-4 AM IST
- **Acceptable**: Any low-traffic period (check analytics)

### Times to Avoid

- Monday 8-10 PM UTC (payout processing)
- Peak traffic hours (check analytics)
- During scheduled appointments
- During active video calls

## 8. Activate Maintenance

- [ ] Navigate to: Dashboard > Maintenance (admin or staff)
- [ ] Enter the reason and estimated end time
- [ ] Click **"Start Degraded Mode"** or **"Start Offline Mode"**
- [ ] **Copy the bypass secret** displayed in the blue card
- [ ] Verify:
  - [ ] Banner appears (DEGRADED) or maintenance page shows (OFFLINE)
  - [ ] Open an incognito window to confirm users see the maintenance state
  - [ ] Bypass access works with the generated secret

## Quick Decision Guide

```
Is the database being modified?
  |
  +-- No  --> Is the deployment risky?
  |           |
  |           +-- No  --> Deploy without maintenance mode
  |           +-- Yes --> Use DEGRADED mode
  |
  +-- Yes --> Is the migration additive only (new tables/columns)?
              |
              +-- Yes --> OFFLINE mode, short window (<15 min)
              +-- No  --> OFFLINE mode, extended window
                          + Disable cron jobs if possible
                          + Full notification to users
```

## Database guarantee verification (2026-08-14, #1169 PR 9)

After any `prisma db push`, restore, or reset, run `npm run db:assert-sidecars` against the target database. The sidecar's guarantees (the exclusion constraint that is the platform's last line of defence against double-booking, every CHECK, and the partial uniques) are applied by hand, not by any deploy step, so this assertion is what turns silent drift into a loud failure. It parses the names straight out of `prisma/sql/check-constraints.sql`, ignoring the block staged for the pre-MVP reset.

