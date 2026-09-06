---
title: An offering is described by structured content, not one free-text blob
band: 70-design-decisions
audience: sde2
status: live
last-reviewed: 2026-07-31
---

# ADR 24 — The offering content model

## Context

The platform sells four things: a one-off consultation, a recurring subscription, a single-sitting webinar, and a multi-week class. Competitors selling the same multi-month mentorship — Preplaced and Propeers are the two we were measured against — describe it in structured pieces: a week-by-week roadmap with a title and a description per week, an explicit statement of who the programme is for, a list of what the price actually buys, and an FAQ that answers the questions that otherwise stall a purchase. Our plans carried a title, a long description, a flat array of learning outcomes, and a pair of free-text prerequisite and materials fields.

A review of the four models found that the roadmap was already half-built and largely invisible. `ClassContent` and `SubscriptionContent` had existed for some time, each carrying a title, a description, an ordinal, an hours allocation and an optional content type and URL. Both were authored in the planner, under the headings "Class Curriculum" and "Session Roadmap". `ClassContent` was rendered on the class detail page, and `SubscriptionContent` was rendered in the subscription pricing toggle as a week-by-week timeline. What was missing was not the table but three things around it: a label for each week, so a consultant could say "Week 1" or "Sprint 2" or group two sessions under one heading; any of the surrounding positioning content; and parity, because the two one-off types had no structured content at all and the two 1:1 types had neither a cover image nor an archive column.

Two further findings shaped the decision. The first is that a large part of the perceived thinness was a seed problem rather than a product problem. Every topic name was `faker.lorem.words(3)`, webinar and class descriptions were lorem paragraphs, every class curriculum module was lorem, and `subscriptionContents` was never seeded at all — so the week-by-week outline the profile page already rendered was permanently empty in every local database. The second is that `level` was a free-text `String` on all four models with no validation, so "Beginner", "Begineer" and "Anyone" could all coexist and the explore level facet could never reliably match.

## Decision

**An offering is described by structured, separately-addressable content, and every plan type carries the same shape.**

Four fields land on all four plan models. `subtitle` is the one-line pitch that appears on cards and in search results, distinct from `description`, which is long-form and reads badly when clamped. `targetAudience` and `whatsIncluded` are string arrays holding the "who this is for" and "what the price buys" bullets. `slug` is reserved for SEO-friendly URLs and is nullable, because the routing that would use it is deliberately not part of this change.

A new `PlanFaq` model holds the question-and-answer pairs. It is polymorphic across the four plan types, using the same four-nullable-foreign-keys shape that `PlanMaterial` has used for attachments since before this change, because an FAQ is the same kind of thing as an attachment: an ordered child list that belongs to exactly one plan of an unknown type.

**The two curriculum tables stay separate.** Collapsing `ClassContent` and `SubscriptionContent` into one polymorphic model was considered and rejected. The two are near-identical today, and a polymorphic table would have removed a duplicated shape and incidentally allowed a webinar to carry an agenda. Against that, they describe genuinely different things — a class module is a unit of syllabus delivered to a cohort, a subscription session is one appointment in a 1:1 engagement — and they are free to diverge as the two products do. Both gain the same two new columns, `sectionLabel` and `outcomes`, and the authoring payload for both is one shared type, so the duplication is confined to the table definitions rather than spreading through the code that reads and writes them.

**`sectionLabel` is free text, not a week number.** An integer would have been tighter, and it was rejected because consultants do not consistently think in weeks: the same field has to hold "Week 1", "Week 1-2", "Module 3", "Sprint 1" and "Phase 2". Ordering still comes from `order`; the label is presentation. Items that share a label render under one heading, which is what allows two sessions to sit inside one week. Grouping only merges _adjacent_ items, so a label repeated later in the list starts a new group rather than pulling a later session backwards and silently reordering the roadmap.

**`level` becomes the `PlanLevel` enum** — `BEGINNER`, `INTERMEDIATE`, `ADVANCED`, `ALL_LEVELS` — and every surface that displays it reads its copy from `lib/labels/plan-labels.ts` rather than printing the enum member. The facet on `/explore/programs` still reads the distinct values from the database rather than listing the enum, so it only offers levels some plan actually has, and it sorts them in teaching order because alphabetical sorting renders Advanced, All levels, Beginner, Intermediate.

