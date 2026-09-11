---
title: 24-hour dual-signing grace on webhook secret rotation
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-06-05
---

# ADR 09 — Outbound webhook secret rotation dual-signs for 24 hours

## Context

Each per-organization outbound webhook endpoint has a shared HMAC secret.
The platform signs every delivery with that secret (header
`X-Familiarise-Signature: t=<unix>,v1=<hex>`, Stripe's scheme), and the
receiver verifies the body against the same secret. Operators need to be
able to rotate a leaked or aging secret. The hazard is the cutover: the
platform and the receiver cannot atomically swap secrets at the same
instant, because the receiver is a third party we don't control and may
deploy its new secret minutes or hours after the operator clicks "rotate."
If the platform starts signing with the new secret the moment rotation
happens, every delivery in that gap fails verification at a receiver that
is still configured with the old secret — silent webhook loss precisely
during a security-sensitive operation.

## Decision

Secret rotation dual-signs for a 24-hour grace window. When
`/rotate-secret` runs it stamps `secretRotatedAt` and retains the prior
secret value in `previousSecretHash`. The delivery worker, on each tick,
checks whether the endpoint is inside the grace window — `secretRotatedAt
!= null && previousSecretHash != null && now − secretRotatedAt ≤
WEBHOOK_ROTATION_GRACE_MS` — and if so passes the previous secret into
`signPayload` as well (`lib/enterprise/outbound-webhooks/worker.ts`).
`signPayload` then emits *both* signatures as repeated `v1=` entries:
`t=<unix>,v1=<current>,v1=<previous>`
(`lib/enterprise/outbound-webhooks/signing.ts`). A receiver running the
body through either secret matches one of the listed signatures — which is
exactly how Stripe and Svix list multiple signatures during their own
rotation grace, so a standard verifier that scans every `v1=` value works
unchanged. The window constant is `WEBHOOK_ROTATION_GRACE_MS = 24h` (added
in #768, commit `e542530e`). After the window the worker drops back to
single-signing with the current secret only, which the reference
`verifySignature` and the worker both encode by passing `null` as the
previous secret once the window has lapsed.

The 24-hour figure is a deliberate operational budget: long enough that a
receiver team can notice the rotation, deploy the new secret, and confirm
it on their own schedule (including across a weekend boundary in the worst
realistic case), but short enough that the old secret — which may be the
very secret that leaked — is honoured for a bounded, auditable period
rather than indefinitely.

## Alternatives considered

We considered a hard cutover: stamp the new secret and immediately sign
only with it. It lost on the unavoidable distributed-systems gap above —
the receiver cannot adopt the new secret atomically, so every delivery
between "operator rotates" and "receiver redeploys" fails verification and
is lost or retried into the dead-letter path. Rotation is supposed to be a
routine hygiene action; making it cause guaranteed webhook loss would mean
operators avoid rotating, defeating the point.

We considered versioned endpoints — issue a new endpoint URL with the new
secret and let the receiver migrate, deprecating the old one. It lost as
overkill for what is fundamentally a key roll: it forces the receiver to
reconfigure a URL (a bigger change than a secret swap), doubles the
endpoint bookkeeping, and still needs an overlap window during which both
endpoints are live — so it has all the complexity of dual-signing plus a
URL migration on top. Dual-signing achieves the same "both old and new
verify during the overlap" property with a single endpoint and a single
header carrying two signatures.

We considered an unbounded or much longer grace (sign with both secrets
indefinitely, or for weeks). It lost on the security purpose of rotation:
if the old secret is honoured forever, rotating a *leaked* secret never
actually closes the exposure. A bounded 24h window forces the old secret
to expire and keeps the exposure auditable.

## Consequences

The real cost is that during the 24-hour window a *leaked* old secret is
still accepted, so rotation does not instantly revoke the compromised key
— it revokes it after the grace lapses. That is an inherent tension
(compatibility vs immediacy) that the bounded window manages rather than
eliminates; an operator dealing with active abuse rather than routine
hygiene needs to understand that the old secret keeps working for up to a
day. A second cost is the schema and worker complexity: the endpoint has
to retain the previous secret value (`previousSecretHash`) for the window,
the worker has to compute the window on every tick, and the signing path
has to handle the two-signature case — all of which is dead weight outside
the rare rotation event.

There is also a coupling worth noting: the signature replay window
(`DEFAULT_REPLAY_WINDOW_SECONDS`, 9h) is tuned to the worker's longest
retry interval (8h), and the rotation grace (24h) comfortably exceeds it,
so a delivery retried late in the grace window still carries a signature
the receiver can verify. If the worker's backoff schedule lengthens, both
windows have to be re-checked together.

Revisit this decision if rotation needs to support immediate revocation
for incident response (a "rotate now, no grace" path for a
confirmed-compromised secret, accepting the webhook loss as the cost of
closing the exposure), or if the 24h budget proves too short for real
receiver teams' redeploy cadence and the window needs widening.
