---
name: booking
description: How this repo's booking subsystem is built and kept correct — the non-negotiable doctrine (CAS status transitions through the seven helpers, never deleting a row a Payment points at, the refund front doors, explicit org scoping, one terminal status for an approved-but-unpaid request, no-backfill reset posture), how published availability becomes bookable slots (weekly vs custom rows, the 30-minute atom, union coverage, the three allocation modes), how concurrent booking writes are serialized (Redis lock atoms, global lock order, CAS-in-WHERE, Serializable retries), where booking touches money (the tentative hold, price derivation, refund quotes, funding rails, the earnings healer), and how to actually verify a booking change (jest suites, prisma-mocking patterns, the seeded dev-server recipe, the chaos runbook). Load when working on booking, appointment, slot, trial, reschedule, cancellation, refund, availability, allocation, checkout or expiry-sweep code — anything under lib/booking/, lib/appointments/, utils/slotAllocation/, utils/appointmentlock.ts, utils/timeSlotsProcessing.ts, lib/db/serializable-retry.ts, lib/payments/pricing/, lib/payments/operations/, scripts/appointments/, prisma/sql/, app/api/slots/, or app/api/appointments|bookings|checkout.
---

# Booking

This is the index for the booking domain. The doctrine below is inline because
every rule here is non-negotiable and has been violated at least once, each
violation costing real money or real bookings — the issue numbers are the
receipts. The four references carry the detail for a specific concern.

| Reference                      | Purpose                                                                                                                                                                      | Read it when                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `references/availability.md`   | How published availability becomes bookable slots — weekly vs custom rows, the 30-minute atom, union coverage, the grid endpoint, the three allocation modes.                | Touching availability rows, the booking calendar grid, slot generation, or conflict detection.                       |
| `references/concurrency.md`    | How concurrent booking writes are serialized — Redis lock atoms, the global lock order, CAS-in-WHERE, retry budgets, Serializable retries.                                   | Touching `utils/appointmentlock.ts`, `lib/db/serializable-retry.ts`, or any booking write that races another writer. |
| `references/money-boundary.md` | Where booking touches money — the tentative hold, price derivation, refund quotes, funding rails, the earnings healer.                                                       | Changing checkout, a payment hold, a refund amount or rail, or a cancellation quote.                                 |
| `references/verification.md`   | How to actually prove a booking change works — jest suites, prisma-mocking patterns, the seeded dev-server recipe, the chaos runbook, the standing prohibition on `db push`. | Before claiming a booking, slot, allocation, checkout, refund, or maintenance change is verified.                    |

## Doctrine

Six rules govern every change in this subsystem. Treat any diff that breaks one
as wrong until proven otherwise.

### 1. Every status write goes through a CAS transition helper

