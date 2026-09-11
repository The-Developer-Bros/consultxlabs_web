# Concurrency & Double-Booking

## Context

Three layers: (1) Redis locks (`utils/appointmentlock.ts`) with documented lock order, (2) re-validation inside transactions, (3) DB GiST `slot_no_confirmed_overlap` for confirmed 1:1 slots. Events (webinar/class) use event locks + Serializable participant recount (no exclusion constraint). Payment confirmation re-checks overlaps before flipping `isTentative=false` (#827).

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| Both users pay; loser stays tentative, refund manual | ✅ FIXED-BY #990 (auto-refund on confirmation block) |
| `allocationIdempotencyKey` unwired | ✅ FIXED-BY #988 (#837) |
| Reconcile detector focuses on SUCCEEDED-payment slots | ✅ FIXED-BY #988 (`buildOccupiedAppointmentFilter`) |
| Class/webinar CRUD guards outside transaction (TOCTOU) | ✅ FIXED-BY #988 (Serializable tx) |
| Legacy rows missing `consultantProfileId` excluded from GiST | 🟡 accurate caveat (until backfilled) |

## Known gaps / bugs

- Both users can still **pay**; loser stays tentative — refund may be manual (Sentry `CONFIRMATION_BLOCKED_DOUBLE_BOOKING`).
- `allocationIdempotencyKey` unwired — double PATCH allocate can still surprise.
- Reconcile script double-booking detector focuses on SUCCEEDED-payment slots; misses some unpaid overlaps.
- Class/webinar CRUD booking-existence guards run outside transaction (TOCTOU window).
- Legacy rows missing `consultantProfileId` excluded from GiST until backfilled.

## Unhappy paths & user psychology

- Two consultees refresh the last green slot; both start Razorpay; both succeed; one gets meeting, one gets silence.
- Consultant manually allocates the same slot the consultee just paid for via another path.
- Waitlisted user notified while another checkout still holds a tentative seat.

## Questions (handled?)

1. **Loser of paid double-booking — auto-refund inside webhook?**  
   - A) Auto-refund on confirmation block  
   - B) Ops runbook + alert only  
   - C) Authorize-only until confirm; capture after GiST  

**Recommendation: A.** Auto-refund on `#827` confirmation block so the paid loser is not left on SUCCEEDED-with-tentative until ops notices.
- Not B: Ops-only recovery is too slow for chargebacks and panics after both parties paid.
- Not C: Authorize-then-capture after GiST is a speculative payment redesign; fix the known loser-refund gap first.

> 🎯 Locked: rec A — #990 auto-refunds the paid loser on the #827 confirmation block.

2. **Should validate-then-allocate UI freeze slots client-side?**  
   - A) Soft hold token for N seconds  
   - B) No UI hold; always recheck at submit  
   - C) Optimistic UI with instant 409 recovery UX  

**Recommendation: B.** Do not pretend the client owns a seat — always recheck at submit and tell the truth when the slot is gone.
- Not A: Client soft holds without a server hold feel like bait-and-switch when the timer expires under contention.
- Not C: Optimistic UI still needs the same recheck; “instant 409 recovery” is polish after correctness messaging exists.

3. **Event last-seat: prefer 503 (Redis down) or risk unlocked recount?**  
   - A) Keep fail-closed 503  
   - B) Continue on Serializable only  
   - C) External capacity semaphore (documented but not in prod)  

**Recommendation: A.** Keep fail-closed 503 for event checkout when Redis is down — overselling seats is worse than temporary conversion loss.
- Not B: Continuing on Serializable alone without the event lock increases last-seat double-sell risk.
- Not C: An external capacity semaphore is documented but not in prod — speculative vs the existing fail-closed path.

> 🎯 Locked: rec A matches shipped behaviour — event checkout stays fail-closed (503) when Redis is down.

## High concurrency / multi-device

20-user storm scenarios exist in tests. Under spike, expect 409/P2034 retries — clients must retry with backoff and clear “slot taken” copy. Multi-window same user: consultee lock serializes; different users contend on slot/event locks.

## Suggested directions

Make confirmation-blocked payments an automated refund path. Extend reconcile to use canonical `buildOccupiedAppointmentFilter`.
