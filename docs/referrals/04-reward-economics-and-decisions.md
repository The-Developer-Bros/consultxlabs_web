# Referral Reward Economics and Decision Record

**Status**: Planned — decisions finalized 2026-06-17. This document records the
agreed target model and the investigation behind it. The reward *engine*
(credits, ledger, deferral, refund-safety) is already implemented and described
in [01-architecture.md](./01-architecture.md) and [03-credit-system.md](./03-credit-system.md);
what is planned here is the reward *policy* (amounts, role-weighting, the
seller-side instrument, guardrails) plus the auth/onboarding integration in
[05-auth-onboarding-integration.md](./05-auth-onboarding-integration.md).

Tracking issue: [#880](https://github.com/Practitionist/familiarise_web/issues/880).

## 1. Why we revisited the policy

The shipped MVP (see [00-overview.md](./00-overview.md)) pays a flat ₹500 to the
referrer and ₹200 to the referee regardless of who is referred. That scheme is
roughly the right magnitude for the Indian market, but it is role-blind, and
two facts make role-blindness wrong for this marketplace. First, the two sides
are not equally scarce: for Familiarise, consultees (demand) are the harder side
to acquire, which is the inverse of the usual marketplace "supply premium," so
acquiring a consultee should be rewarded more than acquiring a consultant.
Second, the reward instrument has to match what the referred person actually
does: a new consultee buys sessions, so a booking credit is valuable to them,
whereas a new consultant sells sessions, so a booking credit is worthless and a
seller-side incentive is required instead.

We also wanted to bound early-stage cost, because a pre-scale platform cannot
absorb an unbounded referral liability while the unit economics are still
unproven.

## 2. The agreed model

The reward is platform-funded and always deferred to a real economic event, and
the payout now depends on the role the referred user takes.

| Referee's resulting role | Referrer reward | Referee reward / instrument | Qualifying action | Window |
|---|---|---|---|---|
| **Consultee** (demand — prioritized) | ₹500 booking credit (launch: ₹300, ramped to ₹500 once unit economics are proven) | ₹300 booking credit, redeemable on a booking of ₹500 or more | Referee's **first paid booking** completes (held past the refund window) | 30 days |
| **Consultant** (supply) | ₹300 booking credit | 0% platform commission on the first 3 completed sessions (capped at roughly ₹2,000 of forgone take-rate), optionally plus ₹200 cash on the first completed session | Referee's **first completed/paid session** (delivered, not merely joined) | 90 days |

The reward is determined by the referee's resulting role, not the referrer's, so
all four cross-role directions are allowed and only the amount and instrument
differ (see §3).

These amounts sit at the Indian two-sided cash norm (Urban Company pays roughly
₹300/₹300, CRED about ₹250, Google Pay around ₹301) and at approximately
10–20% of a plausible consultee acquisition cost and of a typical entry booking,
which on Topmate-class platforms falls in the ₹500–2,000 band.

## 3. Cross-role matrix

| Referrer → Referee | Allowed | Reward driver |
|---|---|---|
| Consultee → Consultee | Yes | Consultee (demand) rate — highest |
| Consultant → Consultee | Yes | Consultee (demand) rate — highest |
| Consultee → Consultant | Yes | Consultant (supply) rate |
| Consultant → Consultant | Yes | Consultant (supply) rate |

Self-referral remains blocked, and one referral per referred user remains
enforced by the unique constraint on `Referral.referredUserId`.

## 4. The consultant (seller) instrument

A referred consultant receives a **commission waiver** — zero platform
commission on their first three completed sessions, capped at roughly ₹2,000 of
forgone take-rate — optionally supplemented by a small ₹200 cash bonus on the
first completed session. This was chosen over the alternatives for three
reasons. It is self-funding, because the platform only forgoes take-rate on
revenue that actually exists, so a consultant who never sells costs nothing and
the scheme adds no payout liability. It maps to seller economics, which a buyer
booking credit does not. And it matches the marketplace norm of fee relief for
new supply (for example Amazon and Walmart new-seller fee credits, and
Airbnb/Fiverr host cash on first booking). Featured-placement rewards were
rejected because they corrupt ranking integrity and have no clean
specification, and a referrer-only scheme was rejected because it
under-incentivizes the supply side we still need to grow.

## 5. Qualifying actions and windows

Rewards are released only on a real, completed economic event, which is the
strongest anti-farming control and matches the documented norm across Uber,
Airbnb, and Fiverr, all of which pay on completed work rather than signup. A
consultee qualifies when their first paid booking completes and clears the
refund window. A consultant qualifies when their first session is actually
delivered, not merely when they join. The qualification window is 30 days for
consultees but 90 days for consultants, because sellers take materially longer
to onboard, verify, and deliver a first session; this asymmetry follows the
benchmark set by platforms such as Airbnb, which gives hosts a 180-day window.

## 6. No pre-booking activation reward at launch

We considered granting consultees a small credit on verified onboarding, before
any booking, to push the scarce demand side harder. We decided against it for
launch. Granting any reward before a paid event re-opens fake-account farming,
which is the single largest referral-fraud vector, and it would contradict the
entire scheme's anti-farming premise of deferring to a real economic event. The
cleaner lever for pulling demand is simply the larger ₹300 referee credit
already in the model. If demand acquisition later proves critically stalled, a
tightly gated micro-reward (no more than ₹100, non-withdrawable, expiring in 14
days, released only behind phone and email verification and a booking already
initiated) can be revisited.

## 7. Guardrails and conservative launch

The per-code referral cap is lowered from 50 to **25**, an annual value cap of
about **₹10,000 per code** is added, and the credit expiry is tightened from six
months to **90 days**, all to bound fraud exposure and outstanding liability for
a pre-scale platform; these mirror the count caps and annual-rupee caps used by
Airbnb, Google Pay, and PhonePe. Every reward is held past the
refund/chargeback window before release, which is the single most-cited fraud
control, and a ₹500 minimum spend is required to redeem a referee credit so the
credit never exceeds the value of the transaction it discounts.

Because the platform is pre-scale and the founder is rightly cautious about
early-stage loss, the program launches conservatively. A program-wide monthly
budget cap is enforced with automatic pause when it is reached, putting a hard
ceiling on total spend. The consultee referrer reward starts at ₹300 and ramps
to ₹500 only after the customer-acquisition-cost and lifetime-value economics
are validated. The consultant referrer reward starts at its target ₹300.

## 8. Cost and liability model

The headline figures look larger than the real exposure, which is bounded for
four reasons. Nothing is paid for signups that never convert, because every
reward is deferred to a real paid event, so a referred user who never books
costs nothing. The credits are discounts on real revenue rather than cash out,
because the ₹500 minimum spend means a ₹300 referee credit discounts a booking
of at least ₹500 that the platform is actually fulfilling, which is effectively
an acquisition discount on a real transaction. The consultant instrument is
self-funding, because the commission waiver only forgoes take-rate on sessions
that actually happen. And the per-code and annual caps, together with the
program-wide monthly budget cap, bound both per-user and aggregate exposure. The
worst case for a single converted consultee referral is therefore roughly ₹800
of credits redeemable only against real bookings, capped per user and per year.

## 9. Decision log and trade-offs

The following records each decision, the options weighed, the choice, and the
main alternative, so the reasoning survives beyond this conversation.

- **Funding model.** Platform-funded credits were kept over a consultant-funded
  discount, because seller-funded rewards discourage consultant participation
  and complicate payouts and refunds, while platform funding is the standard
  acquisition investment for a marketplace.
- **Role weighting and its direction.** A role-weighted scheme biased toward
  consultees was chosen over the flat MVP scheme and over the generic
  supply-premium, because for this marketplace demand is the scarce side and a
  referred consultee both costs the scarce side and immediately generates GMV.
- **Reward amounts.** Flat ₹500 referrer and ₹300 referee for consultees, and
  ₹300 referrer for consultants, were chosen over a percentage-of-first-booking
  model and over a more aggressive ₹750/₹500 demand push. Flat amounts are the
  market norm and are easy to advertise; a percentage protects margin on cheap
  bookings but harms UX; the more aggressive amounts raise early cost and
  liability beyond what a pre-scale launch should carry.
- **Seller instrument.** A commission waiver was chosen over a flat cash bonus,
  a payout-fee waiver, featured placement, or nothing, for the self-funding,
  seller-mapped, liability-safe reasons in §4.
- **Pre-booking micro-reward.** Declined at launch for the anti-farming reasons
  in §6.
- **Windows.** Split windows of 30 days for consultees and 90 days for
  consultants were chosen over a uniform 60-day window, because a single timer
  is slightly loose for consultees and slightly tight for consultants.
- **Caps and expiry.** Tightened to a 25-referral cap, a ~₹10,000 annual value
  cap, and a 90-day expiry, over keeping the generous 50-cap and six-month
  expiry, to bound fraud and liability at this stage.
- **Launch posture.** A conservative launch with a program budget cap and a
  ramped referrer reward was chosen over shipping full amounts immediately and
  over an invite-only beta, to put a hard ceiling on early loss while still
  letting the program run.
- **Organization referrals.** Deferred to a separate B2B effort; the existing
  attribution-only `Referral.organizationId` tag (`#727`) is kept for analytics,
  but org-to-org codes, employee campaigns, and org credit pools are out of
  scope here because they need different, revenue-aligned mechanics.

## 10. Fraud controls

Phone or UPI verification rather than email alone, single-use codes, per-day
velocity limits, self-referral detection across device, UPI, and IP, the
deferral to a completed paid event, the hold past the refund window, and the
per-code, annual, and program-wide budget caps together form the anti-abuse
posture. Phone verification specifically is a trust signal at money-moving
moments and not the primary sybil defense; that decision and its India
compliance work are tracked separately in
[#884](https://github.com/Practitionist/familiarise_web/issues/884).

## 11. Research sources

- Indian two-sided and fintech referral norms (Urban Company, cult.fit, PhonePe, CRED, Google Pay) — https://www.gopaisa.com/referral-signup-bonus-code-coupons-offers/phone-pe-new-user-referral-offer-code
- Topmate session pricing and affiliate model — https://topmate.io/features/meetings
- Marketplace supply-side referral instruments (Airbnb host, Uber, Fiverr) — https://growsurf.com/examples/marketplace-referral-programs/
- Reward sizing versus CAC/LTV and percentage of first transaction — https://referralhero.com/blog/referral-reward
- Referral fraud vectors and guardrails — https://www.referralcandy.com/blog/referral-fraud

## 12. References

- [#880](https://github.com/Practitionist/familiarise_web/issues/880) — referral × auth/onboarding integration (the tracking issue for this work)
- [#884](https://github.com/Practitionist/familiarise_web/issues/884) — phone/SMS step-up verification and its India compliance
- `#437` — deferral of the referee bonus to first paid booking (already shipped)
- `#727` — organization attribution tag; `#766` — org-funded bookings block credit use
- [05-auth-onboarding-integration.md](./05-auth-onboarding-integration.md) — capture and apply flow, verification interaction
