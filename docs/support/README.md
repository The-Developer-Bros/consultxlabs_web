# Support

The support system is the `#support-hub` subsystem (PR #1195): Swiggy-style, two-scope support built on a channel-agnostic flowchart engine, with a ticket queue behind it. Issue #705 extended it with a speakable ticket reference, an SLA model sized to Indian statute, and a deflection counter that says whether the flowcharts are doing any work. Issue #1300 then asked what support, feedback and reviews should each be anchored to, and the answer is the grid in [02-the-grid.md](02-the-grid.md).

## Three sibling subsystems

Support is one of three subsystems that all hang off a booking and answer three different questions, so they anchor to three different things. The table below names each one, what it is about, and where it is documented.

| Subsystem | Answers                              | Anchored to                    | Documented in                    |
| --------- | ------------------------------------ | ------------------------------ | -------------------------------- |
| Support   | "I have a problem with this booking" | the appointment, or the user   | this folder                      |
| Feedback  | "How was that call?" (private CSAT)  | the session                    | [`docs/feedback/`](../feedback/) |
| Reviews   | "What is this expert like?" (public) | the relationship and the track | [`docs/reviews/`](../reviews/)   |

The rule that falls out of the grid is short: a rating is about a conversation, a review is about a person, a case is about a problem, and product feedback is about us.

## Recommended reading order

1. [01-architecture.md](01-architecture.md) — the two scopes and the one engine, the error envelope, the authorization gate, the hub surfaces, and what is deliberately out of scope.
2. [02-the-grid.md](02-the-grid.md) — the object-to-anchor, actor-by-operation, intent-to-scope, booking-shape and organisation-ness grids, and the support gap they expose.
3. [03-ticket-references-and-sla.md](03-ticket-references-and-sla.md) — the `FAM-` reference series and the statutory SLA clocks.
4. [04-deflection-and-support-csat.md](04-deflection-and-support-csat.md) — what fraction the tree resolves, and the two halves of support CSAT.
5. [05-schema-reference.md](05-schema-reference.md) — every support column and why it exists.
6. [06-invariants-and-testing.md](06-invariants-and-testing.md) — the eleven invariants to know before editing, and the test map.
7. [07-engineering-log-2026-08-29.md](07-engineering-log-2026-08-29.md) — the support-drawer turn loss: eight causes, the schema they required, and two stale audit claims.

## Source code map

The table below lists every file the support subsystem is built from and what each one owns.

| File                                                    | Purpose                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `lib/support/flow-walk.ts`                              | The pure graph walk; both scopes execute identical transitions                                    |
| `lib/support/flows.ts`                                  | The ten appointment flowcharts, code-defined and PR-reviewed                                      |
| `lib/support/platform-flows.ts`                         | The five stateless platform flows and the reason-to-issue-type taxonomy                           |
| `lib/support/priority.ts`                               | The single reason-to-priority policy map                                                          |
| `lib/support/create-ticket.ts`                          | The ticket factory, the session-scope guard, the dedup helpers, and `notifyStaffOfTicketActivity` |
| `lib/support/context.ts`                                | Stage (`UPCOMING` / `LIVE` / `COMPLETED`), `endsAt`, `isOrgOperator`                              |
| `lib/support/service.ts`                                | `runSupportTurn`: reason, priority and org attribution, `lastMessageAt`, `ORG_PARTY_CATEGORIES`   |
| `lib/support/resolvers/`                                | The flowchart resolver (turn resolution over a flow)                                              |
| `lib/support/reference.ts`                              | The `FAM-<YYYY>-<SEQ6>` reference format and its allocator                                        |
| `lib/support/sla.ts`                                    | The statutory ceilings, per-priority targets, the pause arithmetic, and `slaStateOf`              |
| `lib/support/deflection.ts`                             | `recordFlowOutcome` and `deflectionSince`                                                         |
| `lib/support/message-seq.ts`                            | `MESSAGE_ORDER`, the per-thread total order                                                       |
| `lib/support/error-copy.ts`                             | The client-side code-to-friendly-copy mapper                                                      |
| `lib/api/support-http.ts`                               | The error envelope, the Sentry policy, `parseRouteParams`                                         |
| `lib/api/appointment-access.ts`                         | The one authorization gate for appointment-scoped routes                                          |
| `app/api/appointments/[appointmentId]/support/route.ts` | Per-appointment scope: `GET` thread and gated intents, `POST` one turn                            |
| `app/api/support/platform/route.ts`                     | Platform scope: `GET` the intent catalogue for the caller's role, `POST` one turn                 |
| `components/support/SupportThreadSheet.tsx`             | The per-appointment drawer                                                                        |
| `components/support/PlatformSupportSheet.tsx`           | The platform drawer                                                                               |
| `components/support/AppointmentSupportStatusCard.tsx`   | The status card on an appointment                                                                 |
| `components/dashboard/shared/support/SupportHub.tsx`    | The consultee and consultant Support tab                                                          |
| `components/dashboard/shared/SupportThreadsPage.tsx`    | The back-office inbox                                                                             |
| `schemas/support.ts`, `schemas/enums.ts`                | Route-parameter schemas, and the one definition of the category and status lists                  |

## Related decisions

- [ADR 20 — organisations see session metadata, never session content](../enterprise/70-design-decisions/20-org-visibility-into-member-sessions.md) sets the visibility rule every org-facing support surface inherits.
- [ADR 23 — notification scope](../enterprise/70-design-decisions/23-notification-scope.md) governs the scope every support notification carries.
- [ADR 29 — two-track reputation and the right of reply](../enterprise/70-design-decisions/29-two-track-reputation-and-the-right-of-reply.md) is the decision behind the reviews row of the grid.
