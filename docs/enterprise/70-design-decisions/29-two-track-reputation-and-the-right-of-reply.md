---
title: A review belongs to a relationship and a product, a group event votes once, and the reviewed expert can answer
band: 70-design-decisions
audience: sde2
status: live
last-reviewed: 2026-09-11
---

# ADR 29 — Two-track reputation, shrunk scores, and the right of reply

Supersedes [ADR 25](25-per-session-reviews-and-published-score.md), which argued that a review belongs to a session. It does not. ADR 25 is kept for its reasoning on the CSAT/review separation and the publication threshold, both of which survive unchanged.

## Context

Three questions had been answered inconsistently, twice each.

**What is a review about?** The anchor has flipped twice in three weeks. It began as the relationship, #705 moved it to the purchase, and #1268 moved it back. ADR 25 was written for the middle position and carried a "superseded in part" preamble within a month of being marked live.

The argument for the purchase is volume: more rows, so the publication threshold is reachable. Measured over every currently-eligible booking, per-purchase would let **66 of 81** consultants reach five rating units against **65 of 81** for per-relationship. Repeat purchase runs at 1.16 bookings per distinct consultee. The volume argument does not survive contact with the data. Meanwhile the ceiling case is instructive: the consultant with the most purchase-units has 18 of them from only 10 distinct clients, so under per-purchase eight of their "independent" data points are repeat opinions from people already counted.

The argument for the relationship is that our unit of reputation is a person, and a person does not change between a client's third and ninth session. Practo — one feedback per patient per doctor however many visits, editable — is the closest published analogue, and it is relationship-anchored for exactly our reason: a subscription holding up to 24 meetings with one expert is Practo-shaped, not Uber-shaped. Trustpilot arrives at the same place from the opposite direction by counting only a reviewer's most recent review toward the score.

**How does a 200-seat webinar compare to a twelve-session engagement?** It doesn't, and that was the mistake. The blended score patched the problem arithmetically — `ratingUnitId` collapsed each event to one data point so it could not dominate — while leaving the underlying claim, that the two belong in the same average, unexamined. Weighting per attendee systematically punishes whoever fills the room; weighting per event lets a three-person class outvote a two-hundred-person one. No platform we could find publishes a method for reconciling them: Udemy sidesteps it by rating the _course_ rather than the instructor, Peloton deleted its class rating outright once it noticed the distribution had no variance, and Zoom keeps webinar surveys private to the host.

**Can the reviewed expert answer?** ADR 25 listed the right of reply among #705's shipped consequences. It was not shipped: `replyBody`, `repliedAt` and `replyDeletedAt` had no writer, no reader, no route and no UI.

## Decision

### One review per (consultant, consultee, track, group event)

`(consultantProfileId, consulteeProfileId, track, ratingUnitId)`, editable, with `appointmentId` as provenance rather than subject. For `ONE_TO_ONE`, where `ratingUnitId` is always `NULL`, this degenerates to one review per relationship; for `GROUP` it is one review per attendee per event, because the group score counts events and a per-relationship key could only ever hold one event's response.

> **Shipping state:** the key is **two columns today**, `(consultantProfileId, consulteeProfileId)`, and widening it is tracked at **#1549**. The reason is sequencing, not doubt. `next build` prerenders `/explore/experts` and friends against the live database, so the columns this decision adds have to be pushed _before_ the code deploys — which leaves a window where the new schema is live and the old code is still serving. Every DDL therefore has to be backward compatible with what is deployed, and replacing a unique is the one statement that is not: Prisma derives its compound-key name from the columns, so `a_b` becomes something else entirely and the deployed review write, which looks up `consultantProfileId_consulteeProfileId`, breaks. Keeping two columns makes the rest of the change purely additive and its push safe to run ahead of its own deploy. Nothing in the code references the compound key, so the DDL for #1549 is deployable on its own; the widened key's spec changed after this decision shipped, though, and that widening does need one accompanying code change, described in full in [07-deployment-and-deferred-work.md](../../reviews/07-deployment-and-deferred-work.md#1549-why-the-review-unique-is-still-two-columns). Because a 1:1 row's `ratingUnitId` is `NULL`, the wider key needs `NULLS NOT DISTINCT` semantics that `@@unique` cannot express in `schema.prisma`, so it ships as a sidecar index rather than a schema-declared unique, the same pattern #1554 prescribes for `AppointmentFeedback`. Until it lands, a mixed-mode client holds one review rather than two, filed under whichever product they reviewed first, and a repeat webinar attendee holds one review rather than one per event, filed under whichever event they last reviewed — both of which are the pre-existing behaviour, not a regression.

