# ADR: DM eligibility, and taking channel creation away from the client

- **Status**: Accepted
- **Date**: 2026-08-15
- **Part of**: #1134 (follow-on), builds on #899, #981

## Context

A consultant reported being able to hold a conversation with themselves from
their own dashboard: searching two letters of their own name returned a row
labelled with their name, clicking it opened a thread, the thread accepted a
message, its header showed a raw `dm-<cuid>-<cuid>` id and "No members", and on
refresh the thread was gone.

Four symptoms, two defects, and neither of them is what the report sounds like.

**The label.** `app/api/stream/channels/search-appointments/route.ts` is
correctly scoped — the caller must be the consultee _or_ the consultant on every
row it returns — but it labelled every row `consultantName`. On a consultee's
dashboard that names the other party. On a consultant's it names the viewer. The
`channelId` underneath was always right and always pointed at the real
consultee; only the label lied. `ChannelSearch` then grouped rows by that name,
which is how one person's consultation and subscription collapsed into a single
row subtitled "Consultation & Subscription".

**The phantom channel.** `ChannelSearch` opened a result with
`client.channel(type, id).watch()` on an id the browser had computed. In
`stream-chat`, `watch()` posts to the channel _query_ endpoint — the same
endpoint `create()` posts to; `channel.create()` is literally
`query({ created_by_id })`. So watching an id that does not exist creates it,
and created that way with no `members` array the caller becomes `created_by` and
is **not a member**. That single fact explains the raw-id header (channelUtils
filters the viewer out of the member list, finds nobody, and falls through to
`channel.id`), the "No members", the message sending fine, and the disappearance
on reload (the sidebar lists `{ members: { $in: [me] } }`).

This reproduces identically against a stranger. The phantom is not a property of
the pair — it is a property of the id not existing.

The id did not exist because the three answers to "are these two people
connected?" disagreed:

|                                      | statuses                                                 |
| ------------------------------------ | -------------------------------------------------------- |
| `checkUserRelationship`              | APPROVED, SCHEDULED (+ subscription window open)         |
| `getDmPairsForUser` (the reconciler) | APPROVED, SCHEDULED                                      |
| the two search routes                | APPROVED, APPROVED_PENDING_PAYMENT, SCHEDULED, COMPLETED |

Search was widest, so it offered rows for bookings the create path had never
fired for. And `checkUserRelationship` — the only implementation of the rule,
with a full unit-test suite — had **zero production call sites**. Nothing
checked eligibility before a DM was created. `createDirectMessageChannel`
validated two non-empty strings: no session, no relationship query, not even
`a !== b`. It was safe by accident, because every caller happened to be a
booking-approval or payment-success path.

Underneath all of it, nothing in this repo has ever configured Stream's chat
permissions. The only `updateAppSettings` call is the webhook subscription
script, and it writes `event_hooks` alone. So `messaging` and `team` run on
Stream's defaults, which grant `create-channel` to the plain `user` role — which
is what made the browser's `watch()` succeed at all.

## Decision

### 1. Eligibility is "ever transacted", and permanent

A consultation or subscription that reached `APPROVED`,
`APPROVED_PENDING_PAYMENT`, `SCHEDULED` or `COMPLETED`, in either direction,
opens the thread and never closes it. (An earlier draft also counted a shared
non-deleted `SlotOfAppointment`; that group arm was removed before merge — see
§4 — because `/api/stream/channels/open` would have made it a user-reachable
path to consultee↔consultee DMs.)

`PENDING` is excluded: a request the consultant has not accepted is not a
relationship, or anyone opens a channel with anyone by requesting a booking they
never intend to pay for.

The scheduling-window filter on subscriptions is gone. A lapsed subscription is
still a relationship that happened, and gating on the window made a thread
unreachable at midnight on the renewal date — mid-conversation, with no notice,
and with the reconciler then classifying the channel stale and evicting both
parties from their own history.

Rejected: active-only (tightest, but threads go read-only mid-exchange) and
active-plus-grace-window (best privacy balance, but needs a dated freeze job for
DMs on top of the one that already exists for event channels — worth revisiting
when there is a retention requirement to satisfy).

`DM_ELIGIBLE_STATUSES` lives in `lib/stream/dm-eligibility-statuses.ts`, a pure
module with no Prisma import, and is the only definition. **It must move as one
unit**: `syncUserEventChannels` removes users from any managed DM channel absent
from the expected set it builds from that constant.

### 2. The client never names a channel

`POST /api/stream/channels/open` takes _who_ or _what_ to talk to — a
counterparty user id, or an event type and id — and re-derives the channel id
server-side from the caller's session. A client-supplied channel id would be an
authorization bypass by construction, since the id is a pure function of the two
user ids: anyone who can name a pair could name their channel.

Both arms are idempotent, and both create with the full member list atomically,
which is the whole difference from what `watch()` was doing.

