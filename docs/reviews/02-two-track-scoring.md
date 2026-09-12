# Two-track scoring

A consultant has two published scores, one per product they sell, and each is a shrunk, decay-weighted mean rather than a plain average. This page is the reference for the arithmetic, the constants, the columns it writes, and the job that runs it. The decision is in [ADR 29](../enterprise/70-design-decisions/29-two-track-reputation-and-the-right-of-reply.md).

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
| Its age        | the review's `ratedSessionAt`                       | the newest `ratedSessionAt` among the event's reviews   |
| Qualifies when | always; the unique guarantees one review per client | it has at least `MIN_GROUP_RESPONSES_PER_EVENT` reviews |
| Publication    | at least `MIN_RATED_CLIENTS_ONE_TO_ONE` clients     | at least `MIN_RATED_EVENTS_GROUP` qualifying events     |
| Collapse key   | none                                                | `ratingUnitId`                                          |

The 1:1 track needs no bucket key at all. The unique already guarantees one review per client, so a review _is_ a data point and there is nothing to collapse; the collapse machinery that existed for the blended score is retired for this track, and `ratingUnitId` is `NULL` on a one-to-one review.

The group track still needs the event identity, and `ratingUnitId` survives as exactly that: `"webinar:<id>"` or `"class:<id>"`, denormalised at write time. A session-type enum cannot do this job, because a webinar shares one `Appointment` across every attendee while a class mints one per enrolment, so grouping by type alone would collapse every class a consultant ever ran into a single point. The key is deliberately not moved on edit: reassigning it merges event buckets, and two clients revising their wording could drop a consultant below the publication threshold. The response floor is what stops two replies out of two hundred buying a score, and it is what `ratingUnitId` is counted against. A `GROUP` review with no event key cannot be attributed to an event and is skipped rather than guessed at.

## The formula

Each track's published score is a Bayesian shrinkage toward the platform mean for that track, with a recency weight on every data point:

```text
published = (Σ(wᵢ · rᵢ) + m · C) / (Σwᵢ + m)

wᵢ = 0.5 ^ (ageᵢ / halfLife)      ageᵢ in days, never negative
m  = SCORE_PRIOR_WEIGHT
C  = the platform mean for the track, from the newest ScoringSnapshot
```

It is IMDb's structure. With no observations it returns the prior, which is why a consultant with nothing is never `0.0`: a zero is a claim, and an absent score is the truth. Shrinkage is what stops a 5.0 from five ratings outranking a 4.8 from two hundred, and every mature platform has migrated off a plain average: Amazon states outright that it "uses advanced models to calculate star ratings, not just a simple average", IMDb shrinks toward a global mean, and Etsy abandoned a hard trailing window because low-volume sellers' scores flapped. The score is published only once the track's data-point count clears its threshold, and otherwise the column is `NULL`.

Because the weight is a function of each row's own age, the recompute cannot be a Prisma `groupBy`. `recomputeConsultantRating` reads the consultant's live, non-excluded rows and computes both tracks in application code; the `(consultantProfileId, deletedAt, ratingUnitId)` index's leading two columns serve that seek.

## The constants

The constants live in `lib/reviews.ts` and are exported together as `SCORING_PARAMS`, so a snapshot records exactly what ran. The table below lists each one with its value and the reason for it.