`track` is in the key because without it a consultee who attends a webinar and later books the same consultant one-to-one holds exactly **one** row for two products. The P2002 is mapped to a 409 the client renders as "update your review", so their attempt to review the 1:1 engagement would overwrite the webinar review — and `track` is pinned at first write, so a year of 1:1 work would be filed under group reputation. In a product that sells both, that is the upsell path, not an edge case.

"One considered opinion per person" therefore becomes "one per person per thing they bought", which is still one card per reviewer per product, and is what Practo's own model degenerates to for a doctor who runs both consultations and group camps.

`track` is **never moved** once set — moving it would refile a year of work under the other product's reputation, and once #1549 lands it would also collide with the same reviewer's other review of the same person. A row with a NULL track is _adopted_ by the next write for that pair and stamped with the track it belongs to; 59 rows predate the column.

The write path looks the pair's review up by `(consultant, consultee)` and **not** by track, deliberately. Under the two-column key, filtering by track would miss a group review while writing a one-to-one one, fall through to an insert, and hand the author a uniqueness error rendered as "you already have a review" for a row the form never showed them. It also means nothing references Prisma's compound key, so the DDL for the wider key is deployable on its own even though the widening itself needs an accompanying lookup change once its spec lands.

### Two published scores, side by side

`ConsultantProfile.publishedRatingOneToOne` and `publishedRatingGroup`, each with its own count, raw mean and effective sample. Airbnb shows a listing rating beside a host rating for the same reason: two numbers that describe different things are more honest than one that describes neither.

The 1:1 track counts distinct **clients**, which the unique already guarantees a review row is — so that track needs no bucket key at all, and the collapse machinery that existed for it is retired. The group track counts qualifying **events**, and an event qualifies only once `MIN_GROUP_RESPONSES_PER_EVENT` attendees answered: without that floor, two replies out of two hundred buy a published score. `ratingUnitId` survives as the event key, and only as that.

A single-slot surface — a card, a directory row — resolves one number through `displayedScore`, preferring the track that matches what it is selling and falling back to the other. A consultant who only ever runs webinars has a real earned score, and hiding it because the card happens to be a person card would be worse than labelling it.

### Scores are shrunk toward the platform mean, and the decay term ships inert

`(Σ(wᵢ·rᵢ) + m·C) / (Σwᵢ + m)`. A plain average is the wrong instrument and every mature platform has migrated off one — Amazon states outright that it "uses advanced models to calculate star ratings, not just a simple average", IMDb shrinks toward a global mean, Etsy abandoned a hard trailing window because low-volume sellers' scores flapped. Shrinkage is what stops 5.0 from five ratings outranking 4.8 from two hundred, and it is free to introduce now because `publishedRating` is NULL on all 83 profiles: nothing changes under anyone.

The recency term is in the arithmetic at a **ten-year half-life**, which makes it inert for every row we hold. Decay is right in principle but it is a claim about a corpus with enough history for "old" to mean something, and this one has 62 reviews. A live half-life would move published numbers for reasons no consultant could act on, and "your score fell and nothing happened" is a support ticket we would be creating for ourselves. Keeping the term present, and recording it on every `ScoringSnapshot`, makes lowering it a constant change rather than a migration.

`ScoringSnapshot` pins the priors and parameters each run used. Without it the first profile in a walk is shrunk toward the mean as it stood at the start and the last toward the mean as it stood at the end, so two consultants' scores are neither comparable nor reproducible after the constants move. One consequence is operational and new: with a recency term, recompute-on-mutation is no longer sufficient on its own, so `ratingAggregatedAt` stops being a drift audit and becomes a recurring job's work queue.

