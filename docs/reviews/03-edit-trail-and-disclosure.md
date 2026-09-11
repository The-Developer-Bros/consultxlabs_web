# The edit trail and the "Edited" disclosure

A review can be edited for as long as the relationship lasts, so the subsystem has to be able to say that a review was edited, when, by whom, and what it used to say. This page describes `ConsultantReviewRevision`, the two clocks on the review row, and the rule that every edit is marked.

## Why `updatedAt` cannot answer it

BIS IS 19000:2022, India's standard for online consumer reviews, asks that an edited review be indicated as edited. `updatedAt` cannot answer that question, because `replyBody`, `repliedAt`, `replyDeletedAt` and `deletedAt` all live on the review row, so a consultant replying moves `updatedAt` without the consumer having touched a word. `editedAt` is the column for it: it is stamped only when the review **text** changed, and `NULL` means never edited. That `NULL` is the badge's own predicate, so the profile page needs no join to the revision trail to decide whether to show the mark.

## Only a changed opinion counts

Re-submitting the same stars and the same words is idempotent. It does not stamp `editedAt`, does not increment `revisionNo`, and does not manufacture a revision row, or a double-tapped Save reads as "this person keeps changing their mind". Toggling `isAnonymous` is a display choice rather than a change to what was said, so it is not a revision either. `AppointmentFeedback.updatedAt` is written by the same rule.

## `revisionNo` is the allocator

`ConsultantReview.revisionNo` is the version number of the **live** text, starting at 1. When the text changes, the write appends a revision row carrying the previous values and the previous `revisionNo`, then increments the counter on the review, inside one transaction. The row lock the update takes is the serialization point between two concurrent editors, which is the same trick `AppointmentSupportThread.messageSeq` uses for messages, and `@@unique([reviewId, revisionNo])` on the revision table turns any residual race into a `P2002` to retry rather than two rows both claiming to be revision 3.

## The trail stores what a review used to say

`ConsultantReviewRevision` stores the superseded `rating` and `reviewDescription`, never the current ones. The live text is on `ConsultantReview`, every read of a review already loads that row, and mirroring the current version into the trail would double every write and create two places that claim to be true. That gives the property which makes the trail cheap: a review that has never been edited has **zero** rows, which was 62 of 62 when the table shipped, so the disclosure is an existence check and the profile page pays nothing for a feature almost nobody has used.

Each row records `supersededAt`, when this text stopped being the live text, and `editorUserId`, who caused the supersession. Before this branch, `isPrivileged` admitted STAFF and ADMIN into the `PUT`, so a staff member could rewrite the text of a consumer review and the row afterwards was indistinguishable from an author edit, with no `ModerationAction`, no audit row and no attribution — under FTC 16 CFR §465 that was the highest-exposure write in the subsystem. `PUT` and `DELETE /api/user/reviews/[id]` are now OWNER-ONLY; staff act only through `/api/staff/moderation/*`, which removes or excludes a review rather than rewriting it. So `editorUserId` on a revision now only ever records the author. The editor relation stays `SetNull` regardless of who it points at, on the general principle that a revision row is evidence of what was said and must survive whichever account is later deleted.

## `afterPublicReply` is stored, not derived

Whether an edit was made after the consultant had publicly answered is recorded on the revision as `afterPublicReply`, computed at write time as "the review had a live reply". It is stored rather than derived from `supersededAt > review.repliedAt`, because that predicate's inputs are mutable: a consultant can delete and re-post a reply, moving `repliedAt`, and whether an edit landed after a public answer must not change afterwards. It is the same rationale as storing the SLA deadlines at intake rather than deriving them.

It is recorded for moderation context and it does **not** decide whether the public surface marks the edit. Every edit is marked. Etsy and Practo both converged on "editable until the provider replies, then marked", and we take the marking and reject the trigger: making the mark conditional on a reply hands the consultant a switch, since they could reply to everything and brand every subsequent revision, and BIS asks for edits to be indicated, full stop.

## Append-only, and the status of the trigger

The revision table is append-only by design. No code path updates or deletes a revision row, and there is no `updatedAt` column because a row that is only ever inserted has nothing to update and the column would invite a writer to try. The review relation was `Restrict` rather than `Cascade`, on the reasoning that a review with an edit history should not be hard-deletable out from under its own evidence, but since nobody hard-deletes a review any more that `Restrict` had no live case to protect and one to break: it sat beneath the `User` → `ConsulteeProfile` → `ConsultantReview` cascade, so deleting the account of anyone who had ever edited a review failed with `P2003` rather than cascading through. #1542 re-points it to `Cascade`; deleting a review now takes its revision history with it, which matches every other piece of evidence in this subsystem, none of which outlives the record it is evidence about.

ADR 29 and the pull request that shipped the table state that append-only is enforced by a `review_revision_immutable` trigger in `prisma/sql/check-constraints.sql`, on the argument that a trail an application bug can rewrite indicates nothing. As of this branch that trigger is **not** in the sidecar; append-only is held by convention and by the absence of any writer. Adding the trigger is tracked as #1551 and belongs in the sidecar, not in the schema, because a trigger is not something `prisma db push` can express.

## Related

- [06-schema-reference.md](06-schema-reference.md) — the revision table's columns and indexes.
- [01-architecture.md](01-architecture.md) — the reply the mark is deliberately independent of.
- [ADR 29](../enterprise/70-design-decisions/29-two-track-reputation-and-the-right-of-reply.md) — the decision that every edit is recorded and every edit is marked.
