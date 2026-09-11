# ADR: Moderation enforcement design (#693) and the consultee↔consultee chat block

- **Status**: Accepted
- **Date**: 2026-07-11
- **Author**: teetangh
- **PR**: `feature/moderation-actions-693` → `dev`
- **Part of**: #693, #899, #725, #734

## Context

Staff moderation actions were write-only theatre: the action route created a `ModerationAction` row, flipped the report status, and then hit a `// TODO` where every side-effect should have been. A "banned" user kept their session, their Stream chat and video access, their upcoming appointments, and their pending payouts. Issue #693 flagged this as the highest-severity item in the backlog, and the 2026-07-10 triage ranked it the first launch blocker (that triage document was deleted with `docs/roadmap/` in #1535; its verdicts live on in the issues it produced). Two adjacent latent holes surfaced during the same triage: the Stream token-provider server actions minted tokens for any caller-supplied user id without any session check, and the `addMemberToChannel` server action performed no authorization at all. Both matter because Stream's server-side API deliberately bypasses its own permission system — whatever gate exists has to live in our application layer.

## Decision

### 1. Ban state lives on the BetterAuth admin plugin's native fields

We registered the BetterAuth `admin()` plugin and use its own `User.banned`, `User.banReason`, and `User.banExpires` columns as the only user-level moderation state. A suspension is `banned: true` with `banExpires` set; a permanent ban is `banned: true` with `banExpires: null`. We deliberately did not add parallel `suspendedAt`/`bannedAt` columns: the `ModerationAction` table already records who acted, when, and why, so duplicating that history onto the `User` row would be denormalization without a reader. The plugin blocks sign-in for banned users and auto-unbans at sign-in once `banExpires` passes, which gives us lazy suspension expiry with no reactivation cron. Adopting the plugin also starts the Tier-1 work tracked in #725. Two operational notes: `defaultRole: "CONSULTEE"` is mandatory because the plugin otherwise stamps new users with the string `"user"`, which is not a valid `UserRole` enum value and would break signup; and we write the ban columns directly via Prisma inside the moderation transaction rather than calling `auth.api.banUser`, because the direct write is transactional with the action row and needs no admin request context.

### 2. Side-effects run in two phases

Phase one is transactional (`lib/moderation/side-effects.ts`): the ban flags, session deletion, earnings hold, profile unverification, and review soft-delete commit atomically with the `ModerationAction` row, so a report can never read `ACTION_TAKEN` while the target kept access. Phase two is best-effort and runs after commit: bulk cancellation with refunds (each refund runs in `refundPayment`'s own Serializable transaction), Stream token revocation and deactivation, and Novu notifications. Every phase-two step is individually caught, reported to Sentry, and best-effort persisted into `ModerationAction.sideEffects` (if that persistence write itself fails it is Sentry-logged rather than lost silently), so staff can see exactly what executed. Re-running the action is deliberately blocked by the route's 409 idempotency guard; partial best-effort failures are therefore remediated manually via the persisted summary until the reconciliation follow-up (see Consequences) lands, and only when that summary was successfully persisted. The bulk cancel runs under a wall-clock budget because Netlify functions are time-capped; anything unfinished is recorded and safely re-runnable since every cancel is CAS-guarded and every refund validates the refundable balance.

### 3. Moderation cancellations refund 100%

Booking-time cancellation-policy snapshots exist to arbitrate disputes between the two parties of a booking. A moderation cancellation is platform-initiated — the counterparty did nothing wrong — so the policy tiers do not apply and every affected payment is refunded in full. Banned consultants additionally have their unpaid earnings (`PENDING`, `PENDING_TRUST`, `READY`) moved to `HELD`, which the release cron never auto-releases, leaving payout disposition to an admin.

### 4. Consultee↔consultee direct messages stay blocked

There is deliberately no code path that creates a consultee↔consultee channel, and we are keeping it that way for launch. The trust-and-safety research is consistent: peer-to-peer chat helps marketplaces only when moderation infrastructure is already strong, and ours has only just gained real enforcement. Group spaces already cover the legitimate need — webinar and class event channels put consultees and consultants in one shared conversation, and collaborator channels cover consultant↔consultant joint sessions. We will revisit peer DMs as a post-launch community feature once #899's hardening ships.

### 5. Stream access is gated at the token mint and at member-add

The token-provider actions now require a session, only mint a token for the caller's own user id (staff and admin may mint for anyone), and refuse banned users — without this, a revoked token was trivially re-mintable. `addMemberToChannel` now requires a session and allows only staff, admins, or the channel's creator to add members, and no longer lazily creates channels for non-privileged callers.

## Consequences

The new schema columns (`User.banned/banReason/banExpires`, `Session.impersonatedBy`, `ConsultantReview.deletedAt`, `ModerationAction.sideEffects`, `CancellationReason.MODERATION`) land with the next coordinated `prisma db push`; this code must not deploy before that push because the session path reads the ban columns on every auth call. Two of the follow-ups below landed in #1270; see `docs/decisions/2026-08-30-moderation-truthfulness.md`, which also records that the persisted `sideEffects` summary went unread by every surface for the whole intervening period. Named follow-ups, in rough priority order: an unban/reinstate staff action (symmetric `reactivateUser` plus clearing the ban columns — **shipped in #1270**), a reconciliation path for partial best-effort failures (**shipped in #1270 for the Stream step only**; refunds and notifications are still manual) (the action route's 409 idempotency guard prevents double refunds but also prevents re-running failed refund/Stream/notification steps recorded in `sideEffects` — until it lands, remediation is manual via the persisted summary), refactoring the single-appointment cancel route onto the shared bulk-cancel core, and creating the three Novu dashboard workflows (`moderation-warning`, `account-suspended`, `account-banned`) whose triggers currently log-and-skip.
