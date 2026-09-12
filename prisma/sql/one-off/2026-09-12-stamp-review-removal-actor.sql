-- #1562 — stamp the removal actor on rows removed before the enum existed.
--
-- ONE-OFF, idempotent, run by hand on the live shared database between
-- `prisma db push` (which adds `removedBy` / `replyRemovedBy` and drops the
-- `…ByUserId` columns) and `npm run db:sidecars` (which adds the CHECKs
-- `consultant_review_removed_pair` and `consultant_review_reply_removed_pair`,
-- and would refuse to apply while a removed row has no actor). A database built
-- from scratch has no such rows, so this is never a sidecar.
--
-- On 2026-09-12 the live database held exactly three such rows, all E2E
-- artefacts of 2026-09-11: two admin takedowns and one staff reply takedown.
-- `MODERATION` is also the fail-closed reading the pre-#1562 code gave a removed
-- row with no recorded remover, so the stamp changes no behaviour.
UPDATE "ConsultantReview"
   SET "removedBy" = 'MODERATION'
 WHERE "deletedAt" IS NOT NULL AND "removedBy" IS NULL;

UPDATE "ConsultantReview"
   SET "replyRemovedBy" = 'MODERATION'
 WHERE "replyDeletedAt" IS NOT NULL AND "replyRemovedBy" IS NULL;
