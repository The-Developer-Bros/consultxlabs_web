# Booking Algorithm Change Checklist

> Run through this checklist after ANY change to the booking system.
> Each section lists invariants that MUST hold. If you break one, fix it before merging.
>
> Last updated: 2026-09-03 (wave 5, `docs/booking-wave-5`)

---

## 1. Auth & Authorization

- [ ] All write endpoints (POST/PUT/PATCH/DELETE) require `getSession()` authentication
- [ ] Ownership verified: `consultantProfile.userId === session.user.id` on mutations
- [ ] Bulk consultant settings route (`/api/user/consultants/[id]`) enforces ownership on PUT and DELETE
- [ ] Checkout validates availability slot belongs to plan's consultant (not cross-consultant)
- [ ] Consultant-only operations (webinar/class reschedule) reject consultee callers
- [ ] Admin/Staff override paths explicitly check privileged roles
- [ ] GET endpoints that return PII (email, phone) are scoped or redacted
- [ ] Org lists stay metadata-only: no drill-in from an org appointments table into session content (ADR 20, `docs/enterprise/70-design-decisions/20-org-visibility-into-member-sessions.md`)

## 2. Data Validation

- [ ] `validateWeeklySlotTimeOrder()` called on all weekly slot creation/update paths (including bulk save + onboarding)
- [ ] Bulk save route checks intra-set overlap via `slotsOverlap()` before writing
- [ ] Bulk save route rejects overlapping custom slot submissions, not only weekly
- [ ] Onboarding persistence (`onboarding-server.ts`) enforces the same weekly/custom validation as the availability CRUD routes
- [ ] Same-day: `startTimeUtc < endTimeUtc` enforced
- [ ] Overnight: `endDay` is the next day after `startDay`, and `startTimeUtc > endTimeUtc`
- [ ] Minutes range validated: 0-1439 (inclusive), `Number.isInteger()` check
- [ ] `typeof` check before `Number.isInteger()` on PATCH paths (partial updates)
- [ ] Custom slot date ordering: `startsAt < endsAt`
- [ ] `Date.parse()` validation on ISO string inputs (reject malformed dates with 400)
- [ ] Duration validation: reject zero, negative, or unreasonably large values
- [ ] Scheduling period validation checks the full slot interval (`slot + 30min <= endDate`), not just the start
- [ ] A booking window is checked against the UNION of a consultant's weekly and custom availability rows, not the first row matched (`utils/slotAllocation/availabilityCoverage.ts`, `findUncoveredAtom`) — see Section 7

## 3. Overnight / Cross-Midnight Handling

- [ ] Weekly slot creation allows overnight (`startDay !== endDay`)
- [ ] `buildWeeklyOverlapWhere()` same-day branch covers 3 shapes:
  - Same-day time overlap
  - Previous-day overnight carry-over into our day
  - Overnight slots starting on our day
- [ ] `buildWeeklyOverlapWhere()` overnight branch covers 5 shapes:
  - Same-day slots on startDay after our start
  - Same-day slots on endDay before our end
  - Other overnight slots starting on the same day
  - Other overnight slots ending on the same endDay
  - Existing overnight carry-over into our startDay
- [ ] `isMinuteWithinWeeklySlot()` handles: same-day, start-day with midnight overflow, next-day
- [ ] Checkout uses `isMinuteWithinWeeklySlot()` (not a same-day-only guard)
- [ ] `SlotAllocationService.isWithinAvailability()` delegates to `isMinuteWithinWeeklySlot()`
- [ ] `SlotValidationService.validateMatchesSchedule()` handles overnight in both directions
- [ ] Unallocated weekly routes roll `slotEnd` to the next UTC day for overnight slots
- [ ] IST is the pinned timezone for launch (ADR 17); no live code path adjusts for DST — see `docs/booking/19-dst-and-timezone-posture.md`

## 4. Overlap & Conflict Detection

- [ ] Weekly overlap query (`buildWeeklyOverlapWhere`) uses all clauses per Section 3
- [ ] Custom overlap uses the proper range predicate (`startsAt < end AND endsAt > start`)
- [ ] Conflict detection (`validateNoConflicts`) is scoped to the consultant via the M2M `user.some.id`
- [ ] `removeBookedSlots()` is scoped to the consultant's `userId` (not a global query)
- [ ] Checkout validates against the correct consultant's booked slots
- [ ] An expired `APPROVED_PENDING_PAYMENT` or a dead-payment `DIRECT_CHECKOUT` `PENDING` hold is treated as available, never as a blocker — see Section 7's hold-expiry rule
- [ ] Tentative slots (`isTentative: true`, `completionStatus: "RESCHEDULED"`) are excluded from conflict checks during a reschedule, but still occupy the calendar for everyone else until the reschedule resolves

