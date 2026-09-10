# Architecture: two scopes, one engine

Support runs in two scopes over one flowchart engine. The per-appointment scope persists a thread per `(appointmentId, userId)`; the platform scope persists nothing until a flow escalates. Both walk the same graph with the same transitions, and both write a ticket through the same factory. This page is the map of that engine, the one error contract every surface honours, and the one authorization gate every appointment-scoped route calls.

## The engine

The tree below shows how the support library is laid out and which module owns which responsibility.

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

`AppointmentSupportThread` is one conversation per `(appointmentId, userId)`. Intents are **stage-gated** like an order state: cancel and reschedule are offered only while the booking is upcoming; no-show, quality and recording intents only after completion. No-show has attendee **and** provider variants. Terminals carry machine-readable `reason`s (`provider_no_show`, `double_charge`, `quality_*`, and so on) that drive priority and land in the ticket description on escalation.

- Route: `app/api/appointments/[appointmentId]/support/route.ts` (`GET` the thread plus the server-gated intents, `POST` one turn).
- The sheet: `components/support/SupportThreadSheet.tsx`.
- Status card: `components/support/AppointmentSupportStatusCard.tsx`.

### Platform scope (stateless intake)

Platform issues (account, payments, site technical, operator billing) have no appointment to hang a thread on. The flowchart runs **statelessly**: the client holds the cursor and replays it each turn, and the server validates every transition against the registry and never trusts client state. A terminal either self-serves (nothing is written) or escalates, and escalation is the only write: a `SupportTicket` via the shared factory.