`CreateChannelDialog` likewise stopped creating custom channels client-side —
that path bypassed the admin/staff-only gate in the create route entirely — and
`ChannelInfoAndManageDialog` now adds members through `addMemberToChannel`, the
server action that had been written for exactly this and never called.

### 3. Stream's own permissions back it up

`scripts/stream/ensure-chat-type-grants.ts`, modelled on the existing
`ensure-call-type-grants.ts`: dry-run by default, `--apply` to write,
`--restore-user-create` to roll back, and refusing to apply without
`--open-route-is-deployed`. It revokes `create-channel` and
`update-channel-members` from `user` and `guest` on both channel types, and sets
`user_search_disallowed_roles`.

`guest` matters as much as `user`: the app has
`guest_user_creation_disabled: false`, so guest sessions are creatable
client-side with nothing but the public API key shipped as
`NEXT_PUBLIC_STREAM_API_KEY`.

Unlike call types, channel types are hardened **in place** with no
grandfathering problem — grants are evaluated per request against the type, not
baked in at creation, so existing channels pick up the change.

### 4. Org scoping stays app-side

A pair keeps one thread per funding context: `dm-<a>-<b>` personal,
`dmo-<org8>-<pair16>` per organization. ADR 19 requires it — dashboards split by
org-ness, so one merged thread could not live in the right place — and it keeps
an org's sponsored conversations separable for export and retention.

Stream's native multi-tenant `teams` field was considered and is **not
available**: `docs/stream/14-pricing-and-cost-model.md` lists Multi-Tenancy /
Teams as an Elevate-tier feature, and this app is on the free Maker account. The
existing scheme — org in the channel key, `custom.organization_id` on the
channel, and the sidebar's `organization_id` filter — is the right approach
regardless, and costs nothing.

While registering this: `dmo-` and `dmh-` were never declared in
`lib/stream-channel-ids.ts`, and `"dmo-".startsWith("dm-")` is false. So
`getChannelTypeFromId` returned `"team"` for org DMs created as `messaging` (four
call sites addressed the wrong type), `isDMChannel` answered false for two of the
three forms, and the reconciler never saw them at all.

## Amendment, same day: the eager sync is retired

Widening `DM_ELIGIBLE_STATUSES` to include `COMPLETED` had a consequence this
ADR did not think through. `COMPLETED` is an absorbing state, so
`getDmPairsForUser` no longer returns _currently active_ work — it returns every
consultation or subscription the consultant has ever finished. Neither query
carries a `take`, and `syncUserEventChannels` made a Stream API call per pair,
five at a time, on every cold dashboard load. A consultant with 500 completed
bookings would pay 100 serial waves in the background of every visit, growing
forever.

The add pass is therefore gone. `syncUserEventChannels` now computes the
expected set and runs the **reconcile-and-remove** pass only. Creation moved to
where it is actually needed: `POST /api/stream/channels/open` provisions the one
channel someone opens, at the moment they open it, and booking approval and
payment success still provision eagerly at transaction time.

The removal half cannot move to an on-demand path — nothing else notices that a
membership _ought_ to be revoked — which is why it stays on the sync.

The trade: a user who has lost membership to a channel that still exists is no
longer silently re-added on load. They recover by opening the conversation from
search, which routes through `/open`. `addUserToDmChannel` was deleted with the
pass; it duplicated `createDirectMessageChannel` and, unlike it, ran no
eligibility check.

This does **not** change the eligibility rule. Ever-transacted still governs who
may hold a DM; it simply no longer governs how many channels get provisioned
speculatively.

## Consequences

`checkUserRelationship` no longer swallows errors into `false`. That read as
fail-closed and behaved as the opposite: harmless for an unused advisory flag,
wrong for a gate, and actively dangerous on the reconcile path where a transient
blip would make a live channel look unexpected.

`searchUsersWithRelationships` now filters instead of ranking. `hasRelationship`
was a sort key, so a two-character query returned every matching user on the
platform — name, email, avatar, role — with connected ones merely listed first.

The gate's original draft had a GROUP ARM: any two attendees of the same
event slot were mutually eligible, on the theory that no code path offered a
consultee a way to open a DM. Review proved that self-refuting — this PR's own
`POST /api/stream/channels/open` is exactly such a path, and attendee ids are
readable from team-channel member state. The arm was removed from
`canDirectMessage` and from `searchUsersWithRelationships`' related-user
builder before merge; peer DMs remain blocked per the 2026-07-11 ADR. If a
"message the host" affordance is ever wanted, reintroduce it behind an explicit
host-check, never blanket co-membership.

Named follow-ups, none of which this change makes worse: there is still no path
that pushes a name or avatar change to Stream (only the 5-minute TTL cache
expiring, incidentally); `restoreStreamAccess` was written with zero callers, so
there was no unban path — #1270 gave it one, see
`docs/decisions/2026-08-30-moderation-truthfulness.md`; and dev, preview and
production still share one
Stream app (#1134 P0-6), which is why the grants script defaults to a dry run.
