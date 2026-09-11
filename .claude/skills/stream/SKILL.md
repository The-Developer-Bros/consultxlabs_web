---
name: stream
description: Work on this repo's Stream.io integration — chat channels, video calls, tokens, webhooks, recordings, moderation, and the crons around them. Use when the user says "stream", "chat channel", "DM channel", "meeting", "video call", "call type", "stream token", "recording", "attendance", "no-show", "webhook not firing", or is touching lib/stream/, lib/stream-*.ts, actions/stream/, app/api/stream/, app/meetings/, or components/chat/.
---

# Stream SDK

Two products under one API key: **Stream Chat** (`stream-chat`, `stream-chat-react`) and
**Stream Video** (`@stream-io/video-react-sdk`, `@stream-io/node-sdk`). They share a user store,
a JWT signing secret, and a token-revocation flag — but bill separately (Chat by MAU, Video by
participant-minute).

Full audit and remediation plan: **issue #1134**.

## Verify against the live app before believing the code

This subsystem has repeatedly looked correct in code and been broken in production. Static
reading is not enough. Before claiming anything works:

```text
mcp__streamio__video_query_calls    {"ended_at": {"$exists": false}}
mcp__streamio__chat_query_channels  {"type": {"$eq": "messaging"}}
mcp__supabase__execute_sql          -- count MeetingSession/MeetingAttendance/WebhookEvent
netlify env:list --json | jq -r 'if type=="object" then keys[] else .[].key end'  -- keys only, never values
```

The 2026-08-12 audit found a **total, never-once-worked webhook outage** that no amount of code
reading would have surfaced: the handler was correct, the secret was simply not set in Netlify.

## Hard rules

**Never derive an ID with `localeCompare`.** It is ICU- and locale-dependent, so two environments
can produce different IDs from the same inputs. Use code-unit ordering: `a < b ? [a, b] : [b, a]`.
A commit that "standardized" this to `localeCompare` silently re-keyed every mixed-case DM pair and
orphaned their history. Channel-ID helpers live in `lib/stream-channel-ids.ts` and
`lib/stream-utils.ts` — all pattern detection goes through them, and the ceiling is 64 chars.

**Always pass `iat` when minting a token.** The signature is `createToken(userId, exp, iat)`.
Stream treats a token with no `iat` as **invalid** once `revoke_tokens_issued_before` is set for
that user — so an `iat`-less token plus one ban equals a permanent lockout. Un-revoking is explicit:
`revokeUserToken(id, null)`, and a deactivated user also needs `reactivateUser(id)`.

**Video tokens are APP-WIDE, by decision.** This rule used to say "scope video tokens to the call
with `generateCallToken({ call_cids })`". That wrapper was written and then deliberately removed —
`lib/stream-client.ts:117-122` explains why: the video client is an app-wide singleton holding one
user token, so per-call tokens would mean a second client per meeting. Access control is instead
call-type grants (`user`/`guest` do not hold `join-call`, `call_member` does) plus the server-side
membership `POST /api/meetings/[meetingId]/join` writes after `resolveMeetingAccess` passes.
**Always pass `iat`**, per the rule above. App-side checks alone are not access control; Stream's
server API deliberately bypasses its own permission system.

**Webhooks must ack first.** Stream retries within a **15-second total budget** (6s per attempt) and
then drops the event forever. Verify the signature, persist the `WebhookEvent` receipt, acknowledge,
then process in `after()`. Stream signs with the **API secret**; there is no separate signing secret.

**Dedup on `sha256(body)`, NOT on `X-Webhook-ID`.** This rule used to say the opposite. The header is
not covered by the signature — Stream signs the body only — so one captured `(body, signature)` pair
replays under N invented header values and mints N dispatches from one verified delivery. The body
hash collapses genuine retries (byte-identical) and separates genuine events (they differ somewhere),
which is everything the header was wanted for. See `app/api/stream/webhooks/route.ts:183-201`;
Razorpay made the same trade for the same reason.

**Use the SDK's `verifySignature(body, signature, secret)`**, not a hand-rolled `createHmac` +
`timingSafeEqual`. Do **not** reach for `verifyAndParseWebhook`: it returns only the parsed `Event`
and not the uncompressed bytes, so the dedup key above would have to be re-derived by re-serialising —
and `JSON.stringify` is not byte-stable.

**`call_cid` is `type:id`.** Split it in exactly one helper. Sites that forget produce silent 404s
that get recorded as `UNVERIFIED` completions.

**Never `await` a Stream call inside a DB transaction**, and never leave channel provisioning as
`void (async () => {…})()` — the Lambda can freeze before it settles. It needs an outbox.

