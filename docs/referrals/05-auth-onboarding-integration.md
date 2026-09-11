# Referral × Authentication and Onboarding Integration

**Status**: Planned — branch `feat/email-verification-referral-capture`. This
document describes how a referral code is captured and applied across every
sign-up path, and how that interacts with the signup verification policy.

Tracking issue: [#880](https://github.com/Practitionist/familiarise_web/issues/880).
Reward policy lives in [04-reward-economics-and-decisions.md](./04-reward-economics-and-decisions.md).

## 1. The problem this solves

In the shipped MVP the referral code is applied only *after* signup, by a client
call to `POST /api/referrals/apply`, which requires an authenticated session.
That works for email/password signup but has two gaps. Google and other OAuth
signups complete through a full-page redirect that bypasses the signup handler,
and nothing persists the `?ref=` parameter across that redirect, so the code is
silently dropped and the referral is never attributed. Separately, once the
signup verification policy (below) requires a verified email, an email/password
signup no longer produces a session immediately, so the post-signup apply call
would have no session to authenticate against. Both problems have the same fix:
capture the code at first touch and apply it after the user authenticates,
whenever that happens.

## 2. Signup verification policy (the gate this integrates with)

The decision, recorded in full alongside the research in the issue tracker, is
that **verified email is the universal signup gate**, and the platform trusts
the `email_verified` claim from OAuth providers and enterprise SSO rather than
re-verifying those users. **Phone verification is not a signup requirement.** It
is instead a risk-based step-up applied only at money-moving moments — claiming
a referral reward, the first paid booking, and a consultant's first payout — and
its implementation and India compliance are tracked separately in
[#884](https://github.com/Practitionist/familiarise_web/issues/884). The reason
phone is not the signup gate is that phone verification is not an effective
sybil defense; the real anti-abuse controls are device fingerprinting, velocity
limits, and the reward deferral already in place.

## 3. Capture at first touch

When a prospective user arrives through a referral, the code is persisted on the
client before authentication so that it survives a full-page OAuth redirect. The
`/r/[code]` landing already validates the code and redirects an unauthenticated
visitor to `/auth/signup?ref=CODE` (and applies the code directly for an
already-authenticated visitor), and the signup page persists the code from the
`?ref=` parameter, and from the manual entry field, into client storage as soon
as it is known. The code is trimmed and validated by a small Zod schema before
it is stored, and the persisted value is cleared if the user empties the
referral field, so a stale or whitespace-only code is never carried forward.
Persisting before the user clicks a social provider is what closes the OAuth gap.

## 4. Apply after authentication

The stored code is applied once the user is authenticated, which for a new user
is when they first land on onboarding. This single apply point covers every
path. An email/password user verifies their address, is auto-signed-in, lands on
the verification page, and is routed to onboarding, where the code is applied. An
OAuth or SSO user returns from the provider already authenticated and lands on
onboarding, where the code is applied. Application reuses the existing
`applyReferralCode` path and remains idempotent, because the unique constraint
on `Referral.referredUserId` and the self-referral guard already enforce
once-only attribution. The apply is non-destructive: the stored code is read
without removing it and is cleared only on a successful apply or a terminal
rejection (an invalid, already-referred, or self-referral `400`); a transient
failure (network, `429`, or `5xx`) leaves the code in place so a later
authenticated render can retry rather than permanently losing attribution.

## 5. Path interaction matrix

| Sign-up path | Email verification | Session created at signup | Where the referral is applied |
|---|---|---|---|
| Email + password | Required (link/OTP) | No — only after verifying | Onboarding, after verify + auto-sign-in |
| Google / other OAuth | Trusted from provider | Yes (after redirect) | Onboarding, on first authenticated landing |
| Enterprise SSO | Trusted from IdP | Yes (after redirect) | Onboarding, on first authenticated landing |

## 6. Why the reward still cannot be farmed

Capturing and applying the code only records the *attribution* (the `Referral`
row in `SIGNED_UP` state). No credit is granted at this point. The actual reward
is still released only when the referee completes a real paid event — a paid
booking for a consultee, a completed session for a consultant — and only after
the hold past the refund window, exactly as described in the reward policy. The
integration therefore widens attribution coverage to OAuth and verified-email
signups without weakening the anti-farming guarantee.

## 7. References

- [#880](https://github.com/Practitionist/familiarise_web/issues/880) — tracking issue
- [#884](https://github.com/Practitionist/familiarise_web/issues/884) — phone step-up verification and compliance
- [04-reward-economics-and-decisions.md](./04-reward-economics-and-decisions.md) — reward policy and decision record
- [01-architecture.md](./01-architecture.md) — the underlying referral engine