**All four plan types get a detail page, and the pricing toggle becomes a chooser.** Webinars and classes already had one; consultations and subscriptions did not, so the two 1:1 products — including the highest-ticket one — had no indexable, shareable or linkable surface at all, and the public organisation page sent an org buyer from a card straight into checkout with nothing to read.

An earlier draft of this decision kept subscription detail in a modal and consultations inline, on the reasoning that a modal is cheaper and that thin consultation pages carry an SEO cost. The modal argument does not survive contact with how these products are actually sold: a modal has no URL, so it cannot be indexed, cannot be shared into a DM, and cannot be the link an organisation circulates internally while it decides. For a multi-month engagement that is the whole acquisition path. Parity across all four also removes a second mental model, where a buyer arriving from the programmes list gets a page and a buyer arriving from an expert profile gets a modal.

The thin-page risk on consultations is real and is accepted rather than dismissed: three duration tiers across many consultants produces many similar short pages. The lever, if organic quality ever suffers, is to mark consultation plans with no authored positioning content `noindex` — cheap to add now that `subtitle`, `targetAudience`, `whatsIncluded` and `PlanFaq` exist to test against.

The consequence for the sidebar is the useful part. The pricing toggle was trying to be a chooser _and_ a brochure, which is what forced a twelve-week roadmap into a 450-pixel column and then into a modal. It is now purely a chooser: tier, price, cadence, a few inclusions, and two buttons — "Open details" to the page and a booking CTA. The roadmap modal is deleted rather than kept, because two renderers of the same content drift.

**A detail page is gated like a list surface.** All four pages fetch by primary key, which is a different reachability model from the lists, and they previously filtered on nothing: an `ORG_ONLY` plan was fully readable by anyone holding its identifier, and an archived plan still rendered a working page with a live booking button. `isPlanViewable` now gates all four — not archived, and either publicly visible or the viewer is an ACTIVE member of the owning organisation. Being the authoring consultant is deliberately not sufficient, because the planner is already the consultant's own org-internal read path.

## Consequences

The schema freeze holds: every column the content model needs is present, including the ones whose user interface is deferred. `slug` exists with no routing behind it, and that is deliberate — adding the column later would have reopened the freeze.

`callsPerWeek` and `meetingsPerWeek` are unified as `sessionsPerWeek`, closing the naming decision that issue #1011 flagged as blocking the freeze. The allocation engine already used one internal name for both, so the rename removed a translation layer rather than adding one.

`marketplaceVisibilityWhere()` and `eventPlanDiscoverableWhere()` no longer differ by plan type. The narrower helper existed only because `ConsultationPlan` and `SubscriptionPlan` had no `archivedAt` column for Prisma to filter on; both now do, so the discoverable filter is correct for all four and is the one public surfaces should use.

A sole-owner consultant can now archive and restore their own offering directly. Before this, `archivedAt` was only ever written by the org-catalog bulk archive endpoint, so a consultant with no organization behind their plan — the majority of consultants on the platform — had no way to stop selling a consultation, subscription, webinar or class they no longer wanted to offer. Each of the four plan-family routes now accepts a `PATCH { archived: boolean }` request, gated by the same ownership check the family's other write routes already use, and the four routes share one helper in `lib/api/plans/archive.ts` so the idempotent set-once-and-clear semantics cannot drift between them. Archiving only stops new bookings: `archivedAt` already excludes the plan from discovery and checkout, and this change does nothing to the appointments or payments that already reference it. These four routes are the sole-owner door only: a plan carrying an `organizationId` is refused with a `PLAN_ORG_GOVERNED` 403 that points the consultant at their organisation admin, because an org-governed offering is withdrawn through the org catalog endpoint, which checks organisation membership and role before it writes.

`OrgPlanVisibility.ORG_ONLY` is no longer write-only. It was possible to author a plan, narrow it to members, and have it become invisible to everyone including the members it was authored for, because the marketplace filter correctly hid it from `/explore/**` and no other surface ever showed it. The member-facing catalog panel on `my-program` is that surface. Per [ADR 19](19-personal-vs-org-dashboard-split.md) it is a panel on an existing destination rather than a new navigation entry, because it is a scope variant of something the learner already has rather than a distinct place to go.

The seed suite now produces real copy for every plan type, seeds the subscription roadmap that was previously always empty, and creates org-owned plans across all three visibility values plus one archived plan — so the catalog, archive and leak-guard paths shipped by #1050 and #1053 have rows to exercise for the first time.
