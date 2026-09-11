-- #776 — DB-level enforcement of the double-entry invariant Σ(DEBIT) == Σ(CREDIT)
-- per LedgerTransaction. The app-level guard in postLedgerTxn() is the first line;
-- this CONSTRAINT TRIGGER is the backstop that makes an unbalanced transaction
-- impossible to COMMIT even via raw SQL, a future code path, or a partial migration.
--
-- DEFERRABLE INITIALLY DEFERRED so the check runs once at COMMIT — after all of a
-- transaction's entries are inserted — not after each row (a balanced txn is
-- transiently unbalanced mid-insert).
--
-- prisma db push / migrate do NOT manage triggers, so this file is applied
-- separately: `npm run db:triggers` (idempotent) after every push/reset. See
-- docs/enterprise/10-money-and-ledger/13-ledger-integrity.md + docs/enterprise/90-audits/03-verification-guide.md.
--
-- Statements are separated by `-- SPLIT` because Prisma's $executeRawUnsafe runs a
-- single statement per call (extended protocol); the apply script splits on it.

DROP TRIGGER IF EXISTS ledger_txn_balanced ON "LedgerEntry";
-- SPLIT
CREATE OR REPLACE FUNCTION assert_ledger_txn_balanced() RETURNS trigger AS $$
DECLARE
  txn_id text;
  imbalance bigint;
BEGIN
  txn_id := COALESCE(NEW."transactionId", OLD."transactionId");
  SELECT COALESCE(
           SUM(CASE WHEN "direction" = 'DEBIT' THEN "amountPaise" ELSE -"amountPaise" END),
           0)
    INTO imbalance
    FROM "LedgerEntry"
   WHERE "transactionId" = txn_id;
  IF imbalance <> 0 THEN
    RAISE EXCEPTION
      'Ledger transaction % is unbalanced by % paise (Sum(DEBIT) - Sum(CREDIT) != 0)',
      txn_id, imbalance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- SPLIT
CREATE CONSTRAINT TRIGGER ledger_txn_balanced
  AFTER INSERT OR UPDATE OR DELETE ON "LedgerEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_ledger_txn_balanced();
