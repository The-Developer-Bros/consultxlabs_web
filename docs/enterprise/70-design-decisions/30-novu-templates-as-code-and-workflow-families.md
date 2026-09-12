---
title: Novu templates as code, grouped into workflow families
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-09-13
---

# ADR 30 — Novu templates as code, grouped into workflow families

## Context

On 2026-09-12 the staff inbox showed `Your ticket "FAM-2026-000007 — Support for Basic Consultation" has been updated to:` with nothing after the colon, and `New support ticket: "…" (bf2a5137-…) - Status:` with a UUID and, again, nothing. Three facts explained it, and none was a copy mistake.

First, the nineteen workflows in the Novu environment were built by hand in Novu's legacy editor on 2026-01-30 (`origin: novu-cloud-v1`). Their bodies referenced payload fields at the root, Handlebars-style (`{{status}}`), while `docs/notifications/03-novu-template-specs.md` had been written for the v2 dashboard's Liquid (`{{payload.status}}`); the two drifted the week they were written and nothing compared them. Novu's migration guide states that legacy workflows "will appear in the new UI however, will not be editable from there" and that there is "no automated way to migrate" them, which is the real meaning of the note in `humanize.ts` that the templates "cannot be edited on the current plan".

Second, the application triggers 66 workflow ids and only 19 existed. Every ban, suspension, payout, dispute, recording, document, collaborator, maintenance and organisation event had been failing with `workflow_not_found` since each was written (#1604 and #1511 had found four of them). The staff-facing "customer replied" notice reused the owner-facing `support-ticket-update` workflow with no status, which is where the blank sentence came from.

Third, and the constraint that shaped the answer: the Novu plan in use caps an environment at **20 workflows**. Pro ($30/month) keeps the same cap; Team ($250/month) raises it to 100. The 48 missing workflows could never have been created by hand on this plan, and both local development and production point at the same Development environment, so any workflow write is a production operation.

## Decision

1. **The repository owns the templates.** `lib/novu/templates/` holds one entry per event — name, audience, opt-out category, in-app subject, Liquid body and redirect — and `scripts/novu/sync-workflows.ts` writes them to the environment through the `@novu/api` v2 workflows endpoints (`get` → `update` or `create`). `npm run novu:sync -- --dry-run` prints the plan, `npm run novu:check` fails on drift, and the apply is run by hand after a merge, like `db:sidecars`. The docs spec becomes a description of the manifest, not a second copy of it.

2. **One Novu workflow per family, the event in the payload.** Sixteen families (`appointment`, `session-media`, `payment`, `refund`, `payout`, `referral`, `subscription`, `trial`, `support-ticket`, `feedback`, `account`, `collaborator`, `platform`, `org-billing`, `org-membership`, `org-program`) map the 69 events, cut by audience and opt-out switch rather than by subsystem, because a Novu workflow is one preference toggle and one digest unit. The trigger layer (`toWire` in `lib/novu/templates/families.ts`) maps an event id to its family and adds `payload.event`; no call site changed. Each family's body is one Liquid `case` over `payload.event`, composed from the per-event manifest at sync time. The redirect cannot branch — Novu's `IN_APP_REDIRECT_URL_REGEX` admits a url that starts with `{{…}}`, `http(s)://` or `/` and nothing else — so the manifest names the payload field that holds an event's destination, `toWire` copies it into `payload.href`, and every family redirects to `{{payload.href}}`; an event with no destination leaves it unset and Novu drops the redirect. This is the discriminator idiom ADR-adjacent work already used for `outcome` (#1085), `reminderStage` and `kind`, applied one level up. Four slots stay free; a family can be split back out with a map change and a sync.

3. **Bodies reference fields only through `payload.` and `subscriber.`,** and a unit test refuses a bare variable. One payload often reaches both parties, so a body names the plan and the time and names a person only where every reader is the other party.

4. **Step conditions are `!= false`, never `== true`.** The runbook in `docs/enterprise/50-operations/09-novu-console-conditions.md` asked for `subscriber.data.categoryX is true`. Novu evaluates the stored JSON Logic and runs the step when it is true; a subscriber whose flag was never written resolves to `null`, and `null == true` would have silenced them. The manifest encodes `routingBell != false` on every bell and `categoryX != false` per family, which is what the runbook meant.

5. **Staff activity is its own event** (`support-ticket-activity`, in the `support-ticket` family) with the customer's name and a verb (`replied`, `reopened`), so ops can later digest or throttle it without touching the owner's bell. Ticket events carry `reference` (`FAM-2026-000007`) as a field of its own and `status` as a sentence fragment (`in progress`), with `statusCode` keeping the enum.

## Consequences

The 48 events that never reached an inbox do so once the sync runs. The sync retires the nineteen legacy workflows first, because the cap counts live workflows and a create on a full environment fails; the onboarding demo Novu created is reported and left alone. The first apply is a production operation and is run by a person after review, never by CI; `novu:check` is the CI-side guard once the environment is in step.

Per-event analytics in the Novu activity feed now filter on `payload.event` rather than on the workflow id. The Inbox tabs are unaffected: they filter on `data.scope` and `data.organizationId`, not on workflow ids.

The `amount`/`amountFormatted` split on the four payment payloads (#536) exists only because the legacy templates printed `{{currency}} {{amount}}`; the manifest prints `amountFormatted`, and the bare `amount` can be retired when those payloads are next touched.

## What was asked and declined

The owner asked whether notifications should be decoupled behind a broker. They are already decoupled from the response body, but the two mechanisms in use are not equivalent: a bare `void` call does not survive the response on Netlify, because the instance can freeze as soon as the body is sent and the five-second SDK cap of #1446 then aborts the still-open HTTP call on thaw, which is exactly how the ops support bells were lost in #1614. Every trigger fired from a request must therefore run inside `after()`, which keeps the invocation alive until the trigger settles, and the remaining `void`-fired sites are a migration backlog rather than an accepted posture. The failure that `after()` does not cover is the instance being frozen or recycled before the deferred task completes, and a broker does not fix that either, because the produce call is lost the same way. What fixes it is the transactional outbox this repository already uses for `OutboundWebhookDelivery` and `FailedEmail`: a row in the same transaction as the business change, drained by the five-minute ticker of ADR 27, idempotent on the transaction id. If that is wanted, its table must land before the schema freeze; the drain can follow. Kafka's floor cost (about $385/month on Confluent's production tier) plus a consumer Netlify cannot host, for fewer than a thousand notifications a day, buys ordering and fan-out that nothing here requires — and Novu is already the asynchronous delivery queue behind the trigger.

## Relations

Supersedes the hand-maintained sections of `docs/notifications/03-novu-template-specs.md` and the manual steps of `docs/enterprise/50-operations/09-novu-console-conditions.md`. Closes the console halves of #1604, #1511, #1085 and #1055. Builds on ADR 23 (notification scope) and ADR 27 (state-as-outbox).
