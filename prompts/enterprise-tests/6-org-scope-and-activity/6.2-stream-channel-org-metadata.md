# 6-org-scope-and-activity — Stream channel + meeting org metadata

> **Required reading:** [`_shared/shared-setup.md`](../_shared/shared-setup.md),
> [`_shared/mcp-recipes.md`](../_shared/mcp-recipes.md),
> [`_shared/case-template.md`](../_shared/case-template.md).
> Apply the **fix-and-retest gate** when any case fails.

**Surface(s) under test:**
- `lib/meeting.ts` — `createMeeting`, `getOrCreateMeetingSession` (server-side; stamps `custom.organizationId`)
- `actions/stream/chat/channel.action.ts` — chat channel creation (stamps `custom.organization_id`)
- `app/meetings/[id]/hooks/useGetCallById.ts` — client-side fallback that now accepts `organizationId` (Round-3 follow-up)

**Case roster:**
1. **S.1** — Server-side meeting creation stamps `custom.organizationId`
2. **S.2** — Chat channel creation stamps `custom.organization_id`
3. **S.3** — Client-side `getOrCreate` fallback stamps when prop passed
4. **S.4** — Backfill query for unstamped historical meetings

---

## Common preconditions

Use `learnpro-academy` (HOST) with a seeded webinar that has a meeting
session.

Capture `<learnpro-id>`, `<webinarId>`, `<meetingSessionId>`.

---

## Case S.1: Server-side meeting stamps organizationId

Trigger a meeting creation through the canonical server path. The
simplest is initiating a fresh webinar booking that creates the meeting
session via `lib/meeting.ts:createMeeting`.

### Assertions
Query Stream:
```ts
mcp__streamio__video_get_call({ call_type: "default", call_id: "<streamCallId>" })
// Inspect response.custom.organizationId — expected: <learnpro-id>
```

If `custom.organizationId` is empty/absent, the server-side stamp is
broken. NON-TRIVIAL — touches `lib/meeting.ts`. ASK.

---

## Case S.2: Chat channel stamps organization_id

Trigger a chat channel create via the channel action. The action
creates a channel with `custom.organization_id` per
`actions/stream/chat/channel.action.ts:79-80`.

### Assertions
```ts
mcp__streamio__chat_query_channels({
  filter_conditions: { type: "messaging", id: { $eq: "<channelId>" } }
})
// Inspect response.channels[0].custom.organization_id — expected: <learnpro-id>
```

Note the field name uses **snake_case** here (`organization_id`) per
the existing convention; the meeting field uses **camelCase**
(`organizationId`). Don't try to unify them in-flight — they're
external surfaces to Stream and changing them is a breaking change for
any downstream consumer.

---

## Case S.3: Client-side fallback

This case exercises the Round-3 follow-up in
`app/meetings/[id]/hooks/useGetCallById.ts`. The hook now accepts an
`organizationId` argument and passes it to
`callInstance.getOrCreate({ data: { custom: { organizationId } } })`.

Find a meeting URL where the server-side path was NEVER hit (i.e. a
stray bookmark / manual link). Navigate the user to the page. The hook's
fallback fires.

### Assertions
- `mcp__streamio__video_get_call` for the resulting call_id returns
  `custom.organizationId` matching the prop (if the page knew the
  orgId).
- If the page didn't know the orgId, the fallback creates the call
  without metadata — that's acceptable (stray-link case is rare; no
  org context to stamp).

---

## Case S.4: Backfill identification

Identify historical meetings with missing org metadata:
```ts
// For each meeting session, look up the linked appointment's organizationId
mcp__supabase__execute_sql({
  project_id: "pzmbxqdgibfkhjwzeprf",
  query: `
    SELECT ms.id, ms."streamCallId", a."organizationId"
    FROM "MeetingSession" ms
    JOIN "SlotOfAppointment" soa ON soa.id = ms."slotOfAppointmentId"
    JOIN "Appointment" a ON a.id = soa."appointmentId"
    WHERE a."organizationId" IS NOT NULL
    ORDER BY ms."createdAt" DESC LIMIT 50;
  `
})
```

For each such row, you'd want Stream's `custom.organizationId` set.
Backfilling is **out of scope** for an automated test — it requires
walking the result and calling `streamClient.video.updateCall` per
call. Document the gap if any rows lack the metadata.

For now this case is **observational** — note the count of missing-metadata
calls and flag if it's > 0.
