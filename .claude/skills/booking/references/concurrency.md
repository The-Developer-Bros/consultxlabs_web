---
name: booking-concurrency
description: How this repo serializes concurrent booking writes — the Redis lock atoms and their exact key shapes, the global lock order, fail-closed acquisition, retry budgets against the function ceiling, TTL versus transaction timeout, CAS-in-WHERE as the optimistic lock, the SQL sidecar constraints, and Serializable retries. Load when touching utils/appointmentlock.ts, lib/db/serializable-retry.ts, lib/db/pg-errors.ts, prisma/sql/, or any booking write that races another writer — checkout, allocation, approval, reschedule, cancel, or a capture webhook.
---

# Booking Concurrency

Correctness under concurrency here is a hybrid: **Redis serializes, Postgres
decides.** The lock removes contention cheaply and gives the loser a fast,
structured answer; Postgres then refuses the illegal write when a lock is
missed, expired or never taken. Which Postgres mechanism does the refusing
depends on the invariant: the `slot_no_confirmed_overlap` exclusion constraint
(§7) blocks a consultant double-book, the CAS WHERE clause (§6) blocks an
illegal status change, and the `Serializable` transaction with its retries (§8)
is what holds webinar and class seat capacity. That last one is not
interchangeable with the other two — an attendee slot carries a null
`consultantProfileId` and so falls outside the constraint's predicate, and CAS
knows nothing about a seat count. Neither half is optional.

## 1. One key shape per atom, minted in one file

Every distributed lock key in this subsystem is minted in
`utils/appointmentlock.ts` and nowhere else, because two names for one atom is
no lock at all.

| Atom                                    | Key shape                                            | Minted by                                 |
| --------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| 30 minutes of one consultant's calendar | `slot-booking:<consultantProfileId>:<atomStartISO>`  | `lockSlotInterval` / `lockSlotBooking`    |
| One consultee's booking activity        | `consultee-booking:<consulteeUserId>`                | `lockConsulteeBooking`                    |
| One sellable event or plan              | `event-checkout:<appointmentType>:<eventOrPlanId>`   | `lockEventCheckout`                       |
| One consultant's allocation pool        | `auto-allocate:<consultantProfileId>[:<scope>]`      | `lockAutoAllocate`                        |
| One consultation approval               | `consultation-approval:<consultationId>`             | `lockConsultationApproval`                |
| One subscription approval               | `subscription-approval:<subscriptionId>`             | `lockSubscriptionApproval`                |
| One pay-link mint                       | `approval-payment-mint:<kind>:<id>`, kind lowercased | `lockApprovalPaymentMint`                 |
| One appointment's lifecycle             | `appointment-lock:<appointmentId>`                   | `lockAppointment` / `withAppointmentLock` |

