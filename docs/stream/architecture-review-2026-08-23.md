# Stream Integration — Architecture Review (HLD + LLD)

**Date:** 2026-08-23 · **Branch reviewed:** `perf/stream-chat-load` · **Method:** 4 parallel deep-dives (cross-cutting/security, server chat core, client chat, video/meetings) + live latency probing.
**Scope:** every file under `lib/stream*`, `actions/stream/**`, `app/api/stream/**`, `app/api/meetings/**`, `app/meetings/**`, `components/chat/**`, `providers/Stream*`, `hooks/useChatUnreadCount.ts`, `jobs/stream/*`, `scripts/stream/*`, `.github/workflows/*stream*|*expire*|*recording*`.

Severity roll-up: **3 HIGH · 9 MED-HIGH/MED · 9 LOW/INFO**. All three HIGH findings are actionable this week.

> **Status addendum (2026-08-30):** this is a dated snapshot and is left
> unmodified below, but one part of it has since been superseded. #1270 moved
> call creation out of the browser entirely, so where §1.3 “Meeting lifecycle” says "First Join mints
> deterministically (`getOrCreateAppointmentMeeting`)" the mint is now the
> server action `provisionAppointmentMeeting`, the call's author is the
> appointment's host rather than whoever clicked, and members are named
> `call_member` at creation instead of `host`/`user`. Ending a call for everyone
> also moved to `POST /api/meetings/[meetingId]/end`. See
> `docs/decisions/2026-08-30-server-side-call-creation.md`.

---

## 1. HLD — what the system is

Stream hosts two products behind one API key: **Chat** (MAU-billed) and **Video** (participant-minute-billed). Postgres stores *no chat state and no call media* — Stream is the system of record for messages/calls; Postgres (`MeetingSession`, `MeetingAttendance`, `Recording`) is the system of record for *entitlements, scheduling truth, and recording metadata*. Everything else is projections.

```text
                    ┌──────────────────────────────────────────────┐
  Browser ────WS──▶ │ Stream edge (chat WS + video SFU)            │
    │               │   primary region: ??? ← 253–395ms RTT probe  │
    │ token         └───────────────▲──────────────────────────────┘
    ▼                               │ REST (server key only)
 Next.js (Netlify functions)        │
  ├ providers/StreamProvider ─ dynamic(ssr:false) connector
  │   ├ token prefetch → connectUser(chat WS) + StreamVideoClient
  │   ├ fire-and-forget syncUserEventChannels (membership reconcile)
  │   └ publishes to connection-store (module store + useSyncExternalStore,
  │     null-SIBLING render — #248 remount-storm architecture)
  ├ "use server" actions (chat channels/users)  ← ⚠ some ungated (F-HIGH-*)
  ├ API routes: /api/meetings/[id]/join (sole membership grantor),
  │             /api/stream/webhooks (verify→persist→200→after()),
  │             /api/stream/recordings/*, org-scoped read routes
  ├ lib/stream/* : clients+breaker, channel-id math, caches, batch/pacing,
  │               consent, call-cid, media-teardown, transfer service
  └ jobs/ + GH-Action crons: expire-event-channels (freeze→delete),
      webhook sweeper, orphaned-session reconciler, user sync, recordings

 Supabase Postgres (Prisma): Appointment/SlotOfAppointment (truth),
   MeetingSession(1:1 slot, streamCallId unique), MeetingAttendance,
   Recording, WebhookEvent(outbox-ish), Webinar/Class.chatFrozenAt ledger
```text

### 1.1 Channel taxonomy & ID discipline

`lib/stream-channel-ids.ts` + `lib/stream-utils.ts` are the single source of ID truth: `dm-<a>-<b>` / `dmo-<org16>-<pair24>` / `dmh-<hash>` (personal DMs, byte-order pair sort — `localeCompare` banned after incident P0-3), `webinar-*`/`class-*` (team), `collab-*` (host+collaborators). Legacy `consultation-/subscription-` prefixes are resolve-only, deliberately unmanaged so survivors aren't swept. 64-char ceiling enforced by deterministic hashing (`fitOrHash`), not validation (`channelIdSchema.min(1)` never enforces it).

### 1.2 Channel lifecycle (state machine)

