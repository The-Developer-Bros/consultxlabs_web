# Pre-MVP database reset runbook

This runbook is the ordered, copy-pasteable procedure for the one-time reset that finalises the launch schema. It exists because several guarantees were deliberately staged for a clean database rather than applied mid-cycle: they can fail against pre-reset data (existing nulls, historical overlaps, drifted denormalisations), and applying them piecemeal would have left the assertion script reporting a permanent failure that people learn to ignore. The reset is also why wave 5 (#1319) added the `AppointmentParticipant` and `BookingStatusHistory` tables without any backfill: the reset starts from clean data, so every writer populates them from day one.

## Why there is no backfill migration

The schema is managed with `prisma db push`, not migrations, and the pre-MVP data is seed data. A backfill written now would run once against rows that are about to be discarded, and it would have to be maintained until then. The doctrine is therefore: freeze the schema shape before launch, write the new tables from every code path from the first day after the reset, and never write a data migration for pre-reset rows.

## Order of operations

Run every step from the repository root, with `DATABASE_URL` exported to the
pooled connection string Prisma uses for the push. Do not run any of this
against the shared development database outside the agreed reset window.

The order matters more than usual here, because step 2 deletes rows outright.
It is behind the backup in step 1 on purpose. Do not reorder them.

`ConsultantReview.isAnonymous` and `AppointmentFeedback.slotOfAppointmentId`
were once phantom columns — present in the database but not in the Prisma
schema, and at risk of being dropped by an unguarded push. #1268 landed both
as real, permanent columns in `prisma/schema.prisma` (`isAnonymous` on
`ConsultantReview`, `slotOfAppointmentId` on `AppointmentFeedback`), so there
is no longer a capture-and-drop step for them: a normal `prisma db push` keeps
them, and no CSV backup or `_phantom_*` sidecar table is needed for either
column at reset time.

1. **Snapshot.** Take a database backup through the Supabase dashboard or
   `pg_dump`, and record the backup identifier in the reset ticket. This comes
   before the deletion in step 2, so that a remediation which removes the wrong
   row is recoverable.

2. **Remove the duplicate rows that block the new unique keys.** The push adds
   `AppointmentFeedback (slotOfAppointmentId, userId)` and
   `ConsultantReview (consultantProfileId, consulteeProfileId)` unique keys; a
   duplicate pair fails the whole push mid-way. Check first with
   `SELECT "slotOfAppointmentId", "userId", count(*) FROM "AppointmentFeedback" GROUP BY 1, 2 HAVING count(*) > 1`
   (and the review twin, grouped on `"consultantProfileId", "consulteeProfileId"`)
   and remove the extras deliberately, one pair at a time (on 2026-09-03 the
   only pair was two QA rows from a per-slot feedback test).

3. **Push the schema and apply the sidecars.** `prisma db push` refuses in
   non-interactive mode when a statement drops data, so if any staged drop is
   still pending on the target database the push is run directly with
   `--accept-data-loss` rather than through `npm run db:push`. The sidecars
   and the assertion then run as their own commands; Prisma 7 has no
   `--skip-generate` flag, so a schema push can no longer silently leave
   `slot_no_confirmed_overlap` and the money CHECK constraints behind.

   ```sh
   npx prisma db push --accept-data-loss
   npm run db:sidecars
   npm run db:assert-sidecars
   ```

4. **Uncomment the STAGED block and re-apply.** The block sits at the very
   bottom of `prisma/sql/check-constraints.sql` under the banner that begins
   `STAGED FOR THE PRE-MVP RESET`. Uncomment only the statements inside that
   banner; three live objects used to sit below it, which is why it was moved to
   the true end of the file. Then re-run the sidecars and the assertion.

   ```sh
   npm run db:sidecars
   npm run db:assert-sidecars
   ```

5. **Seed.** `npm run db:seed`. The seed suite writes `AppointmentParticipant`
   rows alongside every seeded appointment and links them to their seeded
   payments; `BookingStatusHistory` starts empty by design.

6. **Drift check.** `npx tsx scripts/ci/check-db-drift.ts` and
   `npm run db:assert-sidecars` must both pass before the database is declared
   live.

Dropping `consultant_review_legacy_pair_key` was itself a reset precondition
rather than a reset step: #1268 removed it ahead of time, before the
`(consultantProfileId, consulteeProfileId)` push in step 3, because Prisma
matches an existing index to the schema by columns only and ignores its
`WHERE` clause. Left in place, the push would have proposed renaming that
partial index onto the real key, quietly narrowing the constraint to the
legacy rows it was written to protect. There is nothing left for this runbook
to do about it.

## The staged constraints and their preconditions

The following four statements are the STAGED block. Each precondition must hold on the target database or the statement fails and the whole sidecar run stops.

| Constraint                                                                 | Precondition                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `Payment.clientIdempotencyKey SET NOT NULL`                                | No Payment row has a null key. Writers have minted keys since #1169 PR 9, so only pre-reset rows can violate this. |
| `OrganizationPayout.idempotencyKey SET NOT NULL`                           | Same as above for org payouts.                                                                                     |
| `program_assignment_no_active_overlap`                                     | No two ACTIVE `ProgramAssignment` rows for one program and membership overlap in time.                             |
| `subscription_plan_total_sessions_min` and `class_plan_total_sessions_min` | Every plan carries `totalSessions >= 1`.                                                                           |

## Decisions recorded for the reset

Two schema decisions are deferred to the reset day and must be settled in the same window: whether to unify the `uuid()` and `cuid()` id defaults across the booking aggregate (65 models use one, 59 the other), and whether the `#834` waitlist-to-slot unique constraint is added. Both are recorded in `docs/booking/00-architecture-decisions.md` under the A-series.
