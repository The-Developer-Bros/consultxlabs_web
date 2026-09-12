# Collaborator ecosystem audit — DRAFT (resumable notes)

Status: exploration in progress. Findings accumulate below; final issue body assembled at the end.

## Raw findings so far

### Schema / service
- `prisma/schema.prisma:6392` model Collaborator; XOR app-enforced (`lib/collaborators/service.ts:34`); unique (consultantProfileId, webinarPlanId) / (consultantProfileId, classPlanId).
- Host share min 10%: `lib/collaborators/service.ts:24` MIN_HOST_SHARE=10, MAX_COLLAB_BPS=9000 (:30). validateRevenueSharesTx (:869) counts PENDING+ACCEPTED. calculateRevenueSplit (:892) only ACCEPTED; refuses >10000.
- No cap on the number of collaborators anywhere (invite route or service). Only the 90% share cap limits it indirectly (share must be >0 → minimum 1% = 100 bps → up to 90 collaborators possible).
- Permissions: `service.ts:75-80` TODO #1319 — only canSeeAttendees enforced; canApprovePayment/canViewAnalytics/canEditEvent SET but never read.
- PATCH `[id]/route.ts:38-40` passes raw body into updateCollaborator without Zod; permissions cannot be updated after invite (updateCollaborator only takes revenueSharePercentage/role).
- `[id]/route.ts:31` `plan?.consultantProfileId !== ownerProfile?.id` — undefined === undefined passes when both missing (service catches via planWhere, so not exploitable, but sloppy).
- respond route: `respondToInvitation` on ACCEPT creates `collab-<planType>-<planId>` channel.
- removeCollaborator: soft-delete; revokes Stream. Does NOT touch earnings.
- AE-2 availability: enforced on webinars (`app/api/bookings/webinars/crud-with-plan/route.ts:853`) AND classes (`app/api/bookings/classes/crud-with-plan/route.ts:287,859`, `utils/slotAllocation/SlotAllocationService.ts:578`) — docs say webinars only → drift.
- `/api/collaborators/[consultantProfileId]/availability` — no UI caller found (grep). Auth direction inverted: caller must be an ACCEPTED collaborator on a plan owned by the target → co-host can see host's calendar, host cannot see co-host's (the stated purpose in the route comment :8-10).

## TODO sections
- reviews, feedback, support, moderation, stream, notifications, dashboards/explore, permissions, lifecycle, B2B, counts, web research

### Cross-cutting findings (batch 2)
- P0 pool deadlock: `lib/payments/payouts/earnings-service.ts:538` opens `prisma.$transaction(async (tx)…)`; `:618` calls `calculateRevenueSplit()` which reads via the GLOBAL client (`lib/collaborators/service.ts:897` getCollaborators → `:522 prisma.collaborator.findMany`; `:933/:940 prisma.webinarPlan/classPlan.findUnique`). Same shape as #1435 (PG_POOL_MAX=1). Fires for EVERY webinar/class settlement (the findMany runs even with zero collaborators). Also `:627+` per-collab resolveOrgSplit — check whether tx is passed.
- Reviews: `lib/reviews.ts:706-714` describe() picks ONLY plan owner; `app/api/user/reviews/route.ts:163/279` writes `reviewable.consultantProfileId`. Co-host unreviewable; ratingUnitId `webinar:<id>` feeds host GROUP score only. Profile/explore card for co-host-only consultant: no reviews, no plans (consultant-detail.ts:104-105 `webinarPlans: true, classPlans: true` owner-only).
- Feedback: `lib/data/appointment-detail.ts:58-62,222-227` includes ACCEPTED collaborators as consultantUserIds → `appointmentRaterRole` returns PROVIDER for a co-host (good: sees scores only, never rates). Org rollup `app/api/organizations/[orgId]/feedback-summary/route.ts:92,123` groups by `slotOfAppointment.consultantProfileId` (denormalised OWNER) → co-host invisible; all feedback attributed to host.
- Support: `lib/api/appointment-access.ts:67` canAccessAppointment includes collaborators → co-host CAN open the support thread. But `lib/support/context.ts:126-133` isProvider = plan owner only → co-host gets ATTENDEE flows (`lib/support/flows.ts:29` NO_SHOW attendee: "The expert never showed up" → escalate provider_no_show; `OFFER_RESCHEDULE`). No SupportCase org attribution for collaborator's org (AppointmentSupportThread has no consultant column — verify).
- Moderation: `lib/moderation/cancel-user-engagements.ts:207-223` host ban cancels their future webinar/class events (collab earnings reversed via refundEarnings — ok). Collaborator ban: earnings HELD (`side-effects.ts:163-176`) but Collaborator row stays ACCEPTED — still in Stream channels, still a call member, still in split. grep "collaborat" lib/moderation → not found.
- Stream: `actions/stream/meetings/meeting.action.ts:327` CALL_MEMBER_ROLE="call_member" for all; `:953` consultantUserId = hostUserIds[0] (= plan owner, resolvePlanOwnerIds order `lib/booking/plan-owners.ts`); `app/meetings/[id]/session-info.ts:70` isHost = plan owner only → `MeetingRoom.tsx:339,426,441` + `EndCallButton.tsx:131`: co-host cannot record / end call. If owner absent, nobody can. docs 05 says calls are client-side (stale: server-side `:1165 created_by_id`). Recording access `app/api/stream/recordings/[recordingId]/route.ts:92-113`: any ACCEPTED collaborator regardless of canSeeAttendees — fine but undocumented. Event chat channels: collaborators added? (check event-channel.action).
- Notifications: only 3 workflows (`lib/novu/workflows.ts:90-92`); no DECLINED notice to host; no booking notification to co-hosts; reminders (`scripts/appointments/send-appointment-reminders.ts:182-185`) webinar/class → slot participants only (neither host nor collaborators).
- Dashboards/explore: consultant appointments list includes collaborations (`lib/data/consultant-appointments.ts:152,170`; `map-consultant.ts:149-163` collaboratorRole). Public plan page lists ACCEPTED collaborators (`lib/data/plan-details.ts:73,154`; WebinarDetails.tsx:256-265 links to /explore/experts/<id>). Explore listing: `lib/explore/programs.ts:82,92` type has collaborators but `lib/data/explore-programs.ts` never loads them → ProgramCard.tsx:98-112 logo-merge is dead. Expert page: owner-only plans.
- Timings page: `lib/data/manage-timings-target.ts:31,121` treats collaborators as owners (read) but PUT `app/api/bookings/webinars/crud-with-plan/route.ts:524-531` is owner-only → dead-end page for co-hosts.
- Availability route `/api/collaborators/[id]/availability`: no UI callers; auth inverted.
- ADR 18 (docs/enterprise/70-design-decisions/18-open-b2b-b2c-boundary.md:19,33): collaborations org-blind by decision; revisit trigger = incident.
