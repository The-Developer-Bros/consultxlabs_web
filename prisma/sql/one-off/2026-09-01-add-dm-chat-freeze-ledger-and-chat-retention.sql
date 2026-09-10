-- Applied to the shared dev database on 2026-09-01 as Supabase migration
-- `add_dm_chat_freeze_ledger_and_chat_retention`. Recorded here so the change
-- is reconstructable from the repo alone, per the convention set by
-- 2026-08-30-rename-recording-storage-vendor.sql.
--
-- #1280 / #1270 PR F — DM freeze ledger + a chat-specific retention dial.
--
-- Purely additive: two nullable timestamp columns and one integer with a
-- default. No data is read, rewritten or dropped, and nothing writes these
-- until the job that owns them ships, so applying ahead of the deploy is safe
-- in both directions. That is the opposite of the enum rename in #1284, where
-- "0 rows use the old value" did NOT make the change safe because the failure
-- was in the catalog rather than the data.
--
-- `chatFrozenAt` mirrors the existing columns on "Webinar" and "Class". It is
-- the freeze ledger for the PAIR's direct-message channel: DM ids are keyed on
-- the pair, never the appointment, so it is read as MAX() across the pair's
-- bookings and cleared across all of them when they book again.
ALTER TABLE "Consultation" ADD COLUMN IF NOT EXISTS "chatFrozenAt" TIMESTAMPTZ;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "chatFrozenAt" TIMESTAMPTZ;

-- Chat retention is split from `streamRecordingRetentionDays`, which it used to
-- borrow. A recording is a stored asset with a storage bill; a chat channel is
-- the written record of a professional consultation. Default 365 rather than 90
-- because chat is the cheaper of the two to keep and the more expensive to have
-- thrown away.
--
-- NOTE the table is "organizations" (Organization carries @@map), unlike the
-- other two.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "chatRetentionDays" INTEGER NOT NULL DEFAULT 365;
