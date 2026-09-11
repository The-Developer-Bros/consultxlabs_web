# Multi-Device, Tabs & Windows

## Context

Booking state lives on the server (appointments, tentative slots, payment status). Client calendars (`useSlotAllocation`, `useCalendarData`) can lag. Auth multi-device login is tested separately from booking races. Same email = same user; two devices share locks keyed by userId / consultant / slot.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| Large client hook shows stale availability across tabs | 🟡 by-design (client refetches; server is source of truth) |
| Checkout remount may mint new idempotency keys per tab | 🔵 checkout idempotency pre-existing (server reuse of open PENDING) |
| Reschedule A + allocate B → half-tentative subscription | ✅ FIXED-BY #988 (#448 scoped) |
| No first-class cross-device "booking session" mutex | 🟡 by-design (Redis locks on mutating APIs) |

## Known gaps / bugs

- Large client hook (~2170 lines) can show stale availability across tabs until refetch.
- Checkout remount may mint new idempotency keys per tab if not carefully shared.
- Reschedule on device A while allocate on device B can produce half-tentative subscription states (especially with slotId-based API).
- No first-class “booking session” mutex across devices beyond Redis locks on mutating APIs.

## Unhappy paths & user psychology

- User compares slots on phone and laptop, pays on both for overlapping times — second should fail, but UX may look like a bug.
- Consultant opens approval queue on iPad and desktop, double-approves — approval locks exist; UI may not disable the other device.
- Parent books on phone while teen’s laptop checkout is mid-payment for same account.
- User keeps an old tab open overnight; tentatives expire; tab still shows “complete payment.”

## Questions (handled?)

1. **Should open checkout create a visible soft hold across all devices for that user?**  
   - A) Cross-device hold banner via Realtime/poll  
   - B) Server locks only; no cross-device UX  
   - C) Force single active checkout session (kick other tabs)  

**Recommendation: A.** Surface a cross-device “payment in progress” banner from PENDING payments so phone/laptop users do not double-start checkout blindly.
- Not B: Server locks alone leave the other device looking free and drive duplicate pay attempts.
- Not C: Kicking other tabs is hostile UX when a banner plus server reuse of PENDING payments is enough.

2. **Expired tentative + stale tab — auto-redirect or allow revive?**  
   - A) Hard expire; restart checkout  
   - B) Revive if slot still free  
   - C) Convert to waitlist automatically  

**Recommendation: A.** Hard-expire stale tabs and restart checkout so overnight clients cannot revive into a raced seat.
- Not B: Revive-if-free races other checkouts and recreates bait-and-switch psychology.
- Not C: Auto-waitlist converts a payment intent into a different product without explicit consent.

3. **Consultant multi-device approve — require step-up confirm?**  
   - A) Yes for revenue-impacting approve  
   - B) Redis lock sufficient  
   - C) WebAuthn for high-value plans  

**Recommendation: B.** Approval Redis locks already serialize double-approve; add clearer UI disablement rather than step-up ceremony.
- Not A: Extra confirm friction on every revenue approve slows consultants without fixing stale-tab UX.
- Not C: WebAuthn for high-value plans is speculative security ahead of wiring allocate idempotency (#837).

## High concurrency / multi-device

Treat multi-tab as concurrent clients. Prefer server CAS over trusting client selection state. Calendar refetch after every 409.

## Suggested directions

Add “payment in progress on another device” detection using PENDING payments for the user. Document expected behavior in support macros.
