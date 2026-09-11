-- #1319 — SUPERSEDED, RETAINED AS HISTORY. DO NOT RUN.
--
-- This script captured two columns that exist in the database but not in
-- prisma/schema.prisma (`ConsultantReview.isAnonymous` and
-- `AppointmentFeedback.slotOfAppointmentId`) into `_phantom_*` tables, so that
-- the pre-MVP reset's `db push` could drop the columns without losing what they
-- held. It does not work, and the way it fails is silent: `prisma db push`
-- drops every table the Prisma schema does not know about, so the capture
-- tables are removed by the very push they were meant to survive. It was
-- applied once on 2026-09-03 and dropped by that same day's push; the rows were
-- recovered from the pre-push `pg_dump`.
--
-- The capture now happens with `\copy` into CSV FILES, which nothing in the
-- push can reach. Follow docs/prisma/pre-mvp-reset-runbook.md step 1 instead.
--
-- The guard below fails the script immediately. It is here because the body
-- underneath is still valid SQL against a live database, and an operator who
-- found this file and ran it would create tables that give a false sense of
-- having a backup — the exact failure that cost a recovery from `pg_dump`.

DO $$
BEGIN
  RAISE EXCEPTION
    'Superseded: this capture does not survive `prisma db push`. Use the \copy capture in docs/prisma/pre-mvp-reset-runbook.md step 1.';
END $$;

-- The original body, kept for the record and unreachable past the guard above.
--
-- DO $$
-- BEGIN
--   IF EXISTS (
--     SELECT 1 FROM information_schema.columns
--     WHERE table_name = 'ConsultantReview' AND column_name = 'isAnonymous'
--   ) THEN
--     EXECUTE 'DROP TABLE IF EXISTS "_phantom_consultant_review_is_anonymous"';
--     EXECUTE 'CREATE TABLE "_phantom_consultant_review_is_anonymous" AS
--              SELECT "id", "isAnonymous" FROM "ConsultantReview" WHERE "isAnonymous" IS NOT NULL';
--   END IF;
--
--   IF EXISTS (
--     SELECT 1 FROM information_schema.columns
--     WHERE table_name = 'AppointmentFeedback' AND column_name = 'slotOfAppointmentId'
--   ) THEN
--     EXECUTE 'DROP TABLE IF EXISTS "_phantom_appointment_feedback_slot"';
--     EXECUTE 'CREATE TABLE "_phantom_appointment_feedback_slot" AS
--              SELECT "id", "slotOfAppointmentId" FROM "AppointmentFeedback" WHERE "slotOfAppointmentId" IS NOT NULL';
--   END IF;
-- END $$;
