# Cancel, Reschedule & No-Show

## Context

Cancel: CAS-guarded transitions (`lib/booking/transitions.ts`), soft-cancel slots, policy refund for consultation/subscription after commit, waitlist open for events. Reschedule: 24h minimum notice, marks slots tentative, no new charge, consultant re-allocates. No-show: **not automated** (#471); auto-complete cron marks COMPLETED/UNVERIFIED; Stream attendance is foundation data.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| No automated no-show → refund/credit | ✅ FIXED-BY #992 (#471, consultations; subscriptions deferred TODO#471) |
| Partial subscription reschedule status wrong (#448) | ✅ FIXED-BY #988 |
| Docs outdated on who may cancel (code stricter) | 🟡 doc drift |
| Cancel preserves appointment rows for audit | 🟡 by-design (calendars must honour `completionStatus`) |
| Refund policy promises full no-show refund with no code path | ✅ FIXED-BY #992 (now automated) |

## Known gaps / bugs

- No automated consultant/consultee no-show → refund/credit.
- Partial subscription reschedule status semantics wrong (#448).
- Docs outdated on who may cancel (code requires participant/privileged).
- Cancel preserves appointment rows for audit — calendars must respect `completionStatus` or show ghosts.
- Refund policy docs mention full refund on consultant no-show without code path.

## Unhappy paths & user psychology

- Consultee waits 15 minutes on empty call; expects auto-refund; must fight support.
- Consultant cancels last-minute; consultee already took leave from work — policy % feels unfair without clear pre-booking disclosure.
- Reschedule under 24h blocked; user tries from two devices hoping one slips through.
- Webinar cancel frees seats; waitlist notified; original payer still sees “cancelled” and rebooks same seat race.

## Questions (handled?)

1. **No-show definition for automation?**  
   - A) No MeetingAttendance join within N minutes of start  
   - B) Manual only via SupportIssueType  
   - C) Consultant-confirmed no-show button + consultee contest window  

**Recommendation: A.** Define no-show as no MeetingAttendance join within N minutes so #471 can auto-refund from data already collected.
- Not B: Manual-only leaves policy-promised refunds dependent on support judgment.
- Not C: Consultant-gated confirmation invites bias and delays refunds the policy already promises.

> 🎯 Locked: rec A — #992 automates the no-show refund from MeetingAttendance for consultations (subscriptions remain TODO#471).

2. **Cancellation policy snapshot — show at checkout prominently?**  
   - A) Mandatory acknowledge checkbox  
   - B) Link in footer only  
   - C) Dynamic policy by plan tier with examples  

**Recommendation: A.** Require an acknowledge checkbox at checkout so refund % surprises become fewer disputes later.
- Not B: Footer-only links are invisible under payment pressure and do not reduce chargebacks.
- Not C: Dynamic tier examples are good later but secondary to a mandatory acknowledgment now.

3. **Reschedule under 24h — paid exception or never?**  
   - A) Never (current)  
   - B) Paid change fee  
   - C) Consultant discretion override  

**Recommendation: A.** Keep the hard 24h floor — clear, enforceable with CAS, and free of fee/product complexity.
- Not B: Paid change fees are a growth monetization path before #448 status correctness is fixed.
- Not C: Discretion overrides create inconsistent multi-device outcomes and support gray areas.

## High concurrency / multi-device

Cancel vs webhook: CAS — one wins. Cancel vs reschedule: `lockAppointment` (5 min). Multi-tab cancel double-submit should no-op after first success.

## Suggested directions

Ship #471 using existing `MeetingAttendance`. Align refund policy copy with automation reality until then.
