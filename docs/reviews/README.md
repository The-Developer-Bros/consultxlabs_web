# Reviews

Reviews are the public reputation rail: one review per consultee per consultant, rendered on the expert's profile and on the landing page, and folded into two published scores that order the explore directory. The models are `ConsultantReview`, its append-only edit trail `ConsultantReviewRevision`, the per-run `ScoringSnapshot`, and the score columns on `ConsultantProfile`. A review is about a person; the private per-call rating documented under [`docs/feedback/`](../feedback/README.md) is about a conversation, and the [grid](../support/02-the-grid.md) says how the two relate; its section F multiplies both objects out by booking shape and organisation relationship.

This folder is the reference: how the subsystem works, what every column means, and the contracts the code keeps. The _decisions_ live in the ADRs, and the two link both ways.

## Recommended reading order

1. [01-architecture.md](01-architecture.md) — one review per relationship, anonymity, the right of reply, attributed removal, and the public read allowlist.
2. [02-two-track-scoring.md](02-two-track-scoring.md) — the 1:1 and group tracks, the shrinkage formula, the constants, the snapshot, and the recompute.
3. [03-edit-trail-and-disclosure.md](03-edit-trail-and-disclosure.md) — the revision trail and the "Edited" mark.
4. [04-rating-cause-and-aggregate-exclusion.md](04-rating-cause-and-aggregate-exclusion.md) — ratings protection.
5. [05-moderation-and-reports.md](05-moderation-and-reports.md) — reporting a review, soft-delete, and the staff surfaces.
6. [06-schema-reference.md](06-schema-reference.md) — every column and index of the four models.
7. [07-deployment-and-deferred-work.md](07-deployment-and-deferred-work.md) — why the schema is additive-only, the push order, and what is deliberately deferred.

## Source code map

The table below lists the files the reviews subsystem is built from.

| File                                                   | Purpose                                                                                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/reviews.ts`                                       | The scoring constants, `heldSlot`, `trackForAppointment`, `recomputeConsultantRating`, `computePlatformPriors`, eligibility                  |
| `lib/reviews-display.ts`                               | `displayedScore` and `displayedScoreCount`, safe to import from a client component                                                           |
| `lib/data/review-public.ts`                            | `publicReviewSelect`, the one projection every public read uses, and `sanitisePublicReview`                                                  |
| `lib/data/review-privacy.ts`                           | `stripAnonymousReviewer`                                                                                                                     |
| `lib/data/public-cache.ts`                             | `purgeReviewSurfaces`, the cache purge every review mutation ends with                                                                       |
| `lib/moderation/side-effects.ts`                       | `softDeleteReview`, the `CONTENT_REMOVED` path                                                                                               |
| `app/api/user/reviews/route.ts`                        | `GET` the public list, `POST` create-or-edit                                                                                                 |
| `app/api/user/reviews/[id]/route.ts`                   | `GET` one review (public), `PUT` edit, `DELETE` soft-remove; `PUT`/`DELETE` are OWNER-ONLY, staff act only through `/api/staff/moderation/*` |
| `app/api/user/reviews/[id]/reply/route.ts`             | `PUT` and `DELETE` the consultant's reply                                                                                                    |
| `app/api/staff/moderation/reviews/route.ts`            | The staff queue                                                                                                                              |
| `app/api/staff/moderation/reviews/[reviewId]/route.ts` | The ADMIN-only soft delete                                                                                                                   |
| `app/api/report/route.ts`                              | `POST` a moderation report, including the `REVIEW` type                                                                                      |
| `lib/reviews-recompute.ts`                             | `recomputeAllConsultantRatings`, the full recompute that mints a `ScoringSnapshot`; shared by the script and the seed                        |
| `scripts/db/recompute-consultant-ratings.ts`           | `npm run db:recompute-ratings`, the command over it                                                                                          |
| `prisma/seedFiles/7b-create-consultant-reviews.ts`     | Seeds reviews per track and per-call feedback, then runs the recompute                                                                       |
| `scripts/db/preflight-push.ts`                         | `npm run db:preflight`, the destructive-push guard                                                                                           |
| `components/reviews/ProfileReviewComposer.tsx`         | The composer, a client island on the expert's profile                                                                                        |
| `components/reviews/ReviewComposer.tsx`                | The form the island wraps; always `POST`s, edit or not                                                                                       |
| `__tests__/reviews/rating-aggregation.test.ts`         | The two-track scoring pins                                                                                                                   |
| `__tests__/reviews/public-review-allowlist.test.ts`    | Pins the public projection against leakage                                                                                                   |
| `__tests__/reviews/review-privacy.test.ts`             | Pins the anonymity strip                                                                                                                     |
| `__tests__/db/preflight-push.test.ts`                  | Feeds the guard the real reverting plan                                                                                                      |

## Related decisions

- [ADR 29 — a review belongs to a relationship and a product, a group event votes once, and the reviewed expert can answer](../enterprise/70-design-decisions/29-two-track-reputation-and-the-right-of-reply.md) is the decision this folder implements.
- [ADR 25 — per-session reviews and the published score](../enterprise/70-design-decisions/25-per-session-reviews-and-published-score.md) is superseded on the anchor and still live on the CSAT/review separation and on suppressing a score below a minimum sample.
- [ADR 20 — organisations see session metadata, never session content](../enterprise/70-design-decisions/20-org-visibility-into-member-sessions.md) is why a public review is a different object from a private rating.