`lib/booking/transitions.ts` exports seven guarded helpers, and no booking
status column may be written any other way. As of wave 5 (#1319) the set is
complete:

| Helper                          | Guards                               | Allowed-from map               |
| ------------------------------- | ------------------------------------ | ------------------------------ |
| `transitionConsultationRequest` | `Consultation.status`                | `REQUEST_ALLOWED_FROM`         |
| `transitionSubscriptionRequest` | `Subscription.status`                | `REQUEST_ALLOWED_FROM`         |
| `transitionWebinarEvent`        | `Webinar.status`                     | `EVENT_ALLOWED_FROM`           |
| `transitionClassEvent`          | `Class.status`                       | `CLASS_EVENT_ALLOWED_FROM`     |
| `transitionSlotCompletion`      | `SlotOfAppointment.completionStatus` | `SLOT_COMPLETION_ALLOWED_FROM` |
| `transitionTrialSession`        | `TrialSession.status`                | `TRIAL_ALLOWED_FROM`           |
| `transitionRescheduleRequest`   | `RescheduleRequest.status`           | `RESCHEDULE_ALLOWED_FROM`      |

Every map is keyed by **target** state: `ALLOWED_FROM[to]` lists the only states
the row may currently be in, and that set is baked into the `updateMany`'s
WHERE clause. An illegal transition therefore matches zero rows rather than
corrupting state, and the helper throws `IllegalTransitionError` (409,
`ILLEGAL_TRANSITION`, defined in `lib/enterprise/transitions.ts`). The WHERE
clause is the state machine; application-level pre-checks are only friendly
error text. Never swallow the zero-row case.

Two helpers depart deliberately. `transitionSlotCompletion` takes a full
`Prisma.SlotOfAppointmentWhereInput` because callers sweep by appointment rather
than by slot id, accepts `allowZero` because a cancel or reschedule sweep
legitimately matches no live rows, and returns the matched count.
`transitionRescheduleRequest` also clears `openForAppointmentId` and stamps
`resolvedAt` on any terminal target, so callers never have to remember to
release the one-open-proposal lock.

Every helper accepts `fromIn` to narrow or widen the set for a flow-specific
edge, and narrowing is safer: automated completion from a Stream webhook passes
`fromIn: ["SCHEDULED"]` so it can never lift a slot a human pulled back to
UNVERIFIED. As of wave 5 (#1322, ADR A12) each helper also appends one
`BookingStatusHistory` row in the same transaction, reading the from-status
before the CAS, so a lost race logs a stale from-status but never a wrong
state. Wave 6 (#1333) widened that same pre-read to fetch the owning
appointment, so `appointmentId` is stamped without a caller supplying it, and
added `appendCreationHistory` — the one row that is not a transition, written
from the literal `"CREATED"` in the same transaction as the create, because a
booking that has never moved still needs a timeline. The three creation call
sites are `app/api/slots/request-for-approval` and the consultation and
subscription checkout handlers; the capture webhook's legacy creators do not
write it yet.

### 2. Nothing that a Payment points at is ever deleted

`Payment.appointment` cascades on delete, so deleting an Appointment destroys
the Payment rows, the refund trail and the credit usage with it. A trial
cancellation did exactly this once (#1074). The rule that replaced it is
mechanical: **the payment guard rides inside the DELETE's WHERE clause**, never
in an earlier read.

The allocator's form is `tx.appointment.deleteMany({ where: { id, payment:
{ none: {} } } })`. A count of zero means a Payment committed between the read
and the write, so the caller keeps the appointment and strips only its
sessionless slots (`utils/slotAllocation/SlotAllocationService.ts`, #1189 audit
B-P1-05, #898). Requests are retired by status: `DELETE
/api/bookings/consultations/{id}` and its subscription twin answer **405** with
`code: "DELETE_NOT_SUPPORTED"`, and
`__tests__/payments/appointment-delete-forbidden.test.ts` keeps the six sweep
scripts free of the forbidden call shapes.

Slot rows are soft-deleted uniformly as of #1380/#1424: `cleanup-abandoned-payments`,
`expire-stale-requests.ts`, and `cleanup-tentative-slots.ts` all release a
tentative hold the same way, through `transitionSlotCompletion` to `CANCELLED`
with `deletedAt` set in the same call, so the row's history survives the
release. If you think you need a delete on an Appointment or a confirmed slot,
you are almost certainly wrong: reconcile in place, as `replaceContiguousSlotRun`
does precisely so Stream `MeetingSession` and `Recording` rows survive.

### 3. Refunds have exactly two front doors

One booking refunds through `refundBookingPayment`
(`lib/payments/operations/booking-refund.ts`); a whole webinar or class refunds
through `refundWholeEventPayments` (`lib/payments/operations/event-refunds.ts`).
A removed attendee's single seat is the third entry point,
`refundRemovedAttendeeSeat`, in the same event-refunds module. Never call
`createRefund` directly. The front doors exist because there are three rails and
only they split them correctly, keyed off the payment intent prefix.
`isInternalFundedIntent` matches `org_` — the synthetic intents org-funded
bookings carry — and refunds as an in-ledger reversal, because a gateway call on
these dies on `UNKNOWN_GATEWAY` and historically reversed nothing (#1003,
#1020). `isFreeCreditIntent` matches `free_` and restores referral credits
rather than moving gateway money. Everything else is the two-phase gateway refund.

### 4. Org scoping is explicit on every list

`lib/api/scope/parse.ts` is the single definition of the `?orgScope=` vocabulary
and resolves it to one of four kinds: `personal`, `org`, `orgMember`, and `all`.
An active membership alone does not earn `org` scope, which carries no user
filter — below `operations.read` the resolution deliberately downgrades to
`orgMember` (the member's own rows within that org) rather than returning 403.
Compose filters with `scopeOrgId` and `scopeToWhereOrgId`, end every `buildWhere`
with `assertNeverScope` so an unhandled kind is a compile error instead of an
unfiltered cross-tenant read, and never hand-roll an org filter.

The org arm is **owned rows only**. As of #1166 ORG-8 the funded-elsewhere
clause (`payment: { some: { organizationId } }`) is gone from
`lib/api/scope/list-appointments.ts`, because the detail page 404s any row whose
`organizationId` is not this org — the list was offering rows the click could
not open. Cross-org funding visibility now belongs to the money views. Org lists remain
metadata-only by design (ADR 20): an org sees that a session happened, never its
content.

### 5. An approved request that was never paid has one outcome: EXPIRED

The lapsed pay-link sweep is `cleanupExpiredApprovalPendingPayments` in
`scripts/payments/cleanup-abandoned-payments.ts`, and it transitions the request
to `EXPIRED` with `fromIn: ["APPROVED_PENDING_PAYMENT"]` — narrower than the
map's default, so only the lapsed shape moves. The status guard is not enough on
its own: the sweep also **repeats the cohort read's money predicate**
(`appointment: { payment: { none: { paymentStatus: SUCCEEDED } } }`) inside the
CAS `where`, so a capture that landed between the read and the write matches zero
rows instead of expiring a paid booking. Payment rows then expire from `PENDING`
only, through a conditional `updateMany`, so a racing capture keeps its
`SUCCEEDED`. Any new sweep must carry both guards. It is deliberately not REJECTED,
which reads as "the consultant declined" on every surface, and deliberately not
CANCELLED. As of wave 5 (#1321) the unscheduled
`app/api/cleanup/approval-payments` route is deleted and its work rides inside
the abandoned-payments run, so there is one code path and one semantics. Sibling
sweeps with _different_ cohorts still end in CANCELLED, so the one-outcome rule
is about approved-but-unpaid specifically, not all abandonment. No money moves
in this sweep, because a paid row never reaches the expiry: `SUCCEEDED` payments
are filtered out by the cohort read and again by the CAS `where`, and the payment
rows themselves expire from `PENDING` only. The sweep that does refund is a
different cohort — `expireApprovedUnallocatedSubscriptions` in
`scripts/appointments/expire-stale-requests.ts` calls `refundPaymentsForExpired`,
which routes every `SUCCEEDED` payment through `refundBookingPayment`. The
sibling pass in that same file, `expirePaymentPendingRequests`, is the pattern
rather than a counter-example as of #1423: it flips `APPROVED_PENDING_PAYMENT`
to `EXPIRED` through `transitionConsultationRequest`, with `fromIn:
["APPROVED_PENDING_PAYMENT"]` and the `UNPAID_CONSULTATION` money predicate
repeated inside the CAS `where`, the same two guards this rule requires of any
new sweep.

### 6. There are no backfill migrations

The schema is managed with `prisma db push`, not migrations, and everything
currently in the database is seed data awaiting the one-time pre-MVP reset
(`docs/prisma/pre-mvp-reset-runbook.md`). The doctrine is therefore to freeze
the schema shape before launch, have every code path write the new tables from
day one, and never write a data migration for pre-reset rows. This is why wave 5
added `AppointmentParticipant` and `BookingStatusHistory` with no backfill.
Several constraints are staged behind a commented banner at the end of
`prisma/sql/check-constraints.sql` because they cannot pass against pre-reset
data; do not uncomment them outside the reset window.
