-- #676 A1–A4 — data-integrity CHECK constraints for booking/payment tables.
--
-- Prisma 7 has no @@check in PSL, so these ride the same sidecar pattern as
-- ledger-triggers.sql: idempotent statements split on `-- SPLIT`, applied via
-- `npm run db:constraints` after every push/reset (NOT against the shared dev
-- DB mid-cycle — the pre-MVP reset applies them to a clean schema).
--
-- Payment amounts use >= 0, not > 0: credit-covered checkouts and
-- org-sponsored bookings legitimately write amount = 0 (free_/org_ synthetic
-- payment intents in lib/payments/operations/checkout.ts).

ALTER TABLE "SlotOfAppointment" DROP CONSTRAINT IF EXISTS "slot_time_order";
-- SPLIT
ALTER TABLE "SlotOfAppointment" ADD CONSTRAINT "slot_time_order" CHECK ("endsAt" > "startsAt");
-- SPLIT
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "payment_amounts_nonnegative";
-- SPLIT
ALTER TABLE "Payment" ADD CONSTRAINT "payment_amounts_nonnegative" CHECK ("amount" >= 0 AND "originalAmount" >= 0 AND "taxAmount" >= 0);
-- SPLIT
ALTER TABLE "ConsultationPlan" DROP CONSTRAINT IF EXISTS "consultation_plan_price_nonnegative";
-- SPLIT
ALTER TABLE "ConsultationPlan" ADD CONSTRAINT "consultation_plan_price_nonnegative" CHECK ("price" >= 0);
-- SPLIT
ALTER TABLE "SubscriptionPlan" DROP CONSTRAINT IF EXISTS "subscription_plan_price_nonnegative";
-- SPLIT
ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "subscription_plan_price_nonnegative" CHECK ("price" >= 0);
-- SPLIT
ALTER TABLE "WebinarPlan" DROP CONSTRAINT IF EXISTS "webinar_plan_price_nonnegative";
-- SPLIT
ALTER TABLE "WebinarPlan" ADD CONSTRAINT "webinar_plan_price_nonnegative" CHECK ("price" >= 0);
-- SPLIT
ALTER TABLE "ClassPlan" DROP CONSTRAINT IF EXISTS "class_plan_price_nonnegative";
-- SPLIT
ALTER TABLE "ClassPlan" ADD CONSTRAINT "class_plan_price_nonnegative" CHECK ("price" >= 0);
-- SPLIT
ALTER TABLE "WebinarPlan" DROP CONSTRAINT IF EXISTS "webinar_plan_max_participants_min";
-- SPLIT
ALTER TABLE "WebinarPlan" ADD CONSTRAINT "webinar_plan_max_participants_min" CHECK ("maxParticipants" >= 1);
-- SPLIT
ALTER TABLE "ClassPlan" DROP CONSTRAINT IF EXISTS "class_plan_max_participants_min";
-- SPLIT
ALTER TABLE "ClassPlan" ADD CONSTRAINT "class_plan_max_participants_min" CHECK ("maxParticipants" >= 1);
-- SPLIT
-- Per-instance capacity override. NULL means "inherit the plan's value", so
-- the guard has to admit NULL while still rejecting a zero or negative cap.
ALTER TABLE "Webinar" DROP CONSTRAINT IF EXISTS "webinar_max_participants_min";
-- SPLIT
ALTER TABLE "Webinar" ADD CONSTRAINT "webinar_max_participants_min" CHECK ("maxParticipants" IS NULL OR "maxParticipants" >= 1);
-- SPLIT
ALTER TABLE "Class" DROP CONSTRAINT IF EXISTS "class_max_participants_min";
-- SPLIT
ALTER TABLE "Class" ADD CONSTRAINT "class_max_participants_min" CHECK ("maxParticipants" IS NULL OR "maxParticipants" >= 1);

