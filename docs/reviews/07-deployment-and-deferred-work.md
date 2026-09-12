# Deployment, and what is deliberately deferred

The review schema on this branch is additive-only, and that is a consequence of how this application deploys rather than a preference. This page sets out the constraint, the guard that enforces it, the order in which the push and the recompute have to run, the two frozen rating rails, and the work that was filed rather than half-done.

## Why the schema is additive-only

`next build` prerenders `/explore/experts`, `/explore/programs` and the landing page, and those reads hit the **live** database. So a column a prerendered read selects has to exist before the code builds; otherwise the build fails with `P2022: The column ConsultantProfile.publishedRatingOneToOne does not exist in the current database` while prerendering `/explore/experts`. `tsc` and every test suite are blind to it, and Netlify reports only `Build script returned non-zero exit code: 2`; the readable version is in the GitHub Actions log. "Schema in the PR, push at merge" only works when nothing prerendered reads the new columns, and #1268's CI was green only because its schema was already applied.

Pushing before deploying leaves a window where the new schema is live and the **old code is still serving**, so every DDL statement has to be backward compatible with what is deployed. Adding a nullable column, a defaulted column, a table or an index is; dropping or replacing anything is not. Keeping the whole plan additive is what makes its push safe to run ahead of its own deploy.

## The push guard: `npm run db:preflight`

One Postgres project serves development and production, and eleven worktrees symlink the same `.env`. Ten of them sit on schemas that predate the newest columns, so `npm run db:push` from any of those proposes to drop them, and it has already happened once: #1268's push was reverted by a sibling branch and had to be redone by hand.

Prisma's own data-loss prompt is not the guard it looks like. The engine counts non-null values, so dropping a column that is `NULL` on every row raises no warning and needs no `--accept-data-loss`. And neither `DROP INDEX` nor `ALTER INDEX … RENAME TO` warns under any circumstance; the second is how a hand-applied partial index's `WHERE` clause gets transplanted onto a unique the schema declares as total, which is the trap #1268 hit.

`scripts/db/preflight-push.ts` reads the plan `prisma db push` is about to apply and exits non-zero on any statement that destroys or re-points an existing object. The table below lists what it refuses.

It is a heuristic over Prisma's SQL text, not a proof, and it does not catch everything. A column type narrowing (`ALTER COLUMN … SET DATA TYPE`), a `SET NOT NULL`, a primary-key `DROP CONSTRAINT`, or the drop of a hand-applied partial index whose name does not end in `_key` all pass it silently, and running `npx prisma db push` directly, rather than through `npm run db:push`, never invokes it at all. Read the `--print` plan by hand when a change is not plainly additive.