```text
absent ──lazy create-on-miss (addMembers 404→atomic create)──▶ live
absent ──payment webhook / booking approval / collab accept──▶ live
live   ──+7d after last slot ends──▶ frozen (ledgered via chatFrozenAt)
frozen ──+retentionDays (org dial, default 90)──▶ hard-deleted (bulk 100)
live   ──maintenance OFFLINE──▶ frozen (DMs exempt) ──ONLINE exit──▶ unfrozen
```text
Membership is **Postgres-authoritative projection**: expected set rebuilt from plan/slot rows each sync; immediate writes on webhook/approval/removal; nightly cron owns freeze/delete.

### 1.3 Meeting lifecycle

No room exists at booking. First Join mints deterministically: `slot-<anchorSlotId>` (`getOrCreateAppointmentMeeting`), anchor resolved by reusing the run-grouping helper (#1061). `/api/meetings/[id]/join` is the **only** grantor (authn → banned → entitlement union → getOrCreate repair → `updateCallMembers(call_member)`). End paths (session timeout, explicit end, maintenance drain, orphan reconciler) all converge on one guard: **skip if `endedAt` already set**. Recordings: capability+consent-gated start (race-safe atomic claim), webhook-driven lifecycle, Supabase transfer with retry+page-after-3, retention tombstone cron.

---

## 2. LLD — contract highlights worth knowing

| Layer | Contract | Notes |
|---|---|---|
| Webhook route | HMAC over raw body, constant-time compare, secret = `STREAM_WEBHOOK_SECRET \|\| STREAM_API_SECRET`; persist receipt **before** 200; handler in `after()`; `X-Webhook-ID` idempotency | 10 event types handled; compile-time exhaustive dispatch |
| Circuit breaker | Shared Redis breaker (5 fails/30s reset/half-open 3); expected errors (404/code16, 429 post-incident) neither trip nor page | One breaker serves BOTH redis-lock ops and Stream ops — see F-MED-1 |
| Server actions | `upsertUserToStream` cached 5min; creators stamp `organization_id`; `removeUserFromEventChannel` returns `{success:false}` instead of throwing | Several exports have **no session gate** — F-HIGH-1/F-MED-6 |
| Client store | Module snapshot + `useSyncExternalStore`; stable server snapshot; bail-on-no-op writes | Prevents SSR skip + element-type-change remounts |
| Video join | Always `call_member` (a `host` role would lock out — zero grants exist); host-ness from `custom.consultantUserId` | Call type hardened: `user` has NO join-call; script refuses `--apply` until join route deployed |
| Attendance | Sole writer = participant webhooks; `(meetingSessionId,userId)` upsert, immutable `firstJoinedAt` | No-show detection consumes it — webhook outage ⇒ attendance loss |

---

## 3. Findings register

### HIGH

**F-HIGH-1 · Ungated `"use server"` exports combine authz gap with unbounded billing-metered fan-out.**
`initializeAllChannels()` (`actions/stream/chat/channel.action.ts:516`) and the whole `create*Channel` family (:63,:161,:196,:277,:360,:436,:701) are exported from `"use server"` with **no session check** — any client can mint arbitrary channels/memberships or trigger a full-DB upsert+create storm (batches of 10 parallel, no pause, no cap). The repo's own standard ("any client can reach this function directly", `meeting.action.ts:616`) demands gating. Fix: `requireSession`/role checks at each export, delete dead exports (`initializeAllChannels` has zero production callers).

**F-HIGH-2 · Deleted channels resurrect, and resurrected ones can never re-freeze.**
`getWebinarIdsForUser/getClassIdsForUser` have no date/status filter, so after the retention cron hard-deletes a channel, the next dashboard sync re-creates it with the full historic roster — and because `chatFrozenAt` was stamped pre-delete, the ledger classifies the resurrected channel as already-frozen. It stays writable forever and its membership regrows unbounded. Fix: exclude events past retention from the sync expected-set (same window math as the cron), or clear `chatFrozenAt` on delete.

**F-HIGH-3 · Concurrent first-join races produce duplicate-create failures that fail real user journeys.**
Two simultaneous first joins both miss `addMembers`, both build roster and call `create()`; loser throws (payment-webhook path fails that attendee inline). Same shape in DM sync and `createCollaboratorChannel` (docstring claims idempotent; nothing enforces it). Fix: catch duplicate-create (Stream code 17?) and adopt the existing channel, mirroring `createDbMeetingSession`'s P2002 handling.

### MED-HIGH / MED

- **F-MED-1 · Cross-subsystem breaker coupling.** One module-level breaker guards both Redis lock ops and all Stream ops; 5 genuine Stream failures open it, making fail-closed crons page `CronLockUnavailableError` misattributing Stream outages to Redis, and fail-open crons silently skip. Separate namespaces or breakers.
- **F-MED-2 · Lazy-create paths omit `organization_id`** (`event-channel.action.ts:176-186,887-892`) while explicit creators stamp it — the common birth path produces channels invisible to org-scoped queries; also forces the manual backfill script to exist.
- **F-MED-3 · Batch-of-5 sequential sync at scale** (~40 rounds ≈ 8–20s for a consultant with 200 clients) plus per-user consent N-queries in `upsertUsersToStream`. Backgrounded today (#1134 P1-19) but still serverless wall-clock risk.
- **F-MED-4 · Unbounded offset pagination** in the sync stale pass (`do…while page===100`) — offset ceiling + memory growth for heavily-connected users.
- **F-MED-5 · `getChannelTypeFromId` misclassifies `dmo-`/`dmh-` as `team`**, and `dmh-` isn't in MANAGED prefixes → hashed DM memberships never swept; `addMemberToChannel` default type wrong for those ids.
- **F-MED-6 · `syncUserEventChannels(userId, force)` remotely invocable with arbitrary userId** (no session check) — repeatable Stream spend + forced reconciliation keyed off guessed ids.
- **F-MED-7 · Privileged `addMemberToChannel` bare-create lacks `created_by_id`** — documented server-side requirement; likely throws on nonexistent channel. Dead export today; fix or delete.
- **F-MED-8 · Ops/config posture:** no startup config validation (preview deploys fail at first user action, not deploy); Stream cron jobs absent from `MONEY_CRITICAL_JOBS` (Slack-only outage degrades them to unreadable logs); broken `package.json` `stream-sync` script path (`jobs/stream-sync.ts` doesn't exist).
- **F-MED-9 · Non-consenting users dropped from upsert but still listed as members** in atomic creates — one withdrawn-consent attendee can fail creation for an entire webinar cohort.

### LOW / INFO (condensed)

Unhandled webhook events keep only their durable receipt (identity + payload + signature logged by `webhook-dispatch.ts` before dispatch) but no recorded processing outcome · unpaced `backfill-channel-org.ts` shares the paced consumers' budget · positive-only existence caching · dead/deprecated exports on the server boundary (`searchUsers` PII search) · per-process caches near-useless on serverless (documented) · `membershipCache:false` written even on failed removal (documented trade-off, consumers must trust `true` exclusively) · breaker metrics log-only · "reconcile cron catches mid-sync tab close" comment references a cron that doesn't exist (client provider is the only driver) · HEAD verification endpoint unsigned.

### What is genuinely strong (keep doing this)

Ack-first webhook durability with claim semantics + sweeper; the #1134 P0 series (ID discipline, secret fallback, role stripping); grants/subscription scripts engineered like production migrations (dry-run defaults, pre-image dumps, deploy gates, post-write verification); pacing doctrine + freeze ledger; the #248 remount-storm architecture; race-safe recording claims; exhaustive webhook dispatch; 25 focused test files pinning exactly the historical failure modes.

### Docs debt

`docs/stream/02` (phantom `STREAM_SYNC_SECRET`), `05` (old `streamCallId` format, removed client-side getOrCreate), `09/10` (dead paths/routes, NextAuth remnants), `13` (wrong signing-secret story — Stream signs with API secret; handler table lists 6/10 events). README self-aware ("code is correct, docs drifted").

---

## 4. Recommended sequence

1. **This week (small diffs):** gate/delete F-HIGH-1 exports; resurrection filter (F-HIGH-2); duplicate-create adoption (F-HIGH-3); fix `package.json` stream-sync path; stamp `organization_id` in lazy creates (kills the backfill script permanently).
2. **Next sprint:** split breaker namespaces; cap stale-pass pagination; classify `dmo-`/`dmh-`; session-check `syncUserEventChannels`; add Stream jobs to ops-critical list; refresh docs 02/05/13.
3. **Ops track (parallel):** Dashboard region check → Stream support conversation (253–395ms RTT dominates everything); schedule `ensure-webhook-subscription` drift detection; startup config validation.
