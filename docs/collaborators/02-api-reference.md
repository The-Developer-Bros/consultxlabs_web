# Collaborator System — API Reference

All endpoints require an authenticated BetterAuth session; unauthenticated requests receive 401. Request bodies speak **percent** (`revenueSharePercentage`, 0–90); responses return the stored row, whose share field is **basis points** (`revenueShareBps`, 3000 = 30%) per #772 B5. This reference was refreshed on 2026-08-14 against the merged-model routes (#784).

---

## Collaborator management

### GET /api/collaborations/webinar/[planId]

Lists collaborators for a webinar plan, scoped to what the caller may see (`getCollaboratorsForUser`):

- The **plan owner** sees every `PENDING` and `ACCEPTED` collaborator.
- An **accepted collaborator** sees the `ACCEPTED` collaborators only.
- A **pending invitee** sees only their own record.
- Anyone else — including consultees and consultants with no record on the plan — receives 403; a missing plan receives 404.

A successful response returns the visible rows:

```json
{
  "data": [
    {
      "id": "clx...",
      "consultantProfileId": "clx...",
      "collaboratorType": "WEBINAR",
      "webinarPlanId": "clx...",
      "classPlanId": null,
      "role": "CO_HOST",
      "canApprovePayment": false,
      "canViewAnalytics": true,
      "canEditEvent": false,
      "canSeeAttendees": true,
      "revenueShareBps": 2500,
      "status": "ACCEPTED",
      "invitedById": "clx...",
      "respondedAt": "2026-02-10T...",
      "consultantProfile": {
        "id": "clx...",
        "user": { "name": "Alice Smith", "image": "/uploads/alice.jpg" }
      }
    }
  ]
}
```

---

### POST /api/collaborations/webinar/[planId]