**Versions are pinned EXACTLY** since #1282 — no carets. `@stream-io/video-filters-web` is a hard
dependency of the video SDK and is already on disk, so background blur needs no install; only
`@stream-io/audio-filters-web` does, and that one is a **paid** add-on billed per participant-minute.
`noise_cancellation` on the `default` call type is **`available`**, not `auto-on` — #1285 changed it
precisely so that shipping Krisp does not start the meter by itself. Deliberate version holds are
recorded in **#1283** (`node-sdk` 0.8.x, `stream-chat-react` v14, `stream-chat` v10).

**The CSP blocker for filters is `connect-src`, not `worker-src`.** Both filter
packages fetch WASM and models from `unpkg.com` at runtime unless `basePath` is
set. Neither constructs a `Worker`; Krisp uses an AudioWorklet, which CSP checks
under `script-src`.

## Where things live

| Concern                                                | File                                                                                                                                                                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server clients + tokens + Stream's OWN circuit breaker | `lib/stream-client.ts`                                                                                                                                                                                                             |
| Token server actions (session-bound)                   | `actions/stream/chat/stream.action.ts`                                                                                                                                                                                             |
| Channel create / membership                            | `actions/stream/chat/channel.action.ts`                                                                                                                                                                                            |
| Lazy channel sync + reconcile                          | `actions/stream/chat/event-channel.action.ts`                                                                                                                                                                                      |
| Channel ID derivation                                  | `lib/stream-channel-ids.ts`, `lib/stream-utils.ts`                                                                                                                                                                                 |
| Call creation                                          | `lib/meeting.ts`, `actions/stream/meetings/meeting.action.ts`                                                                                                                                                                      |
| Client connection (store, not wrapper)                 | `providers/StreamProviderImpl.tsx`, `lib/stream/connection-store.ts`                                                                                                                                                               |
| Webhooks                                               | `app/api/stream/webhooks/route.ts` → `lib/stream/webhook-dispatch.ts` → `lib/stream/{session,recording}-handlers.ts`                                                                                                               |
| Recordings                                             | `lib/stream/recording-service.ts`, `recording-transfer-service.ts`                                                                                                                                                                 |
| Replay marketplace (#366)                              | `lib/data/recordings-explore.ts`, `app/api/stream/recordings/[recordingId]/{publish,preview}`, `app/api/recordings/[recordingId]/purchase`, `lib/payments/webhooks/recording-purchase.ts`, `docs/stream/recordings-marketplace.md` |
| Media teardown                                         | `lib/stream/media-teardown.ts`                                                                                                                                                                                                     |
| Crons                                                  | `.github/workflows/stream-sync.yml`, `mark-expired-recordings.yml`, `transfer-expiring-recordings.yml`, `cleanup-old-stream-recordings.yml`                                                                                        |

Prisma: `MeetingSession` (1:1 with `SlotOfAppointment`, `streamCallId` unique),
`MeetingAttendance` (unique on session+user), `Recording`. **No chat state is stored in Postgres** —
channels live only on Stream, which is why a bad channel-ID derivation is unrecoverable data loss.

## Traps that have bitten before

- **`ssr: false` skips the component _and its children_.** The provider must render `null` as a
  sibling of `children` and publish to a store, never wrap them — wrapping cost the whole dashboard
  its server-rendered HTML and caused a remount storm.
- **Changing the element type at a position remounts the subtree.** Commit both clients at once.
- **`queryChannels` is capped at 30 per call**, not whatever `limit` you pass. A `do…while
(page.length === PAGE_SIZE)` loop with `PAGE_SIZE = 100` exits after one page and silently
  reconciles only the first 30 memberships.
- **In-memory caches are per-process** and near-useless on serverless; module-level `Set`s used as
  dedup guards grow unbounded.
- **Stream and Redis have SEPARATE breakers** since #1280. They shared one, so five Stream failures
  opened the breaker booking-lock acquisition also went through — a video outage stopped checkout,
  and a Redis outage reported as "Video is temporarily unavailable". Take an instance from
  `createCircuitBreaker(name)` for any new backing service; do not reuse `withCircuitBreaker`, which
  is Redis's.
- **A breaker fallback SWALLOWS the rejection.** `withCircuitBreaker(op, () => x)` returns `x`
  instead of throwing, so a `catch` that was meant to record the failure never runs. Omit the
  fallback and catch, when the point is to degrade _and_ report.
- **`upsertUsers` and `channel.create()` take the whole member array in one request.** Chunk them
  before a 100+ attendee webinar.
- Test with `mcp__streamio__*` against the shared app carefully — **dev, preview and prod currently
  share one Stream app**, so a "test" deletion is a real deletion.

## Docs

`docs/stream/` — 19 files. `03-provider-authentication.md` and `troubleshooting.md` are the freshest
and most reliable. Several others still describe NextAuth and a `streamCallId` format that has not
been used for months; #1134 PR J fixes them. Trust the code over the docs until then.