| Refused                                  | Why                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DROP COLUMN`, `DROP TABLE`, `DROP TYPE` | Destroys data or a type a running deploy may read.                                                                                                            |
| `DROP CONSTRAINT` on a foreign key       | Keyed off Prisma's `DropForeignKey` operation marker, not the `_fkey` suffix, because `@relation(map:)` names a constraint whatever it likes.                 |
| `ALTER INDEX … RENAME TO`                | Destroys nothing and earns its place anyway: it is how Prisma silently narrows a total unique onto a partial index it recognises by columns.                  |
| `DROP INDEX` on a `*_key` index          | Dropping a unique is different in kind from replacing an ordinary `_idx`, which is routine; gating ordinary drops would get the guard disabled within a week. |

The sidecar files legitimately drop and re-add their own `CHECK` constraints on every run, so `DROP CONSTRAINT` is matched only for foreign keys. Intended destructive statements go in `prisma/sql/known-drift.json` under `destructiveStatementsAllowed`, each with an owner, an issue and an expiry; an expired entry is not an entry. `db:push:schema` chains the guard ahead of the push, so the refusal happens before the connection is used for DDL, on whatever branch you are standing on. `__tests__/db/preflight-push.test.ts` feeds it the real eight-statement plan this repository produced on 2026-09-10, because the point is that Prisma was willing to run every statement in it without asking.

Two related guards shipped with it. `feat/**` joined CI's branch filter, because a sub-PR based on a feature branch previously ran no checks at all until the integration PR. And `scripts/db/apply-check-constraints.ts` sets `lock_timeout = '3s'` on the session that runs the DDL, because a `DROP INDEX` queued behind one open transaction blocks every later query on that table in FIFO order, so a lock we cannot take in seconds is an outage rather than a slow script.

## The order: preflight, push, recompute

The runbook for landing this schema is four commands, and the order matters.

```bash
npm run db:preflight                    # "additive — safe to push", or every destructive statement listed as allowed
npm run db:push                         # preflight, prisma db push, the sidecars, then the assertions
npm run db:recompute-ratings -- --dry-run
npm run db:recompute-ratings            # without it the new score columns stay NULL = suppressed
```

The recompute is the step that fills the new columns, and it is deliberately a script rather than a migration; [02-two-track-scoring.md](02-two-track-scoring.md) describes what it does. The legacy `rating`, `publishedRating`, `ratingUnitCount` and `reviewCount` columns are still written from the same rows, so every existing reader keeps working while the surfaces move over.

One sidecar lesson belongs here because it is about the review unique. #1268 removed the `consultant_review_legacy_pair_key` partial index rather than adding it, because Prisma matches an index to the schema by its columns only and ignores its `WHERE` clause; left in place, `prisma db push` would have proposed renaming that partial index onto the real `(consultantProfileId, consulteeProfileId)` key, quietly narrowing the constraint to cover only the legacy rows it was written to protect. A sidecar index's column tuple must never appear in the schema.

## The frozen rating rails on `Consultation` and `Subscription`

`Consultation.rating`, `feedbackFromConsultee` and `feedbackFromConsultant`, and the identical trio on `Subscription`, are marked `FROZEN` as of #1300 in the shape of `Appointment.cancellationPolicySnapshot`. They were never read: 119 rows carry values and no render path ever displayed one. Feedback about a session is `AppointmentFeedback` and an opinion of a consultant is `ConsultantReview`, and the frozen trio belonged to neither.

They were also unsafe to keep writing. The `PUT` that fed them authorised "either participant or staff" and then accepted **both** sides' fields from either party, so a consultant could author the consultee's opinion of themselves, and the two zod schemas even disagreed about the floor (`min(1)` on one, `min(0)` on the other). Every writer was deleted: both schemas, both routes, both seed sites. The schemas are `.strict()`, so a caller that still sends one now gets a 400 rather than silently writing to a field nobody reads.

There is no DDL. A column a running deploy still reads must never be dropped under it, so the columns go at the pre-MVP reset, with no backfill.

## #1549: the review unique, and why it shipped as a sidecar

[ADR 29](../enterprise/70-design-decisions/29-two-track-reputation-and-the-right-of-reply.md) specifies one review per `(consultantProfileId, consulteeProfileId, track, ratingUnitId)`: for `ONE_TO_ONE`, where `ratingUnitId` is always `NULL`, that is one review per relationship; for `GROUP` it is one review per attendee per event, because the group score counts events and a per-relationship row could only ever hold one event's response. #1542 shipped the two-column pair unique and deferred the widening, for two reasons that are now history: the columns had to be pushed before the code deployed, and replacing a unique renames Prisma's compound key under code that was still serving it (`prod` referenced `consultantProfileId_consulteeProfileId` until the #1542 release, #1587, on 2026-09-12).

The widened key landed with #1566 and #1562 in one destructive push, and it is a sidecar rather than a schema `@@unique` for one reason: a 1:1 row's `ratingUnitId` is `NULL`, so the key needs `NULLS NOT DISTINCT`, which Prisma cannot express. `consultant_review_pair_track_event_key` lives in `prisma/sql/check-constraints.sql` with the predicate `WHERE "track" IS NOT NULL`, which exempts legacy `NULL`-track rows and, more importantly, is what keeps `prisma db push` from seeing the index at all: Prisma ignores partial indexes, and a total index whose tuple the schema does not declare would be dropped on the next push. Verified on Prisma 7.7.0 on 2026-09-12: `migrate diff` against the live database is empty with five such partial sidecar uniques in place. The schema declares a plain `@@index([consultantProfileId, consulteeProfileId])` for the write path's pair lookup, because a query that does not imply a partial index's predicate cannot use it.

Three code changes were one rollout with the DDL, because each is wrong under the other key: `POST /api/user/reviews` looks the pair up by `(track, ratingUnitId)` with a `NULL`-track legacy row as the fallback it adopts; `reviewsByConsultant` in `lib/reviews.ts` returns every one of the consultee's reviews of a consultant and `pickExistingReview` — the one rule both the composer and the route apply — picks the row for this session; and the P2002 copy names the event. The pre-check before the push was zero duplicate `(pair, track, event)` groups, which widening a key can only split, never merge.

## Filed rather than half-done

Each of the following is designed or diagnosed and tracked as an issue; none is restated here.

- #1541 — the support-case unification, which replaces four models and two transcript tables and needs its own push and a decision about 62 open tickets.
- #1543 — `MeetingAttendance` is empty platform-wide, so the eligibility gate's attendance arm has never fired; do not tighten it before the pipeline works.
- #1544 — `AppointmentParticipant` is four percent populated and is the only model separating payer from attendee from sponsoring organisation.
- #1547 — no UI reaches the reply or report endpoints for a review, and a consultant cannot see their own reviews.
- #1548 — nothing asks for a rating, which is why the corpus is empty; placement is settled on the dashboard, never the meeting room.
- #1550 — denormalise `consultantProfileId` onto `AppointmentFeedback` so the organisation's quality breakdown becomes a `groupBy`.
- #1551 — the `review_revision_immutable` trigger, which rides the pre-MVP reset. It must refuse every `UPDATE` and refuse a `DELETE` only while the parent review still exists, or it re-breaks the erasure cascade below. The scheduled recompute is moot since #1566 (no decay, so no drift), and the explore sort moved onto `displayedScore` in #1542.

## The `ConsultantReviewRevision` FK cascade (#1542)

`ConsultantReviewRevision.review` is re-pointed from `onDelete: Restrict` to `onDelete: Cascade`, because `Restrict` sat beneath the `User` → `ConsulteeProfile` → `ConsultantReview` cascade and blocked erasing the account of anyone who had ever edited a review with a `P2003`. Prisma compiles the change as a `DROP CONSTRAINT` followed by an `ADD CONSTRAINT` of the same name with the new `ON DELETE` clause, so nothing between the two statements is actually lost; the drop is nonetheless exactly the shape `db:preflight` refuses, so it was allowlisted once in `prisma/sql/known-drift.json` under `trackedBy: "#1542"` and pushed by hand on 2026-09-11, before the code that depends on it deployed, per the order above. The entry was removed after the push. The next destructive push was the #1549 + #1566 + #1562 consolidation, described in the section below.

## The consolidation push (#1549, #1566, #1562)

One push carried three issues, so there was one window rather than three. It dropped the two-column review unique (replaced by the sidecar above), the `ScoringSnapshot` table, the `rawRating*` / `effectiveSample*` / `scoringSnapshotId` diagnostics, the three `…ByUserId` actor foreign keys and `excludedReason` on `ConsultantReview`, `editorUserId` and `createdAt` on `ConsultantReviewRevision`, `AppointmentFeedback.deletedAt` and `SupportFlowOutcome.helpfulRatedAt`; it added the `ReviewActor` enum on `removedBy` / `replyRemovedBy`, made `ModerationAction` the single audit row (nullable `reportId`, new `reviewId` / `feedbackId`, `takenBy` `SetNull`), and applied three CHECK sidecars. Thirteen statements were allowlisted in `prisma/sql/known-drift.json` under `#1549`, `#1566` and `#1562`, generated from the offline `prisma migrate diff --from-schema <dev> --to-schema <branch> --script` by the guard's own classifier so they matched byte for byte, and removed after the push.

The order was: the #1542 release to `prod` first (so no running code referenced the old compound key), then the PR green on its preview (nothing prerendered selects a new column, so the build passes before the push), then the push immediately before the merge, then the merge and the `dev` → `prod` release straight after. The push itself was five commands rather than `npm run db:push`, because the two removal-pair CHECKs cannot be added while a removed row has no actor and the live database held three such rows from the 2026-09-11 E2E pass: `npm run db:preflight`, then `npx prisma db push` (the `db:push:no-sidecars-DANGEROUS` script), then the idempotent one-off `prisma/sql/one-off/2026-09-12-stamp-review-removal-actor.sql` (which stamps `MODERATION`, the reading the old code already gave a removed row with no remover), then `npm run db:sidecars` and `npm run db:assert-sidecars`. A database built from scratch has no such rows and needs no one-off. Between the push and the deploys, the running code's review writes and the staff review queue fail on the dropped columns — a window of minutes, accepted pre-MVP over an expand-and-contract pair of pushes that would have doubled the prod operations for the same result.

## Related

- [`docs/prisma/README.md`](../prisma/README.md) — the repository's schema posture and the cutover to versioned migrations.
- [02-two-track-scoring.md](02-two-track-scoring.md) — the recompute the runbook ends with.
