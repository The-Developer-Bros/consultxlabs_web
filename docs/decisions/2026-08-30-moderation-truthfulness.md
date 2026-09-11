# ADR: Moderation tells the truth about what it enforced (#1270)

- **Status**: Accepted
- **Date**: 2026-08-30
- **Author**: teetangh
- **PR**: `fix/moderation-truthfulness` → `dev`
- **Part of**: #1270
- **Supersedes parts of**: `docs/decisions/2026-07-11-moderation-enforcement-and-peer-chat-block.md`

## Context

The 2026-07-11 ADR gave moderation real side-effects, and it was honest about what it left unfinished. Nine months of use showed that the unfinished parts were not cosmetic; each of them let the moderation surface report an outcome that had not happened.

A ban is executed in two phases. The account state, the session revocation, the earnings hold and the review soft-delete commit in one transaction with the `ModerationAction` row. Everything that has to talk to another service — the bulk cancellation with its refunds, the Stream token revocation and deactivation, the Novu notification — runs best-effort afterwards, and each step records its own outcome in `ModerationAction.sideEffects`. That design is right. The problem was that nothing read the record. The client type in `ModerationPage.tsx` declared only the counters it wanted to put in a toast and omitted `stream` and `errors` entirely, and the success handler congratulated the moderator unconditionally. So when Stream was unreachable, or when the circuit breaker was open and the call never left the process, the database said banned, the sessions were gone, the appointments were cancelled and refunded — and the account's existing chat token kept working for up to an hour while the admin was told the ban had been processed successfully.

Three adjacent defects had the same shape. `CONTENT_REMOVED` on a reported chat message was routed to the review soft-delete, which returns immediately when `reviewId` is null, and `reviewId` is always null for a `MESSAGE` report: the report flipped to `ACTION_TAKEN` and the message stayed in the channel. The 500-character excerpt captured at report time was never rendered anywhere, so moderators decided bans from a reason string. And message reports aggregated on `(targetUserId, type, reviewId)`, which for a message report is `(targetUserId, type, null)` — every complaint about a given author for the life of one row incremented a single counter and discarded its own excerpt, so the twelfth report showed the moderator the first message anyone had ever objected to.

Finally, `restoreStreamAccess` — written in #1134 as the documented inverse of the ban's `deactivateUser` — had zero callers. There was no unban route and no unban control anywhere in the product, so an admin reversing a wrongful ban did it by editing `User.banned`, which left the account able to sign in, book and pay while permanently unable to connect to chat, with nothing on any screen explaining why.

## Decision

### 1. The persisted side-effect summary is the source of truth, and every surface reads it

`ModerationAction.sideEffects` keeps its existing shape and gains two fields: `streamAttempts`, and a fourth `StepStatus` value, `gave_up`. The moderation queue now returns the latest action for every report, so the failure survives the toast that reported it. The action route's response is typed on the client with the fields the route has always sent, and a failed Stream step produces a destructive toast that says what is still true about the target — "the account's existing chat token still works and it has not been deactivated" rather than "stream: failed" — and moves the queue's status filter to the report that just failed, so the incomplete enforcement is on screen rather than one filter away. The report detail view renders the whole summary, and the queue card carries an "Enforcement incomplete" line.

The same summary is what the moderator sees when the enforcement _did_ land, which matters as much: a moderator who has never seen the panel populated has no way to read its absence.

### 2. A moderation report points at the content it is about

`ModerationReport` gains two nullable columns, `streamMessageId` and `streamChannelCid`, populated by `POST /api/report` from the chat report button. They are the message identity Stream's server-side `deleteMessage` needs, and they are the aggregation key that makes a message report about a message rather than about a person. A report that arrives without a message id — an older client, or a surface with no message to point at — deliberately keeps the previous per-user collapse rather than splitting into one row per reporter, which would flood the queue.

`CONTENT_REMOVED` now deletes the reported message, and the queue offers the action, which it never did before. The delete is soft: Stream keeps the row and stops serving the text, so the evidence survives an appeal while the channel stops showing the abuse. A hard delete would destroy the only copy of the thing that was moderated. Because the delete is an API call it cannot join the action's transaction, so it runs in phase two alongside the ban's revocation and reports its outcome through the same field.

### 3. Reversing a ban is a first-class action, and it is ADMIN-only

`POST /api/staff/moderation/reports/[reportId]/unban` clears the ban columns, records a `USER_REINSTATED` action against the report so the whole enforcement history stays on one row, and calls `restoreStreamAccess`. It is gated on `users.moderate`, the same ADMIN-only permission that gates banning, because reversing an enforcement decision is as consequential as taking one.

The route is idempotent on the database side and unconditional on the Stream side. An account whose ban columns were already cleared by hand is precisely the case this exists to repair, so the Stream restore runs whether or not there was anything left to clear.

### 4. A failed Stream write is retried by a sweep, and the summary is the queue

`scripts/cleanup/retry-moderation-enforcement.ts` selects the actions whose recorded outcome is `stream: "failed"`, re-drives the same function the live path calls, and writes the new outcome back. It reuses the durability shape of `sweep-stuck-webhook-events` rather than inventing one, and it deliberately introduces no second table: `sideEffects` already is the durable record, and a parallel outbox would be a second thing to keep in step with it.

Re-driving is safe because every Stream step is idempotent — re-revoking moves a timestamp that is already in the past, re-deactivating an inactive user is a no-op, and a message that is already gone is the outcome the step wanted. It is also guarded on the state that justified it: a ban that has since been lifted, and a suspension whose `banExpires` has passed, are skipped rather than re-enforced, because re-revoking a reinstated user's tokens would recreate the defect the reinstatement was undoing. After six attempts, or seventy-two hours, the row is stamped `gave_up` and reported to Sentry at error level; that terminal value is a different string from `failed`, so a capped row leaves the selector by construction rather than through a negated JSON filter that a null path would defeat.

### 5. The queue offers only the actions the caller may take

The reports endpoint returns a `capabilities.canModerateUsers` flag derived from the same permission matrix the action route enforces. Suspend, Ban and Lift ban are rendered only when it is true. Until now every moderator saw a Ban button that answered 403 on click, and `CONTENT_REMOVED` is offered only on a report that actually points at a message or a review, because offering it elsewhere resolves the report and deletes nothing.

## Consequences

Two nullable columns and one enum value (`ModerationActionType.USER_REINSTATED`) land with the next coordinated `prisma db push`. Nothing needs backfilling: both columns are nullable and every existing report keeps the aggregation behaviour it had. The code must not deploy before that push, because the report route writes the new columns on every message report.

The retry sweep ships with its HTTP entrypoint (`GET|POST /api/cleanup/retry-moderation-enforcement`, `CRON_SECRET`-gated) and with a scheduling workflow that runs it every thirty minutes. It was very nearly shipped on-demand only, and that would have been the wrong shape for this particular failure: a ban whose Stream revocation failed is invisible from the product, because the database says banned and the moderator has already been told it worked. Nobody would think to press the button, so the only signal would be the harasser continuing to post. Enforcement that has been reported as done should not wait on someone noticing to become true.

Two of the 2026-07-11 ADR's named follow-ups are now closed — the unban action, and the reconciliation path for partial best-effort failures, which is this sweep for the Stream step. The refund and notification steps of a partially-failed action are still remediated by hand from the persisted summary; the sweep's shape extends to them, and doing so is the obvious next increment.

The queue's two user relations were also renamed in the client types from `reporter`/`reportedUser` to the `reportedBy`/`targetUser` the route has always sent. The old names were a straightforward runtime crash on the first report that reached the page, and the surface only looked healthy because the queue is usually empty.
