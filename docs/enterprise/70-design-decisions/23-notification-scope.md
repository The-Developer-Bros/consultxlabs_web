---
title: A notification inherits the org-ness of the record that triggered it
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-07-30
---

# ADR 23 — Notifications are scoped, routed and mutable per context

## Context

[ADR 19](19-personal-vs-org-dashboard-split.md) split the dashboards by the org-ness of the underlying session, plan or payment, and every read path learned the rule: the scoped list helpers, the chat channel query, the appointment feeds and the money views all filter on `organizationId`. The notification layer learned none of it. A July 2026 audit of the Novu stack found the split invisible from end to end.

There is one Novu subscriber per user, keyed on `User.id`, and never one per profile or per organization. No topics are used and no tags are set. Of the roughly forty payload types, not one carried an `organizationId` — the single occurrence of that identifier anywhere under `lib/novu/` was a Prisma `where` clause inside a roster resolver. The organization-lifecycle payloads carried an `orgName` string, but that is display copy rather than anything a client can filter on, and the payloads that fire in *both* contexts — appointments, bookings, payments, recordings — carried no discriminator at all. The `Inbox` component rendered with no `tabs` and no `filter`.

The result was that a consultant who also delivers for an organization received one merged feed, rendered identically on every dashboard they could open, in which an organization-hosted booking was byte-for-byte indistinguishable from a business-to-consumer one. Three further problems followed from the same root. Deep links pointed at the wrong tree: the booking-request notification hardcoded the personal Requests page even when the plan was organization-hosted, where the personal scope pins `organizationId: null` and the request is therefore filtered out of the list the user was just sent to. Deterministic transaction ids, derived by hashing the workflow and the canonical payload, collided across contexts whenever two structurally identical events occurred — with no organization field and an optional `appointmentId`, Novu deduplicated the second one away silently. And the seven notification categories a user could configure were all business-to-consumer in shape, so the entire `ORG_*` workflow family was unmutable: an organization owner could not turn off invoice dunning.

A separate, smaller finding sat alongside these. `OrgWorkspaceProfile.notificationRoutingMode` was written by a settings panel, read back into that panel, and consumed by nothing. Its own component docstring asserted that the dispatchers in `lib/novu/org-workflows.ts` read it; they never did. An operator who selected "email only" continued to receive bell notifications and was told the preference had saved.

## Decision

**A notification inherits the org-ness of the record that triggered it, and is delivered and deep-linked into the dashboard that owns that record.**

Every payload describing work that can happen in either context composes a `NotificationScope`, carrying `organizationId`, a derived `scope` of `personal` or `org`, and an optional `orgName` for display. The fields are required rather than optional, so a trigger site that forgets to attribute its notification fails the build instead of quietly emitting another unattributable one; adding the type flushed out thirteen call sites, which is a fair measure of how far the drift had spread. `scope` is derivable from `organizationId` and is stored anyway, because Novu's `Inbox` filters tabs by payload equality and "this field is null" cannot be expressed that way. Both are produced by one helper so they cannot disagree.

Attribution is not delivery. The scope tag changes how a notification is filed and where it points; it does not widen who receives it, and the recipient lists are untouched by this decision.

**Deep links resolve to the owning tree, with one constraint that shapes the answer.** Several workflows trigger once for many recipients with a single payload, so one href has to be correct for all of them. For organization-hosted work the organization route satisfies that: the learner who attended and the expert who delivered both reach the same page. For business-to-consumer work the link stays a bare `/dashboard`, deliberately rather than by omission — the consultant and the consultee have different personal dashboards, and the capability router already resolves the right one per viewer. The old bare `/dashboard` was not wrong in itself; it was wrong because it was also used for organization work. Where a trigger has exactly one recipient whose side is known, a precise route is used instead.

**Preferences gain three organization categories** — billing, membership and programs — rather than one blanket switch, because the audiences genuinely differ: an operator wants invoices but not every roster change, while an expert wants delivery notices and no invoices at all. They are per user rather than per organization, matching the one-subscriber-per-user model, and they surface on a Notifications tab in the organization Settings page as well as on the personal dashboards.

That tab exposed a second instance of the gate-and-page disagreement ADR 19 records. The Settings *page* has always floored at active membership, since its tabs answer to different grants and gating the page on any one of them would lock out a role holding another. The Settings *sidebar entry* demanded an operator grant, so a learner or expert could reach Settings only by typing the URL. The nav entry is now ungated to match the page, and `UrlTabs` shows each role only the tabs it holds.

The console side of this — the workflow conditions that actually read the flags — is written up as a step-by-step runbook at [50-operations/09-novu-console-conditions](../50-operations/09-novu-console-conditions.md), so it is mechanical rather than reverse-engineered from the code.

**`notificationRoutingMode` is honoured rather than deleted.** It is pushed onto the subscriber record as `data.routingMode` alongside boolean channel flags, and the Novu workflow conditions gate their channel steps on those — the same mechanism the category preferences already used. Deleting the field was the alternative, and was rejected because the control has been shown to operators and removing it would take away a choice they believe they have made.

**The organization trees sync their subscriber.** The personal dashboards called `useNovuSubscriberSync` and the organization ones did not, so a user onboarded straight into an organization by invitation was never posted to `/api/novu/subscriber`. Their subscriber record stayed bare and any template interpolating a first name or an email degraded. Both organization trees now sync, which is also what makes the routing preference take effect, since that is where it is set.

## Consequences

The transaction-id collisions resolve as a side effect rather than needing their own fix: once the payload carries an organization field, two structurally identical events in different contexts hash differently and both arrive.

The `ORG_*` workflows do not carry a `NotificationScope`. They are already unambiguous — every one of them is organization-lifecycle by construction and names its organization in the payload — and adding a redundant discriminator to a family that cannot be anything else would be noise. The Inbox tab for an organization filters on `organizationId`, which those payloads would need if they were ever to appear under it; that is a real limitation and the right time to address it is when an organization-lifecycle notification needs to be filed under its organization's tab rather than under All.

ADR 20's boundary is unchanged and now has a test. The notification payload surface sat entirely outside the allowlist suite that pins the list helpers, even though `RecordingPayload.recordingUrl` puts a live media URL in a notification body. Nothing leaked, because the recipient list came from a participant resolver rather than a roster — but that is the "accident of implementation" ADR 20 exists to stop, and a future change widening that list would have leaked the URL with no test failing. `__tests__/security/novu-payload-allowlist.test.ts` now pins both halves: content-bearing payloads reach only participant-derived recipients, and the organization-roster dispatchers carry no content field.

What this decision does not do is give an organization its own inbox. There is still one subscriber per human and one feed, now filterable. A per-organization subscriber, or Novu topics keyed by organization, would let an operator hand off notification duty without handing over an account; that is a larger change and nothing has yet asked for it.
