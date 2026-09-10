# Rating cause and aggregate exclusion

A low rating caused by our own video stack failing mid-session is a true statement about that session and a false statement about the consultant. This page describes the `RatingCause` taxonomy the private rating and the public review share, the split between what a rater claims and what staff adjudicate, and the difference between excluding a rating from the arithmetic and removing it.

## Ratings protection, and the counter-example

Uber publishes this as "ratings protection": it drops ratings attributed to traffic, navigation and co-rider behaviour, because a driver cannot control them. The same argument applies with more force here, where our own stack failing produces a one-star rating about us that lands permanently on a consultant. Urban Company is the counter-example. Category minimums of 4.5 to 4.7 against a platform mean of 4.83 leave a usable range of a third of a star, and it is now a labour dispute. If a rating can end someone's livelihood, they are owed an attribution filter.

## The taxonomy

`RatingCause` is one enum used by both `AppointmentFeedback.ratingCause` and `ConsultantReview.ratingCause`, so that one Stream outage does not read to an organisation as a bad consultant either. The table below lists its values.

| Value                | Meaning                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `CONSULTANT`         | The person. The only value that is unambiguously about them.     |
| `PLATFORM_TECHNICAL` | Our stack failed: Stream video or chat, auth, the meeting route. |
| `PAYMENT`            | Billing, refund or invoice friction, not the session.            |
| `SCHEDULING`         | Reschedule churn, late confirmation, allocation.                 |
| `CONTENT`            | Materials, handouts, pre-reads: the content, not the delivery.   |
| `OTHER`              | Anything else the rater wants to name.                           |

`CONSULTANT` is a positive claim rather than a default. `NULL` means "not asked or not answered" and must stay distinguishable from it, so no surface may treat an absent cause as an accusation of the consultant.

## A claim is not an adjudication

`ratingCause` records what the rater **says** drove a low score. `excludedFromAggregateAt` records the **adjudication**, and on the review it carries `excludedReason` and `excludedByUserId` beside it. The two are deliberately separate: if a self-reported cause removed a rating by itself, every consultant would coach clients to tick "platform issue". Only staff set the exclusion, because a self-served exclusion is a coaching vector.

Only rows with a `NULL` `excludedFromAggregateAt` enter either published score, the organisation's quality aggregate, or the platform priors. `recomputeConsultantRating`, `computePlatformPriors` and the organisation's `feedback-summary` all carry the predicate.

## Excluded is not deleted

`excludedFromAggregateAt` is distinct from `deletedAt`. A rating excluded because our video stack failed is still a true statement about that session and still renders on the profile with its text; it simply stops arithmetically punishing the person who did not cause it. A deleted row disappears from every public read. The public projection never exposes the exclusion columns, so a reader cannot tell an excluded review from a counted one, and `excludedReason` is staff-internal material that the allowlist keeps off the wire.

## What exists today

The columns, the predicates in every aggregate, and the enum all exist. No route yet writes `ratingCause` on either model, and no staff surface yet sets the exclusion; the columns ship ahead of the surfaces that use them so that the push, which is the coordinated step, is done once. The consultant- and staff-facing review surfaces are gathered under #1547, and nothing asks for a rating at all yet, which is #1548.

## Related

- [02-two-track-scoring.md](02-two-track-scoring.md) — the arithmetic the exclusion removes a row from.
- [The org quality signal](../feedback/02-org-quality-signal.md) — the aggregate that honours the same predicate on the private rail.
- [ADR 29](../enterprise/70-design-decisions/29-two-track-reputation-and-the-right-of-reply.md), "A low rating we caused does not count against the consultant".