### The raw mean is not a public column

`consultantPublicScalars` carried `rating` and not `publishedRating`, so every surface built on the one public projection was _structurally unable_ to read the suppressed score. Two public pages consequently rendered the raw mean: a consultant with one five-star review read "5.0" and one with none read "0.0" — the two outcomes the threshold exists to prevent. The allowlist now carries the published columns and not the raw one, which makes the next occurrence a compile error.

### The expert may answer, and cannot use the answer as a lever

`PUT /api/user/reviews/[id]/reply` accepts a reply from the reviewed consultant and nobody else. Staff may **remove** a reply — that is what `replyDeletedAt` is for, separate from the review's own `deletedAt` so an abusive reply comes down without erasing the consumer review underneath it — but staff may not author one, because a response attributed to the reviewed expert has to have come from them.

BIS IS 19000:2022, India's standard for online consumer reviews, asks that the reviewed party be able to respond. Practo, Google and Booking.com all ship a version of it. A public review of a named professional with no way to answer is the one shape every benchmarked platform has moved away from.

A reply cannot change the rating, cannot hide the review, and cannot stop the author editing it.

### Every edit is recorded, and every edit is marked

`ConsultantReviewRevision` stores what a review **used** to say, never what it says now, so a review that has never been edited has zero rows and the "Edited" disclosure is an existence check rather than a join. Append-only is held by convention on this branch, since no code path updates or deletes a revision; the enforcing trigger is #1551, because a trail an application bug can rewrite indicates nothing. Only a changed opinion counts: re-submitting identical stars and words is idempotent, and toggling anonymity is a display choice rather than a change to what was said.

Etsy and Practo both converged independently on "editable until the provider replies, then marked". We take the marking and reject the trigger. Making the mark conditional on a reply hands the consultant a switch — reply to everything and every subsequent revision carries a badge — and BIS asks for edits to be indicated, full stop. `afterPublicReply` is still recorded, for moderation context.

### Nobody hard-deletes a review, and every removal is attributed

The unique is deliberately not partial on `deletedAt`, so a removed row keeps occupying the pair and the same text cannot be re-posted. A hard delete defeated that for the live case, leaving an unlimited post/delete/re-post cycle available to any author — and a privileged caller could hard-delete any review while the sibling moderation route restricts even the soft delete to ADMIN, putting the stricter gate on the safer verb.

`deletedByUserId` separates two states that were previously identical. An author withdrawing their own review and moderation taking one down both set `deletedAt`, and the write path refused both with "removed by our moderation team" — so a consultee who deleted their own review was told, wrongly, that staff had removed it, and could never write another about that person. The author may revive what they withdrew; nobody may revive what moderation removed. A NULL remover on a removed row reads as moderation, which fails closed for the rows that predate the column.

### A low rating we caused does not count against the consultant

`ratingCause` records what the reviewer says drove a low score; `excludedFromAggregateAt` records the adjudication. They are deliberately separate: if a self-reported cause removed a rating by itself, every consultant would coach clients to tick "platform issue". An excluded row still renders with its text — a rating caused by our own video stack failing is a true statement about that session — it simply stops arithmetically punishing someone who did not cause it.

Uber publishes this rule, excluding ratings attributed to traffic, navigation and co-rider behaviour. Urban Company is the counter-example: category minimums of 4.5–4.7 against a platform mean of 4.83 leave a usable range of a third of a star, and it is now a labour dispute. If a rating can end someone's livelihood, they are owed an attribution filter.

## Alternatives considered

**One blended score with the event-collapse key.** Least work — the arithmetic was built and tested. Rejected because it required defending a claim we could not defend: that a webinar attendee's hour and a retainer client's twelve sessions belong in one average. It also carried a live defect, since `ratingUnitId` is frozen on edit and a reviewer who first reviewed after a webinar and later updated after twelve 1:1 sessions stayed inside the webinar bucket, contributing a two-hundredth of one data point.