| Constant                           | Value | Reason                                                                                                                                                                                                                       |
| ---------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIN_RATED_CLIENTS_ONE_TO_ONE`     | 5     | Five different people, which is the honest reading of a published score; under a per-purchase model it could have meant five bookings from two people.                                                                       |
| `MIN_RATED_EVENTS_GROUP`           | 5     | Five webinars is the same evidentiary bar as five clients.                                                                                                                                                                   |
| `MIN_GROUP_RESPONSES_PER_EVENT`    | 5     | An event becomes a data point only once enough attendees answered; a response floor is the cheaper version of Peloton's lesson.                                                                                              |
| `SCORE_PRIOR_WEIGHT`               | 12    | How many "average" observations a consultant is credited with before their own reviews outweigh the mean. Twelve rather than five so that at the threshold itself a consultant is still pulled meaningfully toward the mean. |
| `SCORE_HALF_LIFE_DAYS`             | 3650  | Deliberately inert; see below.                                                                                                                                                                                               |
| `MIN_RATED_UNITS_FOR_PUBLIC_SCORE` | 5     | The gate on the **legacy** blended `publishedRating`, still written for readers that have not moved to the tracks.                                                                                                           |

They are code constants, not columns and not environment variables. A per-consultant column would invite tuning, which is exactly the gaming vector the thresholds exist to close, and an environment variable lets a preview deployment and production disagree about a number users can see. The same argument is made for the organisation's cohort floor in `lib/enterprise/quality-thresholds.ts`.

### The half-life is deliberately inert

Recency decay is right in principle: Uber reads the last 500 trips and Booking.com stops displaying at 36 months. But it is a claim about a corpus with enough history for "old" to mean something, and this one has 62 reviews and no published score. A live half-life would move published numbers for reasons no consultant could act on, and "your score fell and nothing happened" is a support ticket we would be creating for ourselves. Ten years makes the weight effectively 1 for every row we hold while keeping the term in the arithmetic and on every `ScoringSnapshot`, so lowering it later is a constant change rather than a migration, and every previously published score is still explainable.

## The session's clock: `ratedSessionAt`

The weight must measure the age of the conversation, not of the row. A client who edits a year-old review this week has not held a recent session. `ratedSessionAt` is stamped from the run anchor's `endsAt` at write time, because deriving it needs a join through the nullable `appointmentId` on every recompute. On an edit it moves _with_ `appointmentId`, because they are one fact: the row would otherwise claim provenance from this session while its recency weight measured a different one. Stamping it always is safe because `heldAt` is a slot's `endsAt` rather than `now()`, so re-saving cannot refresh anybody's own recency weight, and a genuinely newer session is a newer conversation. It is skipped when unknown, so an offline session with no bounds does not erase a clock the row already had.

`NULL` means legacy, or an offline session with no bounds; the recompute falls back to `createdAt`, which is the honest approximation and owes no backfill.

## What the recompute writes

`recomputeConsultantRating(tx, consultantProfileId, run?)` writes fourteen columns on `ConsultantProfile` in one update. The table below groups them.

| Columns                                                       | Meaning                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publishedRatingOneToOne`, `publishedRatingGroup`             | The two published scores. `NULL` = suppressed, exactly as the legacy `publishedRating` means it. `NULL` is the conservative default, which is why the columns are correct on day one with no backfill, only conservative.                                                                                                                                       |
| `ratedClientsOneToOne`, `ratedEventsGroup`                    | The denominators the suppression gate tests, and the "based on N" display.                                                                                                                                                                                                                                                                                      |
| `rawRatingOneToOne`, `rawRatingGroup`                         | The plain, undecayed, unshrunk means of the qualifying data points. Staff-facing and diagnostic: without them nobody can tell whether a low published score is shrinkage toward the platform mean, recency decay, or genuinely bad work, and "why is my rating 4.1 when every review says 5" is the most predictable consultant escalation this design creates. |
| `effectiveSampleOneToOne`, `effectiveSampleGroup`             | The sum of the per-point decay weights. Decay-dependent and therefore stale the moment it is written, but stale in exact lockstep with the score it explains, so the pair is always internally consistent. This is what separates "the score moved because a review landed" from "the score moved because time passed".                                         |
| `scoringSnapshotId`                                           | Which run's priors and parameters produced the scores above.                                                                                                                                                                                                                                                                                                    |
| `rating`, `publishedRating`, `ratingUnitCount`, `reviewCount` | The legacy blended columns, kept in step from the same rows so every existing reader keeps working while the surfaces move over. One unit per `NULL`-`ratingUnitId` row and one per distinct event key, which is what the old legacy-fold branch already did.                                                                                                   |
| `ratingAggregatedAt`                                          | When this profile was last recomputed. See the job below.                                                                                                                                                                                                                                                                                                       |

Every create, update and delete of a review calls this inside a Serializable transaction with retry. It is a read-then-write over rows two concurrent reviewers both touch, so at `READ COMMITTED` the second write would overwrite an average computed without the first review.

## `ScoringSnapshot`: parameters are policy, priors are data

Every full run mints one `ScoringSnapshot` and pins every profile in the run to it. The row carries two kinds of value.

The **parameters** (`priorWeight`, `halfLifeDays`, `minRatedClientsOneToOne`, `minRatedEventsGroup`, `minGroupResponsesPerEvent`) are policy and live as the code constants above. They are copied onto the snapshot so a score published six months ago is still explainable after a constant moves.

The **priors** (`platformMeanOneToOne`, `platformMeanGroup`, `sampleCountOneToOne`, `sampleCountGroup`) are data, not policy: the platform mean shifts as the corpus grows. `computePlatformPriors` measures them over the whole corpus once, before anything is written, and each track's mean is measured the same way the track is scored, so the 1:1 prior averages review rows and the group prior averages qualifying event means. A track with no qualifying data falls back to the midpoint of the scale rather than to a borrowed mean from the other track, because the two are different products and neither is evidence about the other. Pinning the priors per run is what makes a run internally consistent: without it, the first profile in a walk is shrunk toward the mean as it stood at the start and the last toward the mean as it stood at the end, so two consultants' scores are neither comparable nor reproducible after the constants move. The shape and the argument are the same as `Appointment.cancellationPolicyId`.

A single review mutation does not recompute the corpus on every star. `currentScoringPriors` reads the newest snapshot and shrinks toward the mean the last full run used. Before the first snapshot exists there is nothing to read; the bootstrap prior is the midpoint of the scale (3), chosen so a consultant with no reviews shrinks toward neutral rather than toward flattery, and no snapshot is pinned in that case, because a run that invented its own priors must not claim to be reproducible.

## The recompute job

