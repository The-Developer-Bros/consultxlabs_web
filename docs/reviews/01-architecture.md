# Architecture: one review per relationship

This page describes what a review is anchored to, who can write, answer and remove one, and how every public read is projected. The decision behind each rule is [ADR 29](../enterprise/70-design-decisions/29-two-track-reputation-and-the-right-of-reply.md); this page describes what the code does.

## One review per (consultant, consultee)

A review is about a person, so it anchors to the **relationship**: `@@unique([consultantProfileId, consulteeProfileId])`. A reader wants one considered opinion of a person, not four near-identical ones from the same client; the reviewer edits theirs as the relationship develops, and `appointmentId` records which session last prompted that. Practo's one-feedback-per-patient-per-doctor is the closest published analogue, and it is relationship-anchored for exactly our reason: a subscription holding up to twenty-four meetings with one expert is Practo-shaped, not Uber-shaped.

ADR 29 specifies a three-column key that adds `track`, so a client who attends a webinar and later books the same consultant one-to-one holds one review of each product. Widening the key is deferred to #1549 for a deployment-ordering reason that is set out in full in [07-deployment-and-deferred-work.md](07-deployment-and-deferred-work.md). Until it lands, a mixed-mode client holds one review, filed under whichever product they reviewed first.

The write path in `app/api/user/reviews/route.ts` looks the pair's review up with `findFirst` on `(consultantProfileId, consulteeProfileId)` and **not** by track, deliberately: under the two-column key, filtering by track would miss a group review while writing a one-to-one one, fall through to an insert, and hand the author a uniqueness error for a row the form never showed them. Nothing references Prisma's compound key name. If a row exists it is updated by id; the `track` is adopted when the row has none and never moved once set, because moving it would refile a year of work under the other product's reputation. A residual `P2002` from a concurrent insert of the same pair is mapped to a 409 the client renders as "reload to edit the one you have".

