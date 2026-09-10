# Moderation and reports

A review can be reported, and a reported review can be removed. This page describes the report pipe as it applies to reviews, the soft-delete flow that `CONTENT_REMOVED` runs, and the staff surfaces that read the result. The consumer-facing side of removal, including the author's own withdrawal, is in [01-architecture.md](01-architecture.md).

## Reporting a review

`POST /api/report` accepts `type: "REVIEW"` with a `reviewId` and the `targetUserId` of the person being reported. Before #1300 it wrote whatever the caller sent straight through: no check that the review existed, that it was still live, or that it was written by the user named as the target. `softDeleteReview` no-ops on a dangling id, so a report could sit in the queue naming content that does not exist and `CONTENT_REMOVED` would report success while removing nothing, which is the same failure #1270 fixed for `MESSAGE` reports. And because the target of a review report is its **author**, a report could name one person's review while aiming the suspension, the ban and the bulk cancellation at somebody else.

The route now refuses a review report without a `reviewId` (400), one whose review does not exist or is already removed (404), and one whose review was not written by the reported user (400). The per-content dedup then keys on the review id, so the same reporter cannot file the same review twice while the first report is open.

`ModerationReport.reviewId` became a real relation at the same time. It was an unconstrained, unindexed, unvalidated string, so "every report about this review" was not a query anyone could write. The relation is `SetNull` rather than `Cascade`: reviews are no longer hard-deleted, so the cascade is belt and braces, and a report is a record of what someone objected to even if the row it named is gone. It was safe to add as a foreign key because the table was empty.

No UI reaches that endpoint for a review. Both `fetch("/api/report")` call sites are Stream chat components, so `ModerationReportType.REVIEW` still describes a queue nothing can enqueue into. The API is what makes the control buildable, and the control is part of #1547.

## Soft-delete on `CONTENT_REMOVED`

`softDeleteReview` in `lib/moderation/side-effects.ts` runs inside the action transaction. It stamps `deletedAt` and `deletedByUserId` with the acting staff member in one `updateMany` whose `WHERE` carries `deletedAt IS NULL`, so it is idempotent and the second of two concurrent removals writes nothing rather than overwriting the first one's timestamp and attribution. It then recomputes the consultant's scores in the same transaction, and the action route purges the public caches afterwards, so a removed review stops rendering on the landing page and explore within the request rather than within the hour. The purge at `app/api/staff/moderation/reports/[reportId]/action/route.ts` is present; the audit claim that `CONTENT_REMOVED` did not purge was checked and is stale.

The ADMIN-only `DELETE /api/staff/moderation/reviews/[reviewId]` is the other staff removal path. It stamps `deletedAt` and recomputes, and it leaves `deletedByUserId` `NULL`, which the write path reads as a moderation removal and therefore refuses to revive.

## The staff queue

`GET /api/staff/moderation/reviews` deliberately does **not** filter `deletedAt`, because staff are meant to see removed rows. It then projected neither `deletedAt` nor `isAnonymous`, so a removed review was indistinguishable from a live one and an anonymous author from a named one, on the one surface whose whole job is telling them apart. Both are now projected, along with `editedAt`, because a review that has been rewritten since it was reported is a different review. The rating histogram beside the list had no `where` at all while the list did, so the two numbers on the same screen described different populations; the histogram now uses the list's `where`, including the removed rows, because telling them apart is what the queue is for.

Staff may read, moderate and remove a reply. Staff may not hard-delete, may not author a reply, and may not edit a review without the edit being attributed to them in the revision trail. The actor-by-operation table in [the grid](../support/02-the-grid.md) states the full matrix.

## Related

- [06-schema-reference.md](06-schema-reference.md) — the `reviewId` relation and its index on `ModerationReport`.
- [03-edit-trail-and-disclosure.md](03-edit-trail-and-disclosure.md) — how a staff rewrite is recorded.
