---
title: An organization sees that a session happened, not what happened in it
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-08-30
---

# ADR 20 — Organizations see session metadata, never session content

## Context

An organization pays for its members' sessions, and its dashboard shows those sessions. Nobody had ever written down where that visibility stops. A July 2026 audit of the organization dashboard went looking for the rule and found that no document in the repository stated one, in any band. What the product actually did was therefore an accident of implementation rather than a decision anyone had made.

The accident happened to be mostly right. `listAppointmentsScoped` selects the plan title, both parties' names and emails, the slot times and a completion status, and it selects nothing else. The consultation's `requestNotes`, the free-text field where a member describes what they want to discuss, is never read by an organization surface. Neither are `feedbackFromConsultee`, `feedbackFromConsultant`, `cancellationNotes`, or the plan's long `description`. Only `title` crosses over. That is a defensible line, but it held only because no one had yet added a field to a select statement.

Where the same audit looked at the two sibling surfaces, the accident had already gone the other way. The organization's recordings and documents pages are gated on `operations.read`, the same grant that opens the org-wide appointments feed, and that grant resolves to OWNER, MAINTAINER, MANAGER and SUPPORT. Both list helpers were written with Prisma's `include`, which on a root model returns every scalar column. The tables themselves render only metadata — a recording's status, duration and date; a document's filename and review state — so the exposure was invisible in the product and plain in the network response, which carried `Recording.recordingUrl` and `AppointmentDocument.fileUrl`, `storagePath` and `description`. The schema's own comment on that last column lists its expected contents as "resume, ITR, legal document"; an ITR is an income-tax return. A SUPPORT-role member at a sponsoring employer could retrieve any of it for any colleague.

The forces in play are these. The organization is paying, and its invoices already itemize by member, so a per-session roster tells the organization nothing its accounts-payable team cannot already read; withholding it there while printing it on the invoice would be incoherent rather than protective. Against that, this is a professional-mentoring marketplace whose sessions include career coaching, and a member who believes their employer can watch the recording will use the product differently, or not at all. Those two forces point in opposite directions only if visibility is treated as a single switch, which is what the absence of a written rule had allowed.

## Decision

**An organization may see that a session happened. It may not see what happened in it.**

The metadata half is the organization's own operational record: which member, which counterpart, which named plan, when, what status, and what it cost. That is spend management, and every role that holds `operations.read` — OWNER, MAINTAINER, MANAGER and SUPPORT — gets it. The `Mine | Everyone` control on the appointments page is the interface to it, and it renders only for those roles, so the page never offers a scope it would then refuse.

The content half belongs to the two people who were in the session, and there is no organization role that reaches it. Concretely, that means the session's intake notes, either party's feedback, the rating, the cancellation reason and the plan's long description are never selected into an organization query; the recording and its Supabase mirror, thumbnail, preview clip and Stream identifiers are returned only to participants; and an uploaded document's URL, storage path and the uploader's description of it are likewise participant-only. Chat is content under this rule, which is why the organization dashboard mounts `StreamProvider` with `enableChat={false}` and the `/stream/channels` compliance export fetches channel metadata with `message_limit: 0` and writes an audit row when an operator pulls it.

The rule is enforced by explicit select allowlists in `lib/api/scope/list-recordings.ts` and `lib/api/scope/list-documents.ts`, following the `#946` pattern. Each helper defines a metadata select and a participant select, and chooses between them on the scope kind: `personal` and `orgMember` are the two arms whose `where` clause constrains the caller to be a participant on the appointment, and only those receive content. The `org` arm applies no user filter at all — it returns every row under the organization — and the `all` arm is the admin and staff union. Both read other people's sessions, and both stop at metadata. The result type carries the rule to consumers: content fields are optional, so a caller that wants a file URL has to handle its absence rather than assume it.

Two consequences of the boundary are accepted rather than solved. A plan's `title` is free text written by the consultant, and a title can be as revealing as a note; it crosses to the organization because a session roster without a session name is not usable, and because titles on this platform are marketing copy on a public marketplace listing rather than a private record. And the back-office `all` arm stops at metadata too, even though platform staff are not the member's employer. Its only consumer is the shared documents page, which states on itself that reviewing is the consultant's call and that it exists so support can explain an outcome; it renders no file link. Giving the back office the file is a decision someone should make deliberately, against a stated support need, rather than inherit from an `include`.

## Alternatives considered

Letting an organization owner open session content with an audit row was rejected as a policy that reads better than it works. The audit trail deters casual browsing, but it does not change what the member has to assume about who can watch their coaching session, and the deterrent only functions if someone reads the log. Where a genuine dispute needs evidence, the participants and the platform both hold it, and a support ticket is the path.

