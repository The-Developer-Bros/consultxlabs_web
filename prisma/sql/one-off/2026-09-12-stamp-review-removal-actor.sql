-- #1562 — stamp the removal actor on rows removed before the enum existed.
--
-- ONE-OFF, idempotent, run by hand on the live shared database. Two parts,
-- because the push drops `deletedByUserId` / `replyDeletedByUserId` in the same
-- statement that adds `removedBy` / `replyRemovedBy`, so the actor has to be
-- read BEFORE the push and written AFTER it:
--
--   Part 1 — BEFORE `prisma db push`, with the site in OFFLINE maintenance so
--   no removal can land in between: run the SELECT and keep the ids it returns
--   (the author's own withdrawals). On 2026-09-12 it returned none: the three
--   removed rows were all staff acts from the 2026-09-11 E2E pass.
--
--   Part 2 — AFTER `prisma db push` and BEFORE `npm run db:sidecars` (whose
--   CHECKs `consultant_review_removed_pair` / `consultant_review_reply_removed_pair`
--   refuse a removed row with no actor): stamp AUTHOR for the ids from part 1
--   and MODERATION for every other removed row. MODERATION is also the
--   fail-closed reading the pre-#1562 code gave a removed row with no remover.
--
-- A database built from scratch has no such rows, so this is never a sidecar.

-- Part 1 (before the push): author withdrawals, whose actor must survive.
SELECT r.id
  FROM "ConsultantReview" r
  JOIN "ConsulteeProfile" cp ON cp.id = r."consulteeProfileId"
 WHERE r."deletedAt" IS NOT NULL
   AND r."deletedByUserId" = cp."userId";

-- Part 2 (after the push): substitute the ids from part 1, or leave the list
-- empty and skip the first statement.
UPDATE "ConsultantReview"
   SET "removedBy" = 'AUTHOR'
 WHERE "id" IN ('<ids from part 1>') AND "removedBy" IS NULL;

UPDATE "ConsultantReview"
   SET "removedBy" = 'MODERATION'
 WHERE "deletedAt" IS NOT NULL AND "removedBy" IS NULL;

-- A reply's own withdrawal was never distinguishable from a takedown before
-- #1562 (the consultant's id was the only remover a reply could carry), so
-- every removed reply reads as MODERATION.
UPDATE "ConsultantReview"
   SET "replyRemovedBy" = 'MODERATION'
 WHERE "replyDeletedAt" IS NOT NULL AND "replyRemovedBy" IS NULL;
