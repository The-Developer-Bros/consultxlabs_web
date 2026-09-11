---
title: Slots and sessions — the canonical glossary
band: 00-foundations
audience: sde3
status: live
last-reviewed: 2026-07-31
---

# Slots and sessions — the canonical glossary

Eight distinct concepts hide behind the words "slot" and "session" in this
codebase, and the June 2026 domain audit confirmed that the blur has caused
real bugs and real review confusion. This glossary fixes one true name per
concept. The convention going forward: the chain is **availability window →
bookable slot → booked slot → appointment → engagement → meeting**, with
trials and auth sessions as separate things. The bare word "session" names no
concept in that chain — see "The colloquial traps" for the one place the
`session*` prefix is deliberate.

## The eight concepts

**Availability window.** The hours a consultant offers, never booked
directly. Implemented by `SlotOfAvailabilityWeekly` (recurring, with a frozen
`utcOffsetMinutes` — the #503 DST fragility lives here) and
`SlotOfAvailabilityCustom` (one-off). Consultants create and edit these; the
slot computation pipeline only reads them.

**Bookable slot** (transient). A computed, plan-duration-sized cut of
availability shown in the picker. It exists only between the availability
fetch and the checkout submit, implemented by the `ProcessedSlot`/`TimeSlot`
shapes in `utils/timeSlotsProcessing.ts` and `TSlotTiming` in
`types/slots.ts`. It carries the `slotOfAvailabilityId` binding that the
#788 merge guard protects.

**Booked slot.** One concrete reserved time instance inside an appointment —
the atomic scheduling unit. Implemented by `SlotOfAppointment`:
`isTentative` flips false at webhook confirmation, `completionStatus` walks
SCHEDULED → COMPLETED/UNVERIFIED/CANCELLED/RESCHEDULED, and the m:n `user` relation
links booker and consultant (load-bearing for the #827 double-booking
guard — never treat it as dead code).

**Appointment.** The polymorphic wrapper grouping one or more booked slots
under exactly one of consultation, subscription, webinar, class, or trial.
Tentative-created at checkout, confirmed by the payment webhook,
auto-completed by cron.

**Engagement.** The enterprise consumption unit: one appointment booked
under an org program, metered by `engagementsUsed` on the program
assignment. This is the billing meter — when enterprise code says
"engagement," it means money. Consumption is currently hardcoded to one per
booking regardless of session count (#710).

**Meeting.** The Stream.io video call record for one booked slot
(`MeetingSession`, created lazily at "Start Call," not at confirmation). A
confirmed slot without a meeting is a valid state.

**Trial.** A trial booking (`TrialSession`), optionally org-attributed
via `organizationId` — pure attribution for conversion analytics. The org
attribution itself carries no referral or money logic; a paid trial
charges the consultee directly, never the org.

**Auth session.** BetterAuth's `Session` model. Nothing to do with
scheduling; never rename anything else to "Session."

## The colloquial traps

The plan fields `sessionDurationInHours`, `totalSessions` and `sessionsPerWeek`
mean *meeting occurrences per plan* — they are appointment-adjacent counts, not
video calls and not auth sessions. The first two predate this glossary and are
kept under the schema freeze; `sessionsPerWeek` joined them via ADR 24, which
unified `SubscriptionPlan.callsPerWeek` and `ClassPlan.meetingsPerWeek` under one
name (#1011). This document is their disambiguation.

So "session" is barred as a *concept or model name* — there is no `Session` in
the scheduling chain, and nothing else may be renamed to it — while the
`session*` prefix on these plan-side counts is deliberate and settled. User-facing
copy should say "session" for one occurrence of a recurring plan, never "call"
(which means the Stream video record) or "meeting".

"Enterprise referrals" is not a feature. The phrase has been used loosely
for three unrelated real things: trial attribution
(`TrialSession.organizationId`), the deliberate rule that personal referral
credits are force-disabled on org-funded bookings (`fundingSource !==
"PERSONAL"`), and B2C consultant qualification events. The June 2026
decision: retire the phrase; org-level acquisition incentives, if ever
wanted, are a new post-launch-schema subsystem.
