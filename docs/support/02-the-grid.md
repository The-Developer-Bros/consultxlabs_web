# The grid: what each record is about, who may see it, and when it exists

Support, feedback and reviews all hang off a booking and answer three different questions, so they anchor to three different things. Getting that wrong is how the same five-star widget ended up on screen twice. This page is the answer to #1300, which asked for objects × anchors × actors × booking shapes × organisation relationships.

It reads like a combinatorial problem and it is not. It factors into **three questions**, after which almost every cell is determined by a rule rather than chosen:

1. **Anchor — what is this record _about_?** The test is to anchor to the narrowest thing whose identity the user would name when describing it. "The call on the 14th was terrible" is about a session. "This expert is excellent" is about a person. "I was charged twice for my package" is about a booking. "I can't log in" is about an account.
2. **Visibility — who may write and read it?** Two rules, not a table. _Participation_: only a party to the anchored thing may write about it. _[ADR 20](../enterprise/70-design-decisions/20-org-visibility-into-member-sessions.md)_: an organisation sees metadata and aggregates, never content.
3. **Applicability — does it exist for this booking shape?** It exists if there is a counterparty and a session occurred.

## Vocabulary

Two of these words are not interchangeable, so the definitions matter.

- An **appointment** is the purchase: one consultation, a subscription holding up to twenty-four meetings, or a webinar with two hundred attendees.
- A **session** is one meeting that actually took place. It is stored as a contiguous run of thirty-minute `SlotOfAppointment` rows and identified by the run's first row, its anchor (#1061). `MeetingSession` hangs off exactly that row, and so does a rating.
- A **slot** is a thirty-minute storage row. It is never the unit a user sees, and nothing should be keyed to one directly.
- A **relationship** is one consultee and one consultant, across every booking they have ever shared.
- A **track** is what they bought from each other: one-to-one, or a group event.

## A · Object → anchor

The table below states, for each record, what it is anchored to, what else it carries, and who writes and reads it.

