# Booking State Machines — Generated Reference

> **Generated from `lib/booking/transitions.ts`** (PR 2d, train #1169).
> The maps in that file are the single source of legality; this page is a
> human-readable projection. If the code and this table disagree, THE CODE
> WINS — fix the doc in the same PR as the map change.

## Request-status events (Consultation, Subscription)

`AppointmentStatus`, guarded by `REQUEST_ALLOWED_FROM`. Every write MUST go
through `transitionConsultationRequest` / `transitionSubscriptionRequest`
(doctrine rule 1); a miss rolls back / matches zero rows instead of
corrupting state.

| To ↓ From → | PENDING | APPROVED | APPROVED_PENDING_PAYMENT | SCHEDULED | COMPLETED | REJECTED | CANCELLED | EXPIRED |
|---|---|---|---|---|---|---|---|---|
| **PENDING** | — | ✓ (reschedule restore, policy-gated) | ✓ | | | | | |
| **APPROVED** | ✓ | ✓ (allocation self-edge, `ALLOCATION_APPROVABLE_FROM`) | ✓ | | | | | |
| **APPROVED_PENDING_PAYMENT** | ✓ | ✓ | | | | | | |
| **SCHEDULED** | | ✓ | ✓ | | | | | |
| **COMPLETED** | | | | ✓ | | | | |
| **REJECTED** | ✓ | | ✓ | | | | | |
| **CANCELLED** | ✓ | ✓ | ✓ | ✓ | | | | |
| **EXPIRED** | ✓ (48h sweep) | ✓ (PR 2c: APPROVED-unallocated cohort) | ✓ (7d payment window) | | | | | |

Special sets:

- `ALLOCATION_APPROVABLE_FROM = [PENDING, APPROVED_PENDING_PAYMENT, APPROVED]`
  — allocation re-stamps APPROVED with the self-edge legal there only.
- `RESCHEDULABLE_FROM = [PENDING, APPROVED, APPROVED_PENDING_PAYMENT,
  SCHEDULED]` — which bookings may open a reschedule.
- `CANCELLABLE_FROM = REQUEST_ALLOWED_FROM.CANCELLED`.

## Event lifecycle (Webinar, Class)

`EVENT_ALLOWED_FROM` / `CLASS_EVENT_ALLOWED_FROM` (identical maps), via
`transitionWebinarEvent` / `transitionClassEvent`:

| To ↓ From → | DRAFT | SCHEDULED | IN_PROGRESS | COMPLETED | CANCELLED |
|---|---|---|---|---|---|
| **SCHEDULED** | — (publishing is its own edge: `EVENT_PUBLISHABLE_FROM = [DRAFT]`) | ✓ self (re-allocation re-stamp) | ✓ | | |
| **COMPLETED** | | ✓ | ✓ | | |
| **CANCELLED** | | ✓ | ✓ | | |

DRAFT keeps its status through allocation (B2/#1060): "add a session, then
publish" is the editor flow.

## Reschedule requests

`RescheduleRequestStatus` via `transitionRescheduleRequest`:

- Open states: `PENDING_REVIEW`, `COUNTERED`.
- `ACCEPTED ← [PENDING_REVIEW, COUNTERED]`; `DECLINED ←` open states;
  `WITHDRAWN ←` open states (initiator only); `EXPIRED ← [PENDING_REVIEW,
  COUNTERED]` (hourly sweep). `openForAppointmentId @unique` enforces at most
  one live reschedule per appointment.
- Decline/withdraw deliberately LEAVE slots released (the booking belongs in
  the consultant's allocate queue); only withdrawal restores them.
- A confirmation is two ordered steps: the allocator commits the new times,
  and only then does the caller compare-and-swap the proposal to
  `AUTO_ACCEPTED` or `ACCEPTED`. Because the allocator's supersede sweep
  closes every OTHER open proposal on the same released slots as `DECLINED`,
  a confirming caller passes `excludeRescheduleRequestId` to keep its own row
  out of that set; without it the sweep declined the very row the caller was
  about to accept, the compare-and-swap matched nothing, and the booking moved
  with a refusal in its audit trail (#1340).

## Known raw-status writers (CAS-bypass inventory)

These write status WITHOUT a `transition*` helper. Each was audited on PR 2a;
they are CAS-guarded inline (allowed-from rides their WHERE) and accepted as
documented exceptions. Adding one requires an entry here + doctrine review.

| Writer | Entity | Guard shape | Note |
|---|---|---|---|
| `lib/payments/webhooks/handlers.ts` `confirmExistingAppointment` | Webinar/Class → SCHEDULED | CAS via `EVENT_ALLOWED_FROM.SCHEDULED` updateMany (B2) | terminal capture returns `capturedAfterTerminal` → Phase-2 refund |
| `handlers.ts` legacy subscription creator | Subscription slot birth | n/a (tentative birth, HOIf) | confirm flips owned by guard |
| `app/api/appointments/[appointmentId]/cancel/route.ts` | Consultation/Subscription/Webinar/Class → CANCELLED | `updateMany` with `CANCELLABLE_FROM` / event allowed-from | hoisted maps (#838) |
| `.../reschedule/route.ts` | Consultation PENDING restore; Webinar/Class SCHEDULED | explicit fromIn arrays | policy-gated edges |
| `scripts/appointments/auto-complete-appointments.ts` | all → COMPLETED | `updateMany` with from-set | cron-locked |
| `scripts/appointments/cleanup-invalid-appointments.ts` | → CANCELLED | from-set per entity | ops repair script |
| `lib/moderation/cancel-user-engagements.ts` | → CANCELLED | `CANCELLABLE_FROM` / event maps | moderation front door |
| `scripts/appointments/expire-stale-requests.ts` | Consultation/Subscription → EXPIRED | per-cohort subsets of `REQUEST_ALLOWED_FROM.EXPIRED` | refunds ride along (PR 2c) |

Deliberately NOT migrated: payout/dispute/ledger state machines live under
`lib/payments/**` and have their own transition helpers where applicable.