## 5. Slot Allocation

- [ ] Auto-allocate sorts weekly slots by calendar occurrence (`getNextOccurrenceWeekly()`), not raw `startTimeUtc`
- [ ] `getNextOccurrenceWeekly()` advances to next week if the target time has already passed today
- [ ] Consecutive block detection works for multi-slot sessions (30min x N)
- [ ] Week counting uses `SlotCalculationService.countWeeks()` (single source of truth)
- [ ] `slotsPerCall` computed correctly from `sessionDurationInHours`
- [ ] Subscription: max `sessionsPerWeek` per week, distributed across the scheduling period
- [ ] Class: respects scheduling period boundaries, max sessions/day
- [ ] Webinar: finds a single consecutive block within the search window
- [ ] Consultation: same-day consecutive block
- [ ] There is no client-side auto-allocation engine to keep in sync — the client only pre-validates and submits `isAuto: true`; the server (`SlotAllocationService`) always picks the slots (see `docs/booking/README.md`)

## 6. Locking & Concurrency

Every direct slot writer (checkout, request-for-approval, trial scheduling) locks the SAME atom keys, minted only in `utils/appointmentlock.ts`. There is one namespace per physical resource — never mint a second key shape for an atom that already has one.

- [ ] A booking interval takes one `slot-booking:<consultantProfileId>:<atomStartISO>` lock per 30-minute atom it covers (`lockSlotInterval` / `slotAtomStarts`), with starts floored to the half-hour grid so an unaligned booking still collides with the aligned ones it overlaps
- [ ] Locks for one booking are acquired in ascending atom order (a total order, so two overlapping intervals can never deadlock against each other)
- [ ] Trials take the shared `slot-booking:` atom keys through `lockSlotBooking`, not a namespace of their own — the retired `trial-slot-booking:` prefix must never reappear (`__tests__/booking-algorithm/trial-slot-integrity.test.ts` asserts this)
- [ ] Consultee-side dedupe locks under `consultee-booking:<userId>` (`lockConsulteeBooking`)
- [ ] Event checkout (webinar/class) locks a single mutex per event under `event-checkout:<type>:<eventOrPlanId>` (`lockEventCheckout`) — this is a mutex, not a counting semaphore; capacity is re-checked inside the write transaction, not by the lock
- [ ] `SlotAllocationService` keeps its coarser consultant-wide `auto-allocate:<consultantProfileId>[:scope]` lock (`lockAutoAllocate`), because it discovers slots dynamically under that lock; its write transaction re-validates conflicts and absorbs the `slot_no_confirmed_overlap` exclusion constraint
- [ ] Cancel and reschedule take `lockAppointment` (`APPOINTMENT_LOCK_TTL_MS`) so a stale tab and a live cancel serialize instead of racing the CAS write
- [ ] Global lock order is respected end-to-end: event/consultant -> consultee -> slot
- [ ] Checkout lock TTLs match `CHECKOUT_LOCK_TTL_MS` by type (CONSULTATION 60s, SUBSCRIPTION/WEBINAR 120s, CLASS 600s) — sized per checkout shape, not one universal TTL
- [ ] Request-path lock acquisitions (approvals, allocation, consultee, appointment, event-checkout) use the bounded `REQUEST_PATH_RETRY_CONFIG` (~7s worst case), not the unbounded `DEFAULT_RETRY_CONFIG` (~204s) — a request-path caller that waits on `DEFAULT` will 504 before Redis ever returns a 409
- [ ] Checkout's interval locks use `CHECKOUT_WAIT_RETRY_CONFIG`: contention losers fail fast to a structured 409 rather than queueing, since the winner's checkout (revalidation + gateway call + tx) rarely finishes fast enough for a wait to help
- [ ] A lock acquisition failure is surfaced as a typed error (`SlotLockError`, `EventCheckoutBusyError`, `ConsulteeBookingBusyError`, `AppointmentBusyError`) mapped to 409/423, never swallowed into a generic 500
- [ ] Redis unreachability fails CLOSED on every lock path (`BookingLockUnavailableError`, `EventCheckoutLockUnavailableError`) — no booking write proceeds unlocked