The `trial-slot-booking:` namespace is retired and must not come back. Nothing
else read it, so a trial and a checkout for the same consultant-minute never
contended; trials now take the shared `slot-booking:` atoms (#1093, #1170).

Every path acquires in one global order — **appointment / event / consultant →
consultee → slot** — so the families form a total order that cannot cycle. The
one deliberate nesting is approval → mint: the approval routes still hold their
approval key when they mint the pay link, so the mint is its own atom
underneath, never the reverse.

## 2. Slot locks are interval-granular and all-or-nothing

`slotAtomStarts` floors the start to the half-hour grid (`SLOT_ATOM_MS` is
`30 * 60 * 1000`) and returns one atom per 30 minutes of `[startsAt, endsAt)`,
so an unaligned booking still collides with every aligned booking it overlaps.
`lockSlotInterval` takes those keys in ascending order — a total order, hence
deadlock-free — and on a held atom or a Redis fault releases everything already
taken, in reverse, before throwing. With several atoms held it re-arms them all
to a fresh shared deadline, since sequential acquisition erodes the earliest
atoms' TTL; a failed re-arm means ownership was lost, so abort.

## 3. Acquisition fails closed

`acquireGuarded` is the single acquisition path. It calls `checkRedisHealth()`
first and wraps the attempt in `withCircuitBreaker`; an unreachable Redis or an
open circuit throws `BookingLockUnavailableError` (503,
`BOOKING_LOCK_UNAVAILABLE`), never a benign "try again", because without a lock
two concurrent buyers can both clear the same finite capacity. Genuine
contention is a `LockContentionError`, mapped by each caller to a typed
retryable answer: `EventCheckoutBusyError` (409, `EVENT_CHECKOUT_BUSY`),
`ConsulteeBookingBusyError` (409, `CONSULTEE_BOOKING_BUSY`),
`AppointmentBusyError` (423, `APPOINTMENT_BUSY`), or `SlotLockError` on the
interval path. Sold-out is separate and terminal: `EventFullError` (409,
`EVENT_SOLD_OUT`) offers no retry, because no waiting creates a seat.

## 4. Retry budgets are sized against the function ceiling

`DEFAULT_RETRY_CONFIG` is eleven exponential attempts and waits up to about 204
seconds, roughly eight times the serverless function ceiling, so a request path
using it dies as a 504 before it can return the 409 it computed. As of wave 5
(#1319), `REQUEST_PATH_RETRY_CONFIG` (`retryCount: 5`, so six attempts and about
seven seconds) is the **default parameter of `acquireGuarded`**, so every
request-path acquisition is bounded unless a caller opts out.
`CHECKOUT_WAIT_RETRY_CONFIG` and the private `INTERVAL_RETRY_CONFIG` share that
budget; `DEFAULT` remains only for callers
that run outside a request.

Treat the ceiling as an observed figure, not a configured one: there is no
`26000` constant and no `[functions]` timeout block in `netlify.toml`, only
comments, and `lib/prisma.ts` explicitly disowns the old arithmetic around it.

## 5. TTL must outlive the transaction, and be renewed per attempt

A lock TTL is sized above the transaction it protects, then reduced by the drift
factor (`effectiveTTL = floor(ttl * (1 - driftFactor))`). `APPROVAL_LOCK_TTL_MS`
is 45 s against a 30 s Serializable transaction; `APPOINTMENT_LOCK_TTL_MS` is
75 s against a 60 s reschedule transaction plus its maxWait; `lockAutoAllocate`
and `lockConsulteeBooking` default to 150 s against a 120 s transaction. Per
checkout type, `CHECKOUT_LOCK_TTL_MS` is `CONSULTATION` 60 s, `SUBSCRIPTION` and
`WEBINAR` 120 s, `CLASS` 600 s, because a class checkout writes many sessions
plus a gateway round trip.

Retries multiply the exposure: four Serializable attempts of up to 40 s each
outlive a fixed 45 s grant. As of wave 5 (#1319) the approval path therefore
calls `renewApprovalLock` at the top of every attempt, throwing
`ApprovalLockLostError` (409, `APPROVAL_LOCK_LOST`) if the grant is gone, and
checkout renews its slot grant the same way, aborting when `extendSlotInterval`
returns false.

## 6. The CAS WHERE clause is the optimistic lock

Redis serializes the common case; the status transition is what rejects the
illegal write. The allowed-from set is baked into the UPDATE's WHERE clause, so
a losing writer matches zero rows and throws `IllegalTransitionError` (409,
`ILLEGAL_TRANSITION`). Never swallow a zero-row result. See the booking doctrine in `../SKILL.md`
rule 1 for the helpers and the maps.

## 7. Constraints Prisma cannot express live in SQL sidecars

The final backstops are not in `schema.prisma`. They live in `prisma/sql/`
(`check-constraints.sql`, `ledger-triggers.sql`, `payment-legs-triggers.sql`),
applied after a schema push. The one that matters most here is
`slot_no_confirmed_overlap` on `SlotOfAppointment`: `EXCLUDE USING gist
("consultantProfileId" WITH =, tstzrange("startsAt", "endsAt") WITH &&) WHERE
("consultantProfileId" IS NOT NULL AND NOT "isTentative")`. That predicate has
two consequences — tentative rows and rows with a null `consultantProfileId`
(webinar and class attendee slots) are deliberately outside its reach, and
half-open `tstzrange` means back-to-back slots do not conflict. Never assume the
sidecars are present on a database you did not push to with the full chain.

## 8. Serializable retries, and what may not run inside one

`withSerializableRetry` (`lib/db/serializable-retry.ts`) retries **only**
`P2034`, up to `SERIALIZABLE_MAX_RETRIES` (3) — four attempts total — with
50/100/200 ms backoff plus jitter. Anything else (an `IllegalTransitionError`, a
validation error, a 409) propagates immediately, by design: a business rejection
must never be retried into accidental success. Because the callback runs up to
four times, nothing inside it may be non-idempotent; gateway calls,
notifications, emails and pay-link mints belong after the commit, and a lock
grant taken before the loop must be renewed inside it (see §5).

Exhausted retries surface as a 409 — checkout answers `errorType:
"SERIALIZATION_CONFLICT"` with `yourCardWasNotCharged: true` — never a 500. An
exclusion-constraint violation is the backstop working, so it is a 409 too:
detect it with `isExclusionViolation` from `lib/db/pg-errors.ts` (SQLSTATE
`23P01` structurally, with a narrow text fallback only because Prisma does not
model such constraints — prisma/prisma#25562, #26366), and `isUniqueViolation`
there for `P2002`/`23505`. Never sniff error messages in business logic; that
heuristic is quarantined in `pg-errors.ts` deliberately.
