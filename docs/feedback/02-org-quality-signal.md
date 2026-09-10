# The org quality signal

An organisation that sponsors its members' sessions is entitled to ask whether the money is well spent, and [ADR 20](../enterprise/70-design-decisions/20-org-visibility-into-member-sessions.md) draws the line at metadata versus content: a member's rating of a session is content, and an aggregate is the one exception that makes the organisation's quality question answerable at all. That exception only holds if the aggregate is actually anonymous, which is a numeric claim rather than a vibe. This page describes the endpoint, the floors, and the three suppression rules that make the number safe to publish.

## What the endpoint answers

`GET /api/organizations/[orgId]/feedback-summary` returns, for the organisation's own attendee ratings, an all-time average and count, a thirty-day average and count, and a **per-consultant breakdown**. An enterprise buyer's question is not "how satisfied are our people overall" but "is this expert worth re-booking", and one org-wide average could not answer it: an organisation with four providers could not tell a good one from a bad one even in aggregate. The breakdown is still aggregate. No row, no rating, no comment and no member identity leaves the endpoint, and there is no drill-down. A consultant's _name_ crosses over, which it already does on the organisation's own appointments feed, and BetterUp's employer dashboard segments the same way. ADR 20's 2026-09-10 addendum records the extension.

The rows that count are `organizationId = orgId`, `raterRole = CONSULTEE`, `deletedAt IS NULL` and `excludedFromAggregateAt IS NULL`. Filtering on `CONSULTEE` rather than excluding `PROVIDER` means a row of unknown provenance fails closed, and the last two predicates mean a moderated-away comment's rating goes with it and a rating adjudicated as caused by our own outage does not read as a bad consultant.

The endpoint reads the rows once and aggregates in application code, because `AppointmentFeedback` carries no consultant column (the consultant is on the slot) and Prisma cannot group by a relation's scalar. Moving the two window figures back to a database aggregate would not help: the per-consultant pass still has to see the rows, so peak memory is unchanged, and under `PG_POOL_MAX=1` the extra statements would queue behind the read rather than run beside it. What bounds the read is the `WHERE`: one organisation's own attendee feedback, one row per rated call, three small values per row. Denormalising `consultantProfileId` onto the table is what would turn the last pass into a `groupBy`, and that is a pre-MVP-reset schema change tracked at #1550.

## The grant is `quality.read`

The endpoint is gated on `quality.read`, not on `operations.read`. The roles are the same today (OWNER, MAINTAINER, MANAGER, SUPPORT), so nothing changes about who can read it. The point is that `operations.read` also opens the org-wide appointments feed, the recordings list and the documents list, which are spend-and-utilisation surfaces, while this one is aggregated satisfaction drawn from ratings ADR 20 classifies as content. Sharing one grant means the day somebody widens `operations.read` for an unrelated reason, they widen this too without noticing.

## The floors

The constants live in `lib/enterprise/quality-thresholds.ts`. The table below states each one and what it gates.

| Constant                                   | Value | Gates                                                                                                                                 |
| ------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ORG_QUALITY_MIN_RESPONDENTS`              | 5     | Any average, and any count, reported to an organisation, for the total, the window, and each consultant cohort                        |
| `ORG_QUALITY_MIN_RESPONDENTS_FOR_COMMENTS` | 10    | Free-text, if any organisation surface ever returned it. None does today; the constant exists so the two floors are visibly different |

These are Microsoft Viva Glint's published defaults, the closest thing this problem has to an industry standard: five respondents before a score is reported and ten before free text is, with a secondary suppression rule on top. Culture Amp reports five. Qualtrics merges too-small groups into the next smallest rather than showing them. Ours was three, chosen when the underlying rows were one per _booking_. Once feedback became one row per _call_, three rows stopped being three people: one member rating three sessions of a subscription cleared the floor alone, and the average handed back was their own rating. Respondents are therefore counted as distinct `userId`s, never as rows.

They are code constants, deliberately, and not per-organisation settings. Glint makes a point of freezing its thresholds once a survey has collected data, because an administrator who can lower the bar after seeing the shape of the responses can lower it until the aggregate identifies somebody. A constant cannot be tuned by the party it protects, which is the same argument the public score's thresholds make.

## Three suppression rules

A floor alone is not enough when several numbers are published side by side, because subtraction is a query too. The endpoint applies three rules.

**Below the floor, nothing is reported, not the average and not the counts.** ADR 20's own stated reason for suppressing is that a count makes the disclosure trivial, and the endpoint previously returned `totalResponses` and `respondents` unconditionally, so at one respondent an organisation learned that exactly one member had rated exactly one session. Below the floor the endpoint now returns `null` for the average and both counts, and returns `minRespondents` so the card can say "needs 5 people" rather than render a blank it cannot explain.

**Never hide exactly one cohort.** A floor does not survive a breakdown published beside a total: hide exactly one consultant and its value is the total minus the published ones, so an administrator with a calculator recovers precisely the thing the floor exists to hide. `applyCohortSuppression` hides every cohort below the floor, and if that leaves exactly one hidden, it hides the smallest surviving cohort too. Either nothing is hidden or at least two are, and the sum of the hidden ones is all that can be derived. If the only cohort is below the floor there is no survivor to pair it with, and nothing is published rather than the one thing. The count of hidden cohorts, `consultantsSuppressed`, is safe to state and is the difference between "we have no data on them" and "we are not telling you"; by construction it is never one.

**Withhold the narrower window when its complement is too small.** The thirty-day window sits inside the all-time one, so publishing both counts and both averages publishes the difference: the people who answered longer ago, and their mean, by subtraction. Six all-time respondents beside five recent ones names the sixth person's rating exactly. `suppressNarrowerWindow` withholds the window whenever the complement is a cohort we would have refused to publish on its own; a complement of zero is safe because the two windows describe the same people.

The complement is **counted, not subtracted**. Somebody who answered both before and inside the window belongs to both sets, so `wider − narrower` only lower-bounds the number of people with an older response: it counts the people with _no_ recent response, and the older responses come from those plus the overlap. The lower bound errs toward suppressing, so the earlier subtraction was conservative rather than leaky, but it withheld a window that did not need withholding, and the route already holds the rows to count the real thing. It now summarises the rows with `createdAt < since30d` directly.

## Related

- [01-architecture.md](01-architecture.md) — the rows this aggregate is built from.
- [03-schema-reference.md](03-schema-reference.md) — the index the aggregate scans.
- [Rating cause and aggregate exclusion](../reviews/04-rating-cause-and-aggregate-exclusion.md) — why an excluded rating leaves this aggregate too.
