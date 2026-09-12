# Feedback

Feedback is the private per-call CSAT rail: one rating, and an optional note, per person per session, stored in `AppointmentFeedback`. It is private by construction. The rater sees their own score and note, the rated party sees the score only, and an organisation sees an aggregate above a cohort floor and nothing else ([ADR 20](../enterprise/70-design-decisions/20-org-visibility-into-member-sessions.md)). It is the sibling of two other subsystems, support and reviews, and the [grid](../support/02-the-grid.md) says how the three relate: a rating is about a conversation, a review is about a person, a case is about a problem.

## Recommended reading order

1. [01-architecture.md](01-architecture.md) — one rating per call and per person, who may rate whom, the API, edit semantics, and moderation soft-delete.
2. [02-org-quality-signal.md](02-org-quality-signal.md) — the organisation's per-consultant rollup, the k-anonymity floors, and the three suppression rules that keep the aggregate anonymous.
3. [03-schema-reference.md](03-schema-reference.md) — every column of `AppointmentFeedback`, and why.

## Source code map

The table below lists the files the feedback rail is built from.

| File                                                      | Purpose                                                                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `app/api/appointments/[appointmentId]/feedback/route.ts`  | `GET` the caller's ratings for an appointment or its whole booking, `POST` one rating for one call                            |
| `app/api/organizations/[orgId]/feedback-summary/route.ts` | The organisation's aggregate, per consultant, floored and suppressed                                                          |
| `lib/enterprise/quality-thresholds.ts`                    | `ORG_QUALITY_MIN_RESPONDENTS`, `ORG_QUALITY_MIN_RESPONDENTS_FOR_COMMENTS`, `applyCohortSuppression`, `suppressNarrowerWindow` |
| `lib/data/appointment-detail.ts`                          | `appointmentRaterRole`, which side of the session a user is on                                                                |
| `lib/reviews.ts`                                          | `heldSlot`, the shared "did this session happen, and were you there" predicate                                                |
| `hooks/useSessionFeedback.ts`                             | The timeline's read hook, keyed by `bookingFeedbackKey`                                                                       |
| `components/reviews/SessionRatingRow.tsx`                 | The star row rendered inline on each session of the timeline                                                                  |
| `__tests__/reviews/feedback-rates-the-meeting.test.ts`    | Pins that a rating lands on the run anchor, never on an interior slot                                                         |

## Related decisions

- [ADR 20 — organisations see session metadata, never session content](../enterprise/70-design-decisions/20-org-visibility-into-member-sessions.md), including its 2026-09-10 addendum on the per-consultant breakdown and the `quality.read` grant.
- [ADR 25](../enterprise/70-design-decisions/25-per-session-reviews-and-published-score.md), still live on the separation between this private rail and the public review.