Eligibility is per session and it is what tells the server who is being reviewed: `resolveReviewableSession` in `lib/reviews.ts` accepts the `appointmentId` from the body and derives the consultant, the track and the group event key from it. A body that names its own consultant could review someone the author never met. One 403 message covers "not yours", "not held" and "not paid", because distinguishing them would leak whether an appointment exists. The session has to have been held: `heldSlot(userId)` requires that the slot was not cancelled or rescheduled and that the caller either has an attendance row on a call that has ended, or the run is `UNVERIFIED`, which is what an offline session looks like. The attendance arm has never fired in production because `MeetingAttendance` is empty platform-wide (#1543), so every eligible session currently qualifies through the `UNVERIFIED` arm; do not tighten that arm before the pipeline works.

The composer lives on the expert's profile (`components/reviews/ProfileReviewComposer.tsx`) as a client island, because eligibility is a per-user answer and that page is statically cached: rendering it server-side would either force the page dynamic or land one viewer's eligibility in a shared cache entry. The appointment page keeps a link rather than a second composer, because hosting one in both places is how the same five-star widget ended up on screen twice.

## Anonymity is display-only

`isAnonymous` withholds the reviewer's name from the public surface. It changes nothing about the row: the review still occupies the pair, still counts toward the score, and the consultant still receives the notification, which names the reviewer as "A verified client" when the flag is set. Toggling it is a display choice rather than a change to what was said, so it is not a revision.

`stripAnonymousReviewer` in `lib/data/review-privacy.ts` nulls the reviewer for anonymous rows, and it has to run on **every** public read, not only the list. `GET /api/user/reviews/[id]` is public (middleware prefix-matches `/api/user/reviews/`) and review ids are enumerable from the list endpoint, so one unstripped read per id made the whole feature cosmetic. `appointmentId` and `ratingUnitId` are stripped for anonymous rows too: the consultant knows their own appointment ids, and `class:<id>` narrows the author to one run's roster.

## The public read allowlist

Every public review read selects `publicReviewSelect` from `lib/data/review-public.ts` and passes the result through `sanitisePublicReview`. The reads used a bare top-level `include:`, which on a root model returns every scalar, and the nested `consulteeProfile` include had the same shape. So a named reviewer's `aboutMe`, `goals`, `careerStage`, `skillsToDevelop`, `budgetPreference` and `billingStateCode` were serialised into the landing page's RSC payload, and the public list was CDN-cached; 124 of 142 consultee profiles had `goals` filled in. The same shape would have published this branch's own staff-internal `excludedReason` to anonymous callers the moment the column was added.

The allowlist inverts the default: a new column is private until somebody names it in a diff a reviewer reads. It is the same pattern and the same reasoning as `consultantPublicScalars` (#946). Deliberately absent are `consulteeProfileId`, `revisionNo`, `ratedSessionAt`, `ratingCause`, `excludedFromAggregateAt`, `excludedReason`, `excludedByUserId`, and `updatedAt`, which moves when the consultant replies and so cannot be read as "the review changed"; `editedAt` is the column for that. The reviewer's profile contributes a name and an avatar and nothing else. `__tests__/reviews/public-review-allowlist.test.ts` pins the projection.

`sanitisePublicReview` also drops a reply staff have removed. `replyDeletedAt` exists precisely so an abusive reply can be taken down without erasing the consumer review underneath it, and every public read returned `replyBody` regardless; the leak was unreachable only because nothing wrote a reply.

`lib/reviews-display.ts` exists because `lib/reviews.ts` imports the Prisma client, and a client component that reaches for a helper there pulls `@prisma/adapter-pg`, then `pg`, then `fs` into the browser bundle, and the Next build fails with "Module not found: Can't resolve 'fs'". `tsc` cannot see that, because it is a bundling boundary rather than a type error, so the only thing that catches it is a full build. `displayedScore` and `displayedScoreCount` therefore live in their own module that imports nothing but a type.

## The right of reply

`PUT /api/user/reviews/[id]/reply` accepts a reply from the reviewed consultant and from nobody else; `DELETE` on the same route soft-removes it by stamping `replyDeletedAt`. The three columns had existed since #705 with no writer, no reader and no route.

Staff may **remove** a reply, which is what `replyDeletedAt` is for, but staff may not author one: a response attributed to the reviewed expert has to have come from them. The liveness predicate is in the write itself (`updateMany` where `deletedAt IS NULL`), because the authorization read a moment earlier is not a lock and a review soft-deleted in between would otherwise get its reply saved with a 200. Replacing a reply staff had removed un-removes it, which is correct: the takedown was of the previous text, and their next removal is one call away. The removed body is left in place as the evidence for the takedown, and every public read drops it.

A reply cannot change the rating, cannot hide the review, and cannot stop the author editing it. The consultant gets a voice, not a veto. Whether an edit landed after a public reply is recorded on the revision, for moderation context only; see [03-edit-trail-and-disclosure.md](03-edit-trail-and-disclosure.md).

## Removal is soft, and attributed

Nobody hard-deletes a review. `DELETE /api/user/reviews/[id]` used to call `delete()`, and the comment two lines above it explained why the unique is deliberately not partial on `deletedAt`, so that a removed row keeps occupying the pair and the same text cannot be re-posted; the next statement then destroyed the row for the live case, leaving that invariant holding only against reviews moderation had already removed. An unlimited post/delete/re-post cycle was available to any author. It was also the wrong gate on the wrong verb: a privileged caller could hard-delete any review while the sibling moderation route restricts even the soft delete to ADMIN.

Both the author's route and the staff paths now stamp `deletedAt`, and the author's route and `softDeleteReview` stamp `deletedByUserId` with the caller. That column is the difference between two states that were previously identical. An author withdrawing their own review and moderation taking one down both set `deletedAt`, and the write path refused both with "removed by our moderation team", so a consultee who deleted their own review was told, wrongly, that staff had removed it, and could never write another about that person. Now the `POST` allows the author to revive a row whose `deletedByUserId` is their own user id, clearing both columns; a removed row with any other remover, or with none, is refused with `ModeratedReviewError` and a 409. A `NULL` remover on a removed row therefore reads as moderation, which fails closed for the rows that predate the column and for the ADMIN moderation route, which stamps `deletedAt` alone.

Every removal recomputes the consultant's scores inside the same Serializable transaction, and every mutation ends by calling `purgeReviewSurfaces`, because reviews are the landing page's testimonials and they move the score that orders the directory, and both surfaces are cached for up to an hour.

## Related

- [02-two-track-scoring.md](02-two-track-scoring.md) — what happens to the rating once it is stored.
- [05-moderation-and-reports.md](05-moderation-and-reports.md) — the staff side of removal.
- [The grid](../support/02-the-grid.md) — the actor-by-operation table this page implements.