## 7. Checkout & Payment

- [ ] Availability slot ownership verified (`consultantProfile.userId === consultantUserId`)
- [ ] Weekly guard uses `isMinuteWithinWeeklySlot()` (overnight-aware)
- [ ] Custom guard checks `slotStart >= startsAt && slotEnd <= endsAt`
- [ ] A booking window is validated against the UNION of every published weekly or custom availability row, not the first row that happens to match — `utils/slotAllocation/availabilityCoverage.ts`'s `findUncoveredAtom()` walks every 30-minute atom of the window and only fails if some atom is covered by no row at all, so two adjacent availability rows correctly cover a window that spans both
- [ ] Slot timing validation: not in the past, minimum lead time (`validateSlotTiming`)
- [ ] Plan existence verified inside the transaction
- [ ] Webinar/Class capacity checked (`maxParticipants` vs current participants)
- [ ] Both consultant AND consultee connected to `SlotOfAppointment` via the M2M
- [ ] Payment webhook handling is idempotent (check the existing status before updating)
- [ ] A slot occupied by an `APPROVED_PENDING_PAYMENT` request, or a `PENDING` `DIRECT_CHECKOUT` request, is treated as free once every one of its payment rows is dead (`EXPIRED`, `FAILED`, or `PENDING` past `expiresAt`) — never by the clock alone, since a `SUCCEEDED` row keeps its `expiresAt` and must stay blocking. The JS predicate (`isOccupiedByLiveAppointment`, `utils/slotAllocation/SlotValidationService.ts`) and its SQL twin (`buildDeadHoldFilter`, `utils/slotAllocation/occupancyPolicy.ts`) must agree — `__tests__/booking-algorithm/hold-expiry-predicate.test.ts` asserts this
- [ ] A trial's slot stays occupied through `AWAITING_PAYMENT`, not only `SCHEDULED` — releasing it only on `SCHEDULED` would let a second buyer book the same slot while the first trial's payment window is still open

## 8. Frontend

- [ ] Unscheduled events filtered: both webinars AND classes use `.filter(e => !e.appointment)`
- [ ] `useSlotAllocation` (`hooks/scheduling/useSlotAllocation.ts`) hook: correct `requiredSlots` for SUBSCRIPTION and CLASS types
- [ ] Calendar renders overnight slots correctly (split across two days if needed)
- [ ] Main UI save paths (onboarding + settings) create single overnight weekly records (not split at midnight)
- [ ] Frontend validator (`isValidTimeRange`, `validateTimeSlot` in `lib/scheduling/slotSelectionValidation.ts`) accepts overnight slots
- [ ] Timezone handling uses `minuteUtcToDate()` for weekly slot display
- [ ] Slot selection UI prevents selecting past slots
- [ ] The availability grid polls every 60 seconds while its tab is visible (`lib/scheduling/availabilityPolling.ts`) so a slot someone else just booked stops reading as free; the post-allocation refetch requests `cache: "no-store"` so the consultant sees the slots they just booked
- [ ] Loading states shown during slot fetch operations

## 9. API Routes

- [ ] All mutation routes authenticated (session check before processing)
- [ ] Rate limiting on checkout (tentative booking count) and requests (per-user)
- [ ] Pagination on list endpoints (avoid unbounded queries)
- [ ] Error responses use correct HTTP status codes:
  - 400: validation errors, bad input
  - 401: unauthenticated
  - 403: unauthorized (wrong role)
  - 409: conflict (lock contention, illegal transition, slot already booked)
  - 500: unexpected server errors only
- [ ] Stream channel cleanup: paginated + restricted to managed namespace prefixes
- [ ] Maintenance-mode writes are guarded: cron/job entry points call `abortIfMaintenance` (money-adjacent jobs also join `FINANCIAL_JOB_NAMES`), and every `app/api/cleanup/*` HTTP twin calls the throwing `assertNotInMaintenance` (a 503), since the exit-based job guard cannot run inside a route

## 10. Status Transitions

