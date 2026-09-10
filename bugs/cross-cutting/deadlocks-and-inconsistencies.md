# Cross-Cutting — Deadlocks & Inconsistencies

> **Verdict pass 2026-09-03/04.** Every money-related claim in this file was re-checked against `dev@e1766fa2d` and the live database as part of the 2026-09-03 finance-subsystem verification. Of 8 claims, 4 are still true today, 3 have been addressed since this dossier was written, and 1 are stale. See [`docs/payments/audits/2026-09-03-finance-verdicts.md`](../../docs/payments/audits/2026-09-03-finance-verdicts.md) for the per-item disposition.

## Context

Familiarise avoids classic DB deadlocks with documented Redis lock ordering (consultant/event → consultee → slot) and sorted ledger account updates. Residual pain is less “DB deadlock” and more **distributed inconsistency windows**, **doc/code drift**, and **asymmetric fail modes**.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short)                                                           | Verdict                                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Payment Phase-2 side effects outside confirm tx (skew healed by crons)  | 🔵 by-design (ACK-before-complete + sweeper)                     |
| Sorted ledger-account locking / deadlock avoidance                      | 🔵 by-design                                                     |
| Consent "stub" comments vs live fail-closed checks                      | ✅ FIXED-BY #989 (checkConsent docstring corrected)              |
| `revokeSession` comment-only vs real mechanism                          | ✅ FIXED-BY #985 (comment corrected; true revoke follow-up #725) |
| Payment critical-bugs task file vs fixed code (doc drift)               | ✅ resolved (task file superseded; code fixed)                   |
| Subscription status vs per-session slot after partial reschedule (#448) | ✅ FIXED-BY #988                                                 |
| Rating denormalization vs review rows                                   | ✅ FIXED-BY #987                                                 |
| Wallet cache vs ledger journal drift                                    | ✅ FIXED-BY #990 (freeze + page on reconcile `ok=false`)         |
| Stream call exists before MeetingSession row (orphan window)            | 🟡 LEGIT-DEFERRED                                                |
| BetterAuth `Member` vs `Membership` dual source                         | 🟡 LEGIT-DEFERRED (large)                                        |
| SCIM/docs vs live implementation drift                                  | 🟡 doc drift (SCIM implemented; docs say parked)                 |
| Display currency vs INR settlement dual truth                           | 🔵 TRACKED #783                                                  |
| Novu vs Resend delivery split brain                                     | 🟡 LEGIT-DEFERRED                                                |

## Known gaps / bugs

### Locking & ordering

- Lock order documented — regressions possible when new locks added without review.
- Consultation vs event Redis fail behavior asymmetric (events fail closed).
- Long Serializable txs + pool exhaustion → user-visible timeouts that look like deadlocks.
- Appointment lock TTL 5 min can block cancel/reschedule if a client dies holding intent (server lock, not client).

### Consistency windows

- Payment Phase-1 confirm vs Phase-2 earnings/notifications — temporary skew healed by crons.
- Razorpay `after()` ACK before complete — booking lag.
- Wallet cache vs ledger journal — nightly reconcile.
- Stream call exists before MeetingSession row — orphan window.
- Subscription status vs per-session slot state after partial reschedule (#448).
- Rating denormalization vs review rows.
- Novu vs Resend delivery split brain.
- SCIM/docs vs live implementation drift (doc drift only — SCIM is implemented). Payment critical-bugs task file vs fixed code and consent “stub” comments vs live checks are both resolved per the verdict table above.

### Dual sources of truth

- BetterAuth `Member` vs `Membership`.
- `User.role` vs org `MemberRole` (intentional but easy to misuse in UI).
- Display currency vs INR settlement.
- App validate-access vs Stream permissions.
- Legacy notification preferences vs Novu preferences.

## Unhappy paths & user psychology

- User sees “paid” email before calendar updates — books conflict elsewhere.
- Ops trusts outdated doc (“any user can cancel”) — security/process error.
- Finance trusts wallet balance UI during drift — overdraft attempts fail mysteriously.
- Two admins follow different runbooks because task files disagree with code.

## Questions (handled?)

1. **How to govern new distributed locks?**
   - A) ADR + checklist in PR template
   - B) Central lock registry module only
   - C) Prefer DB constraints over new Redis locks

   **Recommendation: A.** Require an ADR plus PR-template checklist for every new distributed lock so order and fail-open/closed stay reviewable.
   - Not B: a registry without process still drifts when someone adds a lock ad hoc
   - Not C: DB constraints cannot cover Redis slot and appointment intent races

2. **Accept eventual consistency for Phase-2 side effects?**
   - A) Yes + status page + SLA
   - B) Move earnings inside confirm txn
   - C) Outbox pattern with visible pending

   > 🎯 Locked: Phase-2 stays by-design ACK-before-complete with a sweeper/cron backstop; not moved into the confirm txn (B) and no new outbox this wave.

   **Historical recommendation (2026-07-12): C.** Use an outbox (or explicit pending status) for Phase-2 earnings/notifications so users see “processing” instead of silent skew. This was superseded by the 2026-09-03 Locked decision above, which keeps ACK-before-complete with no new outbox this wave.
   - Not A: a status page alone still leaves confirm→side-effect gaps invisible in-product
   - Not B: stuffing earnings into confirm lengthens ACK windows and timeouts

3. **Doc drift process?**
   - A) Docs CI check against flags/paths
   - B) Quarterly audit only
   - C) Delete stale task files when fixed

   **Recommendation: C.** Delete stale task docs when bugs are fixed so ops never follows a runbook that disagrees with code.
   - Not A: full docs CI is heavier process than Familiarise needs right now
   - Not B: quarterly-only lets wrong payment/security docs linger for months

4. **Unify dual truth pairs?**
   - A) Hard deprecate BetterAuth Member fields in app logic
   - B) Keep bridge forever
   - C) Generate Membership from Member only

   **Recommendation: A.** Hard-deprecate BetterAuth `Member` fields in app logic and lean on `Membership` — dual truth is how role bugs keep returning.
   - Not B: keeping the bridge forever preserves every UI misuse of the wrong role model
   - Not C: generating Membership from Member only still couples product auth to BetterAuth’s shape

## High concurrency / multi-device

Under spike, inconsistency windows lengthen (sweeper lag, pool wait, Stream breaker open). Multi-device users observe _different slices_ of the window and conclude the system is random.

## Suggested directions

1. Outbox or explicit “pending side effects” for payment Phase-2.
2. PR template: lock order + idempotency key + fail-open/closed choice.
3. Monthly “doc drift” pass on flags, SCIM, payment bug register, compliance stubs.
4. Prefer one user-visible status model for “money vs booking vs meeting” alignment.
