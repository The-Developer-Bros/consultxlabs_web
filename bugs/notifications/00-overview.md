# Notifications — Overview

## Context

Dual path: **Resend** for auth/payment/waitlist transactional email; **Novu** for 40+ product workflows (appointments, support, reviews, referrals, collaborators, org events). `NotificationPreference` rich model; **two APIs** (legacy narrow toggles vs full Novu sync). Subscriber sync on signup. Failed email retry job. Push/SMS/WhatsApp largely missing (roadmap).

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| Fire-and-forget Novu triggers → duplicate on retries (no transactionId) | ✅ FIXED-BY #989 (idempotent workflow key) |
| Novu unset → workflows silently skip | ✅ FIXED-BY #989 (fail-loud Sentry in prod) |
| Marketing consent (`MARKETING_COMMS`) not stamped at signup | 🔵 TRACKED #701 |
| Preference API duplication (two shapes) | 🟡 LEGIT-DEFERRED |
| Push/FCM missing despite schema fields | 🟡 LEGIT-DEFERRED |
| Quiet-hours enforcement depends on Novu dashboard rules | 🟡 LEGIT-DEFERRED |
| Directus broadcast webhook stub | 🔵 TRACKED #312 |

## Known gaps / bugs

- Preference API duplication — different shapes, user confusion.
- Push/FCM marked missing in ecosystem docs despite schema fields.
- Quiet hours stored; enforcement depends on Novu dashboard rules — drift risk.
- Fire-and-forget Novu triggers — duplicate events on webhook retries possible.
- If Novu unset, workflows silently skip — “notifications broken” with no user-visible reason.
- Marketing consent (`MARKETING_COMMS`) not stamped at signup (#701 follow-up).
- Directus broadcast webhook stub (#312).

## Unhappy paths & user psychology

- User disables email in one settings page; other API still sends — feels ignored.
- Critical payment email works (Resend) but in-app bell empty (Novu down) — split brain.
- Quiet hours violated because Novu cloud rule differs from app toggle.
- Multi-device: read state not synced across tabs beyond Novu subscriber model.

## Questions (handled?)

1. **Long-term orchestration?**  
   - A) Novu for all product events  
   - B) In-house for critical; Novu for engagement  
   - C) Resend-only simplify  

   **Recommendation: B.** Keep Resend for critical auth/payment/waitlist mail and Novu for product workflows — that dual path already matches how Familiarise ships.  
   - Not A: putting critical money/auth mail only through Novu adds a single failure domain  
   - Not C: Resend-only drops in-app bells and the 40+ product workflows already wired  

2. **Push before mobile app?**  
   - A) Skip  
   - B) Web push first  
   - C) Build with native app  

   **Recommendation: A.** Skip push until a real mobile client exists — schema fields without delivery only create false expectations.  
   - Not B: web push before native is half-baked and competes with email that already works  
   - Not C: bundling push with native is fine later; it is not a now decision  

3. **Unify preference APIs?**  
   - A) Deprecate legacy immediately  
   - B) Facade over both  
   - C) Keep legacy for mobile docs  

   **Recommendation: A.** Deprecate the legacy narrow preference API immediately so one Novu-synced model stops “I turned email off” split brain.  
   - Not B: a facade prolongs two shapes and two bugs  
   - Not C: keeping legacy for mobile docs locks in the confusion  

## High concurrency / multi-device

Duplicate notifications under webhook storms — prefer idempotent workflow keys. `auth-broadcast` syncs login, not notification reads. Multi-device preference edits last-write-wins.

## Suggested directions

One preferences UI/API. Fail loud in staging when Novu missing. Stamp marketing consent explicitly.
