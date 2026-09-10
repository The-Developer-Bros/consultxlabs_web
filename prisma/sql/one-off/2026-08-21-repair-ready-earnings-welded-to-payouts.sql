-- ONE-OFF repair: earnings welded to payouts as READY (never BATCHED).
--
-- The weekly GH-Action batch creator (scripts/payouts/create-payout-batch.ts,
-- via jobs/payouts/create-payout-batch.ts) linked earnings to payouts WITHOUT
-- flipping status to BATCHED — the canonical service (#993) always has. Every
-- earning it ever batched stayed `READY` with `payoutId` set, which the
-- canonical handlers (all filtering on BATCHED) cannot see:
--
--   * COMPLETED payouts: earnings never flipped PAID, paidAt never set, and
--     the FY gross aggregation undercounts → wrong TDS threshold math.
--   * FAILED payouts: the release path (READY + payoutId null) matched 0 rows,
--     so the earnings were permanently orphaned — excluded from future batches
--     by `payoutId: null`, never released.
--   * refundEarnings treated them as not-yet-paid even after cash left.
--
-- create-payout-batch.ts now writes BATCHED itself; this script repairs the
-- historical rows. Run once per environment AFTER deploying the code fix.
--
-- ⚠️ OPS GATING (#1205 review): run with payout WRITERS stopped — pause the
-- process-payouts workflow and hold the admin approve/process routes for the
-- duration. The three UPDATEs below are not one locked payout-state snapshot:
-- a payout completing between statement 1 and 3 would leave its earnings
-- READY while its new COMPLETED status expects PAID, and the completion
-- handler only promotes BATCHED rows.
--
-- Repair semantics (mirroring what the canonical paths would have done):
--   * payout COMPLETED            → earnings PAID, paidAt = payout processedAt
--                                   (fallback updatedAt), idempotent guard on
--                                   status so re-running is a no-op.
--   * payout REVERSED             → earnings released (payoutId null, READY) —
--                                   the reversal path re-opens them for re-batch.
--   * payout FAILED or CANCELLED  → earnings released (payoutId null, READY).
--   * payout PENDING/APPROVED/PROCESSING → BATCHED (correctly in-flight).

-- 1) COMPLETED payouts → their earnings become PAID.
UPDATE "ConsultantEarnings" e
SET "status"   = 'PAID',
    "paidAt"   = COALESCE(p."processedAt", p."updatedAt"),
    "updatedAt" = NOW()
FROM "ConsultantPayout" p
WHERE e."payoutId" = p.id
  AND p."status" = 'COMPLETED'
  AND e."status" = 'READY';

-- 2) FAILED / CANCELLED / REVERSED payouts → release their earnings for
--    re-batching (canonical post-failure state: READY + payoutId null).
UPDATE "ConsultantEarnings" e
SET "payoutId"  = NULL,
    "updatedAt" = NOW()
FROM "ConsultantPayout" p
WHERE e."payoutId" = p.id
  AND p."status" IN ('FAILED', 'CANCELLED', 'REVERSED')
  AND e."status" = 'READY';

-- 3) In-flight payouts (PENDING / APPROVED / PROCESSING) → BATCHED.
UPDATE "ConsultantEarnings" e
SET "status"    = 'BATCHED',
    "updatedAt" = NOW()
FROM "ConsultantPayout" p
WHERE e."payoutId" = p.id
  AND p."status" IN ('PENDING', 'APPROVED', 'PROCESSING')
  AND e."status" = 'READY';

-- Verification (expect zero rows from each):
--   SELECT COUNT(*) FROM "ConsultantEarnings" WHERE "payoutId" IS NOT NULL AND "status" = 'READY';