**No public reviews from group attendees at all.** Udemy's split — rate the course, not the instructor — and it would have deleted `ratingUnitId` entirely. Rejected on cost: 203 webinars and 221 class bookings exist, and their consultants would have no public reputation from work they actually did.

**Reverting to one review per purchase.** Rejected on the measurement above: one extra publishable consultant out of 81, in exchange for letting a single enthusiastic client publish a score on their own.

**Live recency decay from day one.** Rejected on timing, not merit. See the decision above.

## Consequences

A consultant's profile can now say two different things about them, and the copy has to carry that. `MIN_RATED_CLIENTS_ONE_TO_ONE` and `MIN_RATED_EVENTS_GROUP` are separate gates, so a consultant can be published on one track and suppressed on the other, and every surface must render a suppressed track as "not enough rated sessions yet" rather than as zero.

The recompute is a mutation hook plus the `db:recompute-ratings` script. A scheduled twin was planned because the scores were a function of the clock; it was never built (#1551), and the amendment below withdraws the need for it.

`ratingUnitId` is load-bearing for exactly one track. Anyone tempted to delete it should read the schema comment first.

What we pay is that a mixed-mode client writes two reviews of one person. That is the correct number — they bought two things — but it does mean a profile can show the same name twice, and the cards need to say which product each review is about.

Revisit if group volume grows enough that the group track needs its own weighting by audience size, which is the question nobody in the market has answered yet.

## Amendment, 2026-09-11

Three points settled since this decision went live, on #1542.

**GROUP anchors to the event, not the relationship, at #1549.** The unique widens to `(consultantProfileId, consulteeProfileId, track, ratingUnitId)` rather than merely adding `track`, because the group score counts events and a per-relationship key could only ever hold one event's response — see the shipping-state note above.

**Staff never rewrite or un-anonymise a review.** `PUT` and `DELETE /api/user/reviews/[id]` are now OWNER-ONLY; the `isPrivileged` admission into the review `PUT` described in the edit-trail documentation is retired. Staff act on a review only through `/api/staff/moderation/*`, which removes or excludes it rather than rewriting its words or its author's identity.

**Moderation wins over an author's withdrawal.** Both `softDeleteReview` and the ADMIN moderation route now stamp themselves over a row the author had already withdrawn, and are a no-op on a row moderation had already removed, so an author cannot revive content staff took down by withdrawing and re-posting it.

**Considered and rejected: splitting `AppointmentFeedback` into immutable `RatingObservation` rows that feed the public score.** The proposal was to record each participant's private rating as an append-only observation and let the public score read from that stream instead of from `ConsultantReview`. It is, structurally, the private per-call rating promoted to a public input, and every one of this ADR's locked decisions argued against exactly that: decision 1 anchors a review to the relationship, not the call, because a reader wants one considered opinion of a person, not a stream of per-session ones; decision 2 keeps the two-track separation between what a session felt like and what a relationship is worth; and the rating-cause section (decision 7, cross-referenced from [04-rating-cause-and-aggregate-exclusion.md](../../reviews/04-rating-cause-and-aggregate-exclusion.md)) depends on staff being able to adjudicate and exclude a claim before it ever reaches the public arithmetic, which an immutable observation feeding the score directly would foreclose. Rejected as reopening settled ground rather than as unworkable.

## Amendment, 2026-09-11 (evening)

**No cross-track fallback on any surface, and the scoring machinery is right-sized (#1566).** The labelled fallback adopted earlier the same day — a person card showing the group score marked "group sessions", a program card showing the 1:1 score marked "1:1 sessions" — is withdrawn. A person surface shows the 1:1 score or nothing; a webinar or class card shows the group score or nothing; the profile's reviews section lists both tracks, which is where a group-only consultant's score is visible. The sort and the filter on person lists use the same 1:1 score the card shows, so the order and the star can no longer disagree. Separately, and to land with the schema consolidation on #1562, decision 4 is amended: the shrinkage machinery is retired. `ScoringSnapshot`, the recency-decay term and the `effectiveSample*` / `rawRating*` diagnostics are dropped; the publication gates are unchanged and the revision trail is kept. The reasoning is on #1566. This part of the amendment is decided and not yet implemented: it lands with #1562, and until then the shipped arithmetic is the one [the scoring reference](../../reviews/02-two-track-scoring.md) describes, a measured track prior pinned by `ScoringSnapshot` with the decay term inert at a ten-year half-life.

## Amendment, 2026-09-12

**A published score is the plain mean of its track, gated, and always shown with its count.** The constant prior proposed on #1566 the evening before (`C = 4.3`, `m = 5`) is withdrawn before it shipped. Once a track clears its gate (`MIN_RATED_CLIENTS_ONE_TO_ONE`, or `MIN_RATED_EVENTS_GROUP` events each above `MIN_GROUP_RESPONSES_PER_EVENT`), the number published is the arithmetic mean of that track's data points, and every surface prints the count beside it. Below the gate the score stays `NULL` and renders as "not enough rated sessions yet". A survey of primary sources on 2026-09-12 found that disclosed shrinkage — Trustpilot's nine imaginary reviews at 3.5, IMDb's Top 250, BoardGameGeek's Geek Rating — exists to show a number from the first review, where there is no gate; with a gate of five the prior's marginal value is small, and an undisclosed one manufactures the ticket "every client gave me five stars and my profile says 4.65". The count beside the score is the disclosure, and it is what lets a reader see why a 5.0 from five clients and a 4.8 from two hundred are not the same claim. Two tracks stand (Amazon, Upwork, Fiverr, Airbnb and Preply all publish more than one number per provider, always split by function). The decision is recorded on #1566 and lands in the same push as #1562. **Re-open trigger:** when a category holds enough published consultants that sort order visibly rewards thin samples, add a _disclosed_ prior in Trustpilot's publish-your-prior shape as a constant change, not before.

## Shipping note, 2026-09-12

Everything the three amendments above decided is live as of the consolidation push that landed #1549, #1566 and #1562 together. The key is one review per `(consultantProfileId, consulteeProfileId, track, ratingUnitId)`, enforced by the sidecar index `consultant_review_pair_track_event_key` (`NULLS NOT DISTINCT`, partial on `track IS NOT NULL`; see [the deployment reference](../../reviews/07-deployment-and-deferred-work.md) for why it is a sidecar and how `db push` is kept from clobbering it), with `pickExistingReview` in `lib/reviews.ts` as the one rule the composer and the write path share. The published score is the plain mean per track, gated, shown with its count; `ScoringSnapshot`, the priors, the decay term and the diagnostics are gone. "Every removal is attributed" now reads: the content row carries `removedBy` / `replyRemovedBy` as a two-value `ReviewActor` (`AUTHOR` | `MODERATION`), kept in step with the timestamps by CHECK sidecars, and `ModerationAction` is the single audit row for every staff act — nullable `reportId`, `reviewId` / `feedbackId` naming the content, `takenBy` `SetNull` so a departed staff member's deletion cannot erase the record. The `…ByUserId` columns, `excludedReason` and the revision `editorUserId` described in the decision text above no longer exist; `ConsultantReviewRevision` also lost its duplicate `createdAt`. The section "Scores are shrunk toward the platform mean" and the sentence on `deletedByUserId` are retained as the record of what was decided on 2026-09-10 and are superseded by this note.

## Related

- [ADR 25 — Per-session reviews and the published score](25-per-session-reviews-and-published-score.md) — superseded by this one on the anchor; still live on the CSAT/review separation and the threshold.
- [ADR 20 — Organizations see session metadata, never session content](20-org-visibility-into-member-sessions.md) — why the private per-call rating and the public review are different objects with different visibility.
- [The grid](../../support/02-the-grid.md) — the object-to-anchor grid this decision is one row of.
- [The reviews reference](../../reviews/README.md) — how the subsystem this decision describes actually works: the scoring arithmetic and constants, the edit trail, the public read allowlist, the deployment order, and every column.