- [ ] Every status write on a Consultation, Subscription, Webinar, Class, TrialSession, SlotOfAppointment, or RescheduleRequest goes through the matching helper in `lib/booking/transitions.ts` (`transitionConsultationRequest`, `transitionSubscriptionRequest`, `transitionWebinarEvent`, `transitionClassEvent`, `transitionSlotCompletion`, `transitionTrialSession`, `transitionRescheduleRequest`) — never a raw `update`/`updateMany` on a status column
- [ ] The allowed-from set for the target status lives in the transition's `*_ALLOWED_FROM` map (keyed by TARGET state); a caller with a flow-specific edge passes `fromIn` rather than hand-rolling the WHERE clause
- [ ] A transition that matches zero rows throws `IllegalTransitionError`, mapped to a 4xx — it must never be swallowed or retried as if it were a transient failure
- [ ] Cancellation soft-cancels: `Appointment`/`SlotOfAppointment` rows are never deleted for a booking a `Payment` row points at. Slots move to `completionStatus: "CANCELLED"`; the slot is freed by status alone
- [ ] Reschedule marks the slots it is replacing `isTentative: true` with `completionStatus: "RESCHEDULED"` (guarded by `SLOT_RESCHEDULABLE_FROM`, so a COMPLETED or CANCELLED slot can never be resurrected), then re-confirms them in place — it does not delete and recreate `SlotOfAppointment` rows for a swap
- [ ] `SlotAllocationService` may `deleteMany` a slot or an empty appointment shell only when it is provably TENTATIVE and unpaid — the delete's own WHERE clause re-checks `payment: { none: {} }` at write time, because a checkout's `Payment` row can commit between an earlier read and the delete
- [ ] The 24-hour reschedule restriction (`MINIMUM_HOURS_BEFORE_RESCHEDULE`) is enforced against every slot being rescheduled, not just the first
- [ ] Cron jobs transition state through the same helpers as the request-path code: auto-complete of past appointments, expiry of stale pending requests, and trial completion (trials auto-complete via the hourly `auto-complete-appointments` job, not a dedicated trial-completion route)

## 11. Database Integrity

- [ ] M2M `_SlotOfAppointmentToUser` connects BOTH consultant AND consultee
- [ ] Cascading deletes: `ConsultantProfile` -> `SlotOfAvailabilityWeekly/Custom`
- [ ] No orphaned slots after cancellation (cleanup or cascade)
- [ ] The correctness backstops that are NOT in `schema.prisma` — the `slot_no_confirmed_overlap` GiST exclusion constraint, CHECK constraints, ledger triggers — are applied via `npm run db:sidecars` after every schema push; never assume they exist on a database that only saw a bare `prisma db push`
- [ ] Migration safety: no destructive migrations without a data migration plan on prod
- [ ] Seed data includes `_SlotOfAppointmentToUser` rows for test appointments

## 12. Cron Jobs & Background Tasks

- [ ] Stale pending request cleanup runs on schedule
- [ ] Tentative slot cleanup removes expired tentative bookings
- [ ] Request expiry transitions old PENDING requests
- [ ] Auto-complete marks past appointments as COMPLETED, and completes eligible trials in the same pass
- [ ] Cron jobs are idempotent (safe to re-run without side effects)
- [ ] No cron job modifies data outside its documented scope
- [ ] A new `jobs/**` entry point that can write during a maintenance freeze calls `abortIfMaintenance` (and joins `FINANCIAL_JOB_NAMES` if it touches money); a new `app/api/cleanup/*` route calls `assertNotInMaintenance`

---

## What to Check Before Merging a Booking Change

1. Does every status write go through `lib/booking/transitions.ts`? A raw `update`/`updateMany` on a status column is a defect, not a shortcut.
2. Does anything `delete`/`deleteMany` an `Appointment` or `SlotOfAppointment`? If so, is it provably unpaid and TENTATIVE, with the payment guard inside the same WHERE clause as the delete? If you cannot answer yes, soft-cancel instead.
3. Does the change touch a lock? Confirm it reuses an existing namespace from `utils/appointmentlock.ts` rather than minting a new key shape for an atom that already has one, and that a request-path caller uses a bounded retry budget (`REQUEST_PATH_RETRY_CONFIG` / `CHECKOUT_WAIT_RETRY_CONFIG`), not `DEFAULT_RETRY_CONFIG`.
4. Does the change touch availability or occupancy? Confirm it reads the UNION of weekly/custom rows (`availabilityCoverage.ts`) and applies the hold-expiry rule (`isOccupiedByLiveAppointment` / `buildDeadHoldFilter`) rather than a bespoke first-match check.
5. Is the org scoping explicit on every new list (`lib/api/scope/parse.ts`), including the org-funded arm (`payment: { some: { organizationId } }`) for sessions an org funded into another host's event?
6. Have the sidecar SQL constraints (`npm run db:sidecars`) been applied to whatever database this was verified against?
7. Was this verified against a running dev server with mock-payment checkouts, not just unit tests and not a `prisma db push` against the shared dev database?