- Route: `app/api/support/platform/route.ts` (`GET` the intent catalogue for the caller's role, `POST` one turn).
- The sheet: `components/support/PlatformSupportSheet.tsx`.
- Replay dedup: a terminal turn reuses the user's recent `OPEN` ticket for the same outcome (`findRecentOpenEscalation`, thirty-minute window) instead of filing a twin.
- Org attribution: only on the `ORG_OPERATOR_BILLING` flow. An explicit `orgId` that is not one of the caller's `ACTIVE` memberships is a 403, never a silent downgrade to a B2C ticket.

### The hub surfaces

Five surfaces read or write this subsystem, and the table below names each one with the file that owns it and the scope it is allowed to see. The two rating surfaces sit here because they share the hub's authorization gate; their own behaviour is documented under [`docs/feedback/`](../feedback/README.md) and [`docs/reviews/`](../reviews/README.md).

| Surface                          | File                                                                                                                 | Scope                                                                                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consultee/consultant Support tab | `components/dashboard/shared/support/SupportHub.tsx`                                                                 | Sessions subtab (recent-session picker plus conversation buckets) and Platform subtab                                                                                  |
| Back-office inbox                | `components/dashboard/shared/SupportThreadsPage.tsx`                                                                 | `threads.manage`: full transcripts, reply, resolve and close                                                                                                           |
| Org triage — threads             | `app/dashboard/organization/[orgId]/support/OrgSupportTriage.tsx` + `GET /api/organizations/[orgId]/support-threads` | `operations.read`: a **metadata-only** thread list with no bodies ([ADR 20](../enterprise/70-design-decisions/20-org-visibility-into-member-sessions.md))              |
| Org triage — quality             | the same page + `GET /api/organizations/[orgId]/feedback-summary`                                                    | `quality.read`: aggregates only, per consultant, floored and secondarily suppressed. See [the org quality signal](../feedback/02-org-quality-signal.md)                |
| CSAT row                         | `components/reviews/SessionRatingRow.tsx`                                                                            | The private attendee rating rendered inline on each session row in `SessionTimeline`, one rating per call. See [feedback architecture](../feedback/01-architecture.md) |
| Public review composer           | `components/reviews/ProfileReviewComposer.tsx`                                                                       | Written on the expert's profile as a client island. See [reviews architecture](../reviews/01-architecture.md)                                                          |

## The error envelope (the one contract)

Every support-surface error response is `{ error, code, detail? }`, produced by `supportError()` in `lib/api/support-http.ts`.

- `error` is user-facing copy, safe to toast verbatim.
- `code` is the machine discriminator (`UNAUTHORIZED`, `INVALID_ID`, `VALIDATION_FAILED`, `NOT_FOUND`, `FORBIDDEN`, `RATE_LIMITED`, `CONFLICT`, `INTERNAL`). Tests assert on it and dashboards group by it.
- `detail` is developer material (a zod flatten, ids). It is echoed to the client only for client-fault statuses below 500; 5xx detail goes to Sentry only.

**The Sentry policy** lives in `supportError`. An original exception is captured with its stack (level `error` at 500 and above, `warning` below); a causeless 4xx is a `captureMessage` warning, which signals contract drift; and **401 and 429 are expected client noise and stay uncaptured on every path.** Exceptions are also written to `console.error` so local development without a Sentry DSN still sees them.

**The client mapping** is `lib/support/error-copy.ts`. `throwSupportError(res, context)` logs the raw payload to the console and throws code-mapped friendly copy; `describeSupportError(payload, fallback)` prefers code copy, then the server `error`, then the fallback. Every hub consumer routes failures through these.

**Route params** are opaque, length-bounded strings (`schemas/support.ts`: `AppointmentIdParams`, `SupportThreadIdParams`, `OrgIdParams`, all `min(1).max(64)`), never `.uuid()`. Seeded demo databases mint readable slugs such as `demo0813-appt-ba`, and the database lookup is the real validator. `parseRouteParams(schema, params, ctx)` awaits the params promise and answers the `INVALID_ID` envelope.

## Authorization: one gate, org-party opt-in

`authorizeAppointment(appointmentId, orgParty?)` in `lib/api/appointment-access.ts` is the single participation gate for the detail, feedback and support routes.

- Coded failures are ordered `UNAUTHORIZED`, then `NOT_FOUND`, then `FORBIDDEN`.
- Participants and platform staff pass; success carries `organizationId` and the already-loaded `detail`, so there is no second read.
- The **org-party grant is opt-in** (`orgParty: true`) and its success type carries no `detail`. An org operator may open their own conversation on their org's appointment, for org-party intents only (`ORG_PARTY_CATEGORIES`, defined once in `lib/support/service.ts` and clamped again defensively in `runSupportTurn`), and the full appointment graph is never reachable through the grant (ADR 20).
- Routes without an org-party surface (detail, feedback) call it bare; the type system then makes `isOrgParty: false` a fact rather than a check to remember.

## Notifications (ADR 23)

Every support notification carries `NotificationScope` for attribution and filing. Deep links follow the `lib/novu/resolve-href.ts` doctrine: org-hosted threads link to `/dashboard/organization/<id>/appointments`, and B2C stays a bare `/dashboard` so the capability router picks the viewer's tree.

Both directions of a ticket conversation page someone. A user replying into an escalated thread, or onto a ticket, previously told nobody, so staff only learned of it by reopening the inbox; `notifyStaffOfTicketActivity` in `lib/support/create-ticket.ts` closes that half. It prefers the assignee and falls back to the whole staff roster only when the ticket is unassigned, because fanning every reply at every staff member is how a queue's notifications get muted. In the other direction, the staff thread `PATCH` that resolves or closes a thread tells the user, who is the only party that cannot see the ops queue. Where a reference has been minted it leads the notification title, since that is the string the user will quote back.

## Deliberately out of scope

An AI resolver, a database-stored flow editor, email intake, org admins as notification _recipients_ for member complaints, a per-org Novu inbox, and mirroring support chat into Stream (support is Postgres only; the PR #1195 description carries the reasoning).

SLA timers were previously on this list and no longer are: the clocks in [03-ticket-references-and-sla.md](03-ticket-references-and-sla.md) are implemented and stored. What remains out of scope is the _sweep_. There is no cron that finds breached tickets and escalates or pages on them, because breach state is derived on read rather than stored, and no surface yet renders it.

## Related

- [02-the-grid.md](02-the-grid.md) — where support sits beside feedback and reviews.
- [06-invariants-and-testing.md](06-invariants-and-testing.md) — the rules the code above must keep.