-- SPLIT
-- #440 — DB-level double-booking backstop for 1:1 bookings. The application
-- guards (consultant allocation lock, #827 confirm-time recheck) are the
-- first line; this exclusion constraint is the last line: two CONFIRMED
-- slots for the same consultant may never overlap in time. Scoped to rows
-- carrying the denormalized consultantProfileId — consultation/subscription
-- slot creates set it; webinar/class attendee slots deliberately leave it
-- NULL (many same-window rows per event are legitimate there) and legacy
-- pre-#440 rows are NULL. tstzrange is '[)' so back-to-back slots don't
-- conflict.
CREATE EXTENSION IF NOT EXISTS btree_gist;
-- SPLIT
ALTER TABLE "SlotOfAppointment" DROP CONSTRAINT IF EXISTS "slot_no_confirmed_overlap";
-- SPLIT
ALTER TABLE "SlotOfAppointment" ADD CONSTRAINT "slot_no_confirmed_overlap"
  EXCLUDE USING gist (
    "consultantProfileId" WITH =,
    tstzrange("startsAt", "endsAt") WITH &&
  )
  WHERE ("consultantProfileId" IS NOT NULL AND NOT "isTentative");

-- SPLIT
-- #747 / #685 — DB-enforced "at most one pending invite per (org, email)".
-- Prisma's `partialIndexes` is still preview at 7.7.0 (drift bugs
-- prisma/prisma#29263 / #29415), so the partial unique index ships via this
-- sidecar instead; the Serializable tx in invitations/route.ts stays as the
-- first line. lower(email): the accept flow compares case-insensitively and
-- the POST handler normalizes, so the index must not admit a mixed-case
-- duplicate from any other writer. Applied to a clean schema (pre-MVP reset)
-- — CREATE fails loudly if duplicate pending invites already exist, which is
-- the correct outcome.
DROP INDEX IF EXISTS "invitations_org_email_pending_key";
-- SPLIT
CREATE UNIQUE INDEX "invitations_org_email_pending_key"
  ON "invitations" ("organizationId", lower("email"))
  WHERE "status" = 'pending';

-- SPLIT
-- #676 PM-17 — extend the payment_amounts_nonnegative pattern to every other
-- money-bearing table. Every paise column is non-negative (>= 0, matching
-- Payment). We deliberately do NOT use > 0: zero is legitimate across the
-- board — fully-refunded or credit/org-sponsored rows, LICENSE-funded
-- bookings (amount = 0), and refund/earnings reversal counter-entries that
-- net a row back to zero. NULLable columns (e.g. tdsAmountPaise, netAmount)
-- are exempted automatically: a CHECK passes when its operand is NULL.
ALTER TABLE "Refund" DROP CONSTRAINT IF EXISTS "refund_amount_nonnegative";
-- SPLIT
ALTER TABLE "Refund" ADD CONSTRAINT "refund_amount_nonnegative" CHECK ("amountPaise" >= 0);
-- SPLIT
ALTER TABLE "Dispute" DROP CONSTRAINT IF EXISTS "dispute_amount_nonnegative";
-- SPLIT
ALTER TABLE "Dispute" ADD CONSTRAINT "dispute_amount_nonnegative" CHECK ("amountPaise" >= 0);
-- SPLIT
ALTER TABLE "ConsultantPayout" DROP CONSTRAINT IF EXISTS "consultant_payout_amounts_nonnegative";
-- SPLIT
ALTER TABLE "ConsultantPayout" ADD CONSTRAINT "consultant_payout_amounts_nonnegative"
  CHECK ("amount" >= 0 AND "tdsDeducted" >= 0 AND ("netAmount" IS NULL OR "netAmount" >= 0));
-- SPLIT
ALTER TABLE "OrganizationPayout" DROP CONSTRAINT IF EXISTS "org_payout_amounts_nonnegative";
-- SPLIT
ALTER TABLE "OrganizationPayout" ADD CONSTRAINT "org_payout_amounts_nonnegative"
  CHECK (
    "amountPaise" >= 0
    AND "grossRevenuePaise" >= 0
    AND "platformFeePaise" >= 0
    AND "refundsPaise" >= 0
    AND "netPayoutPaise" >= 0
    AND "clawbackAmountPaise" >= 0
    AND ("tdsAmountPaise" IS NULL OR "tdsAmountPaise" >= 0)
  );
-- SPLIT
ALTER TABLE "ConsultantEarnings" DROP CONSTRAINT IF EXISTS "consultant_earnings_amounts_nonnegative";
-- SPLIT
ALTER TABLE "ConsultantEarnings" ADD CONSTRAINT "consultant_earnings_amounts_nonnegative"
  CHECK (
    "grossAmount" >= 0
    AND "platformFeePaise" >= 0
    AND "consultantSharePaise" >= 0
    AND "refundedShareAmount" >= 0
    AND ("gstTcsAccruedPaise" IS NULL OR "gstTcsAccruedPaise" >= 0)
  );
-- SPLIT
ALTER TABLE "OrganizationEarnings" DROP CONSTRAINT IF EXISTS "org_earnings_amounts_nonnegative";
-- SPLIT
ALTER TABLE "OrganizationEarnings" ADD CONSTRAINT "org_earnings_amounts_nonnegative"
  CHECK (
    "grossAmountPaise" >= 0
    AND "platformFeePaise" >= 0
    AND "orgSharePaise" >= 0
    AND "consultantSharePaise" >= 0
    AND "refundedAmountPaise" >= 0
  );

-- SPLIT
-- #676 PM-18 — the 3-way split must never distribute more than it took in:
-- platform fee + org share + consultant share <= gross. earnings-service.ts
-- computes orgShare as the residual (gross - platformFee - consultantShare,
-- clamped to >= 0), so equality is the norm and this catches a future writer
-- that mis-derives the split. Applied to OrganizationEarnings only: the
-- ConsultantEarnings COLLABORATOR rows deliberately carry grossAmount = 0
-- while consultantSharePaise > 0 (the booking gross lives once on the OWNER
-- row), so the same invariant does not hold there and must not be enforced.
ALTER TABLE "OrganizationEarnings" DROP CONSTRAINT IF EXISTS "org_earnings_split_within_gross";
-- SPLIT
ALTER TABLE "OrganizationEarnings" ADD CONSTRAINT "org_earnings_split_within_gross"
  CHECK ("platformFeePaise" + "orgSharePaise" + "consultantSharePaise" <= "grossAmountPaise");

-- SPLIT
-- #676 PM-22 — financial-year strings are always "YYYY-YY" (e.g. 2026-27).
-- Both writers persist the FY to avoid Apr-Mar boundary drift; this rejects a
-- malformed value at write time. ConsultantPayout.tdsFinancialYear is nullable
-- (payouts without a TDS deduction), so NULL is admitted.
ALTER TABLE "TDSRecord" DROP CONSTRAINT IF EXISTS "tds_record_financial_year_format";
-- SPLIT
ALTER TABLE "TDSRecord" ADD CONSTRAINT "tds_record_financial_year_format"
  CHECK ("financialYear" ~ '^[0-9]{4}-[0-9]{2}$');
-- SPLIT
ALTER TABLE "ConsultantPayout" DROP CONSTRAINT IF EXISTS "consultant_payout_tds_fy_format";
-- SPLIT
ALTER TABLE "ConsultantPayout" ADD CONSTRAINT "consultant_payout_tds_fy_format"
  CHECK ("tdsFinancialYear" IS NULL OR "tdsFinancialYear" ~ '^[0-9]{4}-[0-9]{2}$');

-- SPLIT
-- #784 — a Collaborator references exactly one plan: a webinar XOR a class.
-- The app-level backstop is assertCollaboratorPlanXor in
-- lib/collaborators/service.ts; this DB CHECK is the last line. Exactly one of
-- the two FKs is non-NULL <=> exactly one IS NULL, which `<>` expresses.
ALTER TABLE "Collaborator" DROP CONSTRAINT IF EXISTS "collaborator_plan_xor";
-- SPLIT
ALTER TABLE "Collaborator" ADD CONSTRAINT "collaborator_plan_xor"
  CHECK (("webinarPlanId" IS NULL) <> ("classPlanId" IS NULL));

-- SPLIT
-- ============================================================================
-- Money invariants that were documented but unenforced (2026-07-28 audit).
--
-- Each of these was already asserted somewhere — in a schema doc-comment, in an
-- ADR, or in an application guard — with nothing stopping a future writer, a
-- raw SQL fix, or a seed script from violating it. Every one was verified to
-- have zero violating rows on the live database before being added; a
-- constraint that cannot be applied is worse than none, because
-- check-db-sidecars then reports a permanent failure people learn to ignore.
-- ============================================================================

-- SPLIT
-- The wallet's only overdraft guard is an ORM conditional updateMany
-- (`where: { walletBalance: { gte: amount } }` in lib/api/organizations/wallet.ts).
-- That is correct but it is the ONLY line of defence: any other writer, or a
-- decrement that skips the guard, can drive an org's prepaid balance negative —
-- money the platform would then owe out of its own pocket. NULL is admitted
-- (accounts on non-WALLET funding never initialise it).
ALTER TABLE "BillingAccount" DROP CONSTRAINT IF EXISTS "billing_account_wallet_nonnegative";
-- SPLIT
ALTER TABLE "BillingAccount" ADD CONSTRAINT "billing_account_wallet_nonnegative"
  CHECK ("walletBalance" IS NULL OR "walletBalance" >= 0);

-- SPLIT
-- A purchase order can never have more left on it than it was worth.
ALTER TABLE "PurchaseOrder" DROP CONSTRAINT IF EXISTS "purchase_order_amounts_coherent";
-- SPLIT
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "purchase_order_amounts_coherent"
  CHECK (
    "totalAmountPaise" >= 0
    AND "remainingAmountPaise" >= 0
    AND "remainingAmountPaise" <= "totalAmountPaise"
  );

-- SPLIT
-- ReferralCredit.remainingAmount is a STORED derived column, and it is the one
-- the user sees and spends. Drift means a buyer is shown — and can consume —
-- a balance the ledger does not agree with. reverseCreditsForPayment nets
-- against it on every refund, so a wrong value compounds.
ALTER TABLE "ReferralCredit" DROP CONSTRAINT IF EXISTS "referral_credit_balance_consistent";
-- SPLIT
ALTER TABLE "ReferralCredit" ADD CONSTRAINT "referral_credit_balance_consistent"
  CHECK (
    "amount" >= 0
    AND "usedAmount" >= 0
    AND "remainingAmount" >= 0
    AND "remainingAmount" = "amount" - "usedAmount"
  );

-- SPLIT
ALTER TABLE "ReferralCreditUsage" DROP CONSTRAINT IF EXISTS "referral_credit_usage_nonnegative";
-- SPLIT
ALTER TABLE "ReferralCreditUsage" ADD CONSTRAINT "referral_credit_usage_nonnegative"
  CHECK ("amount" >= 0 AND "originalAmount" >= 0 AND "restoredAmount" >= 0);

-- SPLIT
-- #775 states the invariant in the schema doc-comment ("marginalPaise ==
-- basePaise + surchargePaise") but nothing enforced it. The member is charged
-- marginalPaise while the org's accrual is carved on basePaise, so a mismatch
-- means one side of a single booking is billed a different number.
ALTER TABLE "OverageEvent" DROP CONSTRAINT IF EXISTS "overage_marginal_is_base_plus_surcharge";
-- SPLIT
ALTER TABLE "OverageEvent" ADD CONSTRAINT "overage_marginal_is_base_plus_surcharge"
  CHECK (
    "basePaise" >= 0
    AND "surchargePaise" >= 0
    AND "marginalPaise" = "basePaise" + "surchargePaise"
  );

-- SPLIT
-- ADR 02's central claim is that `platformBps + orgBps + consultantBps = 10000`
-- is "an integer equality that the system can assert and that always holds".
-- It was asserted nowhere. earnings-service clamps a bad card at runtime, which
-- silently redistributes a booking's money rather than refusing it.
ALTER TABLE "RateCard" DROP CONSTRAINT IF EXISTS "rate_card_bps_sum_is_whole";
-- SPLIT
ALTER TABLE "RateCard" ADD CONSTRAINT "rate_card_bps_sum_is_whole"
  CHECK (
    "platformBps" >= 0 AND "orgBps" >= 0 AND "consultantBps" >= 0
    AND "platformBps" + "orgBps" + "consultantBps" = 10000
  );

-- SPLIT
-- A collaborator's share is a fraction of the whole, so it lives in [0, 10000].
-- The cross-row "shares on one plan sum to <= 10000" invariant cannot be a
-- CHECK; it is asserted by the ledger reconciler instead.
ALTER TABLE "Collaborator" DROP CONSTRAINT IF EXISTS "collaborator_share_bps_in_range";
-- SPLIT
ALTER TABLE "Collaborator" ADD CONSTRAINT "collaborator_share_bps_in_range"
  CHECK ("revenueShareBps" >= 0 AND "revenueShareBps" <= 10000);

-- SPLIT
-- The journal's direction column carries the sign, so an entry amount is
-- strictly positive. postLedgerTxn already rejects <= 0, but the CONSTRAINT
-- TRIGGER that enforces the balance invariant sums these values: a zero or
-- negative entry would let an "unbalanced" transaction sum to zero and pass.
ALTER TABLE "LedgerEntry" DROP CONSTRAINT IF EXISTS "ledger_entry_amount_positive";
-- SPLIT
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "ledger_entry_amount_positive"
  CHECK ("amountPaise" > 0);

-- SPLIT
-- Redemption caps are enforced only in application code today, so a race or a
-- direct write can over-redeem a capped discount.
ALTER TABLE "DiscountCode" DROP CONSTRAINT IF EXISTS "discount_code_uses_within_cap";
-- SPLIT
ALTER TABLE "DiscountCode" ADD CONSTRAINT "discount_code_uses_within_cap"
  CHECK (
    "currentUses" >= 0
    AND ("maxUses" IS NULL OR "currentUses" <= "maxUses")
  );

-- SPLIT
-- #1093 §4 — two partial uniques the schema doc-comments always claimed.
-- Verified duplicate-free on the live database before adding (2026-08-13), so
-- these apply cleanly outside a reset. Two orgs may map the same IdP user;
-- one org must not map them twice — without this, deprovisionScimUser's
-- findFirst picks arbitrarily and an IdP DELETE can leave a twin ACTIVE.
DROP INDEX IF EXISTS "membership_org_scim_key";
-- SPLIT
CREATE UNIQUE INDEX "membership_org_scim_key"
  ON "Membership" ("organizationId", "externalScimId")
  WHERE "externalScimId" IS NOT NULL;
-- SPLIT
DROP INDEX IF EXISTS "erasure_request_active_user_key";
-- SPLIT
CREATE UNIQUE INDEX "erasure_request_active_user_key"
  ON "ErasureRequest" ("userId")
  WHERE "status" IN ('PENDING', 'IN_PROGRESS');

-- SPLIT
-- ============================================================================
-- Statutory-document and billing-amount guards (money-hardening pass).
-- These tables had NO DB-level guard at all: every other money model got a
-- CHECK in this file, but the GST documents (invoice / credit note / line
-- items), wallet top-ups, per-earning share bps and seat-config pricing were
-- writable to nonsense by any direct write or future code path that skipped
-- app validation. Amounts use >= 0 where zero is legitimate (free lines,
-- zero-rated); top-ups must be strictly positive (a zero top-up is a bug,
-- not a state).
ALTER TABLE "OrganizationInvoice" DROP CONSTRAINT IF EXISTS "org_invoice_amounts_nonnegative";
-- SPLIT
ALTER TABLE "OrganizationInvoice" ADD CONSTRAINT "org_invoice_amounts_nonnegative"
  CHECK (
    "subtotalPaise" >= 0
    AND "igstPaise" >= 0 AND "cgstPaise" >= 0 AND "sgstPaise" >= 0
    AND "totalPaise" >= 0
    AND "igstPaise" + "cgstPaise" + "sgstPaise" <= "totalPaise"
  );
-- SPLIT
ALTER TABLE "InvoiceLineItem" DROP CONSTRAINT IF EXISTS "invoice_line_item_amounts_nonnegative";
-- SPLIT
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "invoice_line_item_amounts_nonnegative"
  CHECK ("quantity" > 0 AND "unitPricePaise" >= 0 AND ("taxPaise" IS NULL OR "taxPaise" >= 0));
-- SPLIT
ALTER TABLE "CreditNote" DROP CONSTRAINT IF EXISTS "credit_note_amounts_nonnegative";
-- SPLIT
ALTER TABLE "CreditNote" ADD CONSTRAINT "credit_note_amounts_nonnegative"
  CHECK (
    "subtotalPaise" >= 0
    AND "igstPaise" >= 0 AND "cgstPaise" >= 0 AND "sgstPaise" >= 0
    AND "totalPaise" >= 0
    AND "igstPaise" + "cgstPaise" + "sgstPaise" <= "totalPaise"
  );
-- SPLIT
ALTER TABLE "WalletTopUp" DROP CONSTRAINT IF EXISTS "wallet_topup_amount_positive";
-- SPLIT
ALTER TABLE "WalletTopUp" ADD CONSTRAINT "wallet_topup_amount_positive"
  CHECK ("amountPaise" > 0);
-- SPLIT
-- The RateCard bps sum got rate_card_bps_sum_is_whole; the per-earning
-- snapshot of that split had nothing — a direct write could record a 150%
-- share against an earning.
ALTER TABLE "ConsultantEarnings" DROP CONSTRAINT IF EXISTS "consultant_earnings_share_bps_range";
-- SPLIT
ALTER TABLE "ConsultantEarnings" ADD CONSTRAINT "consultant_earnings_share_bps_range"
  CHECK ("shareBps" >= 0 AND "shareBps" <= 10000);
-- SPLIT
ALTER TABLE "LicensedSeatConfig" DROP CONSTRAINT IF EXISTS "licensed_seat_config_pricing_sane";
-- SPLIT
ALTER TABLE "LicensedSeatConfig" ADD CONSTRAINT "licensed_seat_config_pricing_sane"
  CHECK (
    "ratePerSeatPaise" >= 0
    AND ("priceCapPerEngagementPaise" IS NULL OR "priceCapPerEngagementPaise" >= 0)
    AND ("maxOveragePerCyclePaise" IS NULL OR "maxOveragePerCyclePaise" >= 0)
    AND ("overageSurchargeBps" IS NULL OR ("overageSurchargeBps" >= 0 AND "overageSurchargeBps" <= 10000))
  );
-- SPLIT
ALTER TABLE "Contract" DROP CONSTRAINT IF EXISTS "contract_payment_terms_nonnegative";
-- SPLIT
ALTER TABLE "Contract" ADD CONSTRAINT "contract_payment_terms_nonnegative"
  CHECK ("paymentTermsDays" >= 0);

-- #1244 review — document review thread versioning. Prisma cannot express a
-- functional/partial unique, so this rides the sidecar like the CHECKs above:
-- one version number per position within a live thread. The root row joins
-- the thread via COALESCE(rootDocumentId, id); tombstoned rows are excluded
-- so the nightly purge can never conflict with itself.
ALTER TABLE "AppointmentDocument" DROP CONSTRAINT IF EXISTS "appointment_doc_thread_version_unique";
-- SPLIT
DROP INDEX IF EXISTS "appointment_doc_thread_version_unique";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_doc_thread_version_unique"
ON "AppointmentDocument" (COALESCE("rootDocumentId", "id"), "versionNo")
WHERE "deletedAt" IS NULL;
-- SPLIT
-- #705 — reviews became per-appointment, so the unique moved to
-- (appointmentId, consulteeProfileId). Rows written before appointmentId
-- existed carry NULL, and Postgres treats a NULL key column as distinct, so
-- that unique is permissive for exactly the rows that were never gated per
-- session — the old "one review per (consultant, consultee)" rule would
-- silently lapse for them. This preserves it for the legacy band only, and
-- expires with the pre-MVP reset once no NULLs remain.
--
-- Cannot fail to build: the constraint it replaces already guarantees those
-- pairs are unique today.
DROP INDEX IF EXISTS "consultant_review_legacy_pair_key";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "consultant_review_legacy_pair_key"
ON "ConsultantReview" ("consultantProfileId", "consulteeProfileId")
WHERE "appointmentId" IS NULL;
-- SPLIT
-- #onboarding-ux — the resumable-onboarding draft blob. The writer already
-- byte-gates at ONBOARDING_DRAFT_MAX_BYTES (utils/onboarding-draft.ts), but
-- that gate lives in application code on a column any future writer can reach
-- directly. `pg_column_size` measures the stored (post-TOAST-compression)
-- width, so a pasted resume that compresses well still gets in — the
-- constraint is a backstop against an unbounded row, not a second copy of the
-- product rule.
ALTER TABLE "onboarding_drafts" DROP CONSTRAINT IF EXISTS "onboarding_draft_payload_size";
-- SPLIT
ALTER TABLE "onboarding_drafts" ADD CONSTRAINT "onboarding_draft_payload_size"
  CHECK (pg_column_size("payload") <= 65536);

-- SPLIT
-- #1405 — one OPEN rate-card window per scope. `bumpRateCard` closes the
-- current card and inserts its replacement in one transaction, but under the
-- default isolation two concurrent OWNER bumps each read "nothing open here"
-- and each insert a row with `effectiveTo = NULL`; `findEffective` then picked
-- between the two open windows non-deterministically, so the same booking
-- could settle on either split. The route is Serializable + retried now; this
-- index is the structural guarantee behind it. Three of the four scope columns
-- are nullable and Postgres treats NULL key columns as distinct, which is
-- exactly the case that must NOT be exempt, so NULL key columns
-- are treated as equal via NULLS NOT DISTINCT (Postgres 15+); an enum-to-text
-- COALESCE expression is not IMMUTABLE and Postgres refuses it in an index.
DROP INDEX IF EXISTS "rate_card_one_open_window";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "rate_card_one_open_window"
  ON "RateCard" ("ownerOrgId", "ownerContractId", "planType", "planId")
  NULLS NOT DISTINCT
  WHERE "effectiveTo" IS NULL;

-- SPLIT
-- #1365 — B2C tax invoices are documents, not postings, so nothing else asserts
-- their arithmetic. A negative head on a statutory document is unfilable.
ALTER TABLE "ConsumerInvoice" DROP CONSTRAINT IF EXISTS "consumer_invoice_amounts_nonnegative";
-- SPLIT
ALTER TABLE "ConsumerInvoice" ADD CONSTRAINT "consumer_invoice_amounts_nonnegative"
  CHECK ("taxableValuePaise" >= 0 AND "cgstPaise" >= 0 AND "sgstPaise" >= 0 AND "igstPaise" >= 0 AND "totalPaise" >= 0);
-- SPLIT
-- A supply is either intra-state (CGST+SGST) or inter-state (IGST); an invoice
-- carrying both heads names two mutually exclusive places of supply at once.
ALTER TABLE "ConsumerInvoice" DROP CONSTRAINT IF EXISTS "consumer_invoice_tax_head_xor";
-- SPLIT
ALTER TABLE "ConsumerInvoice" ADD CONSTRAINT "consumer_invoice_tax_head_xor"
  CHECK ("igstPaise" = 0 OR ("cgstPaise" = 0 AND "sgstPaise" = 0));
-- SPLIT
ALTER TABLE "ConsumerCreditNote" DROP CONSTRAINT IF EXISTS "consumer_credit_note_amounts_nonnegative";
-- SPLIT
ALTER TABLE "ConsumerCreditNote" ADD CONSTRAINT "consumer_credit_note_amounts_nonnegative"
  CHECK ("taxableValuePaise" >= 0 AND "cgstPaise" >= 0 AND "sgstPaise" >= 0 AND "igstPaise" >= 0 AND "totalPaise" >= 0);

-- SPLIT
-- ============================================================================
-- #1354 — one withholding table, two deductee rails.
--
-- TDSRecord and TdsAdjustment used to be consultant-only, with a NOT NULL
-- `consultantProfileId` doing the structural work. Admitting host
-- organisations meant making that column nullable, which on its own would
-- allow a row belonging to NEITHER rail (both null — an unattributable
-- statutory deduction) or to BOTH (a return line filed twice, against two
-- different PANs). Prisma cannot express a CHECK, so the invariant it used to
-- get free from NOT NULL has to be restated here.
--
-- Precedent: collaborator_plan_xor above, same `<>`-on-IS-NULL shape.
-- ============================================================================

-- SPLIT
-- Exactly one deductee. `(a IS NULL) <> (b IS NULL)` is true only when the two
-- nullness flags differ, which is exactly "one of them is set".
ALTER TABLE "TDSRecord" DROP CONSTRAINT IF EXISTS "tds_record_deductee_xor";
-- SPLIT
ALTER TABLE "TDSRecord" ADD CONSTRAINT "tds_record_deductee_xor"
  CHECK (("consultantProfileId" IS NULL) <> ("organizationId" IS NULL));

-- SPLIT
-- The payout column must match the rail. Both FKs are real, so nothing else
-- stops an org row from citing a ConsultantPayout: the row would then dedupe
-- on the consultant unique (all-NULL, therefore never conflicting) and file
-- its credit under someone else's disbursement.
ALTER TABLE "TDSRecord" DROP CONSTRAINT IF EXISTS "tds_record_payout_rail_matches";
-- SPLIT
ALTER TABLE "TDSRecord" ADD CONSTRAINT "tds_record_payout_rail_matches"
  CHECK (
    ("organizationId" IS NULL AND "orgPayoutId" IS NULL)
    OR ("consultantProfileId" IS NULL AND "payoutId" IS NULL)
  );

-- SPLIT
-- Same XOR on the filing-side adjustment rows, which the return generator
-- exports as revised-statement lines.
ALTER TABLE "TdsAdjustment" DROP CONSTRAINT IF EXISTS "tds_adjustment_deductee_xor";
-- SPLIT
ALTER TABLE "TdsAdjustment" ADD CONSTRAINT "tds_adjustment_deductee_xor"
  CHECK (("consultantProfileId" IS NULL) <> ("organizationId" IS NULL));

-- SPLIT
-- #676 PM-22 shape, now on the org rail too: OrganizationPayout.tdsFinancialYear
-- is what the completion-time TDSRecord files under, so a malformed value there
-- files a whole quarter's org withholding under a year that does not exist.
ALTER TABLE "OrganizationPayout" DROP CONSTRAINT IF EXISTS "org_payout_tds_fy_format";
-- SPLIT
ALTER TABLE "OrganizationPayout" ADD CONSTRAINT "org_payout_tds_fy_format"
  CHECK ("tdsFinancialYear" IS NULL OR "tdsFinancialYear" ~ '^[0-9]{4}-[0-9]{2}$');

-- SPLIT
-- ============================================================================
-- STAGED FOR THE PRE-MVP RESET (#1169 decision 8 — do NOT apply mid-cycle).
-- Each of these can fail against pre-reset data (existing nulls, historical
-- overlaps, drifted denormalizations). They ship here commented so review and
-- the reset runbook see them; uncomment at the reset.
--
-- 1. #1093 §3 — make the idempotency guarantees structural once no nulls exist
--    (writers mint since #1169 PR 9, so no new nulls are created):
--    ALTER TABLE "Payment" ALTER COLUMN "clientIdempotencyKey" SET NOT NULL;
--    ALTER TABLE "OrganizationPayout" ALTER COLUMN "idempotencyKey" SET NOT NULL;
--
-- 2. #1093 §5 — overlapping ACTIVE program assignments double-bill a seat; the
--    (programId, membershipId, periodStart) unique cannot see different starts:
--    ALTER TABLE "ProgramAssignment" ADD CONSTRAINT "program_assignment_no_active_overlap"
--      EXCLUDE USING gist (
--        "programId" WITH =,
--        "membershipId" WITH =,
--        tstzrange("periodStart", "periodEnd") WITH &&
--      ) WHERE ("status" = 'ACTIVE');
--
-- 3. #1169 PR 1 residue — the denormalized session totals feed
--    calculateRequiredSlots as authoritative; incoherent values make plans
--    impossible to allocate ("Could only find N of M"):
--    ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "subscription_plan_total_sessions_min"
--      CHECK ("totalSessions" >= 1);
--    ALTER TABLE "ClassPlan" ADD CONSTRAINT "class_plan_total_sessions_min"
--      CHECK ("totalSessions" >= 1);
--
-- 4. #1499 — "at most one ACTIVE cancellation policy per scope" and "one row per
--    (scope, version)" are enforced today only by the Serializable rotation in
--    publishOrgCancellationPolicy. Postgres treats NULLs as distinct in a plain
--    unique, so the platform row (organizationId IS NULL) escapes the Prisma
--    @@unique entirely; NULLS NOT DISTINCT closes that. These stay COMMENTED —
--    check-db-sidecars strips comments and would demand an index that is not
--    applied, and the partial unique can fail against pre-reset rows:
--    CREATE UNIQUE INDEX "cancellation_policy_one_active_per_scope"
--      ON "CancellationPolicy" ("organizationId") NULLS NOT DISTINCT
--      WHERE "status" = 'ACTIVE';
--    CREATE UNIQUE INDEX "cancellation_policy_scope_version"
--      ON "CancellationPolicy" ("organizationId", "version") NULLS NOT DISTINCT;
-- ============================================================================
