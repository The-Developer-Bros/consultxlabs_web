# Collaborator Permissions

## Overview

Collaborator permissions are four **typed boolean columns** on the `Collaborator` model, set by the host at invite time and defaulting to `false` so an unspecified permission is never silently granted (#768 lockdown #12). The earlier design — role-based defaults with an optional `permissions` JSON override and a `lib/collaborators/permissions.ts` checking module — no longer exists; the JSON column was replaced by the booleans and there is no permissions module. This page was rewritten on 2026-08-14 to describe what is actually enforced.

The columns live at `prisma/schema.prisma:5133-5136`:

```prisma
canApprovePayment   Boolean @default(false)
canViewAnalytics    Boolean @default(false)
canEditEvent        Boolean @default(false)
canSeeAttendees     Boolean @default(false)
```

---

## What each flag means, and what is enforced today

The intent of each flag and its current enforcement status are as follows.

| Flag | Intended capability | Enforced today? |
| --- | --- | --- |
| `canSeeAttendees` | View the participant roster of the plan's events | **Yes** — the participant-roster GETs |
| `canApprovePayment` | Approve payment-gated requests on the plan | No — stored only, pending #768 |
| `canViewAnalytics` | View the plan's analytics and stats | No — stored only, pending #768 |
| `canEditEvent` | Edit event details | No — stored only, pending #768 |

The three unenforced flags are **write-only**: the invite and update APIs persist them, and the UI can display them, but no endpoint reads them yet because the collaborator-facing payment-approval, analytics, and event-edit surfaces do not exist. The gate lands together with each surface under #768. Treat any claim that they restrict anything today as false — and conversely, do not build a new collaborator-facing surface for one of these areas without wiring its boolean.

---

## The enforced surface: participant rosters

`GET /api/participants/webinar/[webinarId]` and `GET /api/participants/class/[classId]` return the event's roster. For non-privileged callers the query itself constrains visibility: the event must belong to a plan the caller **owns**, or a plan on which the caller is an **`ACCEPTED` collaborator with `canSeeAttendees: true`**. Everyone else receives 404 — the event's existence is not confirmed to callers with no right to its roster.

```typescript
// app/api/participants/webinar/[webinarId]/route.ts
webinarPlan: {
  OR: [
    { consultantProfileId: session.user.consultantProfileId ?? "__none__" },
    {
      collaborators: {
        some: {
          consultantProfileId: session.user.consultantProfileId ?? "__none__",
          status: "ACCEPTED",
          canSeeAttendees: true,
        },
      },
    },
  ],
}
```

Admin and staff (`isPrivileged`) bypass the ownership filter.

---

## How permissions are granted

The host passes the booleans in the invite body (`POST /api/collaborations/{planType}/[planId]`), and `normalizePermissions()` in `lib/collaborators/service.ts` coalesces every omitted flag to `false` before the row is written. Re-activating a `REMOVED`/`DECLINED` collaboration through a fresh invite **overwrites** the flags with the new invite's values — a re-invited collaborator does not inherit their old grants.

There is no role-derived default: a `CO_HOST` and a `TECHNICAL_SUPPORT` collaborator both start with all four flags false unless the host grants them. The role (`CollaboratorRole`) is descriptive for the deal and drives the revenue-split labels; it does not imply permissions.

---

## What needs no flag

Some capabilities attach to the `ACCEPTED` status itself rather than to any permission column. An accepted collaborator can always:

- Appear in the plan's collaborator list visible to the owner and other accepted collaborators.
- See the other `ACCEPTED` collaborators (`getCollaboratorsForUser` scoping).
- Use the plan's private Stream coordination channel.
- View co-host availability of consultants they share an accepted collaboration with (`GET /api/collaborators/[consultantProfileId]/availability`).
- View the plan's revenue-split preview (`GET .../revenue-split`).
- Receive their earnings share at settlement.

Scheduling is deliberately **not** a permission: no flag grants it, and only the plan owner can create events and set times. When the owner schedules a webinar, that scheduling is itself constrained by the co-host availability guard; class scheduling is not, because no class route calls it (#784 AE-2 — see [01-architecture.md §5](./01-architecture.md#5-scheduling-with-enforced-co-host-availability)).

---

## Host vs collaborator capability summary

The full capability matrix, with the enforcement source for each row, is:

| Capability | Host | Collaborator | Where enforced |
| --- | --- | --- | --- |
| Create the plan | Yes | No | Plan CRUD ownership checks |
| Invite / update / remove collaborators | Yes | No | Collaboration routes (owner check) |
| Create events, set times | Yes | No — never | Event CRUD ownership; no flag exists |
| View participant roster | Yes | Only with `canSeeAttendees` | Participant GETs (#768) |
| View revenue-split preview | Yes | Yes (accepted) | Revenue-split route scoping |
| View co-host availability | Yes | Yes (shared accepted collaboration) | Availability route scoping |
| Chat in the collaborator channel | Yes | Yes (accepted) | Stream channel membership |
| Accept/decline own invitation | — | Yes | Respond route identity check |
| Receive earnings | Yes | Yes (accepted) | Settlement split |
| Approve payments / view analytics / edit events | Yes (as owner) | Not yet — flags stored, unenforced | Pending #768 |
