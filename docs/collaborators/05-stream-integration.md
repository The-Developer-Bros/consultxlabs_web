# Collaborator Stream.io Integration

## Overview

When a collaborator accepts an invitation, a private Stream.io messaging channel is created (or reconciled) for team coordination, so the host and all accepted collaborators can communicate before, during, and after events. This page was refreshed on 2026-08-14; the creation function is now a full member **reconciler** rather than a create-only helper.

**File**: `actions/stream/chat/channel.action.ts` — `createCollaboratorChannel()` (called from `respondToInvitation()` in `lib/collaborators/service.ts`).

---

## Channel architecture

### Channel naming convention

The platform distinguishes channel purposes by ID prefix; the canonical prefix constants and the type-inference helper live in `lib/stream-channel-ids.ts`.

| Purpose | Channel ID pattern | Channel type | Members |
| --- | --- | --- | --- |
| Direct message | `dm-{...}` | `messaging` | The two participants |
| Webinar event | `webinar-{webinarId}` | `team` | Host + participants |
| Class event | `class-{classId}` | `team` | Host + participants |
| **Collaborator (webinar)** | `collab-webinar-{webinarPlanId}` | `messaging` | Host + accepted collaborators |
| **Collaborator (class)** | `collab-class-{classPlanId}` | `messaging` | Host + accepted collaborators |

The `consultation-{id}` and `subscription-{id}` patterns are **legacy** — nothing creates them any more (#1134 P0-7); 1:1 conversations are DMs. `getChannelTypeFromId()` still resolves all messaging-side prefixes (including `collab-`) so existing rows keep working.

### Why the `messaging` type?

Collaborator channels use `messaging` (private, invitation-only) rather than `team` (the open event-channel type) because only the host and accepted collaborators should have access — event participants must not see the behind-the-scenes coordination.

---

## Channel creation and reconciliation

### Trigger

The channel is created or reconciled when a collaborator **accepts** an invitation. `respondToInvitation()` loads the action via dynamic `import()` (avoiding a service ↔ server-action circular dependency) and treats failure as non-blocking — the acceptance stands, and the error is logged and reported to Sentry (`subsystem: "stream"`, warning level):

```typescript
// lib/collaborators/service.ts — respondToInvitation(), on ACCEPTED
try {
  const { createCollaboratorChannel } =
    await import("@/actions/stream/chat/channel.action");
  await createCollaboratorChannel(planType, planId);
} catch (err) {
  Sentry.captureException(..., { tags: { subsystem: "stream" }, level: "warning" });
  console.error("Failed to create collaborator channel:", err);
}
```

### What the reconciler does

`createCollaboratorChannel(planType, planId)` performs these steps:

1. Loads the plan with its host and all `ACCEPTED` collaborators, and builds the deduplicated expected member set (host + collaborators).
2. Skips entirely (returns `null`) when fewer than two members exist — no channel is needed while the host is alone.
3. Creates the channel idempotently: type `messaging`, id `collab-{planType}-{planId}`, name `"{Plan Title} - Collaborators"`, `created_by_id` = host, with the metadata keys `{planType}_plan_id` and `is_collaborator_channel: true`.
4. Grants the host channel-scoped moderator rights (#899 — this path bypasses the shared `createChannel` helper, so the grant is repeated here).
5. **Diffs membership in both directions**: queries the channel's current members, adds anyone present in the DB set but missing from the channel, and removes anyone on the channel who is no longer in the DB set (the host is always in the expected set). A second collaborator accepting later is added by the same call; a departed one is dropped on the next reconcile.

Because the function converges the channel onto the DB state rather than only appending, re-running it is always safe.

---

## Access revocation on removal

When the host removes a collaborator, `removeCollaborator()` revokes chat access in two places, independently of the removal notification:

- **Event channels** — the collaborator is removed from every `webinar-{id}`/`class-{id}` channel of the plan's events via `removeUserFromEventChannel`. That helper reports failure by returning `{ success: false }` rather than throwing, so the service checks every result and reports any event whose revocation failed to Sentry; previously a failed revocation was indistinguishable from success and a removed collaborator silently kept chat access (#1125).
- **The coordination channel** — the collaborator is removed from `collab-{planType}-{planId}` with its own error handling, since losing the coordination channel is a different access grant than the event channels.

Notification and Stream revocation run in separate try/catch blocks so a Novu outage cannot block revocation, and vice versa.

---

## Channel lifecycle

```
1. Collaborator A accepts        → channel created: collab-webinar-{planId}
                                    members [Host, A]; host granted moderator
2. Collaborator B accepts        → reconciler adds B → members [Host, A, B]
3. Team coordinates via chat     → content, logistics, timings
4. Host removes collaborator B   → B removed from event channels (verified,
                                    #1125) AND from the collab channel
5. Channel persists              → no auto-deletion; the next reconcile
                                    converges membership onto the DB state
```

---

## Video call roles (deferred)

Stream video calls support role-based permissions, and the intended mapping is recorded here for when the work is picked up.

| Collaborator role | Intended Stream role | Status |
| --- | --- | --- |
| CO_HOST / CO_INSTRUCTOR | `host` | Deferred |
| MODERATOR / TEACHING_ASSISTANT | `moderator` | Deferred |
| GUEST_SPEAKER / GUEST_LECTURER | `speaker` | Deferred |
| TECHNICAL_SUPPORT / CONTENT_CREATOR | `attendee` | Deferred |

The reason it is deferred is that video calls are created client-side (`lib/meeting.ts` `call.getOrCreate()`). Assigning collaborator-specific roles requires either server-side call creation (an architectural change) or client-side role assignment after creation (racy). The collaborator data in the DB is the foundation for a future implementation.

---

## Chat UI integration

Collaborator channels appear in the consultant's chat interface. The `collab-` prefix and the channel metadata let the UI group them separately from DMs and event channels:

```json
{
  "webinar_plan_id": "clx...",
  "is_collaborator_channel": true
}
```

With that, the UI can display a "Collaborations" section, show the plan title as the channel name, and link back to the plan management page.