Invites a collaborator to a webinar plan. The body carries the deal terms and the typed permission grants (#768):

```json
{
  "consultantProfileId": "clx...",
  "role": "CO_HOST",
  "revenueSharePercentage": 25,
  "canApprovePayment": false,
  "canViewAnalytics": true,
  "canEditEvent": false,
  "canSeeAttendees": true
}
```

The route and service enforce, in order: the requester is the plan owner (else 403); the body parses against `inviteWebinarCollaboratorSchema` (else 400); the target is not the owner themselves (else 400); no `PENDING`/`ACCEPTED` collaboration already exists for the pair (else 409); the role belongs to the webinar subset of the merged enum; the invited profile exists; and the share keeps the collaborator total at or under 90%, validated inside a Serializable transaction. A prior `REMOVED`/`DECLINED` row is re-activated to `PENDING` with the new terms instead of a second row being inserted.

A successful invite returns 201 with the created (or re-activated) row in the GET shape above, with `status: "PENDING"`.

---

### PATCH /api/collaborations/webinar/[planId]/[id]

Updates a collaborator's role or revenue share. The body accepts either or both fields:

```json
{ "role": "MODERATOR", "revenueSharePercentage": 15 }
```

Only the plan owner may update (else 403). The service re-validates the 90% cap excluding the row being updated, rejects a role outside the plan type's subset, and verifies the collaborator actually belongs to this plan before touching it (IDOR guard). Failures surface as 400. A success returns 200 with the updated row.

---

### DELETE /api/collaborations/webinar/[planId]/[id]

Removes a collaborator by setting `status: REMOVED` (a soft delete). Only the plan owner may remove (else 403). The response returns the updated row. Removal triggers the notification and the verified Stream chat-access revocation described in [01-architecture.md §8](./01-architecture.md#8-removing-a-collaborator).

---

### Class collaborator endpoints

The class endpoints are identical in shape, at:

- `GET /api/collaborations/class/[planId]`
- `POST /api/collaborations/class/[planId]`
- `PATCH /api/collaborations/class/[planId]/[id]`
- `DELETE /api/collaborations/class/[planId]/[id]`

The role must come from the class subset of the merged `CollaboratorRole` enum: `CO_INSTRUCTOR`, `TEACHING_ASSISTANT`, `GUEST_LECTURER`, `CONTENT_CREATOR`.

---

## Invitation response

### PATCH /api/collaborations/[id]/respond

Accepts or declines a collaboration invitation:

```json
{ "response": "ACCEPTED", "planType": "webinar" }
```

The route validates that `response` is `ACCEPTED` or `DECLINED` and `planType` is `webinar` or `class` (else 400), and that the caller has a consultant profile (else 404). The service then requires that the record belongs to the caller, that `planType` matches the record's plan FK (#784), and that the record is still `PENDING`; any mismatch returns 400.

On `ACCEPTED`, two best-effort side effects run: the Stream coordination channel `collab-{planType}-{planId}` is created or updated, and the plan owner is notified. Neither can fail the acceptance. A success returns 200 with the updated row (`status`, `respondedAt` set).

---

## My collaborations

### GET /api/collaborations

Returns all `PENDING` and `ACCEPTED` collaborations for the authenticated consultant, split by type. Each item embeds the plan (with its owner, its other visible collaborators, and up to five upcoming `SCHEDULED`/`IN_PROGRESS` events with their slots — this feeds the read-only schedule section on the collaboration cards) and the inviter:

```json
{
  "data": {
    "webinarCollaborations": [
      {
        "id": "clx...",
        "role": "CO_HOST",
        "revenueShareBps": 2500,
        "status": "PENDING",
        "webinarPlan": {
          "id": "clx...",
          "title": "Advanced React Patterns",
          "price": 100000,
          "consultantProfile": { "user": { "name": "Kaustav Ghosh" } },
          "collaborators": [ ... ],
          "webinars": [ ... ]
        },
        "invitedBy": { "user": { "name": "Kaustav Ghosh" } }
      }
    ],
    "classCollaborations": [ ... ]
  }
}
```

---

## Revenue split preview

### GET /api/collaborations/webinar/[planId]/revenue-split?amount=100000

Previews how a given amount would be divided by `calculateRevenueSplit()`. The `amount` query parameter is in paise and defaults to 10000 (₹100). Note that at real settlement the amount passed in is the **consultant pool** (gross minus the floored 20% platform fee), so a preview of the gross shows the proportions, not the final payouts — see [03-revenue-sharing.md](./03-revenue-sharing.md).

Access is limited to the plan owner, accepted collaborators on the plan, and admin/staff; others receive 403.

The response is the raw split array — owner first with the remainder, then each accepted collaborator with their floored share:

```json
{
  "data": [
    { "consultantProfileId": "clx-owner", "share": 60000, "role": "OWNER" },
    { "consultantProfileId": "clx-a", "share": 25000, "role": "CO_HOST" },
    { "consultantProfileId": "clx-b", "share": 15000, "role": "MODERATOR" }
  ]
}
```

An empty array means the plan has no accepted collaborators and settlement will use the ordinary single-owner flow.

### GET /api/collaborations/class/[planId]/revenue-split

The class variant behaves identically.

---

## Co-host availability

### GET /api/collaborators/[consultantProfileId]/availability?date=YYYY-MM-DD

Returns a co-host's availability and booking status for one date; the host's scheduling calendar renders it as the color overlay. Access is limited to the profile owner, consultants who share an **accepted** collaboration with the target (checked across both plan types in one lookup on the merged model), and admin/staff; a missing `date` parameter returns 400.

```json
{
  "data": {
    "consultantProfileId": "clx...",
    "scheduleType": "WEEKLY",
    "date": "2026-03-15",
    "weeklySlots": [
      { "startDay": "MONDAY", "startTimeUtc": 540, "endDay": "MONDAY", "endTimeUtc": 1020 }
    ],
    "customSlots": [],
    "bookedSlots": [
      { "startsAt": "2026-03-15T10:00:00Z", "endsAt": "2026-03-15T11:00:00Z" }
    ]
  }
}
```

`bookedSlots` uses overlap semantics against the day and includes events the co-host has accepted a collaboration on, not only events they own. The overlay interpretation is: green when availability exists and no booking overlaps, yellow when no availability is defined for the time, red when a booking overlaps. The overlay is advice for picking a time. On the webinar path that advice is backed by hard enforcement — `assertCollaboratorsAvailable` returns 409 — but on the class path the overlay is all there is, because no class route calls the guard. Both cases are described in [01-architecture.md §5](./01-architecture.md#5-scheduling-with-enforced-co-host-availability).
