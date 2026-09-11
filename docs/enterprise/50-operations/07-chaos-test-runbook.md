---
title: Chaos test runbook — pre-launch concurrency and failure drills
band: 50-operations
audience: sde3
status: live
last-reviewed: 2026-06-11
---

# Chaos test runbook

This runbook is the go/no-go validation gate for the B2C hardening work
tracked in #837. It is an eight-scenario suite that two developers can run in
roughly a day against a staging clone with the Razorpay sandbox. It must
never be run against production or against the shared development database.

Two prerequisites come first, in this order: the checkout idempotency key
(#828) must be deployed, because scenarios 1 and 3 are meaningless without
it, and request logging must carry transaction identifiers and the
`x-razorpay-event-id` header, because a failed scenario without correlated
logs cannot be diagnosed. The scenarios are ordered by what kills the
business fastest.

## The scenarios

**1. Same-slot two-user race (Playwright, two browser contexts, ~30 min).**
Both contexts POST `/api/checkout` for the identical consultant slot, then
both complete sandbox payments so both `payment.captured` webhooks land. The
pass condition is exactly one confirmed slot, with the loser's payment
**auto-refunded** — a `CONFIRMATION_BLOCKED_DOUBLE_BOOKING` system event
followed by a `refundPayment` call in the webhook handler, with
`REQUIRES_MANUAL_RECOVERY` recorded only if that refund call itself fails.
This exercises the #827 confirm-time recheck end to end.

**2. Webinar capacity overrun (k6 or Playwright, N+1 concurrent, ~20 min).**
With `maxParticipants = N`, fire N+1 simultaneous checkouts and complete
every payment. The pass condition is exactly N confirmations. This settles
empirically whether the in-lock capacity recount sees concurrent tentative
enrollments.

**3. Double-submit (Playwright, one user, two tabs, ~15 min).** Two POSTs to
`/api/checkout` with the same payload and the same `clientIdempotencyKey`
before the first response returns. The pass condition is one Payment row, one
set of tentative slots, and the second request receiving the first's replayed
response (`reused: true`).

**4. Webhook replay and reorder (Node script with the Razorpay SDK, ~30
min).** Replay the same `payment.captured` payload twice (same
`x-razorpay-event-id`); send `refund.created` before `payment.captured` and
confirm the defer-and-re-drive path completes once the capture lands; replay
a capture during an `APPROVED_PENDING_PAYMENT` confirmation. The pass
condition is zero duplicate confirmations and zero duplicate refund cascades
(`Refund.cascadedAt` holds).

**5. Cleanup-versus-webhook race (~20 min).** Seed tentative slots aged past
the cleanup threshold whose payments are PENDING, then run the
tentative-slot cleanup while firing those payments' capture webhooks. The
pass condition is that no SUCCEEDED payment ends up with deleted slots
(issue #829 tracks the known gap).

**6. Load ramp to twice expected peak (k6, ~45 min).** Mixed browse,
checkout, and validate traffic. Watch four gauges: Netlify function duration
against the 125-concurrent-invocation ceiling, `pg_stat_activity` connection
count against the pooler limit, Redis lock acquisition retries, and — most
importantly — the serializable-retry exhaustion rate (PostgreSQL SSI
predicts 5–20% conflicts under contention; the give-up rate of
`withSerializableRetry` is the launch metric). The pass condition is an
error rate under 5%, P95 under two seconds, and zero pool exhaustion.

**7. Connection drop mid-transaction (~15 min).** `pg_terminate_backend()`
on active connections during checkout. The pass condition is that Prisma's
P1001/P1017 surface as a retried request with no half-written appointment.
The multi-session class checkout is the worst case because of the 60-second
appointment-lock TTL (issue #832).

**8. Payload and limiter abuse (~15 min).** A ten-megabyte body against the
report and feedback endpoints, and a burst of POSTs against the event
routes. The pass condition is 413/422 on size and 429 on burst (issue #831
tracks the known gaps).

## Scenarios 9–16: the real-API extension (#837 train)

The first eight scenarios were authored before the suite had a harness that
drives the live application. Scenarios 9 through 16 run through
`npm run test:chaos:api`, which executes the `07-real-api-booking` and
`09-webhook-storm` categories of the race-condition suite against a seeded
database and a running server. `CHAOS_BASE_URL` selects the target and
defaults to the local dev server; unlike the sandbox-payment drills above,
these scenarios move no money, restore their fixtures, and delete the rows
they create, so a local run against seeded development data is sanctioned.
The staging clone remains the venue for the go/no-go record. Each scenario
is a standalone script under `tests/typescript/race-conditions/scenarios/`
that exits non-zero on failure, so the master runner's report is the
pass/fail record. The master runner creates its results directory with
`fs.mkdir(reportsDir, { recursive: true })` so a fresh checkout never fails
on a missing path.

**Auth-limiter note.** The master runner spawns each scenario as its own
process. The BetterAuth sign-in rate limiter is 10 logins per 15 minutes per
IP, which a full suite run exhausts. `loginAs` in
`tests/typescript/race-conditions/utilities/api-client.ts` therefore caches
session cookies in `os.tmpdir()/chaos-session-cache.json` (cross-process
persistence via the temp directory), validating each cached cookie with a
`GET /api/auth/get-session` probe before reuse. A stale cookie falls through
to a real login. `test-multi-device-login` is immune: its five parallel
`loginAs` calls race past the empty cache by design and exercise real
concurrent logins.

**9. Cancel versus reschedule on the same appointment (implemented:
`test-cancel-vs-reschedule-race`).** Two tabs act on one appointment
simultaneously, one cancelling and one rescheduling. Ordering decides the
winner count — the reschedule-first interleaving legally admits both
actions, because reschedule resets the request to PENDING and a PENDING
request is cancellable. The invariants are therefore: no server errors,
never zero winners, a successful cancel is never resurrected by the racing
reschedule, and the slots never end in a CANCELLED+RESCHEDULED mix.

**10. Reschedule storm (implemented: `test-reschedule-storm`).** Ten
concurrent reschedules of one appointment. Reschedule is re-entrant, so
multiple winners are legal; the invariants are zero server errors, terminal
slots never resurrected to RESCHEDULED, and a single coherent final state.

**11. Approve versus decline race (implemented:
`test-approve-decline-race`).** A consultant approves while the same pending
request is concurrently declined. The #836 allowed-from guard must admit
exactly one transition; the loser receives 409, never a silent overwrite.

**12. Multi-device login (implemented: `test-multi-device-login`).** Five
concurrent credential sign-ins for one user. Every login must succeed with
its own session token, and all five sessions must be concurrently valid.

**13. Onboarding double-submit (implemented for organizations:
`test-onboarding-double-submit-org`).** A stuttering click submits creation
twice concurrently. The slug-unique guard inside the creation transaction
must admit exactly one; exactly one row may exist afterwards. The consumer
profile-completion variant is staged for a follow-up.

**14a. Cancel-pending versus capture webhook (implemented:
`test-cancel-pending-vs-webhook`).** A user abandons checkout and
hits `DELETE /api/checkout/pending/[paymentId]` at the same moment
the gateway's `payment.captured` webhook lands. Both sides CAS the
payment inside Serializable transactions. The invariants are: no 5xx,
the webhook is always ACKed 2xx, the payment never stays PENDING, and
the end state is exactly one of three consistent outcomes — cancel wins
(EXPIRED, slots deleted, parent CANCELLED), webhook wins (SUCCEEDED,
slots confirmed, cancel gets 409), or documented late-capture orphan
(SUCCEEDED after a 200 cancel; the webhook handler auto-refunds it via
`refundPayment`, never a half-confirmed booking, with
`REQUIRES_MANUAL_RECOVERY` recorded only if that refund call fails). Second leg: two concurrent `DELETE` calls on
the same PENDING payment — exactly one 200, the loser 409 (CAS
cancel-vs-cancel guard). Tracked by #849.

**14b. Last-seat enrollment storm (implemented:
`test-last-seat-storm`).** N concurrent checkouts race for a webinar
with exactly one free seat. Guards under test: per-event checkout lock
plus the tentative-inclusive participant recount
(`countWebinarParticipants`/`countUniqueParticipants`) inside the
Serializable checkout transaction.
Invariants: exactly one winner, losers receive a clean 4xx ("Webinar is
full"), zero 5xx, and the confirmed participant count never exceeds
`maxParticipants`. This is a capacity regression test for the #440
`slot_no_confirmed_overlap` exclusion constraint and the last-seat path.

**14c. Enterprise allocation races (staged).** Seat/program-assignment
over-allocation (N+1 concurrent assignments against N seats), invoice
generate-versus-void, and wallet top-up webhook replay. The underlying CAS
guards shipped with #825/#826 and are exercised at the service level; the
API-level chaos scripts need org fixture scaffolding and are tracked as
first-month work on #837.

**15. Webhook bulk replay (implemented: `test-webhook-bulk-replay`).** Ten
deliveries of one signed `payment.captured` envelope, five of them
concurrent. Every delivery must be ACKed 2xx (a 5xx provokes gateway retry
storms) and exactly one `WebhookEvent` row may exist for the envelope.

**16. Webhook out-of-order delivery (implemented:
`test-webhook-out-of-order`).** A `refund.created` lands before its
`payment.captured`. Both must be ACKed, each envelope recorded exactly once
under its composite event id, and a replay of either must not create a
second row.

A run of this extension on 2026-06-11 surfaced exactly the failure class it
exists to catch: scenarios 9, 10, 11, and 13 initially failed against the
shared dev database because schema declared by the merged hardening train
(`Appointment.cancellationPolicySnapshot`, `organizations.version`) had not
been pushed to it — the `db push` owed by #837. The push was applied the
same day (with a data-preserving manual migration for the
`CreditPoolConfig.creditsPerCycle` → `creditBudgetPerCycle` rename, and the
ledger triggers re-applied per the sidecar contract), after which all seven
implemented scenarios pass. The production deploy must follow the same
order: push before deploy, or the same route families 500.

**17. Flash-sale hot-slot + hot-event storm (staged — needs k6 or equivalent
load generator against staging; booking-journey hardening train #1201–#1211).**
Simulates a popular consultant releasing availability: 50+ concurrent
consultation checkouts for the SAME 1:1 slot, plus 200 concurrent webinar
checkouts against a `maxParticipants: 20` event. The guards under test are
the full B4/B5/B8 stack shipped on the train:

- Optimistic capacity pre-check (`readEventCapacity`) must answer SOLD OUT
  for webinar losers before the mutex is requested.
- The event mutex and consultee lock waiters use `CHECKOUT_WAIT_RETRY_CONFIG`
  (~7s worst case) — no request may hang past the ~26s function ceiling.
- Structured BUSY 409s (`EVENT_CHECKOUT_BUSY`, `CONSULTEE_BOOKING_BUSY`,
  `EVENT_SOLD_OUT`) carry `retryAfter` and are never raw 504/500s.
- The client's single auto-retry fires once per BUSY 409 and cannot mint a
  duplicate order (same idempotency key).
- RFA hold cap: a bot farm submitting >3 pending requests from one account
  receives 429.

Invariants: exactly one confirmed consultation slot; exactly 20 webinar
confirmations; zero double charges; zero raw 502/504 responses (structured
4xx only); P95 under 26s. The pass condition is that every non-winner
receives either a clean sold-out/busy/retry-later 4xx with honest copy, or
a successful auto-retry after a brief pause.

## Scenarios 6, 14c and 17 now have a harness

The three scenarios above that were recorded as staged — the load ramp to
twice the expected peak, the enterprise allocation races, and the flash-sale
storm — needed a load generator that drives the real write paths, and until
#1319 there was none. That harness now exists under `load-tests/booking/`,
composed by `scenarios.js` and dispatched by the `Load Gate` workflow, with its
own operating instructions in
[08-load-gate-runbook.md](08-load-gate-runbook.md). It is built and has not yet
been executed; #874 is closed by running it and recording the numbers.

Two things it discovered are worth reading before planning any run of the
scenarios above. The `isMockPayment` flag is honoured only when the server runs
with `NODE_ENV=development`, so a Netlify deploy preview — a production build —
silently ignores it and leaves a real gateway hold instead of a confirmed
booking, which changes what a run measures. And the availability read limiter
is thirty requests per minute per IP and does not skip localhost, so a browse
mix driven from a single runner measures Upstash rather than the application
above roughly half a request per second.

## Go/no-go

Scenarios 1 through 4 must pass with zero duplicate charges and zero double
bookings, and scenarios 6 and 17 must pass at twice the expected launch peak.
Scenarios 9 through 13, 14a, 14b, 15, and 16 must pass on the staging clone
after the schema push; they are cheap enough to run on every hardening PR.
Scenario 14c (enterprise allocation races) and the others inform the
first-month backlog (#829–#834) rather than blocking launch, unless a failure
reveals money loss.