Making content visibility a per-session opt-in by the delivering consultant was rejected on timing rather than merit. It is the most flexible answer, and it fits the case where an organization-wide training webinar has no privacy expectation at all while a one-to-one does. It needs a new column, and the schema freezes before launch, so shipping it would mean adding a field for a workflow nobody has yet asked for.

Narrowing the metadata view — dropping SUPPORT from `operations.read`, or reducing the organization to aggregate utilization with no per-session rows — was rejected because it removes the ability to act without removing the ability to know. SUPPORT exists to triage, and triage without seeing the session is escalation. Aggregate-only reporting contradicts the invoice, which names the member on every line.

## Consequences

The organization dashboard is now honest about what it is: a spend and utilization surface over sessions the organization funded, not a window into them. The line is stated once and enforced in one place per model, so adding a column to a list helper cannot quietly move it — the `org` arm has to be edited deliberately, and `__tests__/security/org-scope-payload-allowlist.test.ts` fails if a content field is added to a metadata select or if either helper reverts to `include`.

What we pay is that an organization investigating a complaint cannot self-serve the evidence, and will open a support ticket instead. That is the intended trade. Revisit this decision if a customer with a regulated training obligation needs attested proof of attendance content, in which case the consultant opt-in above is the design to reach for, and the schema field it needs should be added before the freeze rather than after.

## Addendum (2026-08-14)

A consequence of this decision that keeps getting re-reported as a bug deserves stating plainly: the rows in the org "Everyone" appointments table deliberately do not link anywhere. There is no per-session detail page an organization role is permitted to open — such a page would exist only to show content this ADR withholds — so the table is metadata-only **by design**, and the missing row link is intent, not an unfinished feature. The 2026-08-13 booking audit (#1169) flagged the absence and this addendum records the resolution: do not add a drill-in without revisiting this ADR itself.

## Addendum (2026-08-21) — #support-hub: support conversations are content

The support subsystem (#appt-support / #support-hub) lands inside this decision's boundary, and the org-facing triage surface states the rule rather than inheriting it by accident. A member's support conversation about their own session is **content**: it contains their complaints, and a member who believes their employer can read "the expert was unprepared" will raise fewer of them. So:

- The org triage page and its endpoint (`GET /api/organizations/[orgId]/support-threads`, gated `operations.read`) select an explicit metadata allowlist — status, category, channel, timestamps, the member's name, the plan title — and **no messages, no bodies, no last-message preview**. `__tests__/security/org-scope-payload-allowlist.test.ts` pins the select; adding a content field to it fails the suite.
- The org's CSAT visibility is the aggregate card (`/feedback-summary`: average + count) — individual ratings and comments never reach an organization surface, consistent with "either party's feedback, the rating" being content.
- What the org DOES get is a party role, not a spectator role: an operator holding `operations.read` may open **their own** conversation on one of their org's appointments (`ORG_ADMIN_DISPUTE` / `SPONSORSHIP_BILLING` intents only, enforced in the thread route's authorize branch and clamped again in the support service). The org can raise a concern; it still cannot read anyone else's.
- Platform staff are the exception by function, not by grant: once a thread escalates to the HUMAN channel, staff must read the transcript to respond — the same deliberate line as the back-office documents page, stated here so it is a decision rather than an `include`. The back-office Conversations inbox reads transcripts for exactly this reason and no other.

## Addendum (2026-08-30) — #1270: the Stream call export was the missed arm

The July 2026 audit fixed the two list helpers and left a third surface carrying the same leak. `GET /api/organizations/[orgId]/stream/calls` is the org-scoped Stream call log, gated MANAGER+, and when called with `?withRecordings=1` it selected `Recording.recordingUrl` and `Recording.supabaseUrl` and returned both verbatim. The first of those is Stream's pre-signed S3 link: fourteen days of validity, its own credentials embedded, no session required to fetch it. Anybody who ended up holding the string could watch the session, which means forwarding the JSON forwarded the video — to a colleague, into a BI tool, or out of the company entirely. Like the two surfaces before it, nothing in the product rendered the field, so the exposure was invisible in the UI and plain in the network tab.

The route now uses an explicit select allowlist with the same shape as `recordingMetadataSelect`, naming no field that reaches or resolves to the media. It keeps the retention facts the compliance pull exists for — status, storage type, duration, and the Stream URL expiry that drives the transfer window.

It deliberately does **not** gain a short-lived signed-URL arm, even behind a separate opt-in parameter and even though every call already writes a `STREAM_CALLS_EXPORTED` audit row. That is the alternative this decision considered and rejected above, and the reasoning has not changed: the trail deters casual browsing but does not alter what a member has to assume about who can watch their session, and it only functions if somebody reads the log. An organization that needs evidence still opens a support ticket.

`__tests__/stream/recording-operator-access.test.ts` pins the route's select alongside the platform-operator rules from the same issue.
