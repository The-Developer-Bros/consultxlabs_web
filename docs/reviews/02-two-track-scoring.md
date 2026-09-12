# Two-track scoring

A consultant has two published scores, one per product they sell, and each is the plain arithmetic mean of its track's data points, published only once the track clears its gate and always shown with its count. This page is the reference for the arithmetic, the constants, the columns it writes, and the job that runs it. The decision is in [ADR 29](../enterprise/70-design-decisions/29-two-track-reputation-and-the-right-of-reply.md).

## Why two scores and not one blend

A twelve-session one-to-one engagement and a two-hundred-seat webinar are different products bought by different people, and averaging them tells a buyer of either one nothing. Airbnb shows a listing rating and a host rating for the same reason. It is also the one thing no benchmarked platform has solved: weighting per attendee systematically punishes whoever fills the room, and weighting per event lets a three-person class outvote a two-hundred-person one. Udemy sidesteps it by rating the course rather than the instructor, Peloton deleted its class rating once it noticed the distribution had no variance, and Zoom keeps webinar surveys private to the host. Refusing to average the two is the only honest answer, so `ConsultantProfile` carries `publishedRatingOneToOne` and `publishedRatingGroup` side by side, and there is no `MIXED` track: a review lands in exactly one track, or in neither.

`ReviewTrack` is decided by the booking shape in `trackForAppointment`: a webinar or a class is `GROUP` however few people turned up, and a consultation, subscription or trial is `ONE_TO_ONE` however long it ran. It is pinned on the review at first write and never moved.

A review with a `NULL` track is legacy and unclassifiable, and it is **not** presumed one-to-one. The 59 rows that predate #705 carry a `NULL` `appointmentId` too, so nothing on them says which product the session was, and both track aggregates filter on an explicit track. Unknown provenance fails closed, the same call as `AppointmentFeedback.raterRole`. That has zero user-visible cost today, because no profile had a published score before the split (0 of 83, with a maximum of four rating units against a threshold of five), and the legacy blended columns are still written from the same rows so a consultant with only legacy reviews still shows something about themselves.

## The data points, per track

The two tracks count different things, and the table below states what one data point is on each.

|                | 1:1 track                                           | Group track                                             |
| -------------- | --------------------------------------------------- | ------------------------------------------------------- |
| One data point | one distinct **client**                             | one qualifying **event**                                |
| Its rating     | the review's own rating                             | the mean of the event's reviews                         |
| Qualifies when | always; the unique guarantees one review per client | it has at least `MIN_GROUP_RESPONSES_PER_EVENT` reviews |
| Publication    | at least `MIN_RATED_CLIENTS_ONE_TO_ONE` clients     | at least `MIN_RATED_EVENTS_GROUP` qualifying events     |
| Collapse key   | none                                                | `ratingUnitId`                                          |

The 1:1 track needs no bucket key at all. The unique already guarantees one review per client, so a review _is_ a data point and there is nothing to collapse; the collapse machinery that existed for the blended score is retired for this track, and `ratingUnitId` is `NULL` on a one-to-one review.

The group track still needs the event identity, and `ratingUnitId` survives as exactly that: `"webinar:<id>"` or `"class:<id>"`, denormalised at write time. A session-type enum cannot do this job, because a webinar shares one `Appointment` across every attendee while a class mints one per enrolment, so grouping by type alone would collapse every class a consultant ever ran into a single point. The key is deliberately not moved on edit: reassigning it merges event buckets, and two clients revising their wording could drop a consultant below the publication threshold. The response floor is what stops two replies out of two hundred buying a score, and it is what `ratingUnitId` is counted against. A `GROUP` review with no event key cannot be attributed to an event and is skipped rather than guessed at.

## The formula

Each track's published score is the plain arithmetic mean of its data points, and nothing before the gate clears:

```text
published = Σrᵢ / n        when n ≥ the track's gate
published = NULL           otherwise
```

