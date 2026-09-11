-- Drop LEMON_SQUEEZY and XFLOW from the live PaymentGateway enum.
--
-- ONE-OFF, and deliberately not a sidecar. Sidecars under prisma/sql/ are
-- re-applied to every database because `prisma db push` never creates them.
-- This is the opposite case: schema.prisma already declares the correct four
-- values, so a database built from scratch comes out right on its own. Only the
-- existing, drifted one needs correcting, and re-running this against a clean
-- database would be a no-op at best.
--
-- Why it is needed at all: commit 183d0e72 removed both labels from the schema
-- when the gateways were retired (#984), but Postgres has no
-- `ALTER TYPE ... DROP VALUE`, so `prisma db push` left them in place. The
-- Prisma client then refuses to read any column typed by an enum it does not
-- fully recognise, which is how reconcile-disputes and cleanup-abandoned-payments
-- started failing with P2023 — an error naming neither the enum nor the gateway.
--
-- Safety, verified against the live database on 2026-07-29 before writing this:
--   * Zero rows use either value across Payment, Refund and Dispute.
--   * Six columns are typed by this enum, all on plain tables. No views,
--     functions or generated columns depend on it.
--   * None of the six has a DEFAULT, so no default has to be dropped and
--     re-added around the type swap.
--   * Those six tables hold 555 rows in total, so the ACCESS EXCLUSIVE lock
--     each ALTER takes is measured in milliseconds. This matters because the
--     production and development apps share one database.
--
-- The value order below matches schema.prisma so the two agree exactly.

ALTER TYPE "PaymentGateway" RENAME TO "PaymentGateway_old";

CREATE TYPE "PaymentGateway" AS ENUM ('STRIPE', 'RAZORPAY', 'DODO_PAYMENTS', 'CARD');

ALTER TABLE "Payment"            ALTER COLUMN "paymentGateway" TYPE "PaymentGateway" USING "paymentGateway"::text::"PaymentGateway";
ALTER TABLE "Refund"             ALTER COLUMN "paymentGateway" TYPE "PaymentGateway" USING "paymentGateway"::text::"PaymentGateway";
ALTER TABLE "Dispute"            ALTER COLUMN "paymentGateway" TYPE "PaymentGateway" USING "paymentGateway"::text::"PaymentGateway";
ALTER TABLE "OrganizationPayout" ALTER COLUMN "paymentGateway" TYPE "PaymentGateway" USING "paymentGateway"::text::"PaymentGateway";
ALTER TABLE "ConsultantPayout"   ALTER COLUMN "provider"       TYPE "PaymentGateway" USING "provider"::text::"PaymentGateway";
ALTER TABLE "PayoutAccount"      ALTER COLUMN "provider"       TYPE "PaymentGateway" USING "provider"::text::"PaymentGateway";

DROP TYPE "PaymentGateway_old";
