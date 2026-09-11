# Collaborator System

**Status**: Implemented; merged single-model form since #784
**Scope**: Webinars and Classes only

## Overview

The collaborator system enables multi-creator content on the Familiarise platform. A consultant (the "host") who owns a webinar or class plan can invite other consultants to collaborate with defined roles and revenue shares. Collaborators accept or decline invitations, and when participants pay for the service, earnings are split among all collaborators at settlement time.

This document set was rewritten on 2026-08-14 against the current code. The largest change since the original write-up is #784, which merged the two per-type junction models (`WebinarCollaborator` and `ClassCollaborator`) into one `Collaborator` model, and #768/#772, which replaced the JSON permission override and the float revenue share with typed columns.

### Goals

The system exists to make five things possible:

- Team-taught webinars and classes.
- Fair, transparent revenue sharing with per-collaborator splits.
- Automated earnings distribution at settlement, including settlement to a collaborator's own host organization (#773).
- Private communication channels for collaborator coordination.
- Co-host availability visibility for scheduling, now enforced rather than advisory (#784 AE-2).

### Key design decisions

The following table records the load-bearing choices and why each was made.

| Decision | Choice | Rationale |
| --- | --- | --- |
| Scope | Webinars + Classes only | Consultations and subscriptions are inherently 1:1 |
| Data model | One merged `Collaborator` model with a `collaboratorType` discriminator (#784) | Two parallel tables duplicated every query and migration |
| Scheduling | Host-only; co-host availability enforced on webinars only (#784 AE-2) | Only the owner creates events; a webinar co-host can no longer be silently double-booked, but a class co-instructor still can |
| Revenue split | Host sets it, collaborator accepts or declines | The owner controls the deal |
| Share storage | Integer basis points (`revenueShareBps`, #772 B5) | Integer money math; the API surface stays in percent |
| Minimum host share | 10% (collaborator total capped at 90%, enforced in a Serializable transaction) | Prevents giving away the entire revenue, race-safely |
| Platform fee | 20% floored off the gross once; the pool is then split | The owner absorbs rounding as the residual party (#778 §C-2) |
| Permissions | Four typed booleans (#768 lockdown #12) | The old JSON override was unauditable and never validated |
| Chat channels | Auto-created on acceptance | Collaborators need a place to coordinate |
| Video roles | Deferred | Calls are created client-side; needs deeper changes |
| Org relationship | Collaborations are org-blind (ADR 18) | Each collaborator's earnings settle to their own host org independently |

---

## Data model

One `Collaborator` row links a consultant profile to exactly one plan. The `collaboratorType` discriminator says which kind, and exactly one of `webinarPlanId`/`classPlanId` is set — Postgres CHECK constraints are not Prisma-expressible, so the XOR is app-enforced by `assertCollaboratorPlanXor` in `lib/collaborators/service.ts:33`.

```
ConsultantProfile ──── owns ────────────► WebinarPlan / ClassPlan
        │                                        │ 1:many
        │ collaborates via                       ▼
        └─────────────────────────────► Collaborator
                                          collaboratorType  WEBINAR | CLASS
                                          webinarPlanId?  ⊕  classPlanId?   (XOR)
                                          role              CollaboratorRole
                                          revenueShareBps   Int (3000 = 30%)
                                          canApprovePayment / canViewAnalytics /
                                          canEditEvent / canSeeAttendees  Boolean
                                          status            PENDING → ACCEPTED | DECLINED | REMOVED
                                          invitedById       ConsultantProfile
                                          respondedAt       DateTime?
```

### The `Collaborator` model

The model lives at `prisma/schema.prisma:5125`. Its fields are listed below.

| Field | Type | Description |
| --- | --- | --- |
| `id` | String | Primary key (cuid) |
| `consultantProfileId` | String | The collaborator's profile |
| `collaboratorType` | `CollaboratorType` | `WEBINAR` or `CLASS` — mirrors which plan FK is set |
| `webinarPlanId` | String? | Set iff `collaboratorType = WEBINAR` |
| `classPlanId` | String? | Set iff `collaboratorType = CLASS` |
| `role` | `CollaboratorRole` | One merged enum; the service rejects a class role on a webinar collaboration and vice versa |
| `canApprovePayment` | Boolean | Typed permission, default `false` (#768) |
| `canViewAnalytics` | Boolean | Typed permission, default `false` (#768) |
| `canEditEvent` | Boolean | Typed permission, default `false` (#768) |
| `canSeeAttendees` | Boolean | Typed permission, default `false`; the only one currently enforced (#768) |
| `revenueShareBps` | Int | Basis points, e.g. 3000 = 30% (#772 B5) |
| `status` | `CollaboratorStatus` | `PENDING`, `ACCEPTED`, `DECLINED`, `REMOVED` |
| `invitedById` | String | The host who sent the invitation |
| `respondedAt` | DateTime? | When the collaborator responded |

Uniqueness is a pair of partial-behaving constraints: `@@unique([consultantProfileId, webinarPlanId])` and `@@unique([consultantProfileId, classPlanId])`. Postgres treats NULLs as distinct, so each constraint bites only for its own plan type — a consultant can hold one collaboration per plan.

### Enums

The three enums sit directly below the model (`prisma/schema.prisma:5160`, `:5165`, `:5173`).

```
CollaboratorType:    WEBINAR | CLASS

CollaboratorStatus:  PENDING   — invitation sent, awaiting response
                     ACCEPTED  — collaborator accepted
                     DECLINED  — collaborator declined
                     REMOVED   — host removed the collaborator (soft delete)

CollaboratorRole (union of the old per-type enums, #784):
  Webinar subset:  CO_HOST, MODERATOR, GUEST_SPEAKER, TECHNICAL_SUPPORT
  Class subset:    CO_INSTRUCTOR, TEACHING_ASSISTANT, GUEST_LECTURER, CONTENT_CREATOR
```

Because the merged DB enum cannot reject a class role on a webinar collaboration the way the old per-type enums did, the subset check lives in the service (`ROLES_BY_PLAN_TYPE` in `lib/collaborators/service.ts:62`, backed by `schemas/collaborators.ts`).

### `ConsultantEarnings` (settlement side)

Settlement writes one `ConsultantEarnings` row per party (`prisma/schema.prisma:4476`). The columns relevant to collaborations are these.

| Field | Type | Description |
| --- | --- | --- |
| `role` | `EarningRole` | `OWNER` or `COLLABORATOR` |
| `shareBps` | Int | Cached basis-point share of the consultant pool (10000 = 100%); floored per row with the last row absorbing the remainder so the sum is exactly 10000 (#812) |
| `grossAmount` / `platformFeePaise` / `consultantSharePaise` | BigInt | Integer paise; the owner's row carries the gross and the marketplace fee, a collaborator's row carries only its share |
| `paymentId` | String | Indexed, not unique — one payment fans out to many earnings rows; uniqueness is `@@unique([paymentId, consultantProfileId, role])` |

The full split mechanics, including settlement to a collaborator's host org (#773), are in [03-revenue-sharing.md](./03-revenue-sharing.md).

---

## File map

The table below maps each concern to its source file.

| File | Purpose |
| --- | --- |
| `lib/collaborators/service.ts` | Core business logic: invite, respond, update, remove, visibility scoping, revenue split |
| `lib/collaborators/availability.ts` | `assertCollaboratorsAvailable` — the AE-2 co-host double-booking guard, called from the webinar plan route only |
| `lib/payments/payouts/earnings-service.ts` | `createEarningsFromPayment` — applies the split at settlement and posts the booking journal |
| `app/api/collaborations/webinar/[planId]/route.ts` | GET/POST webinar collaborators |
| `app/api/collaborations/webinar/[planId]/[id]/route.ts` | PATCH/DELETE a specific webinar collaborator |
| `app/api/collaborations/class/[planId]/route.ts` | GET/POST class collaborators |
| `app/api/collaborations/class/[planId]/[id]/route.ts` | PATCH/DELETE a specific class collaborator |
| `app/api/collaborations/[id]/respond/route.ts` | PATCH accept/decline an invitation |
| `app/api/collaborations/route.ts` | GET all my collaborations |
| `app/api/collaborations/webinar/[planId]/revenue-split/route.ts` | GET webinar revenue-split preview |
| `app/api/collaborations/class/[planId]/revenue-split/route.ts` | GET class revenue-split preview |
| `app/api/collaborators/[consultantProfileId]/availability/route.ts` | GET co-host availability for a date |
| `app/api/participants/webinar/[webinarId]/route.ts` | Participant roster — the surface `canSeeAttendees` gates |
| `components/collaborators/` | `CollaboratorsTab`, `InvitationsPanel`, `HostedPlanCard`, `RevenueSplitBar` and friends |
| `actions/stream/chat/channel.action.ts` | `createCollaboratorChannel()` |
| `schemas/collaborators.ts` | Zod schemas, including the per-plan-type role subsets |
| `prisma/seedFiles/14b-create-collaborators.ts` | Seed data |

---

## Related docs

The rest of this folder goes deeper on each area:

- [01 — Architecture & Flows](./01-architecture.md)
- [02 — API Reference](./02-api-reference.md)
- [03 — Revenue Sharing](./03-revenue-sharing.md)
- [04 — Permissions](./04-permissions.md)
- [05 — Stream Integration](./05-stream-integration.md)
- [06 — Scheduling Approaches](./06-scheduling-approaches.md)
