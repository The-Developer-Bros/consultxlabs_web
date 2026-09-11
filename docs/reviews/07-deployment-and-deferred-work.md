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
npm run db:preflight                    # must print "additive — safe to push"
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

## #1549: why the review unique is still two columns

[ADR 29](../enterprise/70-design-decisions/29-two-track-reputation-and-the-right-of-reply.md) specifies a wider key so that a client who attends a webinar and later books the same consultant one-to-one holds one review of each product rather than one that overwrites the other, and so that a repeat webinar attendee gets one review PER EVENT rather than one for their whole relationship with the consultant. The key on this branch is the two-column one, and the reason is sequencing, not doubt.

1. As set out above, the columns this branch adds must be pushed **before** the code deploys, not at merge, because the build prerenders against the live database.
2. That leaves a window in which the new schema is live and the old code is still serving, so every statement has to be backward compatible with what is deployed. Replacing a unique is the one statement that is not. Prisma derives its compound-key name from the columns, so `consultantProfileId_consulteeProfileId` becomes something else entirely, and `dev`'s deployed `app/api/user/reviews/route.ts` looked the old name up by the old compound key. Pushing the wider key would have broken review creation in production until this branch deployed.

Keeping two columns makes the review-key part of the plan additive, so the push is safe to run ahead of its own deploy; the one statement `npm run db:preflight` gates is the foreign-key swap on `ConsultantReviewRevision` described below, which is allowlisted for exactly that reason. Nothing on this branch references the compound key anymore: the write path is `findFirst` on the pair plus `update({ where: { id } })`, and the composer's lookup is keyed by consultant alone. So the DDL for #1549 is deployable on its own, once its own spec is settled.

The spec itself changed while this branch was in flight. The obvious widening, adding `track` alone, is not enough: the group score counts **events**, not relationships, so a per-relationship key can only ever hold one event's response, and a repeat webinar attendee's second review overwrote their first while staying filed under the first event's bucket. The real key is `(consultantProfileId, consulteeProfileId, track, ratingUnitId)`: for `ONE_TO_ONE`, where `ratingUnitId` is always `NULL`, this still degenerates to "one review per relationship"; for `GROUP`, it becomes one review per attendee per event. Because a 1:1 row's `ratingUnitId` is `NULL`, the wider key needs `NULLS NOT DISTINCT` semantics, which `@@unique` in `schema.prisma` cannot express, so #1549 ships as a sidecar index rather than a schema-declared unique — the same pattern #1554 prescribes for `AppointmentFeedback`. Two code changes land in the same PR as that DDL, because each is wrong under the other key. The `POST /api/user/reviews` lookup must filter on `(reviewable.track, reviewable.ratingUnitId)`, with a fallback to a `NULL`-track legacy row that the write then adopts; under today's pair-only key that filter would miss a GROUP row while writing a one-to-one review, fall through to `create`, and hand the author a `P2002` for a row the form never showed them, which is why the lookup is deliberately pair-only on this branch. And `reviewsByConsultant` in `lib/reviews.ts` must key by `(consultant, track, ratingUnitId)` so the composer can show a client every one of their reviews of one person, not just one per track. The create cannot fail on the data, because there were 0 duplicate pairs across 62 rows and widening a unique key can only split groups, never merge them. Until it lands, a mixed-mode client holds one review rather than two, filed under whichever product they reviewed first, and a repeat webinar attendee holds one review rather than one per event, filed under whichever event they last reviewed — both of which are `dev`'s existing behaviour, not a regression.

## Filed rather than half-done

Each of the following is designed or diagnosed and tracked as an issue; none is restated here.

- #1541 — the support-case unification, which replaces four models and two transcript tables and needs its own push and a decision about 62 open tickets.
- #1543 — `MeetingAttendance` is empty platform-wide, so the eligibility gate's attendance arm has never fired; do not tighten it before the pipeline works.
- #1544 — `AppointmentParticipant` is four percent populated and is the only model separating payer from attendee from sponsoring organisation.
- #1547 — no UI reaches the reply or report endpoints for a review, and a consultant cannot see their own reviews.
- #1548 — nothing asks for a rating, which is why the corpus is empty; placement is settled on the dashboard, never the meeting room.
- #1549 — widen the review unique to `(consultantProfileId, consulteeProfileId, track, ratingUnitId)` as a `NULLS NOT DISTINCT` sidecar index, as argued above.
- #1550 — denormalise `consultantProfileId` onto `AppointmentFeedback` so the organisation's quality breakdown becomes a `groupBy`.
- #1551 — two things the schema's comments promised that the code does not yet do: the `review_revision_immutable` trigger and a scheduled recompute. Moving every public surface, including the explore sort, off the legacy blended score and onto `displayedScore` shipped on this branch and is no longer #1551's job.

## The `ConsultantReviewRevision` FK cascade (#1542)

`ConsultantReviewRevision.review` is re-pointed from `onDelete: Restrict` to `onDelete: Cascade`, because `Restrict` sat beneath the `User` → `ConsulteeProfile` → `ConsultantReview` cascade and blocked erasing the account of anyone who had ever edited a review with a `P2003`. Prisma compiles the change as a `DROP CONSTRAINT` followed by an `ADD CONSTRAINT` of the same name with the new `ON DELETE` clause, so nothing between the two statements is actually lost; the drop is nonetheless exactly the shape `db:preflight` refuses, so it is allowlisted once in `prisma/sql/known-drift.json` under `trackedBy: "#1542"`, expiring 2026-09-30, and the push that applies it remains a human step run before the code that depends on it deploys, per the order above.

## Related

- [`docs/prisma/README.md`](../prisma/README.md) — the repository's schema posture and the cutover to versioned migrations.
- [02-two-track-scoring.md](02-two-track-scoring.md) — the recompute the runbook ends with.
