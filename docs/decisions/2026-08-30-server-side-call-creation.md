# ADR: the server creates the call, and owns it

- **Status**: Accepted
- **Date**: 2026-08-30
- **Part of**: #1270. Reverses part of the #1134 P0-2 decision; builds on #1061, #1070, #1077, #1271, #1272.

## Context

Until this change, the Stream video call for a booking was created in the
browser. `getOrCreateAppointmentMeeting` in `lib/meeting.ts` took the
signed-in user's own `StreamVideoClient`, built a `Call` handle for
`slot-<anchorSlotId>` and ran `getOrCreate` with a payload the browser had
assembled. Six dashboard surfaces called it, plus four more through
`useLazyJoinMeeting`, and every one of them ran as whoever had pressed Join.

That arrangement was not a shortcut anybody chose on its merits. It was simply
where the code started, and each subsequent fix worked around it rather than
moving it. Four consequences accumulated.

**Ownership went to whoever clicked first.** Stream records a `created_by` for
every call, and on a client-side `getOrCreate` that is the connected user. For
roughly half of all sessions the consultee arrives first, so Stream's own record
of who owns the room contradicted the product's. Everything that reads
authorship from Stream — the dashboard, a recording listing, any future
per-owner API — was reading the wrong person.

**Every field of `custom` was authored by a browser.** That includes
`consultantUserId`, and `consultantUserId` is not decoration: `useSessionInfo()`
derives `isHost` from it, and `isHost` is what decides whether the "End for
everyone" control renders. The value that gates the most destructive action in
the meeting UI was being written by the least trusted party in the system. It
also includes `organizationId`, the audit tag on `MeetingSession`.

**Authorization ran after the write.** The entitlement check lived in
`createDbMeetingSession`, which runs _after_ `call.getOrCreate`. A caller with
no connection to a booking was refused the database row and still left a real,
billable Stream room behind that nothing would ever point at or clean up.

**Minting a room turned the camera on.** `getOrCreate` applies the call type's
device settings, and this type has `camera_default_on` and `mic_default_on`, so
merely creating a room opened capture — on the dashboard, from a `Call` handle
that was function-local and never returned. #1271 had to add a
`releaseLocalMedia` call in a `finally` to put the recording indicator out.

There was also a second, independent creation path.
`POST /api/meetings/[meetingId]/join` calls `getOrCreate` itself, server-side,
to repair a `MeetingSession` row whose Stream call does not exist. So the same
call id already had two authors and two stories about who made it.

## Decision

Creation moves to a server action, `provisionAppointmentMeeting` in
`actions/stream/meetings/meeting.action.ts`. It takes one argument — a slot —
and returns either the Stream call id or a refusal. `lib/meeting.ts` keeps its
name and its place in the join flow, but is now a thin wrapper: it calls the
action, re-throws a refusal as a user-facing error for the toast boundary, and
returns the id the browser navigates to. It imports no SDK and constructs no
`Call`.

Four properties follow, and they are the point of the change.

The call's author is the **appointment's host**, resolved from
`resolvePlanOwnerIds` rather than from who is holding the mouse. When no host
can be resolved at all the caller is used instead and the fallback is logged,
because a session with an unresolvable owner still has to be joinable.

The call's `custom` data is **read from the same rows the entitlement gate
reads**. Nothing a browser supplies reaches Stream. The title, the offering, the
session bounds, the two sides' names and ids, and the organization tag are all
derived server-side. Callers still pass a slot, because the anchor-resolution
fallback in #1061 depends on the row the surface actually had.

**Entitlement is checked before the Stream write**, not after it. A caller with
no connection to the booking now leaves nothing behind anywhere.

**Nothing client-side opens the camera to create a room.** The `releaseLocalMedia`
workaround #1271 added to `lib/meeting.ts` is deleted along with the `Call`
handle that made it necessary; teardown on the real join paths under
`app/meetings/[id]` is untouched.

Two related decisions ship with it.

Members are named `call_member` at creation, for both sides. They used to be
`host` for the consultant and `user` for everyone else, which was worse than
doing nothing: the live `default` call type has six role keys and `host` is not
among them, so those consultants held no grants at all, and `user` loses
`join-call` the moment `scripts/stream/ensure-call-type-grants.ts` is applied.
Host-ness in the UI has always come from `custom.consultantUserId`, never from
the Stream role, so nothing is lost by making the role uniform.

Ending a call for everyone moves to `POST /api/meetings/[meetingId]/end`. The
route re-resolves access from the database and requires the hosting side —
the plan owner or an accepted collaborator. `EndCallButton` posts to it instead
of calling `call.endCall()`.

## Consequences

This reverses part of the #1134 P0-2 decision, and it is worth being precise
about which part. P0-2 removed a `getOrCreate` that ran from a React effect on
the meeting page, _racing_ the access check, so an unauthorized visitor became
`created_by` of a call that should not exist. That removal stands and is
reinforced here. What P0-2 left behind was the dashboard-side mint, which it
never examined — and which had the same defect in slower motion. Creation is
still forbidden before authorization; it is now forbidden in the browser at all.

The mint is one server round trip instead of five. It used to be five separate
server-action calls from the browser (anchor, existing session, refusal check,
call profile, database write) with the Stream write in the middle.

The mint now performs one extra entitlement read on the create-only branch,
because the hoisted check and `createDbMeetingSession`'s own check are both
retained. The write gate is deliberately not weakened: it is the authoritative
one, and it is reachable directly as a server action.

`custom.title` changes shape for surfaces that used to supply a booker name from
their own payload. The title is now built from the server-resolved guest name,
which for a 1:1 booking is the same person. Existing calls keep the title they
were minted with; Stream's `getOrCreate` does not rewrite `custom` on a call
that already exists.

Two operational prerequisites are created, and neither is executed here.
`scripts/stream/backfill-call-member-role.ts` must be applied before
`ensure-call-type-grants.ts`, because every call minted before this change has
members holding a role that will stop admitting them. The grants script now
refuses to `--apply` until at least one member of an open call holds
`call_member` — its previous post-apply guard only checked that the _grant_
existed on the role, which is true by construction and says nothing about
whether anybody holds it. That was a green run away from a total video outage.

`end-call` is still granted to `call_member`. Revoking it is now possible, and
is deliberately left for a later run, on the same rule as the join-call move:
it may only be applied once the `EndCallButton` that posts to the new route is
deployed and serving traffic. Until then any participant can still end a call
from devtools, which is the state this change makes fixable rather than the
state it fixes.
