# Support & Feedback Hub

The `#support-hub` system (PR #1195): Swiggy-style, two-scope support built on
the channel-agnostic flowchart engine, plus the per-call CSAT feedback rail
rendered inline on each session row. This document is the map of what exists,
where, and the contracts that hold it together.

Issue #705 extended it with three things the queue could not run without: a
speakable ticket reference, an SLA model sized to Indian statute, and a
deflection counter that says whether the flowcharts are doing any work. Those
three have their own sections below. The defects that pass fixed alongside
them, and the reasoning behind each schema column, are recorded in the
[engineering log for 2026-08-29](engineering-log-2026-08-29.md).

## The two scopes, one engine

```text
lib/support/
├── flow-walk.ts          # PURE graph walk — both scopes execute identical transitions
├── flows.ts              # 10 appointment flowcharts (code-defined, PR-reviewed)
├── platform-flows.ts     # 5 stateless platform flows + reason→issueType taxonomy
├── priority.ts           # single reason→priority policy map
├── create-ticket.ts      # THE ticket factory + session-scope guard + dedup helpers
├── context.ts            # stage (UPCOMING/LIVE/COMPLETED), endsAt, isOrgOperator
├── service.ts            # runSupportTurn: reason/priority/org attribution,
│                         # lastMessageAt maintenance, ORG_PARTY_CATEGORIES
└── resolvers/            # flowchart-resolver (turn resolution over a flow)

lib/api/
├── support-http.ts       # the error envelope + Sentry policy + parseRouteParams
└── appointment-access.ts # ONE authz gate for appointment-scoped routes

lib/support/error-copy.ts # client-side code→friendly-copy mapper
```

### Per-appointment scope (persisted threads)

`AppointmentSupportThread` — one conversation per `(appointmentId, userId)`.
Intents are **stage-gated** like an order state: cancel/reschedule only while
upcoming; no-show/quality/recording only after completion. No-show has
attendee **and** provider variants. Terminals carry machine-readable
`reason`s (`provider_no_show`, `double_charge`, `quality_*`, …) that drive
priority and land in the ticket description on escalation.

- Route: `app/api/appointments/[appointmentId]/support/route.ts`
  (`GET` thread + server-gated intents, `POST` one turn)
- The sheet: `components/support/SupportThreadSheet.tsx`
- Status card: `components/support/AppointmentSupportStatusCard.tsx`

### Platform scope (stateless intake)

Platform issues (account, payments, site technical, operator billing) have no
appointment to hang a thread on. The flowchart runs **statelessly**: the
client holds the cursor and replays it each turn; the server validates every
transition against the registry and never trusts client state. A terminal
either self-serves (nothing written) or escalates — the only write, a
`SupportTicket` via the shared factory.

- Route: `app/api/support/platform/route.ts`
  (`GET` intent catalog for the caller's role, `POST` one turn)
- The sheet: `components/support/PlatformSupportSheet.tsx`
- Replay dedup: a terminal turn reuses the user's recent OPEN ticket for the
  same outcome (`findRecentOpenEscalation`, 30-minute window) instead of
  filing a twin.
- Org attribution: only on the `ORG_OPERATOR_BILLING` flow; an explicit
  `orgId` that isn't one of the caller's ACTIVE memberships is a 403, never a
  silent downgrade to a B2C ticket.

### The hub surfaces

Five surfaces read or write this subsystem, and the table below names each one
with the file that owns it and the scope it is allowed to see.

| Surface                          | File                                                              | Scope                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consultee/consultant Support tab | `components/dashboard/shared/support/SupportHub.tsx`              | Sessions subtab (recent-session picker + conversation buckets) + Platform subtab                                                                                                                |
| Back-office inbox                | `components/dashboard/shared/SupportThreadsPage.tsx`              | `threads.manage` → full transcripts + reply + resolve/close                                                                                                                                     |
| Org triage                       | `app/dashboard/organization/[orgId]/support/OrgSupportTriage.tsx` | `operations.read` → **metadata-only** thread list + CSAT aggregates (ADR 20)                                                                                                                    |
| CSAT row                         | `components/reviews/SessionRatingRow.tsx`                         | Private attendee rating rendered inline on each session row in `SessionTimeline`, via its `renderSessionExtra` prop and the `useSessionFeedback` hook; one rating per call, not per appointment |
| Public review card               | `components/reviews/SessionReviewCard.tsx`                        | The consumer review of the same session, deliberately a separate object — see [ADR 25](../enterprise/70-design-decisions/25-per-session-reviews-and-published-score.md)                         |

## The error envelope (the one contract)

Every support-surface error response is `{ error, code, detail? }`
(`lib/api/support-http.ts` → `supportError()`):

- `error` — USER-facing copy, safe to toast verbatim.
- `code` — machine discriminator (`UNAUTHORIZED`, `INVALID_ID`,
  `VALIDATION_FAILED`, `NOT_FOUND`, `FORBIDDEN`, `RATE_LIMITED`, `CONFLICT`,
  `INTERNAL`). Tests assert on it; dashboards group by it.
- `detail` — DEVELOPER material (zod flatten, ids). Echoed to the client only
  for client-fault statuses (<500); 5xx detail is Sentry-only.

**Sentry policy** (in `supportError`): an original exception is captured WITH
its stack (level `error` ≥500, `warning` below); a causeless 4xx is a
`captureMessage` warning (contract drift); **401/429 are expected client
noise and stay uncaptured on every path.** Exceptions are also
`console.error`'d so local dev without a Sentry DSN still sees them.

**Client mapping** (`lib/support/error-copy.ts`): `throwSupportError(res,
context)` logs the raw payload to the console and throws code-mapped friendly
copy; `describeSupportError(payload, fallback)` prefers code copy → server
`error` → fallback. Every hub consumer routes failures through these.

**Route params**: ids are opaque, length-bounded strings
(`schemas/support.ts` — `AppointmentIdParams`, `SupportThreadIdParams`,
`OrgIdParams`, all `min(1).max(64)`), never `.uuid()` — seeded demo databases
mint readable slugs (`demo0813-appt-ba`), and the DB lookup is the real
validator. `parseRouteParams(schema, params, ctx)` awaits the params promise
and answers the INVALID_ID envelope.

## Authz: one gate, org-party opt-in

`authorizeAppointment(appointmentId, orgParty?)`
(`lib/api/appointment-access.ts`) is the single participation gate for the
detail/feedback/support routes:

- Coded failures: `UNAUTHORIZED` → `NOT_FOUND` → `FORBIDDEN`.
- Participants and platform staff pass; success carries `organizationId` and
  the already-loaded `detail` (no second read).
- The **org-party grant is opt-in** (`orgParty: true`) and its success type
  carries NO `detail` — an org operator may open their OWN conversation on
  their org's appointment, org-party intents only
  (`ORG_PARTY_CATEGORIES`, defined once in `lib/support/service.ts` and
  clamped again defensively in `runSupportTurn`), and the full appointment
  graph is never reachable through the grant (ADR 20).
- Routes without an org-party surface (detail, feedback) call it bare; the
  type system then makes `isOrgParty: false` a fact, not a check to remember.

## What each object is ABOUT

Feedback, support and reviews all hang off a booking, and they answer three
different questions, so they anchor to three different things. Getting this
wrong is how the same five-star widget ended up on screen twice. The vocabulary
matters because two of these words are not interchangeable:

- An **appointment** is the purchase. One consultation, a subscription holding
  up to twenty-four meetings, or a webinar with two hundred attendees.
- A **session** is one meeting that actually took place. It is stored as a
  contiguous run of thirty-minute `SlotOfAppointment` rows and identified by the
  run's first row, its anchor (#1061). `MeetingSession` hangs off exactly that
  row, and so does a rating.
- A **slot** is a thirty-minute storage row. It is never the unit a user sees,
  and nothing should be keyed to one directly.
- A **relationship** is one consultee and one consultant, across every booking
  they have ever shared.

| Object                                              | Anchored to                                                                     | Also carries                                                          | Why                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppointmentFeedback` — the private per-call rating | the **session**, via `slotOfAppointmentId` pointing at the run anchor           | `appointmentId`, denormalised                                         | You rate the conversation you had. One rating per appointment gave a three-month subscription a single score; one per slot would ask you to rate one conversation three times. The denormalised `appointmentId` exists only so the organisation aggregate can roll up without a join. |
| `AppointmentSupportThread` — the help conversation  | the **appointment**, via `@@unique([appointmentId, userId])`                    | a single `category`                                                   | This is the one that does not yet fit. Most intents are about a specific call, and the thread cannot say which. See the gap below.                                                                                                                                                    |
| `ConsultantReview` — the public review              | the **relationship**, via `@@unique([consultantProfileId, consulteeProfileId])` | `appointmentId` as provenance, `ratingUnitId` as the weighting bucket | A reader wants one considered opinion of a person, not four near-identical ones from the same client. The appointment proves the review is genuine; it is not its subject.                                                                                                            |

The rule that falls out of the table is short. A rating is about a conversation,
a review is about a person, and a support thread is about a problem.

### The support gap, and what is done about it for now

The support thread is anchored one level too high. Of the ten appointment
intents, five are about a particular call — `NO_SHOW`, `RESCHEDULE`,
`RECORDING_ACCESS`, `TECHNICAL` and `QUALITY_COMPLAINT` — while the rest
(`CANCEL_REFUND`, `PAYMENT_STATUS`, `DOCUMENTS`, `SPONSORSHIP_BILLING`,
`ORG_ADMIN_DISPUTE`) genuinely belong to the booking. Because the unique is
`(appointmentId, userId)`, a no-show reported in week two and a billing question
asked in week nine share one thread, one category and one transcript, which is
not how a ticketing system is supposed to work.

Moving the anchor is a schema change that also touches the operations queue, the
SLA clocks and the staff notifications, so it is tracked separately rather than
bolted onto the review work. Two things were done in the meantime, and both are
worth knowing about because they change what staff see.

`buildSupportContext` now takes the thread's category and resolves the session
from it. A retrospective intent describes the most recently finished session,
and everything else describes the current-or-next one. Previously every intent
was answered with the next upcoming session, so a report of a missed call came
back describing a call that had not happened yet. The refund preview is
deliberately exempt and always measures against the session you would actually
be cancelling.

The same function now groups slots into runs before reading the session bounds.
Taking a single row gave a ninety-minute meeting a thirty-minute window, so
`endsAt` fell an hour early and the stage flipped to `COMPLETED` while the call
was still running — which is what decides the intents on offer.

## Invariants worth knowing before you edit

1. **Status mirrors are transactional.** Thread ⇄ ticket status changes
   (`staff/support-threads/[threadId]` PATCH, ticket-route mirror) commit in
   one `prisma.$transaction`, CAS-guarded with `status: { notIn: ["CLOSED"] }`
   **unconditionally** — a status-conditional `notIn: []` is a no-op filter in
   Prisma and would clobber a closed thread.
2. **All three write doors CAS on CLOSED, and a refusal rolls the turn back.**
   The self-serve turn, `persistHumanTurn` and `escalate()` each express the
   guard in the `WHERE` rather than checking it in JavaScript. `escalate()` was
   the door left open, and it was the worst one: closing a thread clears
   `supportTicketId`, so a reopen also minted a **second** ticket with its own
   reference and its own SLA clock while the first sat resolved in the queue.
   The refusal is a thrown `ThreadSettledError`, not a returned flag —
   returning `false` from a Prisma interactive transaction **commits** it, so
   the messages written earlier in the same callback survived a refused status
   write and the user was told their message was not sent while the row was in
   fact stored.
3. **`resolvedAt` semantics**: RESOLVED stamps the clock, IN_PROGRESS clears
   it, CLOSED keeps it (closing a resolved thread must not erase its
   resolution time).
4. **`lastMessageAt` is the activity clock** on both `SupportTicket` and
   `AppointmentSupportThread` — every visible message write bumps it inside
   the same transaction (queue replies bump the ticket's clock too). The hub
   and both inboxes sort by it.
5. **The ticket spam budget is charged at escalation only** — navigating a
   flowchart must never spend the same budget as filing a ticket.
6. **The recording 48h window is server-verified** (`runSupportTurn`): a
   client claiming "within 48h" after the slot's `endsAt` + 48h has really
   passed is re-anchored onto the flow's escalation terminal. Claiming
   "beyond" early is allowed — wanting a human is never wrong.
7. **CSAT writes are participant-only, and attributed** — staff read access
   must not become write access, and `AppointmentFeedback.raterRole` records
   which side of the session the author was on. The org aggregate filters on
   `CONSULTEE` rather than excluding `PROVIDER`, so a row of unknown
   provenance fails closed. The card itself renders for the consultee only.
8. **CSAT aggregates suppress small cohorts** — `feedback-summary` returns
   `null` averages below `MIN_COHORT = 3` **distinct raters**, counted with a
   `groupBy(["userId"])`. Rows stopped being a headcount when feedback moved to
   one row per call: a single member rating three calls of one subscription
   cleared a three-row threshold alone, and the "average" handed back was their
   own private rating (ADR 20).
9. **Org triage is metadata-only, by design** — the select allowlist is
   pinned by `__tests__/security/org-scope-payload-allowlist.test.ts`. Do not
   add content fields to `THREAD_METADATA_SELECT`.
10. **`SupportMessage` is ordered by `seq`, never by `createdAt` alone** — the
    user's turn and the bot's reply are written in one transaction and Postgres
    `CURRENT_TIMESTAMP` is transaction start time, so both rows can carry a
    byte-identical timestamp. Every read uses `MESSAGE_ORDER`
    (`lib/support/message-seq.ts`), and every write allocates its numbers from
    `AppointmentSupportThread.messageSeq` inside the same transaction.
11. **The intent list has one definition** — `SupportThreadCategoryEnum` and
    `SupportThreadStatusEnum` in `schemas/enums.ts`. Three routes previously
    transcribed the category list by hand and every copy had lost `DOCUMENTS`,
    so the `GET` offered a chip the `POST` rejected. Which intents are
    _offered_ is the flow registry's decision; these schemas only have to
    accept whatever it can emit.

## Ticket references: `FAM-<YYYY>-<SEQ6>`

Every ticket minted from either scope now carries a speakable handle in
`SupportTicket.referenceNumber`, formatted by `lib/support/reference.ts` as
the literal prefix `FAM`, the calendar year, and a six-digit zero-padded
sequence — `FAM-2026-000123`. A uuid cannot be read back over a phone line or
quoted in an email subject, and before this the two staff surfaces had each
invented their own truncation of the id (the tickets table took the first
eight characters, the staff home took the last), so the two screens named the
same ticket differently and the user was shown no identifier at all.

The series is scoped to the year rather than being a single lifetime counter,
and that is a privacy decision rather than a cosmetic one. A lifetime counter
publishes the platform's all-time ticket volume to anyone who files two
tickets and subtracts one reference from the other. This is the German tank
problem, which is exactly how the Allies estimated German production from
sequential part serial numbers. Resetting each January caps the leak at the
current year's volume.

Allocation runs through `allocateTicketReference(tx, now)` inside the same
transaction that creates the ticket, so a rolled-back ticket never leaves a
live reference behind. The upsert on `SupportTicketCounter` compiles to
`INSERT … ON CONFLICT DO UPDATE … RETURNING`: the create path is arbitrated by
the primary key and the update path is an in-place increment holding a row
lock, so concurrent allocators queue and each returns a distinct value with no
read-modify-write in application space. The column is also `@unique`, which
turns any residual duplicate into a `P2002` to retry rather than two tickets
quietly sharing a handle. Gaps are acceptable here — a rolled-back ticket
burns a number and nothing depends on the series being unbroken — which is
the difference from the GST invoice series, where CGST Rule 46 would not
allow it.

The column is nullable and minted forward-only. A unique index permits
unlimited nulls, so tickets that predate the counter keep their uuid and every
surface falls back to the old truncation for them; no backfill is owed.

## The SLA model

India makes a support escalation ladder a legal artifact rather than a
nicety, and two regimes can apply. The table below states both, and the row
the implementation is sized to.

| Regime                                      | Acknowledge within | Dispose within |
| ------------------------------------------- | ------------------ | -------------- |
| Consumer Protection (E-Commerce) Rules 2020 | 48 hours           | 1 month        |
| IT Rules 2021                               | **24 hours**       | **15 days**    |

`lib/support/sla.ts` is sized to the IT Rules 2021 numbers, exported as
`STATUTORY_ACK_HOURS` and `STATUTORY_RESOLUTION_DAYS`. They are the tighter of
the two, so meeting them satisfies both regimes and the platform does not have
to first settle whether it is an intermediary.

Inside those ceilings sit per-priority internal targets. They are a service
goal and never a relaxation of the statutory number, which is what the first
test in `__tests__/support/sla-and-reference.test.ts` pins.

| Priority | Acknowledge | Resolve |
| -------- | ----------- | ------- |
| `URGENT` | 2 hours     | 1 day   |
| `HIGH`   | 8 hours     | 3 days  |
| `MEDIUM` | 24 hours    | 7 days  |
| `LOW`    | 24 hours    | 15 days |

`slaDeadlinesFor(priority, from)` is called once at intake and its two
deadlines are stored on the ticket, never re-derived on read. That is the same
rationale as `Appointment.cancellationPolicySnapshot`: a later change to the
table above must not retroactively re-date the breach of a ticket that is
already open.

**The resolution clock pauses while the ball is in the user's court.**
Without that, a customer who takes a week to answer reads as the team
breaching and the number stops meaning anything. A staff reply calls
`applyStaffReply`, which sets `awaitingUserSince` and, on the first occasion
only, `acknowledgedAt` and `firstAgentReplyAt`. A user reply calls
`userRepliedPatch`, which folds the wait that just ended into `pausedSeconds`
and clears `awaitingUserSince`; it is a no-op when nothing was being awaited,
so a user sending three messages in a row cannot bank three pauses. The
effective deadline is therefore `resolutionDueAt + pausedSeconds`, computed by
`effectiveResolutionDueAt`. Seconds rather than milliseconds because an `Int`
of milliseconds overflows at 24.8 days, which a ticket parked on the user for a
couple of months would reach. The **acknowledgement** clock never pauses,
because nobody has replied yet and there is therefore nothing to be waiting
for.

An internal note is not a reply. `applyStaffReply` runs only when
`isInternal` is false, since the user has not heard anything and nothing is
yet owed back to them.

Breach state is derived by `slaStateOf(clock, now)` and never stored. A stored
breach flag needs a cron to stay honest and is wrong between runs, whereas the
five stored timestamps plus the current time are complete. Two indexes on
`SupportTicket` make the sweeps cheap: `[acknowledgedAt, ackDueAt]` answers
"unacknowledged and past due" and `[resolvedAt, resolutionDueAt]` answers
"unresolved and past due".

`firstAgentReplyAt` is deliberately distinct from `acknowledgedAt`. An
automated acknowledgement satisfies the latter; only the former is the number
that predicts CSAT, and it is set once and never moved so that an
auto-acknowledgement cannot claim it.

## Deflection: what fraction the tree actually resolves

"What fraction of conversations the tree resolves without a human" is the
number that says whether the flowcharts work, and until now it was
unanswerable even after the fact. Appointment-scope resolutions could only be
inferred from thread status, and platform-scope resolutions persisted nothing
at all, so a user whom the payments flow helped left no trace whatsoever.

`SupportFlowOutcome` records one row per **terminal** support turn in both
scopes, written by `recordFlowOutcome` in `lib/support/deflection.ts`. Each
row carries the scope, the flow key, the terminal node id, the terminal's
machine-readable `reason`, the outcome as `RESOLVED` or `ESCALATED`, and the
user and organization for attribution. It carries no message bodies: this is
a counter, not a transcript.

Three design points are worth stating, because each of them looks like an
unnecessary difference from what already exists. The outcome is not derived
from thread status, because a thread is reused across intents and its final
status therefore describes the last thing that happened to it rather than each
flow run — and the platform scope has no thread to read at all. The `scope`
field is a plain string rather than an enum, because it is a reporting
dimension rather than a state machine and a third intake surface should not
need a migration to be counted. And `recordFlowOutcome` never throws when
called without a transaction: an analytics row must not be able to roll back
the support turn that produced it, or a metric outage becomes a support
outage.

`deflectionSince(since, where)` returns the resolved and escalated counts and
the rate. The rate is `null` rather than `0` when nothing happened, because
zero deflection and no traffic are different facts and a dashboard that
conflates them lies.

**Read the number with its caveat.** Deflection alone scores a user who gave
up exactly like a user who was helped: both leave a `RESOLVED` row and never
contact a person. The counter is therefore only honest when read next to a
re-contact signal — did this person come back within the next few days — which
is what the `[userId, createdAt]` index exists to serve. A deflection rate
quoted on its own is a measure of how easy the tree is to abandon.

## Schema (additive-only, freeze-compliant)

The table below lists every schema change the subsystem carries, oldest
first. All of them are additive and either nullable or defaulted, so each is
compatible with the pre-MVP freeze and none needs a backfill.

| Change                                                                                                                                                                                                                                | Why                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SupportTicket.organizationId?` + `@@index([organizationId, status])`                                                                                                                                                                 | ops queue filterable by customer org                                                                                                                                                                                                        |
| `lastMessageAt?` on `SupportTicket` + `AppointmentSupportThread` (+ `@@index([status, lastMessageAt])` on the thread)                                                                                                                 | "latest activity first" — `updatedAt` doesn't move on message inserts; the inbox sort needs the index                                                                                                                                       |
| `SupportTicket.referenceNumber?` (`@unique`, `VarChar(20)`) + the `SupportTicketCounter` model                                                                                                                                        | the speakable handle and its year-scoped allocator (#705)                                                                                                                                                                                   |
| `SupportTicket.assignedTo` relation (`SetNull`) replacing the bare `assignedToId` string                                                                                                                                              | a bare string could name a user who no longer exists, and the queue could not render a name without a second query; a staff departure must not delete tickets                                                                               |
| `SupportTicket.ackDueAt`, `acknowledgedAt`, `resolutionDueAt`, `resolvedAt`, `closedAt`, `firstAgentReplyAt`, `awaitingUserSince`, `pausedSeconds` + `@@index([acknowledgedAt, ackDueAt])` + `@@index([resolvedAt, resolutionDueAt])` | the SLA clocks, stored at intake so a policy change cannot re-date an open ticket's breach; the indexes turn a breach sweep into an index scan                                                                                              |
| `AppointmentSupportThread.messageSeq` + `SupportMessage.seq` + `@@index([threadId, seq])`                                                                                                                                             | a strict per-thread total order; `createdAt` alone cannot order rows written in one transaction                                                                                                                                             |
| `SupportMessage.authorUserId?` (`SetNull`) + `@@index([authorUserId])`                                                                                                                                                                | which staff member wrote an `AGENT` message; Postgres does not index a foreign key for you and the `SetNull` scans by it                                                                                                                    |
| the `SupportFlowOutcome` model + the `SupportFlowOutcomeKind` enum                                                                                                                                                                    | the deflection counter, in both scopes, with no message bodies                                                                                                                                                                              |
| `AppointmentFeedback.raterRole?` + the `AppointmentFeedbackRole` enum; `@@index([organizationId, createdAt])` becomes `@@index([organizationId, raterRole, createdAt])`                                                               | a consultant's rating of their own session used to be indistinguishable from an attendee's and fed the org quality average; the aggregate now filters `raterRole` before the date range, which leaves the old index without a usable prefix |

> `@@index([status, lastMessageAt])` requires `npm run db:push` (which chains
> the sidecars) on each environment — a schema-only merge does not create it.
> The same is true of every index in the table above. #1268 removed the
> `consultant_review_legacy_pair_key` sidecar rather than adding it, because
> Prisma matches an index to the schema by its columns only and ignores its
> `WHERE` clause; left in place, `prisma db push` would have proposed renaming
> that partial index onto the real `(consultantProfileId, consulteeProfileId)`
> key, quietly narrowing the constraint to cover only the legacy rows it was
> written to protect.

## Notifications (ADR 23)

Every support notification carries `NotificationScope` (attribution +
filing). Deep-links follow `lib/novu/resolve-href.ts` doctrine: org-hosted
threads link to `/dashboard/organization/<id>/appointments`; B2C stays a bare
`/dashboard` and the capability router picks the viewer's tree.

Both directions of a ticket conversation now page someone. A user replying
into an escalated thread, or onto a ticket, previously told nobody, so staff
only learned of it by reopening the inbox; `notifyStaffOfTicketActivity`
(`lib/support/create-ticket.ts`) closes that half. It prefers the assignee and
falls back to the whole staff roster only when the ticket is unassigned,
because fanning every reply at every staff member is how a queue's
notifications get muted. In the other direction, the staff thread `PATCH` that
resolves or closes a thread now tells the user, who is the only party that
cannot see the ops queue. Where a reference has been minted, it leads the
notification title, since that is the string the user will quote back.

## Testing

- `__tests__/support/` — flow-walk (pure transitions), platform-flows (gates/
  taxonomy/priority), service (clamps, attribution, window verification,
  the unrecognized-input reply, the intent chip recorded as the user's first
  message), support-http (envelope + Sentry policy), error-copy (mapper),
  appointment-access (authz matrix incl. org-party metadata-only),
  appointment-support-route (**slug-id regression**: `demo0813-appt-ba` must
  200), platform-route (entry-turn regression, 404/401 envelopes).
- `__tests__/support/intent-offer-accept-parity.test.ts` — the `GET` and the
  `POST` must agree on which intents exist. It asserts the invariant over both
  flow registries rather than the one symptom, so the next flow added with a
  fresh category cannot reintroduce the divergence that made every `DOCUMENTS`
  press a 400.
- `__tests__/support/sla-and-reference.test.ts` — the per-priority targets
  stay inside the statutory ceilings, the pause arithmetic, and the reference
  format and its allocator.
- `__tests__/security/org-scope-payload-allowlist.test.ts` — pins the org
  triage select against content leakage.

## Deliberately out of scope

AI resolver, DB-stored flow editor, email intake, org admins as notification
_recipients_ for member complaints, per-org Novu inbox, and mirroring support
chat into Stream (Postgres only — see the PR #1195 description for the
reasoning).

SLA timers were previously on this list and no longer are: the clocks
described above are implemented and stored. What remains out of scope is the
_sweep_ — there is no cron that finds breached tickets and escalates or pages
on them, because breach state is derived on read rather than stored, and no
surface yet renders it.

## Related

- [Engineering log, 2026-08-29](engineering-log-2026-08-29.md) — the eight
  causes behind the support-drawer turn loss, the schema they required, and
  two audit claims that were checked and found stale.
- [ADR 25 — per-session reviews and the published score](../enterprise/70-design-decisions/25-per-session-reviews-and-published-score.md)
  — the public review model that sits beside the private CSAT rail described
  here.