| Object                                              | Anchored to                                                                                                                                                                              | Also carries                                                                                                | Written by                                                       | Read by                                                                                                                                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppointmentFeedback` — the private per-call rating | the **session**, via `slotOfAppointmentId` pointing at the run anchor                                                                                                                    | `appointmentId` denormalised, `organizationId`, `raterRole`, `ratingCause`                                  | any participant, once the call is over                           | the rater (score and note), the rated party (**score only**), the organisation (aggregate above the cohort floor), staff read-only                                                              |
| `ConsultantReview` — the public review              | the **relationship**, via `@@unique([consultantProfileId, consulteeProfileId])`; the track is a column and joins the key at #1549 ([why](../reviews/07-deployment-and-deferred-work.md)) | `appointmentId` as provenance, `ratingUnitId` as the group event key, the reply columns, the revision trail | the consultee, after one attended session                        | the world                                                                                                                                                                                       |
| `AppointmentSupportThread` — the help conversation  | the **appointment**, via `@@unique([appointmentId, userId])`                                                                                                                             | a single `category`                                                                                         | the participant, or an org operator on its own org-party intents | the participant, staff in full, the organisation as metadata only                                                                                                                               |
| `SupportTicket` — the escalated grievance           | a **bare user**, with untyped links to a consultation, subscription or payment                                                                                                           | the SLA clocks, the `FAM-` reference, priority, issue type, assignee                                        | escalation, or the platform ticket form                          | the owner, staff in full                                                                                                                                                                        |
| `SupportFlowOutcome` — the deflection counter       | **the flow run**: a user and an optional organisation, deliberately no entity anchor                                                                                                     | the terminal node, the reason, and the tree's own CSAT                                                      | the server, on every terminal turn                               | staff, in aggregate only                                                                                                                                                                        |
| `Feedback` — product feedback about the platform    | **the user**                                                                                                                                                                             | a rating nothing aggregates, a free-text category, a triage status                                          | any signed-in user                                               | the author, staff                                                                                                                                                                               |
| `DpdpGrievance`                                     | the **data principal**                                                                                                                                                                   | —                                                                                                           | the principal                                                    | the grievance officer. Deliberately a **separate pipe** — Unacademy's terms say the same thing, that an IT-Rules grievance officer is not the contact for consumer grievances. Do not merge it. |

The rule that falls out is short. **A rating is about a conversation, a review is about a person, a case is about a problem, and product feedback is about us.**

## B · Actor × operation

The table below is derived from the two visibility rules above rather than enumerated independently. A dash means no path should exist.

| Actor                                          | Private rating                                                    | Public review                                                                      | Support                                                                        | Product feedback  |
| ---------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------- |
| Consultee (participant)                        | write own · read own score and note                               | write one per consultant per track · edit any time · withdraw and revive their own | open, reply, read own                                                          | write, read own   |
| Consultant (the rated party)                   | read attendee **scores only**, never the note                     | **reply** · never edit, never delete                                               | open, reply, read own                                                          | write, read own   |
| Org LEARNER / EXPERT without `operations.read` | as a participant only                                             | as a consultee only                                                                | as a participant only                                                          | as a user         |
| Org OWNER / MAINTAINER / MANAGER / SUPPORT     | **aggregate only**, above the cohort floor, counts suppressed too | nothing beyond what the public sees, and never attributable to a named member      | metadata-only list of members' threads · **full** on the ones it raised itself | —                 |
| Org BILLING_ADMIN                              | — (finance-only by design)                                        | public only                                                                        | billing-subject cases only                                                     | —                 |
| Platform STAFF                                 | read-only                                                         | read · moderate · remove a reply. **No hard delete, no unattributed edit**         | full                                                                           | triage the status |
| Platform ADMIN                                 | read-only                                                         | as STAFF, plus the ADMIN-only soft delete, always attributed                       | full                                                                           | triage the status |
| Anonymous public                               | —                                                                 | read, with anonymous reviewers stripped on **every** path                          | —                                                                              | —                 |

Three cells are worth stating because the code has got them wrong at least once each.

- **Read access is never write access.** Staff can read a rating and must not be able to author one; the feedback route enforces this through `appointmentRaterRole`.
- **An organisation is a party, not a spectator.** It may open its own thread on a member's appointment (`ORG_ADMIN_DISPUTE`, `SPONSORSHIP_BILLING`) and cannot read the member's. Note this deliberately **inverts** Zendesk, whose documented rule is that organisation-level sharing overrides a per-user restriction, which is the wrong default for career and health consultations.
- **The refund flow and the review flow must not be able to see each other.** A support agent negotiating a refund must not be able to tell that the consultee has an unpublished review. The FTC and Airbnb both treat review-for-value as the bright line.

## C · Support intent → subject scope

Five of the ten appointment intents are about one particular call; the rest are about the booking; the platform flows are about the account. The thread is anchored to the booking and cannot say which, and that is the gap described at the end of this page. The table below sorts every intent by the scope it is really about.

| Scope       | Categories                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Session** | `NO_SHOW`, `RESCHEDULE`, `RECORDING_ACCESS`, `TECHNICAL`, `QUALITY_COMPLAINT`                                           |
| **Booking** | `CANCEL_REFUND`, `PAYMENT_STATUS`, `DOCUMENTS`, `SPONSORSHIP_BILLING`, `ORG_ADMIN_DISPUTE`                              |
| **Account** | the five platform flows — `PAYMENTS_BILLING`, `ACCOUNT_ACCESS`, `PLATFORM_TECHNICAL`, `ORG_OPERATOR_BILLING`, `GENERAL` |

## D · Booking shape → what applies

The table below states, for each booking shape, which rating and review objects exist and which published score a review feeds.

| Shape                                     | Private rating           | Public review                                                    | Notes                                                                                          |
| ----------------------------------------- | ------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Consultation (1:1)                        | per session              | → the **1:1 score**                                              |                                                                                                |
| Subscription (up to 24 meetings)          | per session              | → the **1:1 score**, one review for the whole relationship       | the dominant shape, and the reason relationship-anchoring wins                                 |
| Trial                                     | per session              | → the 1:1 score                                                  |                                                                                                |
| Webinar (one appointment, many attendees) | per session per attendee | → the **group score**, once that event clears the response floor |                                                                                                |
| Class (one appointment per enrolment)     | per session              | → the **group score**, per class run                             | grouping by session _type_ would collapse a consultant's whole teaching history into one point |
| Offline / in person                       | per session              | → the 1:1 score                                                  | rides the `UNVERIFIED` arm of the eligibility gate                                             |
| Group plan with **no named consultant**   | private only             | **none**                                                         | nobody to review. Needs an explicit empty state rather than silence                            |

## E · Organisation-ness → treatment

The attribution rule is that **a case belongs to an organisation when the _thing it is about_ belongs to the organisation, never because the human happens to be a member.** The platform flow already states and enforces this; the manual ticket form contradicts it by stamping the caller's first `ACTIVE` membership onto any ticket, which is how "I can't log in" from a LEARNER gets attributed to their employer. The table below states the treatment for each relationship.

| Relationship                                                                      | Represented by                                                                                                 | Support                                                 | Feedback                     | Review                                                                                                                                |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| B2C personal                                                                      | `organizationId` NULL throughout                                                                               | own thread                                              | own rating                   | publishes                                                                                                                             |
| Org-sponsored — the org pays, a marketplace consultant delivers, a member attends | `Appointment.organizationId`, `AppointmentParticipant.organizationId` per seat, `BillingAccount.fundingSource` | attributed to the org by subject; the org sees metadata | rolls into the org aggregate | publishes normally, and the org can never attribute it to the named member                                                            |
| Org-hosted — the org's own EXPERT delivers                                        | `Membership.role = EXPERT` with `payoutRecipient = ORGANIZATION`                                               | same                                                    | same                         | **no public review**: an internal engagement is not a marketplace transaction, which is why BetterUp and CoachHub publish none at all |
| The operator's own concern                                                        | a membership holding `operations.read`                                                                         | its own thread, org-party intents only                  | n/a                          | n/a                                                                                                                                   |

## The support gap, and what is done about it for now

The support thread is anchored one level too high, and grid C is the evidence: five of the ten appointment intents are about a particular call and the thread cannot say which, because the unique is `(appointmentId, userId)`. On a subscription holding twenty-four meetings, a no-show reported in week two and a billing question asked in week nine share one thread, one category and one transcript, which is not how a ticketing system is supposed to work. Zendesk's problem/incident model exists precisely to keep the issue separate from its container.

Moving the anchor is a schema change that also touches the operations queue, the SLA clocks and the staff notifications, so it is tracked at #1541 rather than bolted onto the review work. Two things were done in the meantime, and both change what staff see.

`buildSupportContext` takes the thread's category and resolves the session from it. A retrospective intent describes the most recently finished session and everything else describes the current-or-next one; previously every intent was answered with the next upcoming session, so a report of a missed call came back describing a call that had not happened yet. The refund preview is deliberately exempt and always measures against the session you would actually be cancelling.

The same function groups slots into runs before reading the session bounds. Taking a single row gave a ninety-minute meeting a thirty-minute window, so `endsAt` fell an hour early and the stage flipped to `COMPLETED` while the call was still running, which is what decides the intents on offer. It also selects every non-cancelled slot rather than only `SCHEDULED` ones: a finished session is `COMPLETED` or `UNVERIFIED`, so the old filter removed exactly the rows a retrospective intent needs and `lastEndedRun` was structurally always null.

## Related

- [ADR 29 — two-track reputation and the right of reply](../enterprise/70-design-decisions/29-two-track-reputation-and-the-right-of-reply.md) is the decision behind the reviews row of grid A.
- [ADR 20](../enterprise/70-design-decisions/20-org-visibility-into-member-sessions.md) is the visibility rule behind every organisation cell of grid B.
- [Feedback architecture](../feedback/01-architecture.md) and [reviews architecture](../reviews/01-architecture.md) describe the two sibling objects in full.
