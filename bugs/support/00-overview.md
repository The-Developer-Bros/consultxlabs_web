# Support — Overview

## Context

In-app `SupportTicket` with responses, attachments, internal notes, and Swiggy-style links to consultation/subscription/payment/refund entities. User and staff APIs; Novu for create/update/response. Mobile API notes in `docs/api/support-tickets-mobile.md`.

## Architecture (2026-08-21, #support-hub)

Two scopes, one engine (`lib/support/`):

- **Per-appointment** — `AppointmentSupportThread` + `SupportMessage` (persisted, one per appointment×user), driven by `FlowchartResolver` over the code-defined flow registry (`flows.ts`). Stage-gated intents (upcoming/live/completed), provider vs attendee variants, org-party intents for operators. Escalation links a `SupportTicket` (the single ops queue) and flips the channel to HUMAN.
- **Platform** — stateless flowchart intake (`platform-flows.ts` + `POST /api/support/platform`); the client holds the cursor, the server validates every turn. Terminal = self-serve (nothing written) or a `SupportTicket` via the shared `createSupportTicket` factory (org-attributed via `SupportTicket.organizationId`).

Surfaces: the dashboard Support tab is the Swiggy-style hub (`SupportHub.tsx`: Sessions / Platform subtabs, status-bucketed, last-activity-sorted); the appointment detail page carries the inline thread status card + "Get help" sheet; back-office "Conversations" inbox (`threads.manage`) reads full transcripts and replies as AGENT (mirrored to the linked ticket); org dashboards get metadata-only triage + the CSAT aggregate (ADR 20 addendum 2026-08-21). Session-scoped issue types are rejected (422) on the platform ticket route — they belong on the appointment thread.

Deliberately NOT Stream: support chat stays on Postgres (transactional cursor+messages, low volume, ADR-20-allowlistable). Mirror-into-Stream is the post-launch option if human realtime is ever needed.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| No ticket merge/dedup for one failed payment | ✅ FIXED-BY #989 (runtime create-time reuse by `paymentId`) |
| Concurrent staff status updates last-write-wins | ✅ FIXED-BY #989 (status CAS) |
| No SLA / escalation / CSAT automation | 🟡 LEGIT-DEFERRED |
| No email-to-ticket ingestion / Zendesk bridge | 🟡 LEGIT-DEFERRED |
| Auto-refund-from-ticket unclear | 🟡 LEGIT-DEFERRED |
| Priority auto-escalation absent | 🟡 PARTIAL — reason→priority map (`lib/support/priority.ts`); time-based auto-escalation still deferred |

## Known gaps / bugs

- No SLA / escalation / CSAT automation.
- No email-to-ticket ingestion or Zendesk bridge.
- `refundId` link exists; auto-refund-from-ticket unclear.
- No ticket merge/dedup when user opens three tickets for one failed payment.
- Time-based priority auto-escalation is absent (the reason→priority mapping exists in `lib/support/priority.ts`).
- Concurrent staff status updates are last-write-wins (no version).

## Unhappy paths & user psychology

- User pays twice, opens two tickets + Razorpay dispute — three teams, no single owner.
- HIGH-priority ticket sits over weekend — no paging.
- Attachment upload fails on flaky mobile network — no resumable upload.
- Staff internal note accidentally non-internal — user sees raw ops language.

## Questions (handled?)

1. **Support channel strategy?**  
   - A) In-app only  
   - B) Email intake + in-app  
   - C) External helpdesk as system of record  

   **Recommendation: A.** Keep support in-app so tickets stay linked to consultation/payment entities without a second system of record.  
   - Not B: email intake adds bridge/SLA complexity before basic dedup and timers exist  
   - Not C: an external helpdesk splits ownership from Familiarise payment and booking truth  

2. **On-call for URGENT tickets?**  
   - A) PagerDuty  
   - B) Slack business hours  
   - C) Next-business-day only  

   **Recommendation: B.** Route URGENT tickets to Slack during business hours until volume and SLAs justify a paid paging stack.  
   - Not A: PagerDuty is premature before ticket volume and runbooks mature  
   - Not C: next-business-day is too slow for failed-payment panic  

3. **One payment one ticket rule?**  
   - A) Dedup by paymentId  
   - B) Allow multiples  
   - C) Auto-merge  

   **Recommendation: A.** Dedup by `paymentId` so one failed charge has one owner instead of three parallel threads.  
   - Not B: multiples recreate the pay-twice / dispute / ticket storm  
   - Not C: auto-merge is harder to get right than preventing duplicates at create  

## High concurrency / multi-device

User replies from phone while staff closes on desktop — need clear status CAS. Attachments from multiple devices should remain ticket-scoped.

## Suggested directions

Dedup by linked payment/refund. Define SLA timers even if manual at first. Keep mobile API doc current.
