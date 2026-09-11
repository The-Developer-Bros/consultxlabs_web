# Collaborator Scheduling Approaches

This document records the three considered approaches to collaborator scheduling visibility and control, from what is implemented today to the most involved future option. It was refreshed on 2026-08-14; the material change since the original write-up is that the current approach is no longer purely advisory on the webinar path — co-host availability is **enforced** when a webinar is scheduled (#784 AE-2), while class scheduling remains advisory because no class route calls the guard.

---

## 1. View-only, with enforced availability (current)

### What is implemented

Scheduling remains exclusively the host's action, and two things are true for collaborators:

1. **They can see the schedule.** Collaborators with `ACCEPTED` status get a read-only schedule section on each active collaboration card in the Collaborations dashboard page.
2. **They cannot be double-booked by it — on webinars.** When the host schedules a webinar, the proposed window is checked against every accepted co-host's confirmed commitments, and a clash is rejected with HTTP 409 rather than silently proceeding (`assertCollaboratorsAvailable` in `lib/collaborators/availability.ts`, called from `app/api/bookings/webinars/crud-with-plan/route.ts` — see [01-architecture.md §5](./01-architecture.md#5-scheduling-with-enforced-co-host-availability)). Class plans have no such guard: no route under `app/api/bookings/classes/` calls the function, so a class co-instructor can still be scheduled over an existing commitment. For classes, therefore, point 2 does not yet hold, and the visibility described in point 1 remains the only protection a co-instructor has.

### What collaborators see

For webinar collaborations the card shows the event status badge and tentative indicator, the date and time of the first upcoming slot, the duration from the plan's `durationInHours`, the participant count against capacity, the plan owner's name, and a "+N more events" count. For class collaborations it shows the class status badge, the scheduling period, the session count and cadence (e.g. "1h/session, 2x/week"), the participant count, and the next upcoming session.

### How it works

On the backend, `getMyCollaborations` (`lib/collaborators/service.ts`) includes each plan's nested `webinars`/`classes` with their appointments and `slotsOfAppointment`, limited to the five most recent `SCHEDULED`/`IN_PROGRESS` events, plus the plan owner via `consultantProfile.user`. On the frontend, `InvitationsPanel` and the `ScheduleSummaries` components render the expandable schedule section and handle the empty states — no events yet, an event without a time slot, a class with no sessions.

The edge cases render as follows.

| Scenario | Display |
| --- | --- |
| No webinar events exist | "No events scheduled yet" |
| Webinar exists but no appointment/slot | "Event exists but no time slot set" |
| No class instances exist | "No classes scheduled yet" |
| Class exists but no scheduling period or sessions | "Sessions not yet scheduled" |

---

## 2. View + suggest (future option)

### Concept

Collaborators view the schedule as above and can additionally **suggest** changes; the plan owner approves or rejects. This preserves host authority while giving collaborators a voice.

### Required DB changes

A new model would carry the suggestion lifecycle. Sketch (not implemented; field names indicative):

```prisma
model ScheduleSuggestion {
  id     String           @id @default(cuid())
  type   SuggestionType   // NEW_EVENT | RESCHEDULE | CANCEL
  status SuggestionStatus @default(PENDING) // PENDING | APPROVED | REJECTED

  suggestedStartsAt DateTime?
  suggestedEndsAt   DateTime?
  reason            String?

  suggestedByProfileId String
  suggestedByProfile   ConsultantProfile @relation(fields: [suggestedByProfileId], references: [id])

  // Same XOR discipline as Collaborator (#784): exactly one plan FK set.
  webinarPlanId String?
  classPlanId   String?

  respondedAt  DateTime?
  responseNote String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

### Workflow

The loop would run: collaborator opens "Suggest change" on a scheduled event → a modal captures times and a reason → the suggestion is created `PENDING` → the owner is notified (Novu) and sees it in their planner → approving applies the change (which itself passes through the AE-2 availability guard), rejecting records a note → the collaborator is notified of the outcome. Note that the schema freezes before launch (see the schema-freeze decision), so this model must be added before the freeze or wait for a post-launch migration window.

---

## 3. Full editing for senior roles (future option)

### Concept

Senior collaborators (`CO_HOST` for webinars, `CO_INSTRUCTOR` for classes) would schedule directly, without owner approval.

### Required changes

Four pieces of work would be needed: an authorization layer on the event CRUD endpoints that honors a collaborator-scheduling grant alongside owner auth (most naturally a fifth typed boolean in the #768 pattern, not a role-derived rule); a filtered Event Planner view for plans the collaborator can schedule on; concurrency control between two schedulers (the existing slot exclusion constraint plus the AE-2 guard already provide the DB-level backstop; an optimistic `version` column would improve the UX of conflicts); and an audit trail of who created or modified each event.

---

## Competitor research

The original survey of comparable platforms still stands and is retained for context.

| Platform | Scheduling model |
| --- | --- |
| Zoom | Only the meeting host schedules; co-hosts have in-meeting powers only |
| Thinkific | Course admin manages the schedule; instructors cannot |
| TopMate | Single-host model, no collaborator concept |
| Google Calendar | Shared calendars with granular read/write permissions per user |
| Calendly | Team events allow round-robin but scheduling is admin-controlled |

The industry consensus keeps scheduling as a host/admin-only action, which supports the current approach. Approach 2 is the next step if collaborator feedback shows scheduling friction; approach 3 should only be built on clear demand from power users running large multi-instructor programs.
