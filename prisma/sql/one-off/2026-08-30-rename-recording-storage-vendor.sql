-- Take the vendor name out of the recording storage model (#1280).
--
-- ONE-OFF, and deliberately not a sidecar. Sidecars under prisma/sql/ are
-- re-applied to every database because `prisma db push` never creates them.
-- This is the opposite case: schema.prisma already declares the new names, so
-- a database built from scratch comes out right on its own. Only the existing,
-- drifted one needs correcting.
--
-- Why it cannot be left to `prisma db push`:
--
--   * Enums. Postgres has no `ALTER TYPE ... DROP VALUE`, so a push would ADD
--     PLATFORM and PERMANENT while leaving SUPABASE and SUPABASE_PERMANENT in
--     the live types. The Prisma client refuses to read any column typed by an
--     enum it does not fully recognise, so every read of Recording.storageType
--     and of the four *Plan.recordingStoragePolicy columns would fail with
--     P2023 — an error naming neither the enum nor the value. That is exactly
--     how reconcile-disputes and cleanup-abandoned-payments were red for weeks
--     after commit 183d0e72 (see 2026-07-29-drop-dead-gateway-enum-values.sql).
--     `scripts/ci/check-db-drift.ts` exists to catch this and does: it fails
--     this branch with four drifts until this file is applied.
--
--     Note the difference from that earlier case. Dropping a value needs the
--     create-replacement-type-and-swap-columns dance. This is a RENAME, and
--     Postgres 10+ has `ALTER TYPE ... RENAME VALUE`, which rewrites the label
--     in place: no new type, no column swap, no defaults to drop and re-add,
--     and a far lighter lock. The database here is 15.8.
--
--   * Columns. `db push` sees a rename as a drop plus an add, which would
--     discard the columns rather than carry them over. Renaming them here
--     first means the push that follows sees no diff at all.
--
-- Safety, verified against the live database on 2026-08-30 before writing this:
--   * Zero rows use either renamed value. All 191 Recording rows are STREAM_S3;
--     all 971 rows across the four plan tables are STREAM_ONLY. (This does NOT
--     by itself make the change safe — see the P2023 note above, which bites on
--     the catalog rather than on the data — but it does mean nothing to migrate.)
--   * Five columns are typed by the two enums, all on plain tables. No views,
--     materialized views, functions or generated columns depend on either type.
--   * Every one of those five defaults to STREAM_S3 or STREAM_ONLY, neither of
--     which is being renamed, so no default has to be dropped and re-added.
--   * Recording.storageUrl and Recording.storagePath are entirely NULL today
--     (nothing has ever been transferred), so the column renames carry no data.
--
-- Order matters: run this BEFORE `npm run db:push` and before deploying the
-- branch, or the build fails on the drift guard and reads fail with P2023.

ALTER TYPE "RecordingStorageType"   RENAME VALUE 'SUPABASE'           TO 'PLATFORM';
ALTER TYPE "RecordingStoragePolicy" RENAME VALUE 'SUPABASE_PERMANENT' TO 'PERMANENT';

ALTER TABLE "Recording" RENAME COLUMN "supabaseUrl"  TO "storageUrl";
ALTER TABLE "Recording" RENAME COLUMN "supabasePath" TO "storagePath";
