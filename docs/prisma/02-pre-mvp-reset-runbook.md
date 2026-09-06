# Pre-MVP database reset runbook

This runbook is the ordered, copy-pasteable procedure for the one-time reset that finalises the launch schema. It exists because several guarantees were deliberately staged for a clean database rather than applied mid-cycle: they can fail against pre-reset data (existing nulls, historical overlaps, drifted denormalisations), and applying them piecemeal would have left the assertion script reporting a permanent failure that people learn to ignore. The reset is also why wave 5 (#1319) added the `AppointmentParticipant` and `BookingStatusHistory` tables without any backfill: the reset starts from clean data, so every writer populates them from day one.

## Why there is no backfill migration

The schema is managed with `prisma db push`, not migrations, and the pre-MVP data is seed data. A backfill written now would run once against rows that are about to be discarded, and it would have to be maintained until then. The doctrine is therefore: freeze the schema shape before launch, write the new tables from every code path from the first day after the reset, and never write a data migration for pre-reset rows.

## Order of operations

Run every step from the repository root. Both connection strings must be
exported: `DATABASE_URL` is the pooled string Prisma uses for the push, and
`DIRECT_URL` is the non-pooled one the `psql` capture below opens, because a
`\copy` of a whole column is exactly the long-running single session a
transaction pooler is worst at. Do not run any of this against the shared
development database outside the agreed reset window.

The order matters more than usual here, because two of these steps destroy
data: step 1 captures columns that step 4 drops, and step 3 deletes rows. Both
are behind the backup in step 2 on purpose. Do not reorder them.

1. **Capture the two phantom columns.** `ConsultantReview.isAnonymous` and
   `AppointmentFeedback.slotOfAppointmentId` exist in the database but not in
   the schema, and the push in step 4 drops them. Nothing in application code
   reads either, so this is insurance rather than a migration.

   ```sh
   psql "$DIRECT_URL" -At -c '\copy (SELECT "id", "isAnonymous" FROM "ConsultantReview" WHERE "isAnonymous" IS NOT NULL) TO capture-consultant-review-is-anonymous.csv CSV HEADER'
   psql "$DIRECT_URL" -At -c '\copy (SELECT "id", "slotOfAppointmentId" FROM "AppointmentFeedback" WHERE "slotOfAppointmentId" IS NOT NULL) TO capture-appointment-feedback-slot.csv CSV HEADER'
   ```

   Capture to FILES, not to tables. The 2026-09-03 additive push proved that
   `prisma db push` drops every table the Prisma schema does not know, so the
   `_phantom_*` tables that
   `prisma/sql/one-off/2026-09-02-capture-phantom-columns.sql` creates are
   removed by the very push they were meant to survive (the rows were recovered
   from the pre-push `pg_dump` afterwards). Keep the two CSV files with the
   backup from the next step.

2. **Snapshot.** Take a database backup through the Supabase dashboard or
   `pg_dump`, and record the backup identifier in the reset ticket. This comes
   before the deletion in step 3, so that a remediation which removes the wrong
   row is recoverable.

3. **Remove the duplicate rows that block the new unique keys.** The push adds
   `AppointmentFeedback (appointmentId, userId)` and
   `ConsultantReview (appointmentId, consulteeProfileId)` unique keys; a
   duplicate pair fails the whole push mid-way. Check first with
   `SELECT "appointmentId", "userId", count(*) FROM "AppointmentFeedback" GROUP BY 1, 2 HAVING count(*) > 1`
   (and the review twin) and remove the extras deliberately, one pair at a time
   (on 2026-09-03 the only pair was two QA rows from a per-slot feedback test).

4. **Push the schema and apply the sidecars.** `prisma db push` refuses in
   non-interactive mode when a statement drops data, and the phantom-column
   drops from step 1 are exactly such statements, so the push is run directly
   with `--accept-data-loss` rather than through `npm run db:push`. The sidecars
   and the assertion then run as their own commands; Prisma 7 has no
   `--skip-generate` flag, so a schema push can no longer silently leave
   `slot_no_confirmed_overlap` and the money CHECK constraints behind.

   ```sh
   npx prisma db push --accept-data-loss
   npm run db:sidecars
   npm run db:assert-sidecars
   ```

5. **Uncomment the STAGED block and re-apply.** The block sits at the very
   bottom of `prisma/sql/check-constraints.sql` under the banner that begins
   `STAGED FOR THE PRE-MVP RESET`. Uncomment only the statements inside that
   banner; three live objects used to sit below it, which is why it was moved to
   the true end of the file. Then re-run the sidecars and the assertion.

   ```sh
   npm run db:sidecars
   npm run db:assert-sidecars
   ```

6. **Drop the legacy review index.** `consultant_review_legacy_pair_key` kept
   pre-`appointmentId` review rows unique and expires with the reset once no
   such rows exist. Remove its `CREATE UNIQUE INDEX` from the sidecar in the
   same commit that uncomments the staged block.

7. **Seed.** `npm run db:seed`. The seed suite writes `AppointmentParticipant`
   rows alongside every seeded appointment and links them to their seeded
   payments; `BookingStatusHistory` starts empty by design.

8. **Drift check.** `npx tsx scripts/ci/check-db-drift.ts` and
   `npm run db:assert-sidecars` must both pass before the database is declared
   live.

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