## Quick Smoke Test After Changes

1. **Overnight slot creation:** Create Mon 22:00->Tue 02:00 availability, book at Tue 01:00
2. **Cross-consultant rejection:** Use consultant A's plan with consultant B's avail ID -> expect error
3. **Auto-allocate ordering:** With Mon 09:00 and Tue 08:00 slots, auto-allocate picks Monday first
4. **Unscheduled classes:** Dashboard shows only unscheduled classes in "Set Schedule" section
5. **Overnight overlap:** Create Mon 22:00->Tue 02:00, then try Tue 01:00->Wed 03:00 -> overlap rejected
6. **Auth on writes:** Unauthenticated POST to `/api/slots/availability/weekly` -> 401
7. **Lock contention:** Two concurrent auto-allocations for same consultant -> one gets 409
8. **Unallocated overnight:** Mon 22:00->Tue 02:00 with Tue 01:00 booking is excluded from both `/api/slots/unallocated/weekly` and `/api/slots/unallocated/[consultantId]`
9. **Midnight boundary:** 22:00→00:00 weekly availability saves with `endTimeUtc=0` on the next day (not `1439` on the same day); 23:30→00:00 slot is bookable
10. **Scheduling period boundary:** A 1-hour session ending after `schedulingPeriodEndsAt` is rejected even if its last slot starts exactly at the end time
11. **Illegal transition:** Attempt to approve an already-cancelled request -> `IllegalTransitionError` -> 409, not a silent no-op
12. **Dead hold released:** An `APPROVED_PENDING_PAYMENT` consultation whose payment has expired no longer blocks the slot it held

---

## Key File Paths

| Area                          | Files                                                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Availability CRUD             | `app/api/slots/availability/weekly/route.ts`, `weekly/[id]/route.ts`, `custom/route.ts`, `custom/[id]/route.ts`                                                       |
| Public availability           | `app/api/slots/availability/[consultantId]/route.ts`, `availability-with-allocation/[consultantId]/route.ts`                                                          |
| Checkout                      | `lib/payments/operations/checkout.ts`, `schemas/checkout.ts`                                                                                                          |
| Status transitions (CAS)      | `lib/booking/transitions.ts`                                                                                                                                          |
| Availability union check      | `utils/slotAllocation/availabilityCoverage.ts`                                                                                                                        |
| Occupancy / hold-expiry       | `utils/slotAllocation/occupancyPolicy.ts`, `utils/slotAllocation/SlotValidationService.ts` (`isOccupiedByLiveAppointment`)                                            |
| Slot utils                    | `utils/slotAllocation/slotTimeUtils.ts` (overlap, overnight matching, time conversion)                                                                                |
| Allocation engine (server)    | `utils/slotAllocation/SlotAllocationService.ts`                                                                                                                       |
| Validation engine             | `utils/slotAllocation/SlotValidationService.ts`                                                                                                                       |
| Calculation                   | `utils/slotAllocation/SlotCalculationService.ts`                                                                                                                      |
| Locking                       | `utils/appointmentlock.ts`                                                                                                                                            |
| Cancel/Reschedule             | `app/api/appointments/[appointmentId]/cancel/route.ts`, `reschedule/route.ts`                                                                                         |
| Request flow                  | `app/api/slots/request-for-approval/route.ts`                                                                                                                         |
| Frontend hooks                | `hooks/scheduling/useSlotAllocation.ts`, `hooks/scheduling/useCalendarData.ts`                                                                                        |
| Frontend selection/validation | `lib/scheduling/slotSelectionValidation.ts`, `lib/scheduling/allocationAlgorithms.ts` (manual/requested pre-submission only), `lib/scheduling/availabilityPolling.ts` |
| Stream cleanup                | `actions/stream/chat/event-channel.action.ts`                                                                                                                         |
| Appointments page             | `app/dashboard/consultant/[consultantId]/(features)/appointments/page.tsx`                                                                                            |
| Onboarding                    | `app/form/onboarding/components/ConsultantPreferredScheduleForm.tsx`                                                                                                  |

See `docs/booking/README.md` for the full source map and `docs/booking/00-architecture-decisions.md` / `docs/booking/05-troubleshooting-and-changelog.md` for the history behind these rules.
