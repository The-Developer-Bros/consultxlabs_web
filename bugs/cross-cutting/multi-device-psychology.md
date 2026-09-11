# Cross-Cutting — Multi-Device Psychology

## Context

Real users do not use one browser tab. They bounce between phone, laptop, iPad, WhatsApp OTPs, UPI apps, and email deep links. Familiarise is largely a **web** product with server-authoritative mutations, but client state and third-party SDKs (Razorpay, Stream, Novu, OAuth) create multi-surface races.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's cross-system claims map as follows:

| Claim (short) | Verdict |
|---|---|
| Onboarding: same email, two roles, two devices → last write wins | ✅ FIXED-BY #985 (onboarding CAS) |
| Waitlist: notify then claim elsewhere without soft hold | ✅ FIXED-BY #986 (seat-hold) |
| Checkout: new idempotency keys per remount/tab | 🔵 by-design (checkout idempotency pre-existing) |
| Referrals: localStorage attribution dies across devices | 🔵/🎯 accepted (post-auth entry deferred) |
| Booking: stale green slots across devices | see booking pack — ✅ #988 correctness, ✅ #990 auto-refund |
| Payments: UPI-on-phone success invisible until refresh | 🔵 by-design (server-truth + refetch) |
| Stream video: multi-tab join → echo / duplicate sessions | 🟡 LEGIT-DEFERRED |
| Notifications: preference toggles disagree across APIs/devices | 🟡 LEGIT-DEFERRED |

## Known gaps / bugs (cross-system)

- Platform onboarding: same email, two roles, two devices → last write wins.
- Checkout: new idempotency keys per remount/tab if not shared.
- Booking calendars: stale green slots across devices.
- Waitlist: notify on email/phone; claim on another device without soft hold.
- Referrals: localStorage attribution dies across devices.
- Stream video: multi-tab join → echo / duplicate sessions.
- Auth: OAuth completes on one device; other tabs need broadcast; onboarding drafts diverge.
- Payments: UPI on phone while desktop modal open — success invisible until refresh.
- Notifications: preference toggles disagree across APIs/devices.
- Support: parallel tickets from phone + desktop for one payment.

## Unhappy paths & user psychology (catalogue)

1. **Double identity intent** — consultant firm signup on laptop + consultee curiosity on phone.  
2. **Payment anxiety** — OTP on phone; desktop shows failure; user pays twice.  
3. **Meeting panic** — join on iPad then phone “for audio”; call ruined.  
4. **False availability** — old tab overnight; slot expired; blame the product.  
5. **Referral betrayal** — shared link; signup elsewhere; no reward.  
6. **Org admin split brain** — SSO enforce on laptop; password attempt on phone blocked opaquely.  
7. **Approve twice** — consultant taps approve on two devices; second 409 feels broken.  
8. **Dispute storm** — cancel on web, dispute in bank app, ticket in support — three truths.

## Questions (handled?)

1. **Product principle for multi-device?**  
   - A) Server truth + aggressive refetch; allow parallel sessions  
   - B) Single active session per user (kick others)  
   - C) Soft warnings when parallel mutating sessions detected  

   > 🎯 Locked: A — server is authoritative with refetch; parallel sessions stay allowed (UPI-on-phone / email deep links require it).


   **Recommendation: A.** Treat the server as truth with aggressive refetch and allow parallel sessions — UPI-on-phone and email deep links require it.  
   - Not B: kicking other sessions breaks the phone-OTP / desktop-checkout flow  
   - Not C: soft warnings alone do not fix stale slots or double submits  

2. **Where to invest first?**  
   - A) Onboarding CAS + checkout key persistence  
   - B) Stream single-session  
   - C) Cross-device pending-payment banner  

   > 🎯 Locked: A — onboarding CAS shipped (#985) and waitlist seat-hold (#986); checkout idempotency pre-existing. Stream single-session and banners deferred.


   **Recommendation: A.** Invest first in onboarding CAS and checkout idempotency-key persistence — identity and money races hurt more than call echo.  
   - Not B: Stream single-session matters but is secondary to signup/payment correctness  
   - Not C: banners help UX but do not remove the root remount/tab races  

3. **Mobile strategy?**  
   - A) Responsive web + WebView payments  
   - B) Native SDK later  
   - C) PWA install prompts  

   **Recommendation: A.** Double down on responsive web plus WebView-friendly payments before native — Familiarise is still a web product.  
   - Not B: native SDKs can wait until web multi-device money flows are solid  
   - Not C: PWA install prompts without fixing dual-device races are vanity  

## High concurrency / multi-device

Treat every user as N concurrent clients. Idempotency, CAS, and clear 409 copy matter more than perfect UI sync. Prefer banners: “You have a payment in progress,” “You joined this call elsewhere,” “Onboarding continued as ROLE on another device.”

## Suggested directions

Ship three banners above before new features: pending payment, active call elsewhere, onboarding role lock. Add chaos tests for dual-device onboarding and dual-tab checkout.
