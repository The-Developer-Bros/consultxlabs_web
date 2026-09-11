# Collaborator System — Architecture & Flows

This document tells the story of how multi-creator collaboration works on Familiarise. It follows the journey from a host inviting a collaborator, through acceptance and coordination, to how revenue is split when a customer pays, and what happens during refunds. It was rewritten on 2026-08-14 against the merged-model code (#784); each section names the function that implements it.

---

## Table of contents

1. [The big picture](#1-the-big-picture)
2. [Inviting a collaborator](#2-inviting-a-collaborator)
3. [Responding to an invitation](#3-responding-to-an-invitation)
4. [Coordinating via Stream chat](#4-coordinating-via-stream-chat)
5. [Scheduling with enforced co-host availability](#5-scheduling-with-enforced-co-host-availability)
6. [How revenue gets split at settlement](#6-how-revenue-gets-split-at-settlement)
7. [Refund cascade — unwinding multi-party earnings](#7-refund-cascade--unwinding-multi-party-earnings)
8. [Removing a collaborator](#8-removing-a-collaborator)
9. [The complete lifecycle](#9-the-complete-lifecycle)

---

## 1. The big picture

Familiarise supports four paid service types: consultations, subscriptions, webinars, and classes. Consultations and subscriptions are inherently one-on-one. Webinars and classes are group events, and in the real world these are often team efforts — a React webinar might have a primary instructor and a co-host managing Q&A; a bootcamp class might have a lead teacher, a teaching assistant, and a guest lecturer.

The collaborator system makes this possible. It sits on top of the existing plan/event architecture without changing how participants register. The key principle is that **the host owns the plan; collaborators participate on the host's terms**. Since #784 the whole feature runs on one merged `Collaborator` model (`prisma/schema.prisma:5125`) with a `collaboratorType` discriminator, so every flow below is written once and parameterized by plan type rather than duplicated per table.

The system touches five areas: the Prisma schema (the `Collaborator` junction model plus the multi-row `ConsultantEarnings` fan-out), a service layer (`lib/collaborators/service.ts` and `lib/collaborators/availability.ts`), API routes under `app/api/collaborations/`, Stream.io for auto-created chat channels, and the dashboard UI in `components/collaborators/`.

---

## 2. Inviting a collaborator

A host invites collaborators from the "Collaborators" tab in their plan editor (the `CollaboratorsTab` component). The invitation specifies who (consultant profile id), what role, what revenue share (a percent between 0 and 90), and which of the four permission booleans to grant.

### What the route validates

The POST handler (`app/api/collaborations/webinar/[planId]/route.ts` and its class sibling) performs the checks that need request context: the requester must be the plan owner, the body must pass `inviteWebinarCollaboratorSchema` (or the class variant), self-invitation is rejected, and an existing collaboration in `PENDING`/`ACCEPTED` status returns 409 before the service is ever called.

### What the service validates

`inviteCollaborator()` in `lib/collaborators/service.ts:96` then enforces the system invariants:

1. **Percentage range.** The share must be greater than 0 and at most 90.
2. **Role subset.** The merged `CollaboratorRole` enum cannot itself reject a class role on a webinar invitation, so `asPlanRole()` checks the role against the plan type's allowed subset (`WEBINAR_COLLABORATOR_ROLES` / `CLASS_COLLABORATOR_ROLES` from `schemas/collaborators.ts`).
3. **Invitee existence.** The invited consultant profile must exist; without this check a fabricated id would create an orphaned row.
4. **The 90% cap, race-safely.** Validation and creation run inside one Serializable transaction (isolation `Serializable`, 10s timeout — FIX B1), so two concurrent invitations cannot jointly exceed the cap. `validateRevenueSharesTx()` sums `revenueShareBps` over all `PENDING` and `ACCEPTED` collaborators and checks that the total plus the new share stays at or under 9000 bps.

Note that **PENDING invitations count toward the total**. If the host invites three people at 35% each before any of them respond, the third invitation is rejected, because 105% would over-allocate the pool.

### Re-activation instead of re-creation

The unique constraint permits only one row per (consultant, plan). If a previous collaboration exists in `REMOVED` or `DECLINED` status, the service **updates that row back to `PENDING`** with the new role, share, and permissions rather than inserting a second one (FIX #6). A row already in `PENDING` or `ACCEPTED` makes the invite a no-op (`null` → HTTP 400/409 at the route).

### Share storage

The API surface speaks percent; the database stores integer basis points. `pctToBps()` converts at the boundary (`service.ts:28`), so a 25% invitation is stored as `revenueShareBps: 2500` (#772 B5).

### The side-effect

After the transaction commits, the service fires a best-effort Novu notification to the invitee (`notifyCollaboratorInvited`). A notification failure is logged and reported to Sentry but never fails the invite.

---

## 3. Responding to an invitation

When the invited consultant opens their dashboard, the Collaborations page (powered by `InvitationsPanel` and fed by `GET /api/collaborations`) shows the pending invitation with the plan, the inviter, the proposed role, the revenue share, and Accept/Decline buttons.

### The response

`PATCH /api/collaborations/{id}/respond` carries `{ "response": "ACCEPTED" | "DECLINED", "planType": "webinar" | "class" }`. `respondToInvitation()` (`service.ts:237`) verifies three things:

1. **Identity** — the record's `consultantProfileId` must match the authenticated consultant. You can only answer your own invitations.
2. **Type match** — with the merged table, a `planType` that does not match the record (its `webinarPlanId`/`classPlanId`) is the old wrong-table lookup and returns null (#784).
3. **Status** — the record must still be `PENDING`. You cannot re-accept an accepted invitation or revive a declined one.

If valid, the row is updated to the response status with `respondedAt` stamped. Declining frees the reserved share; the host can invite someone else with that percentage.

### Side-effects on acceptance

Acceptance triggers two independent best-effort actions, each in its own try/catch so neither can fail the acceptance and neither blocks the other:

- **Stream channel** — `createCollaboratorChannel(planType, planId)` is loaded via dynamic `import()` (avoiding a service ↔ server-action circular dependency) and creates or updates the private coordination channel. See [05-stream-integration.md](./05-stream-integration.md).
- **Host notification** — `notifyCollaboratorAccepted` tells the plan owner who accepted and in what role.

Failures in either are reported to Sentry with `subsystem: "stream"` at warning level.

---

## 4. Coordinating via Stream chat

Once a collaborator accepts, the team needs a place to talk. The system creates a private Stream.io messaging channel per plan, named `collab-webinar-{planId}` or `collab-class-{planId}`. Collaborator channels use the `messaging` type (private, invitation-only) rather than `team`, because event participants must not see the behind-the-scenes coordination. Creation is idempotent — Stream's `getOrCreate` updates the member list when a second collaborator accepts later. The full channel architecture, including what happens on removal, is in [05-stream-integration.md](./05-stream-integration.md).

---

## 5. Scheduling with enforced co-host availability

Scheduling remains host-only — collaborators cannot create events or set timings. But the host needs to know when co-hosts are free, and since #784 (AE-2) the platform **enforces** co-host availability on the webinar path instead of treating it as advisory. Read that scope literally: the enforcement described below is wired into the webinar plan route alone, and class-plan co-hosts are still only advised.

### The availability endpoint

`GET /api/collaborators/{consultantProfileId}/availability?date=YYYY-MM-DD` returns three data sets for the date: the co-host's weekly availability (`SlotOfAvailabilityWeekly`), their custom one-off availability (`SlotOfAvailabilityCustom`), and their booked slots — including events they collaborate on, not only events they own. Access is limited to the profile owner, consultants who share an accepted collaboration with them, and admin/staff.

The scheduling calendar renders this as a color overlay: green means available with no booking, yellow means no availability defined (they may be flexible), red means an existing booking.

### The two enforcement layers

Enforcement has two halves, both landing with #784:

1. **The owner's own slots.** The plan owner's `consultantProfileId` is denormalized onto webinar and class group-event slots, exactly as it always was for 1:1 consultation slots. Group-event slots previously left that column NULL, so the `slot_no_confirmed_overlap` exclusion constraint never guarded the host there; with the column populated the constraint protects the host across every event type. A clash surfaces as a Postgres `23P01` exclusion violation, which the API translates to HTTP 409.
2. **The co-hosts, on webinar plans.** Co-hosts are not slot participants — only the plan owner is denormalized onto `SlotOfAppointment` — so neither the constraint nor the owner-scoped checks ever saw them, which used to let a co-host be silently double-booked. `assertCollaboratorsAvailable()` (`lib/collaborators/availability.ts:58`) closes that: at the event's time-commit it checks every `ACCEPTED` co-host's confirmed commitments (appointments they own or have accepted a collaboration on) for overlap with the proposed window, and throws `CollaboratorUnavailableError` naming the clashing co-hosts, which the route maps to HTTP 409.

The guard is a no-op when the plan has no accepted collaborators, runs inside the scheduling transaction so its read stays consistent with the slot write that follows, and asks one aggregate query on the common no-conflict path (the per-co-host probe runs only when a clash is already certain).

**Layer 2 covers webinar plans only.** The function accepts a `planType` of either `WEBINAR` or `CLASS`, but `app/api/bookings/webinars/crud-with-plan/route.ts:801` is its only caller in the application: no route under `app/api/bookings/classes/` invokes it. A class-plan co-instructor can therefore still be scheduled into a session that clashes with a commitment elsewhere, and nothing rejects it. Layer 1 is unaffected — the owner's denormalized `consultantProfileId` protects the host across every event type — so the residual gap is co-hosts on classes specifically. Anyone extending the class scheduling path should call the same guard there: its `CLASS` branch already selects on `classPlanId` and needs no new code, only a caller. Note that the unit suite does not cover it either — every case in `__tests__/collaborators/availability.test.ts` passes `planType: "WEBINAR"` — so a class-side wiring would need its own test.

---

## 6. How revenue gets split at settlement

This is the most consequential part of the system. The split does not happen at checkout; it happens when `createEarningsFromPayment()` (`lib/payments/payouts/earnings-service.ts:293`) settles a succeeded payment — from the payment webhook for gateway payments, or inline at checkout for mock, zero-amount, and org-sponsored payments, which bypass webhooks.

### Fee first, then the pool

The platform fee is not applied per share. Settlement floors the marketplace fee off the gross once (`PLATFORM_FEE_PERCENTAGE = 20` in `lib/payments/payouts/constants.ts:11`; floored per #778 §C-2 so the shaved paisa stays in the consultant pool), and the remainder is the **consultant pool**. When the plan is org-owned, the pool comes from the org rate-card split instead. The pool — not the gross — is what `calculateRevenueSplit()` divides.

### The split calculation

`calculateRevenueSplit()` (`lib/collaborators/service.ts:900`) fetches the `ACCEPTED` collaborators and returns an empty array when there are none, which sends settlement down the ordinary single-owner path. Otherwise:

- Each collaborator's share is `floor(pool × revenueShareBps / 10000)`. Flooring, not rounding — `Math.round` could overshoot the total and push the owner's remainder negative (#778 §C-2).
- If the stored bps sum exceeds 10000, the plan is mis-configured and the function throws rather than minting money.
- The **owner gets the remainder** (`pool − Σ collaborator shares`), absorbing every floored paisa as the pool's designated residual party.

For a ₹1,000 webinar with collaborators at 25% and 15%, settlement therefore floors ₹200 of fee off the top, then splits the ₹800 pool: ₹200 to the co-host (2500 bps), ₹120 to the moderator (1500 bps), and the ₹480 remainder to the host.

### Settlement to a collaborator's host org (#773)

Collaborations are org-blind by design (ADR 18): a collaborator on someone else's org-owned plan is not that org's expert, so their share settles to **their own** host org, not the seller's. Before writing any rows, settlement resolves each non-owner split through `resolveOrgSplit()` against the collaborator's own HOST/HYBRID org rate card. A settled collaborator's `ConsultantEarnings` row is credited the NET of their card (the org's cut lands on an `OrganizationEarnings` row, the card's fee slice is platform revenue); an independent collaborator keeps the full share. A would-be second `OrganizationEarnings` row for the same (payment, org) pair is skipped deterministically, keeping the old P2002 semantics: the colliding collaborator simply stays unsettled.

### The earnings rows

One `ConsultantEarnings` row is created per party, all pointing at the same `paymentId` (uniqueness is `@@unique([paymentId, consultantProfileId, role])`). The owner's row carries the gross and the marketplace fee; a collaborator's row carries `grossAmount: 0` and its own fee slice only when org-settled. Each row caches `shareBps` — its share of the pool — floored per row with the **last** row absorbing the remainder so the cached bps sum to exactly 10000 (#812). When the sponsoring org is an unverified INVOICE org, every row parks in `PENDING_TRUST` instead of `PENDING` (#687 E-02).

Finally, settlement posts the balanced double-entry booking journal (one `CONSULTANT_PAYABLE` credit per party, one `ORG_PAYABLE` per involved org, the summed fee slices as `PLATFORM_FEE`) keyed `booking:<paymentId>`. A non-retryable posting failure records the drift and re-throws so earnings and journal roll back together — the ledger is the source of truth (#812).

### Independent payouts

Each `ConsultantEarnings` row is processed independently by the payout system: a hold period, then batching grouped by `consultantProfileId`. The host's payout has no dependency on any collaborator's.

---

## 7. Refund cascade — unwinding multi-party earnings

When a payment is refunded, all earnings rows for that payment must be reversed. `refundEarnings()` (`lib/payments/payouts/earnings-service.ts:1079`) does a `findMany` on the `paymentId` and walks every row — owner, collaborators, and any `OrganizationEarnings` rows from the 3-way or collaborator-org splits.

Partial refunds reverse proportionally: each party's clawback is floored via the shared integer-paise proration helper (#813), and the shaved paise are absorbed by the **platform** — the buyer is made whole in full, and no consultant or org is ever over-clawed (#778 §C-2). `refundedShareAmount` accumulates across successive partial refunds so a row is never reversed past its share.

Refunds are all-or-nothing across parties for any given refund amount: you cannot refund just the host's share. If the customer gets money back, every party's earnings for that payment are wound down in proportion.

---

## 8. Removing a collaborator

The host removes a collaborator from the `CollaboratorsTab`, which calls `DELETE /api/collaborations/{planType}/{planId}/{id}`. `removeCollaborator()` (`service.ts:323`) first verifies the collaborator actually belongs to that plan (the planId parameter exists to prevent IDOR), then sets `status: REMOVED` — a soft delete; the row persists for audit and for the re-activation path in §2.

Two independent side-effects follow, each guarded separately so a Novu outage cannot block Stream revocation or vice versa:

- **Notification** — `notifyCollaboratorRemoved` tells the collaborator.
- **Stream revocation** — the removed collaborator is taken out of every event channel for the plan's webinars/classes and out of the plan-level `collab-*` coordination channel. `removeUserFromEventChannel` reports failure by returning `{ success: false }` rather than throwing, so the service now checks every result and reports any event channel that still has the removed collaborator to Sentry — previously a failed revocation looked identical to a successful one and a removed collaborator silently kept chat access (#1125). A failed lookup of the collaborator's user id is likewise reported, because it would skip both side-effects.

Removal only affects **future** payments. Earnings already created while the collaborator was active are theirs to keep; the freed share becomes available for a new invitation.

---

## 9. The complete lifecycle

Every state a collaboration can pass through:

```
Host creates plan
       │
       ▼
Host invites Consultant B (role, share %, permission booleans)
       │  (Serializable tx: 90% cap checked; REMOVED/DECLINED row re-activated)
       ▼
┌──────────────┐
│   PENDING    │  Share is reserved (counts toward the 90% cap).
└──────┬───────┘
       │
  ┌────┴────────────┐
  ▼                 ▼
┌──────────┐  ┌──────────┐
│ ACCEPTED │  │ DECLINED │  DECLINED frees the share; the row stays
│ + Stream │  └──────────┘  and can be re-activated by a new invite.
│   channel│
└──────┬───┘
       │
  ┌────┴──────────────────────────────────────┐
  │ Active collaboration                      │  Host removes
  │  - Counts in the AE-2 scheduling guard    ▼
  │  - Gets a pool share at settlement   ┌──────────┐
  │  - Has Stream chat access            │ REMOVED  │  Soft delete. Share freed.
  │  - Visible per the scoping rules     │          │  Stream access revoked
  └──────────────────┐                   │          │  (verified, #1125). Past
                     │                   └──────────┘  earnings preserved.
                     ▼
        Customer pays → settlement:
          fee floored off gross → pool → floor per collaborator,
          owner takes remainder → per-party ConsultantEarnings
          (org-settled where #773 applies) → balanced booking journal
                     │
                     ▼
        Independent payouts per consultant after the hold period
```

### What is NOT in the collaborator system (deliberate exclusions)

- **Consultation/subscription collaborators** — those services are 1:1 by definition.
- **Stream video call roles** — calls are created client-side; assigning collaborator-specific roles (host, moderator, speaker) needs server-side call creation and is deferred.
- **Collaborator-initiated scheduling** — only the host creates events and sets times. The enforced availability guard protects co-hosts; it does not empower them. See [06-scheduling-approaches.md](./06-scheduling-approaches.md) for the considered future options.
- **Enforcement of three of the four permission booleans** — `canApprovePayment`, `canViewAnalytics` and `canEditEvent` are stored but have no surface to gate yet; only `canSeeAttendees` is enforced. See [04-permissions.md](./04-permissions.md).
