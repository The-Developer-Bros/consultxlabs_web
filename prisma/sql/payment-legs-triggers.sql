-- #1020-4 / C-02 — PaymentLeg funding-sum invariant, enforced by the DATABASE.
--
-- `lib/payments/payment-legs.ts::checkPaymentLegsSumToAmount` defines the
-- invariant: sum of non-reversal, non-REFERRAL_CREDIT legs === Payment.amount,
-- and every *_REVERSAL leg is negative and never exceeds its original sibling
-- in magnitude. Checkout logs drift warn-only (a surprise 500 on the hot path
-- blocks real bookings); reconcilers assert it after the fact. Both are
-- detection. This trigger makes the imbalance UNCOMMITTABLE — the same
-- posture ledger-triggers.sql already gives the journal — so no writer
-- (app code, raw SQL, a future script) can persist drifted legs.
--
-- Semantics mirror checkPaymentLegsSumToAmount:
--   * funding sum  = Σ amountPaise over legs whose source does not end in
--     `_REVERSAL`
--   * a payment whose non-reversal legs are ALL 0-value LICENSE legs skips the
--     sum comparison outright: the licence is absorbed at contract time, so the
--     leg is deliberately 0 while Payment.amount stays at full price and the
--     comparison is structurally false for every one of them. The checker
--     carves the same shape out; without it here the trigger would reject at
--     COMMIT the very checkout the checker waves through. The carve suppresses
--     the sum comparison ONLY — both sides still run their reversal-pair loop
--     over a licence-only payment, because a reversal with no original sibling
--     is corrupt under either reading.
--   * REFERRAL_CREDIT is EXCLUDED from that sum (#1347): Payment.amount is the
--     gateway charge and the credit is already netted out of it, so counting
--     the leg would demand the credit twice and fail every credit checkout
--   * reversal leg = must be negative; |reversal| ≤ Σ its original siblings
--
-- DEFERRABLE INITIALLY DEFERRED: fires at COMMIT, so multi-statement writes
-- (Payment + legs in one tx) never see a half-written state. Row-level per
-- Postgres constraint-trigger rules; each fired row re-checks its whole
-- payment, which is idempotent when several rows commit together.

CREATE OR REPLACE FUNCTION assert_payment_legs_ok(p_payment_id TEXT) RETURNS void AS $$
DECLARE
  v_amount BIGINT;
  v_funding_sum BIGINT;
  v_sibling_sum BIGINT;
  v_original_count BIGINT;
  v_non_license_count BIGINT;
  r RECORD;
BEGIN
  SELECT "amount" INTO v_amount FROM "Payment" WHERE "id" = p_payment_id;
  IF NOT FOUND THEN
    RETURN; -- payment already gone (cascade delete) — nothing to guard
  END IF;

  -- Both counts span every non-reversal leg INCLUDING REFERRAL_CREDIT, so the
  -- carve fires on exactly the shapes checkPaymentLegsSumToAmount carves: a
  -- credit sitting beside a licence leg is a real funding leg and keeps the
  -- payment in the comparison.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE NOT ("source"::text = 'LICENSE' AND "amountPaise" = 0)
    )
  INTO v_original_count, v_non_license_count
  FROM "PaymentLeg"
  WHERE "paymentId" = p_payment_id
    AND RIGHT("source"::text, 9) <> '_REVERSAL';

  IF NOT (v_original_count > 0 AND v_non_license_count = 0) THEN
    SELECT COALESCE(SUM("amountPaise"), 0) INTO v_funding_sum
    FROM "PaymentLeg"
    WHERE "paymentId" = p_payment_id
      AND RIGHT("source"::text, 9) <> '_REVERSAL'
      AND "source"::text <> 'REFERRAL_CREDIT';

    IF v_funding_sum <> v_amount THEN
      RAISE EXCEPTION 'payment_legs_sum_to_amount violated for payment %: legs sum to % but Payment.amount is %',
        p_payment_id, v_funding_sum, v_amount
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  FOR r IN
    SELECT "source", "amountPaise"
    FROM "PaymentLeg"
    WHERE "paymentId" = p_payment_id
      AND RIGHT("source"::text, 9) = '_REVERSAL'
  LOOP
    IF r."amountPaise" >= 0 THEN
      RAISE EXCEPTION 'payment_legs_reversal_pair violated for payment %: reversal leg % carries non-negative %',
        p_payment_id, r."source", r."amountPaise"
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT COALESCE(SUM("amountPaise"), 0) INTO v_sibling_sum
    FROM "PaymentLeg"
    WHERE "paymentId" = p_payment_id
      AND "source"::text = LEFT(r."source"::text, LENGTH(r."source"::text) - 9);

    IF -r."amountPaise" > v_sibling_sum THEN
      RAISE EXCEPTION 'payment_legs_reversal_pair violated for payment %: reversal % (%) exceeds original sibling sum %',
        p_payment_id, r."source", -r."amountPaise", v_sibling_sum
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
-- SPLIT
-- #1205-triage — a leg RE-PARENTING must validate BOTH payments: moving one
-- leg from payment A to B can leave A under-funded while B validates clean.
--
-- The column references MUST stay double-quoted. PL/pgSQL case-folds a bare
-- `NEW.paymentId` to `paymentid`, which is not a field on a Prisma-generated
-- camelCase table, so every leg write died at COMMIT on `record "new" has no
-- field "paymentid"` — the sum was never reached and the guard below never
-- actually guarded anything.
CREATE OR REPLACE FUNCTION assert_payment_legs_on_leg_write() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM assert_payment_legs_ok(OLD."paymentId");
  ELSIF TG_OP = 'UPDATE' AND NEW."paymentId" IS DISTINCT FROM OLD."paymentId" THEN
    PERFORM assert_payment_legs_ok(OLD."paymentId");
    PERFORM assert_payment_legs_ok(NEW."paymentId");
  ELSE
    PERFORM assert_payment_legs_ok(NEW."paymentId");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- SPLIT
DROP TRIGGER IF EXISTS payment_legs_sum_to_amount ON "PaymentLeg";
-- SPLIT
CREATE CONSTRAINT TRIGGER payment_legs_sum_to_amount
  AFTER INSERT OR UPDATE OR DELETE ON "PaymentLeg"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_payment_legs_on_leg_write();
-- SPLIT
-- #1205-triage — a DIRECT Payment.amount UPDATE escapes the leg-side trigger
-- entirely (it only fires on PaymentLeg writes). Guard the parent too.
-- SPLIT
-- Parent-side validator: same invariant from a Payment.amount write.
CREATE OR REPLACE FUNCTION assert_payment_legs_on_payment_update() RETURNS trigger AS $$
BEGIN
  PERFORM assert_payment_legs_ok(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- SPLIT
DROP TRIGGER IF EXISTS payment_amount_vs_legs ON "Payment";
-- SPLIT
CREATE CONSTRAINT TRIGGER payment_amount_vs_legs
  AFTER UPDATE OF "amount" ON "Payment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_payment_legs_on_payment_update();
