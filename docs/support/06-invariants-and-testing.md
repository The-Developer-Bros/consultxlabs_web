# Invariants and testing

The rules below are the ones the support code has to keep, each with the failure that motivated it. The test map after them says where each rule is pinned.

## Invariants worth knowing before you edit

1. **Status mirrors are transactional.** Thread and ticket status changes (`staff/support-threads/[threadId]` `PATCH`, the ticket-route mirror) commit in one `prisma.$transaction`, CAS-guarded with `status: { notIn: ["CLOSED"] }` **unconditionally**. A status-conditional `notIn: []` is a no-op filter in Prisma and would clobber a closed thread.
2. **All three write doors CAS on CLOSED, and a refusal rolls the turn back.** The self-serve turn, `persistHumanTurn` and `escalate()` each express the guard in the `WHERE` rather than checking it in JavaScript. `escalate()` was the door left open, and it was the worst one: closing a thread clears `supportTicketId`, so a reopen also minted a **second** ticket with its own reference and its own SLA clock while the first sat resolved in the queue. The refusal is a thrown `ThreadSettledError`, not a returned flag: returning `false` from a Prisma interactive transaction **commits** it, so the messages written earlier in the same callback survived a refused status write and the user was told their message was not sent while the row was in fact stored.
3. **`resolvedAt` semantics.** `RESOLVED` stamps the clock, `IN_PROGRESS` clears it, `CLOSED` keeps it, because closing a resolved thread must not erase its resolution time.
4. **`lastMessageAt` is the activity clock** on both `SupportTicket` and `AppointmentSupportThread`. Every visible message write bumps it inside the same transaction (queue replies bump the ticket's clock too), and the hub and both inboxes sort by it.
5. **The ticket spam budget is charged at escalation only.** Navigating a flowchart must never spend the same budget as filing a ticket.
6. **The recording 48-hour window is server-verified** in `runSupportTurn`. A client claiming "within 48h" after the slot's `endsAt` plus 48 hours has really passed is re-anchored onto the flow's escalation terminal. Claiming "beyond" early is allowed, because wanting a human is never wrong.
7. **CSAT writes are participant-only, and attributed.** Staff read access must not become write access, and `AppointmentFeedback.raterRole` records which side of the session the author was on. The org aggregate filters on `CONSULTEE` rather than excluding `PROVIDER`, so a row of unknown provenance fails closed. The card itself renders for the consultee only. The full rule is in [feedback architecture](../feedback/01-architecture.md).
8. **CSAT aggregates suppress small cohorts.** `feedback-summary` returns `null` averages _and_ `null` counts below `ORG_QUALITY_MIN_RESPONDENTS` distinct raters, applies secondary suppression to the per-consultant breakdown, and withholds the thirty-day window when its complement is too small. Respondents are people, never rows: rows stopped being a headcount when feedback moved to one row per call, so a single member rating three calls of one subscription would clear a row-counted floor alone. The arithmetic is in [the org quality signal](../feedback/02-org-quality-signal.md).
9. **Org triage is metadata-only, by design.** The select allowlist is pinned by `__tests__/security/org-scope-payload-allowlist.test.ts`. Do not add content fields to `THREAD_METADATA_SELECT`.
10. **`SupportMessage` is ordered by `seq`, never by `createdAt` alone.** The user's turn and the bot's reply are written in one transaction and Postgres `CURRENT_TIMESTAMP` is transaction start time, so both rows can carry a byte-identical timestamp. Every read uses `MESSAGE_ORDER` (`lib/support/message-seq.ts`), and every write allocates its numbers from `AppointmentSupportThread.messageSeq` inside the same transaction.
11. **The intent list has one definition**: `SupportThreadCategoryEnum` and `SupportThreadStatusEnum` in `schemas/enums.ts`. Three routes previously transcribed the category list by hand and every copy had lost `DOCUMENTS`, so the `GET` offered a chip the `POST` rejected. Which intents are _offered_ is the flow registry's decision; these schemas only have to accept whatever it can emit.

## Testing

The suites below are where the rules above are pinned.

- `__tests__/support/` covers flow-walk (pure transitions), platform-flows (gates, taxonomy, priority), service (clamps, attribution, window verification, the unrecognized-input reply, the intent chip recorded as the user's first message), support-http (envelope and Sentry policy), error-copy (the mapper), appointment-access (the authz matrix including org-party metadata-only), appointment-support-route (the **slug-id regression**: `demo0813-appt-ba` must return 200), platform-route (the entry-turn regression and the 404/401 envelopes), deflection, and context-retrospective-run.
- `__tests__/support/intent-offer-accept-parity.test.ts` asserts that the `GET` and the `POST` agree on which intents exist. It asserts the invariant over both flow registries rather than the one symptom, so the next flow added with a fresh category cannot reintroduce the divergence that made every `DOCUMENTS` press a 400.
- `__tests__/support/sla-and-reference.test.ts` pins that the per-priority targets stay inside the statutory ceilings, the pause arithmetic, and the reference format and its allocator.
- `__tests__/security/org-scope-payload-allowlist.test.ts` pins the org triage select against content leakage.

## Related

- [01-architecture.md](01-architecture.md) names the modules these rules live in.
- [07-engineering-log-2026-08-29.md](07-engineering-log-2026-08-29.md) records the defects several of these rules were written against.
