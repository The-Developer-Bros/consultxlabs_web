# Email Verification and Phone Step-Up

| Field | Value |
|---|---|
| Status | Email verification: implemented on `feat/email-verification-referral-capture`. Phone step-up: stub only (tracked in #884). |
| Audience | All engineers |
| Last reviewed | 2026-06-17 |
| Source files | `lib/auth.ts`, `lib/email.ts`, `emails/auth/VerificationEmail.tsx`, `app/auth/verify-email/page.tsx`, `app/auth/signup/page.tsx`, `app/auth/signin/page.tsx`, `lib/auth-phone-stepup.ts` |

## 1. Decision

Verified email is the universal signup gate for credential (email/password)
accounts. Google and other OAuth signups, and enterprise SSO signups, are
trusted as verified because the identity provider already asserts a verified
email, so they are not re-verified. Phone verification is deliberately **not** a
signup requirement; it is a risk-based step-up reserved for money-moving moments
(claiming a referral reward, the first paid booking, and a consultant's first
payout) and is implemented separately under #884. The reasoning, including the
2026 fraud-cost and India-compliance research behind it, is recorded in #884 and
summarised in `docs/referrals/05-auth-onboarding-integration.md`: phone
verification is not an effective sybil defense, and the India cost of a
phone-first signup is the TRAI/DLT regulatory overhead rather than the per-SMS
price.

## 2. Email verification flow

`lib/auth.ts` sets `emailAndPassword.requireEmailVerification: true` and
configures the `emailVerification` block with `sendOnSignUp: true`,
`autoSignInAfterVerification: true`, a one-hour `expiresIn`, and a
`sendVerificationEmail` hook that delegates to `sendVerificationEmail` in
`lib/email.ts`. That sender renders `emails/auth/VerificationEmail.tsx`, sends
through Resend with the same dead-letter handling as the other transactional
emails, and logs the verification URL to the server console when `RESEND_API_KEY`
is unset so the flow is testable locally.

The end-to-end path is as follows. A credential signup creates the account but,
because verification is required, issues no session — `signUp.email` returns with
a null token. The signup page detects the null token and shows a
check-your-email panel with a resend button instead of routing onward. The
verification email's link carries `callbackURL=/auth/verify-email`, with any
validated upstream `callbackUrl` (for example an invite or deep-link
destination) threaded through as a nested, relative-only parameter so the
original destination survives verification. When the user clicks it, BetterAuth
verifies the address and, because `autoSignInAfterVerification` is on,
establishes a session and redirects to `/auth/verify-email` already
authenticated. That page detects the authenticated session and forwards the user
to onboarding, or to the validated `callbackUrl` (falling back to the dashboard)
when onboarding is already complete. If the link is invalid or expired,
BetterAuth redirects to `/auth/verify-email?error=CODE`, and the page shows a
friendly message with a resend form that preserves the same `callbackUrl`.

## 3. Sign-in behaviour for unverified users

An unverified credential sign-in is rejected by BetterAuth with an
`EMAIL_NOT_VERIFIED` error. We leave `sendOnSignIn` off so we do not also fire a
second verification email whose callback would default to `/`. The sign-in page
detects the error and shows an inline banner with a "Resend verification email"
button that sends a fresh link pointing back at `/auth/verify-email`. OAuth and
SSO sign-ins are unaffected because their email arrives already verified.

## 4. Interaction with onboarding and referrals

Because verification removes the immediate post-signup session, any referral
code is no longer applied at signup; it is captured at first touch and applied
after authentication on the onboarding landing. See
`docs/referrals/05-auth-onboarding-integration.md` for that flow.

## 5. Phone step-up (stub)

`lib/auth-phone-stepup.ts` scaffolds the integration seam for the future phone
step-up. It exposes `evaluatePhoneStepUp(userId, gate)` returning
`{ required: false }` for now, so no gate is blocked, and documents the three
gates and the planned WhatsApp-primary-plus-SMS-fallback implementation. The
real implementation, the risk-scoring layer, and the TRAI/DLT and DPDP
compliance work are tracked in #884 and must not be assumed present.

## 6. Local testing note

With `RESEND_API_KEY` unset in development, verification emails are not actually
delivered; the `sendVerificationEmail` sender logs the verification URL to the
server console (`[verify-email] <email> -> <url>`) so the link can be opened
manually. Existing accounts created before this change have
`emailVerified = false` and will need to verify (or be re-seeded) once this
ships, which is acceptable given the planned pre-MVP database reset.

## 7. References

- #884 — phone/SMS step-up verification and India compliance
- `docs/referrals/05-auth-onboarding-integration.md` — referral capture/apply and the verification interaction
- [03-sessions-and-hooks.md](./03-sessions-and-hooks.md) — session lifecycle and hooks
