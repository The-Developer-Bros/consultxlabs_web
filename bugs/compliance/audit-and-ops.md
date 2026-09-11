# Audit Logs & Compliance Ops

## Context

`OrgAuditLog` with categories and sanitization; CSV export; retention prune (7y financial-ish, 2y operational). Ledger + TDSRecord as financial audit. Webhook scrubber for PII. Compliance jobs: IRP, MSME alerts, breach deadlines, consent sweeper, data exports, audit prune.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| No platform-wide B2C user audit log (org-scoped only) | 🟡 LEGIT-DEFERRED |
| Supabase `audit_logs` historical dead end (removed triggers) | 🟡 LEGIT-DEFERRED |
| Missing jobs: grievance SLA sweeper, GST TCS aggregator, TDS quarterly prep, erasure SLA cron | 🟡 LEGIT-DEFERRED |
| SOC 2 / ISO evidence automation deferred | 🟡 LEGIT-DEFERRED |
| Cron Slack alerts need `SLACK_OPS_WEBHOOK_URL` | 🔵 config gate (ops wiring) |

## Known gaps / bugs

- No platform-wide B2C user audit log — org-scoped emphasis.
- Supabase `audit_logs` historical dead end (removed triggers).
- Missing planned jobs: grievance SLA sweeper, GST TCS aggregator, TDS quarterly prep, erasure SLA cron.
- SOC 2 / ISO evidence automation deferred.
- Cron Slack alerts need `SLACK_OPS_WEBHOOK_URL`.

## Unhappy paths & user psychology

- Enterprise security questionnaire asks for immutable admin audit of B2C staff actions — thin answer today.
- Breach table updated late; 72h alert fires after customer already tweeted.

## Questions (handled?)

1. **Platform audit log for ADMIN/STAFF on consumer data?**  
   - A) Build now  
   - B) Org-only until SOC 2  
   - C) Rely on provider logs (BetterAuth, Sentry)  

**Recommendation: A.** Staff access to consumer data needs our own immutable trail for enterprise questionnaires and disputes.  
- Not B: Org-only leaves B2C admin actions invisible until SOC 2 forces a scramble.  
- Not C: Provider logs are incomplete, not retention-aligned, and hard to export for auditors.

2. **Page on-call for compliance cron failures?**  
   - A) PagerDuty  
   - B) Slack only  
   - C) Weekly human checklist  

**Recommendation: B.** Slack ops webhook is enough at current cron criticality; escalate to pager when breach/erasure SLAs go live.  
- Not A: PagerDuty overhead before SLAs and volume justify it.  
- Not C: Weekly checklists miss 72h breach clocks.

3. **Erasure SLA automation?**  
   - A) Cron escalating overdue ErasureRequest  
   - B) Admin calendar reminder  
   - C) Legal holds queue first  

**Recommendation: A.** Admin DSAR is fine interim only if an escalating SLA cron exists.  
- Not B: Calendar reminders do not survive vacation or ticket volume.  
- Not C: Legal holds matter but should not block overdue-request escalation.

## High concurrency / multi-device

Audit write volume under webhook storms — ensure async/non-blocking. Export jobs must not lock hot tables during business hours.

## Suggested directions

Wire Slack ops webhook. Add erasure SLA sweeper. Decide platform audit scope before enterprise security reviews.
