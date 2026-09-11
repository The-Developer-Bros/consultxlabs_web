# Maintenance Mode Documentation

Familiarise's maintenance mode system provides two-tier protection (DEGRADED and OFFLINE) for planned downtime. It uses Redis for edge-fast reads and Prisma for audit trails, with fail-open design ensuring the site stays up if Redis becomes unreachable.

## Quick Reference

| Mode         | User Experience                 | Reads | Writes    | Webhooks     | Cron Jobs | BetterStack           |
| ------------ | ------------------------------- | ----- | --------- | ------------ | --------- | --------------------- |
| **OFF**      | Normal operation                | Yes   | Yes       | Yes          | Yes       | No incident           |
| **DEGRADED** | Warning banner, site functional | Yes   | Yes (gap) | Yes          | Yes (gap) | No incident           |
| **OFFLINE**  | Full maintenance page           | No    | No        | Yes (exempt) | Yes (gap) | Auto-creates incident |

**Key gaps**: DEGRADED does not block writes. Cron jobs bypass middleware entirely in all modes.

## Table of Contents

0. [BetterStack Setup Guide](./00-betterstack-setup.md) -- **Start here**: full from-scratch setup: account, monitors, status page, API token
1. [Architecture](./01-architecture.md) -- System design, data flow, key files
2. [DEGRADED vs OFFLINE](./02-degraded-vs-offline.md) -- What each phase blocks (with tables)
3. [Business Risks](./03-business-risks.md) -- Money-at-stake analysis
4. [Cron Jobs Reference](./04-cron-jobs-reference.md) -- All 61 jobs, schedules, locking, maintenance impact
5. [Webhook Behavior](./05-webhook-behavior.md) -- Payment webhook handling during downtime
6. [Pre-Maintenance Checklist](./06-pre-maintenance-checklist.md) -- Step-by-step operational checklist
7. [Post-Maintenance Recovery](./07-post-maintenance-recovery.md) -- Verification and reconciliation steps
8. [SDK Update Guide](./08-sdk-update-guide.md) -- Detailed per-package update guide
9. [Future Improvements](./09-future-improvements.md) -- Planned code changes for better protection

## Emergency Contacts

| Role           | Contact | Notes                                        |
| -------------- | ------- | -------------------------------------------- |
| Platform Admin | _TBD_   | Primary escalation for maintenance decisions |
| DevOps Lead    | _TBD_   | Infrastructure and deployment issues         |
| Payment Ops    | _TBD_   | Payment reconciliation and refund issues     |

## Quick Commands

**Start DEGRADED mode** (admin dashboard):
`Dashboard > Maintenance > Start Degraded Mode`

**Start OFFLINE mode** (admin dashboard):
`Dashboard > Maintenance > Start Offline Mode`

**Bypass during maintenance** (for admin testing):

- Header: `x-maintenance-bypass: <secret>`
- Cookie: `maintenance_bypass=<secret>`

**Health check**: `GET /api/health` -- returns maintenance state + BetterStack connectivity

```json
{ "status": "healthy", "maintenance": { "phase": "OFF" }, "betterstack": { "configured": true, "reachable": true, "monitors": [...] } }
```
