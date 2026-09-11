# ADR: `resolveMeetingAccess` returns what it loaded, as a discriminated union

- **Status**: Accepted
- **Date**: 2026-08-13
- **Author**: teetangh
- **PR**: `fix/stream-review-tail` → `dev` (#1149)
- **Part of**: #1134

## Context

`resolveMeetingAccess` in `lib/meetings/access.ts` is the single answer to "may
this user join this meeting". It was introduced by #1136 to close P0-1, where
the only gate on a video call was a React conditional while the Stream token
authorized every call in the application. Three routes now share it: the join
gate, the read-only `validate-access` probe, and both recording-consent
handlers.

To answer the question it loads the meeting session together with its slot, the
joined users, and all four plan relations, because deciding whether the caller
is the host requires knowing which consultant profile owns the appointment. It
then returned a small verdict object and discarded everything else it had read.

Two problems followed from that, and both were found in review rather than in
production.

### The data was loaded and then thrown away

Both recording-consent handlers needed the appointment in order to decide what
notice to show. Since the resolver did not hand it back, each handler ran its
own `prisma.meetingSession.findUnique` immediately after the access check,
against the same row, by the same unique key. Every consent request therefore
paid for two loads of one row. On a serverless deployment where `PG_POOL_MAX`
is 1, those queries serialize, so the second load is latency the user waits
through rather than work done in parallel.

### The verdict shape did not say what was actually true

The interface carried optional fields with a comment explaining when they were
present:

```ts
export interface MeetingAccess {
  hasAccess: boolean;
  role: MeetingRole;
  message: string;
  reason: MeetingAccessReason;
  /** Present only when the meeting exists, regardless of the access verdict. */
  streamCallId?: string;
}
```

A comment is not a constraint. Any caller that wanted `streamCallId` had to
either re-check for undefined in a branch where it could not be undefined, or
write a non-null assertion and hope the comment stayed true. This is the same
class of problem as the one immediately above it in the same file: `reason` was
added by #1136 precisely because two routes had been choosing between a 404 and
a 403 by comparing `message` against the literal string `"Meeting not found"`,
and the docblock warning callers not to do that did not stop the consent
handlers from doing exactly that anyway. Written conventions in this file have a
demonstrated track record of not being followed.

## Decision

**The resolver returns the appointment and the session id it already loaded, and
`MeetingAccess` becomes a discriminated union rather than one interface with
optional fields.**

```ts
interface MeetingNotFound {
  hasAccess: false;
  role: null;
  message: string;
  reason: "not_found";
}

interface MeetingResolved {
  hasAccess: boolean;
  role: MeetingRole;
  message: string;
  reason: "granted" | "unauthorized";
  streamCallId: string;
  meetingSessionId: string;
  appointment: MeetingAppointment;
}

export type MeetingAccess = MeetingNotFound | MeetingResolved;
```

Narrowing on `hasAccess` eliminates `MeetingNotFound`, because its `hasAccess`
is the literal `false`. What survives is `MeetingResolved`, where the three
fields are not optional. "Present only when the meeting exists" stops being a
comment and becomes something the compiler enforces.

`MeetingAppointment` is inferred from the resolver's own query rather than
hand-written, so the type cannot drift from what is actually selected:

```ts
type ResolvedMeetingSession = NonNullable<
  Awaited<ReturnType<typeof loadMeetingSession>>
>;
export type MeetingAppointment =
  ResolvedMeetingSession["slotOfAppointment"]["appointment"];
```

Supplying the appointment required `recordingEnabled` on each of the four plan
selects. This is worth stating precisely, because it is the part that could have
been a regression: the four plan relations are **already joined** for the
ownership test. Adding a column to an existing join changes neither the number
of queries nor the number of rows. It is not a widened fetch.

## Consequences

### Positive

- Both consent handlers lost a full database round trip each. On this
  deployment those queries serialize, so the saving is wall-clock latency on a
  request the user is waiting on in a lobby.
- The `access.message === "Meeting not found"` comparison is gone from the two
  handlers that still had it. Rewording a user-facing string can no longer flip
  a 404 into a 403.
- Callers that need the appointment get it non-optionally, so no site needs a
  non-null assertion to use it.
- Future callers cannot reintroduce the duplicate load without deliberately
  ignoring a field that is already in their hand.

### Negative

- `MeetingAccess` is no longer a single interface that can be read at a glance,
  and a caller wanting `streamCallId` without first narrowing on `hasAccess`
  now gets a type error where it previously compiled. That error is the point,
  but it is friction at the call site.
- The resolver's return type is now coupled to its query. Removing a field from
  the select is a breaking change to consumers, which is stricter than before
  and will be noticed at build time rather than at runtime.

### Neutral

- The union has two members today. If a third verdict shape is ever needed —
  for example a meeting that exists but has been cancelled — it is added as a
  third member rather than as two more optional fields.

## Alternatives considered

### Keep optional fields and use non-null assertions at the call sites

Rejected. This is what the code already did, and the file's own docblock
warning about `message` comparisons demonstrates that a written instruction in
this file does not reliably prevent the thing it warns about. An assertion also
moves the failure from compile time to runtime, in an authorization path.

### Keep a separate loader function for the appointment

Rejected, because this is literally what was there. The removed
`loadAppointment` helper in the consent route was a well-factored, clearly named
function that existed solely to re-read a row the caller had just read. Naming
the duplicate work does not stop it being duplicate work.

### Widen the select without introducing the union

This would have removed the second query while leaving the shape dishonest —
`appointment?: MeetingAppointment | null` next to a comment promising it is
present. It captures the performance benefit and none of the correctness one,
and it leaves the next caller writing the same non-null assertion. The union is
the cheaper half of the change and the half that keeps paying.

### Return a `Result`-style wrapper rather than a union on `hasAccess`

Rejected as a larger refactor than the problem justifies. There are three
consumers, all of which already branch on `hasAccess` as their first statement,
so narrowing on that field fits the code as written rather than asking every
caller to adopt a new idiom.

## Follow-ups

- The attendee ceiling on group admissions is still absent from the join route.
  The rate limit is in place at the edge (`middleware.ts`, the
  `stream: meeting join` rule), but nothing caps how many people may be admitted
  to one call. Tracked in #1146.

## References

- #1134 — the Stream SDK audit that produced this work.
- #1136 — introduced `resolveMeetingAccess` and the `reason` field.
- #1149 — this change.
- #1146 — the remaining-items tracker for the train.