In plain terms: add up the stars a track has earned, divide by the number of data points, say nothing until there are at least five of them, and print "based on N" beside the number. There is no prior and no recency term (#1566, ADR 29 amendment of 2026-09-12). A Bayesian average, which pretends every consultant starts with a few imaginary reviews at a typical score so that thin evidence cannot outrank thick evidence, exists at Trustpilot, IMDb's Top 250 and BoardGameGeek to solve a gate-less cold start; with a five-point gate its marginal value at this scale is small, and an undisclosed prior manufactures "why is my 5.0 shown as 4.65" tickets. The count printed beside every published score is the disclosure that lets a 5.0 from five clients sit above a 4.8 from two hundred in a sort without misleading anyone. ADR 29 names the trigger for revisiting this: when a category's sort order visibly rewards thin samples, a _disclosed_ prior in Trustpilot's publish-your-prior shape is a constant change, not before.

With no observations the column stays `NULL`, which is why a consultant with nothing is never `0.0`: a zero is a claim, and an absent score is the truth.

The recompute is not a Prisma `groupBy`, because the group track averages event means rather than rows. `recomputeConsultantRating` reads the consultant's live, non-excluded rows and computes both tracks in application code; the `(consultantProfileId, deletedAt, ratingUnitId)` index's leading two columns serve that seek.

## The constants

The constants live in `lib/reviews.ts`. The table below lists each one with its value and the reason for it.

| Constant                           | Value | Reason                                                                                                                                                 |
| ---------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MIN_RATED_CLIENTS_ONE_TO_ONE`     | 5     | Five different people, which is the honest reading of a published score; under a per-purchase model it could have meant five bookings from two people. |
| `MIN_RATED_EVENTS_GROUP`           | 5     | Five webinars is the same evidentiary bar as five clients.                                                                                             |
| `MIN_GROUP_RESPONSES_PER_EVENT`    | 5     | An event becomes a data point only once enough attendees answered; a response floor is the cheaper version of Peloton's lesson.                        |
| `MIN_RATED_UNITS_FOR_PUBLIC_SCORE` | 5     | The gate on the **legacy** blended `publishedRating`, still written until the pre-MVP reset drops the column (#1554); nothing public reads it.         |

They are code constants, not columns and not environment variables. A per-consultant column would invite tuning, which is exactly the gaming vector the thresholds exist to close, and an environment variable lets a preview deployment and production disagree about a number users can see. The same argument is made for the organisation's cohort floor in `lib/enterprise/quality-thresholds.ts`. A change to any of them is a code commit plus `npm run db:recompute-ratings`, and the change should be dated in this page's history, Steam-style.

## The session's clock: `ratedSessionAt`

`ratedSessionAt` is provenance: the end of the session the review followed, stamped from the run anchor's `endsAt` at write time. It no longer feeds a weight (#1566), and it is kept because it is the one column that dates the engagement rather than the row. On an edit it moves _with_ `appointmentId`, because they are one fact; it is skipped when unknown, so an offline session with no bounds does not erase a clock the row already had. `NULL` means legacy, or an offline session with no bounds. #1554 renames it `ratedOccurrenceAt`.

## What the recompute writes

`recomputeConsultantRating(tx, consultantProfileId, now?)` writes nine columns on `ConsultantProfile` in one update. The table below groups them.

| Columns                                                       | Meaning                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `publishedRatingOneToOne`, `publishedRatingGroup`             | The two published scores. `NULL` = suppressed, exactly as the legacy `publishedRating` means it. `NULL` is the conservative default, which is why the columns are correct on day one with no backfill, only conservative.                                                                  |
| `ratedClientsOneToOne`, `ratedEventsGroup`                    | The denominators the suppression gate tests, and the "based on N" display that every score is shown with.                                                                                                                                                                                  |
| `rating`, `publishedRating`, `ratingUnitCount`, `reviewCount` | The legacy blended columns, still written from the same rows until the reset drops them (#1554). No public surface reads them; `reviewCount` is a total across both tracks and is the wrong number beside a per-track score, which is why the profile header prints the track's own count. |
| `ratingAggregatedAt`                                          | When this profile was last recomputed: a drift audit, since a score only moves on a review mutation.                                                                                                                                                                                       |

Every create, update and delete of a review calls this inside a Serializable transaction with retry. It is a read-then-write over rows two concurrent reviewers both touch, so at `READ COMMITTED` the second write would overwrite an average computed without the first review.

## The recompute job

`npm run db:recompute-ratings` runs `scripts/db/recompute-consultant-ratings.ts`, a thin command over `recomputeAllConsultantRatings` in `lib/reviews-recompute.ts`; the seed's review step (`prisma/seedFiles/7b-create-consultant-reviews.ts`) ends by calling the same routine, so a freshly seeded database already carries published scores. It is not a backfill migration: it is ordinary application code calling the same `recomputeConsultantRating` every mutation calls, it is idempotent and re-runnable, it touches no DDL, and nothing in the schema depends on it having run. What it prevents is a visible gap. The score columns arrive `NULL` and zero, and `NULL` means suppressed, so until it runs every consultant's public score is hidden.

It walks every profile ordered by id and wraps each in the same Serializable-with-retry the mutation paths use, so a review landing mid-run cannot lose-update the average it writes. One bad profile does not abandon the rest; failures are collected and reported. `--dry-run` calls the **real** scoring function against a capturing transaction and diffs the eight data-determined columns against what is stored, rather than reimplementing the arithmetic.

With no recency term, recompute-on-mutation is sufficient: a consultant who receives no new reviews does not drift, so there is no scheduled twin and none is planned. The script is the bootstrap after a reset and the drift check when somebody suspects one.

## History

- 2026-09-10 (#1542): shipped as a shrunk, decay-weighted mean toward a measured platform mean, pinned per run on a `ScoringSnapshot`, with the half-life inert at ten years.
- 2026-09-12 (#1566, landed with #1562): the plain mean per track, gated, count always shown; the snapshot, the priors, the decay term and the `rawRating*` / `effectiveSample*` diagnostics dropped. The gates are unchanged.

## What the seed produces

The review seed writes one review per held (consultant, consultee) pair on the track the session was, with `ratedSessionAt`, `ratingUnitId` for group events, a spread of anonymous reviews, replies, low-score causes and a few revisions, plus one private `AppointmentFeedback` row for about half the held calls. In `small` mode the appointment seed holds at most five past one-to-one clients and two past group events per consultant, so three consultants publish a one-to-one score and none publishes a group score; the group threshold of five events with five responses each needs the appointment volumes raised, not the constants lowered.

## Displaying one number

A single-slot surface, a card or a directory row, resolves one number through `displayedScore` in `lib/reviews-display.ts`. It shows the track that matches what the surface is selling and nothing else: a person surface shows the 1:1 score, a webinar or class card shows the group score, and there is no fallback to the other track (#1566, decided 2026-09-11, replacing a same-day labelled-fallback design), so a group product never wears a 1:1 reputation and a person card shows no star until that person's 1:1 score publishes. The profile's reviews section lists both tracks, which is where a webinar-only consultant's score is visible. `PERSON_SCORE_ORDER` and `personScoreAtLeast` sort and filter person lists on the same 1:1 score the card shows. `displayedScoreCount` returns the matching denominator. `NULL` means suppressed, and every caller must render that as "not enough rated sessions yet" rather than as 0.0, which is the whole reason the raw mean is no longer in the public allowlist.

The profile page shows both scores, each with its own count ("clients" for 1:1, "events" for group) and each suppressed independently, so an expert can be published on one track and withheld on the other. Explore's sort and filter now run on `PERSON_SCORE_ORDER` and `personScoreAtLeast` from `lib/reviews-display.ts` — 1:1 descending with nulls last, then group — rather than the legacy blended `publishedRating`; the two single-column indexes on the track columns are what that sort scans. What is left for #1551 is the `review_revision_immutable` trigger, which rides the pre-MVP reset.

## Related

- [06-schema-reference.md](06-schema-reference.md) — the column list.
- [07-deployment-and-deferred-work.md](07-deployment-and-deferred-work.md) — the push-then-recompute order.
- `__tests__/reviews/rating-aggregation.test.ts` pins that a 200-seat webinar cannot touch the 1:1 score at all, that each class run counts separately, that a thinly-answered event counts for nothing, per-track suppression, that the published number is the plain mean (one vote per event on the group track), and that legacy rows contribute to neither published score while still feeding the legacy blended columns.