`npm run db:recompute-ratings` runs `scripts/db/recompute-consultant-ratings.ts`, a thin command over `recomputeAllConsultantRatings` in `lib/reviews-recompute.ts`; the seed's review step (`prisma/seedFiles/7b-create-consultant-reviews.ts`) ends by calling the same routine, so a freshly seeded database already carries published scores and one snapshot. It is not a backfill migration: it is ordinary application code calling the same `recomputeConsultantRating` every mutation calls, it is idempotent and re-runnable, it touches no DDL, and nothing in the schema depends on it having run. What it prevents is a visible gap. The score columns arrive `NULL` and zero, and `NULL` means suppressed, so until it runs every consultant's public score is hidden.

It measures the priors once, mints one snapshot, walks every profile ordered by id, and wraps each in the same Serializable-with-retry the mutation paths use, so a review landing mid-run cannot lose-update the average it writes. One bad profile does not abandon the rest; failures are collected and reported. `--dry-run` calls the **real** scoring function against a capturing transaction and diffs the twelve data-determined columns against what is stored, rather than reimplementing the arithmetic; the previous dry run was a fourth copy of the formula and could agree with a version of the code that no longer existed. A dry run mints no snapshot.

With a recency term in the weighting, recompute-on-mutation is no longer sufficient on its own: a consultant who receives no new reviews still drifts. `ratingAggregatedAt` therefore stops being a drift audit and becomes the selector a scheduled recompute would use to pick stale profiles. As of this branch there is **no scheduled twin** under `app/api/cleanup/` and the script walks every profile unconditionally; with the half-life at ten years the drift is immaterial, and scheduling the job (#1551) is what makes lowering the half-life a constant change rather than a migration.

## The pending amendment (#1566)

Everything above this heading is the shipped arithmetic. It is being replaced, and the replacement is simpler than what is shipped. ADR 29's amendments of 2026-09-11 and 2026-09-12 (#1566) retire the shrinkage machinery altogether: a published score becomes the **plain arithmetic mean** of its track's data points once the gate clears, always shown with its count, and `ScoringSnapshot`, `scoringSnapshotId`, the recency-decay term, the `rawRating*` / `effectiveSample*` diagnostics and the measured priors go. The gates and the revision trail stay. In plain terms: add up the stars a track has earned and divide by the number of data points, but say nothing until there are at least five of them, and print "based on N" beside the number. A weighted or Bayesian average, which pretends every consultant starts with a few imaginary reviews at a typical score so that thin evidence cannot outrank thick evidence, is deliberately not shipped at this scale; the ADR names the trigger for revisiting it and requires that any such prior be disclosed on the profile. It lands with the schema consolidation on #1562, and this page is rewritten then.

## What the seed produces

The review seed writes one review per held (consultant, consultee) pair on the track the session was, with `ratedSessionAt`, `ratingUnitId` for group events, a spread of anonymous reviews, replies, low-score causes and a few revisions, plus one private `AppointmentFeedback` row for about half the held calls. In `small` mode the appointment seed holds at most five past one-to-one clients and two past group events per consultant, so three consultants publish a one-to-one score and none publishes a group score; the group threshold of five events with five responses each needs the appointment volumes raised, not the constants lowered.

## Displaying one number

A single-slot surface, a card or a directory row, resolves one number through `displayedScore` in `lib/reviews-display.ts`. It shows the track that matches what the surface is selling and nothing else: a person surface shows the 1:1 score, a webinar or class card shows the group score, and there is no fallback to the other track (#1566, decided 2026-09-11, replacing a same-day labelled-fallback design), so a group product never wears a 1:1 reputation and a person card shows no star until that person's 1:1 score publishes. The profile's reviews section lists both tracks, which is where a webinar-only consultant's score is visible. `PERSON_SCORE_ORDER` and `personScoreAtLeast` sort and filter person lists on the same 1:1 score the card shows. `displayedScoreCount` returns the matching denominator. `NULL` means suppressed, and every caller must render that as "not enough rated sessions yet" rather than as 0.0, which is the whole reason the raw mean is no longer in the public allowlist.

The profile page shows both scores, each with its own count ("clients" for 1:1, "events" for group) and each suppressed independently, so an expert can be published on one track and withheld on the other. Explore's sort and filter now run on `PERSON_SCORE_ORDER` and `personScoreAtLeast` from `lib/reviews-display.ts` — 1:1 descending with nulls last, then group — rather than the legacy blended `publishedRating`; the two single-column indexes on the track columns are what that sort scans. What is left for #1551 is the `review_revision_immutable` trigger and a scheduled recompute, not the explore sort.

## Related

- [06-schema-reference.md](06-schema-reference.md) — the column list.
- [07-deployment-and-deferred-work.md](07-deployment-and-deferred-work.md) — the push-then-recompute order.
- `__tests__/reviews/rating-aggregation.test.ts` pins that a 200-seat webinar cannot touch the 1:1 score at all, that each class run counts separately, that a thinly-answered event counts for nothing, per-track suppression, shrinkage ordering, and that legacy rows contribute to neither published score while still feeding the legacy blended columns.
