---
title: Enterprise Backlog Triage — 61-Issue Sweep & Disposition Record
band: 90-audits
audience: sde4
status: live
last-reviewed: 2026-06-12
---

# Enterprise Backlog Triage — 61-Issue Sweep & Disposition Record

**Branch:** `chore/enterprise-backlog-triage` | **Date:** 2026-06-12 | **Scope:** all 32 `Enterprise`-labeled open issues plus 29 unlabeled enterprise/billing/compliance issues.

This document is the durable record of a full staff-level triage of the enterprise issue backlog. Every issue body and comment thread was read, every "shipped?" claim was verified against the codebase with file-and-line evidence, and the payments, payouts, disputes, and compliance questions were re-researched against current Razorpay documentation, RBI directions, the Income-tax Act 2025, and the DPDP Rules. The headline finding is that **most of the backlog was already shipped** by the v0–v4 audit trains (#768/#776/#777/#778/#779), the lockdown stack (#780/#781), the hardening trains (#825→#838, #845→#848), and the docs rewrite (#798–#811) — the issues simply had never been closed. The PR carrying this document closes 43 of the 61 issues and leaves a curated backlog of 17 open issues plus one consolidated launch-residuals register.

---

## 1. Research findings that anchored the verdicts

The following facts were re-verified against primary sources on 2026-06-12 and drove specific dispositions. Each implication is recorded next to the fact so the verdicts can be audited later.

| Topic | Finding | Consequence for the backlog |
| --- | --- | --- |
| Razorpay disputes | `payment.dispute.action_required` is the urgent signal: roughly **three business days** to respond before the right to contest lapses; verdicts arrive 15–30 days after evidence; `closed` is a terminal ended-without-verdict state. | The dispatch gaps were already fixed under #789; the `closed → NEEDS_RESPONSE` mis-map was still live and is fixed in this PR (new `CLOSED` terminal status). |
| Razorpay refunds | RBI TAT is T+5 working days with ₹100/day compensation thereafter; `speed_requested`/`speed_processed` metadata is advisory and does not change fees (MDR is non-refundable). | Dropping refund-speed metadata is acceptable; no work item. |
| RazorpayX payouts | The UTR arrives on the `payout.processed` payload (NEFT within ~90 seconds of bank confirmation); a `processed` payout can still reverse up to ~T+3. | UTR persistence was already implemented (`app/api/webhooks/utils.ts`, payout switch); post-completion reversal is webhook-covered (#812); the poller-side re-poll remains a fast-follow residual. |
| RBI e-mandate framework (eff. 2026-04-21) | Recurring auto-debit without AFA is capped at **₹15,000 per transaction** (₹1,00,000 carve-outs cover insurance/MF/credit-card bills only), with mandatory tokenization and a 24-hour pre-debit notice. | Notify-only wallet auto-top-up stays correct for launch; the future mandate work must cap `autoTopUpAmountPaise` at ₹15,000 (recorded in the wallet doc §7). |
| IT Act 2025 (eff. 2026-04-01) | 194-O is consolidated into §393 (Table Sl. 8(v)); the no-PAN provision is §397(2) with a 5% e-commerce carve-out; forms renumber (26Q→140-series successor, 16A→131). Public concordances still conflict on the exact 10xx payment codes. | "Document, do not hard-code" stands; the §393 code mapping happens at the Form 140/144 export boundary. Citation fixes to `docs/compliance/03`/`11` and the `tds.ts` header ship in this PR. |
| GST e-invoicing | The mandatory-IRN AATO threshold remains ₹5 crore; the 30-day IRN reporting window binds at ≥₹10 crore, including credit notes. | The env-gated IRP uploader posture is correct below threshold; settlement SLAs should stay within 30 days of invoice once AATO crosses ₹10 crore. |
| DPDP Rules 2025 | Consent and notice obligations are live now; breach-notification enforcement phases in around May 2027 with a 72-hour detailed-report window. | The `checkConsent()` stub is a real pre-launch gap — it stays tracked in #701, which is kept open as the compliance-governance tracker. |
| Prisma 7 | The repo is on 7.7.0; `partialIndexes` is still a preview feature with known migration-drift bugs (prisma/prisma#29263, #29415). | #747/#685 ship via the `prisma/sql` sidecar now instead of waiting for the preview to stabilize. |
| Razorpay Route vs RazorpayX | Route is a payment-splitting layer with T+2 linked-account settlement and no TDS support; RazorpayX is the banking/payout rail. | The batch-payout-with-TDS architecture (ADR 04) stands; #630's instant-payout premise conflicts with per-period TDS reckoning. |

---

## 2. Issues closed by this PR (43)

### 2.1 Shipped and verified — labeled set (17)

The audit-series issues were executed across the v0–v4 trains and verified here against the schema, the job files, and the workflow schedules. The table records the closing evidence for each.

| Issue | Evidence it shipped |
| --- | --- |
| #768 v0 mega-audit | Lockdown decisions all executed: God-Model satellites (`OrganizationTaxInfo`/`OrganizationMsmeInfo`/`OrgKybVerification`), BigInt money, TDS engine fix. |
| #771 v0 architectural review | Double-entry ledger live (`LedgerTransaction`/`LedgerEntry`/`LedgerAccount`), cutover complete (#772 closed), P0 list resolved. |
| #775 overage settlement | `OverageEvent` state machine + circuit breaker in schema; `settle-invoice-accruals` cron scheduled monthly; `timeout-member-overages` + `sweep-abandoned-overage-charges` live. |
| #776 v1 mega-audit | Money core shipped (reversal engine, credit notes, idempotency, `LedgerAccountBalance`); the only residual is the `ENABLE_LIVE_PAYOUTS` go-live flip, which is a runbook gate, not code. |
| #777 v2 mega-audit | Shipped as PR #787; residual (auto-top-up mandate) moves to the residuals register with the RBI ₹15k constraint. |
| #778 v3 mega-audit | Schema correctness + TDS reversal shipped; residuals (TdsAdjustment FVU export at first filing, `ENABLE_TDS_ADMIN_VIEW`) move to the register. |
| #779 v4 mega-audit | Cycle engine, auto-renew, supersession, `Program.configLockedAt`, dunning, verification resubmit — all verified in jobs/ and schema. |
| #780 BigInt | All ~80 money columns verified BigInt in `prisma/schema.prisma`. |
| #781 currency/immutability/Decimal/indexes | `Currency` enum on money rows, Restrict + `deletedAt` soft-delete pattern, `Decimal(18,6)` FX snapshots verified. |
| #783 INR-denominated ledger | `LEDGER_ACCOUNT_NON_INR` reconcile invariant live in `scripts/reconcile/reconcile-ledgers.ts`; ADR 03 currency segment reserved. |
| #784 schema design audit | The load-bearing call — TDS rates as a dated lookup table, not an enum — is shipped (`TdsRate` model with `thresholdPaise` and effective dates). |
| #769 compliance build-vs-buy | Vendor matrix decided and recorded; KYB schema (`OrgKybVerification`) landed; HRIS models dropped as decided; vendor integrations are demand-triggered. |
| #766 cross-cutting deferral rollup | All ten deferrals documented in `40-compliance-and-data/06-cross-cutting-integrations.md`; reopen conditions recorded. |
| #713 four gaps post-#710 | All four verified: MSME cron + IRP uploader (flag-gated) + contract-expiry cron + org-payout two-cron pattern, each with a scheduled workflow. |
| #715 overage charging | CHARGE_MEMBER instant path and CHARGE_ORG cycle-close cron both live; the "unscheduled invoice jobs" docs flag was stale. |
| #730 WIP banners | Programs banner removed (feature shipped); capability-gated UI replaced blanket banners. |
| #745 simplification umbrella | Executed via the 2026-06-05 docs reorganization and the #798–#811 rewrite stack. |

### 2.2 Shipped and verified — unlabeled set (10)

| Issue | Evidence it shipped |
| --- | --- |
| #789 docs rewrite umbrella | PR stack #798–#811 merged (`git log`: 025a6467, 1f20f24e, 4f91c1c3). |
| #751 coverage-overlap warning | 409 + explicit acknowledgement shipped (`app/api/organizations/[orgId]/programs/route.ts:159,333`; commit 1038da05). |
| #749 INVOICE rollup leg | `lib/payments/billing/invoice-rollup.ts` stamps `billableToOrgInvoiceId` and runs via the scheduled `settle-invoice-accruals` workflow. |
| #723 tour-owner seed | `prisma/seedFiles/15a-create-organizations.ts:779` seeds `tour-owner@familiarise.dev` with `SEED_PASSWORD` and a BetterAuth account. |
| #719 org slug control | Owner-editable slug on the Settings page (commit 0f138f9e); the wizard-side nicety is recorded as a residual. |
| #720 capability toggle UI | Owner-editable `canSponsor`/`canHost` toggles on the Settings page (same commit 0f138f9e). |
| #699 runtime/authz audit | ENT-1..5 closed via commit 40591aab; ENT-4 verified separately — the program DELETE route logs `PROGRAM_DELETED`, not `PROGRAM_PAUSED`. |
| #712 Arch-4 follow-ups | Item 1 (coveredPlanTypes in the create dialog) shipped; item 2 (contract CRUD UI) is tracked by #770; items in #751/#752 closed here; the `/billing`-vs-`/credits` surface decision moves to the residuals register. |
| #721 OrgContextFilter | Mounted and wired on five surfaces (consultant appointments/planner/requests/documents, consultee appointments); the filter value drives the query params. |
| #722 seed PaymentLeg mismatch | Premise obsolete: the seed rewrite under #771/#773 removed org-scoped seeded Payments entirely, and the reconcile LED-3 sweep only walks org-scoped payments, so a fresh seed has nothing to flag. |

### 2.3 Done inside this PR (6)

| Issue | What shipped here |
| --- | --- |
| #709 cron de-collision + alerting | All 54 scheduled workflows re-mapped to a collision-free minute grid (verified by simulating a full month — zero same-minute starts); Slack failure alerts wired into `msme-payment-alerts`, `irp-uploader`, and `expire-contracts` via the existing `notify-ops-failure.sh` pattern. |
| #727 schema future-proofing | `Referral.organizationId` added (attribution-only, mirroring `TrialSession.organizationId`); trial column already existed; collaborator org-awareness intentionally stays plan-level (derivable via `WebinarPlan.organizationId`). |
| #747 partial-unique invitation index | `invitations_org_email_pending_key` ships via the `prisma/sql/check-constraints.sql` sidecar; the Serializable transaction stays as the first line of defense. |
| #685 (duplicate of #747) | Same index; closed by the same change. |
| #269 dispute assignment | `Dispute.assignedToUserId` + `Dispute.internalNotes` columns added pre-freeze; the assignment UI is a residual. |
| #752 minor findings | Per-item: `% consumed` now uses `Math.ceil` (1 of 10,000 reads 1%, not 0%); the OrgPayerSelector label reads "Wallet: ₹X" (the value was always wallet balance); a Delete affordance for never-used programs now fronts the existing guarded DELETE endpoint; the `scripts/dev/` item is obsolete — the directory no longer exists and dev scripts are session-ephemeral by convention. |

In addition this PR fixes a live money-path bug found during verification: `mapDisputeStatus` had no `case "closed"`, so Razorpay's terminal `closed` fell to the default branch and re-entered `NEEDS_RESPONSE` (or was rejected as a backward transition and stranded the dispute). A dedicated `CLOSED` terminal status now exists end to end (enum, mapper, transition guard, earnings release, query schema, dashboard config).

### 2.4 Closed as superseded or wontfix (10)

These closures are deliberate decisions, not lost work. Each records why the issue should not survive.

| Issue | Disposition and rationale |
| --- | --- |
| #662 PROVIDER org plan | Superseded by the `canSponsor`/`canHost` capability model (#655/#681); the remaining HOST work is tracked by the verdict grid and `ENABLE_HOST_ORGS`. |
| #686 v1 scope audit | Superseded by the v0–v4 audit series and the shipped permutation grid in `60-scenarios-and-verdicts`. |
| #732 readiness backlog | Superseded by the same series; its gap matrix is fully absorbed by the 90-audits band. |
| #744 v1 defer list | Absorbed: the defer decisions live in the readiness audit's do-not-build list and this document. |
| #708 schema redundancy refactors | **Wontfix.** PaymentLeg flatten, LICENSE→`walletIsUnlimited`, enum unification, and seat-field dedup are cosmetic DRY improvements against shapes the ledger, reconcile invariants, and 1,000+ tests are green on. Churning four schema areas days before the freeze trades real regression risk for aesthetics. The redundancies are accepted as-is. |
| #711 `*Paise` → `*Minor` rename | **Wontfix** by the same lens: 81 fields and ~200 call sites of churn for vocabulary, against ADR 02's explicit INR-paise decision (#783). If real multi-currency ever lands, the rename rides that migration. |
| #667 billing-mode enum rename | **Wontfix**, same lens — naming-only schema churn post-freeze is never worth a production migration. |
| #630 payout overhaul | **Obsolete.** ADR 04's batch-payout-with-per-period-TDS architecture supersedes its premises: instant payouts conflict with TDS reckoning, tier commission was replaced by RateCard bps, fraud scoring has no schema. The one residual worth watching — milestone holds for recurring events (a consultant is fully paid after the hold even if later sessions are not delivered) — is in the residuals register with a re-file trigger. |
| #737 B2C compliance audit | Superseded by #738 (the refined audit with the applicability filter); #738 stays open as the active tracker. |
| #812 hardening umbrella | Core findings shipped via #825/#826/#838 (locks, DEAD_LETTER, CAS, GST gross-up tests); residuals (multi-collaborator refund journal, TdsAdjustment wiring, dunning-suspend cascade decision) move to the residuals register. |

---

## 3. The curated backlog that survives (17 + 1)

The intent is that this list — not the closed noise — is the enterprise backlog. Each survivor is a genuine epic or tracker with remaining work.

**Labeled (7):** #367 recording-library marketplace (parked; reopen trigger is ≥3 HOST/training orgs asking to monetize recordings — its designed schema lives in the issue comments); #663 analytics time-series (the two endpoints and charts are still unbuilt); #684 organization plans catalog (no `/plans` routes exist); #724 ORG_ADMIN half-onboarded-state collapse; #725 BetterAuth plugin tiers (2FA/Captcha/HIBP first); #746 additions roadmap umbrella; #767 CMS/newsletter RFC (decide when #312/#334 are staffed).

**Unlabeled (10):** #438 invoice PDF generation — **flagged launch-critical**: `OrganizationInvoice` rows exist but `pdfUrl` is never populated, no PDF library is installed, and a Net-60/PO-driven INVOICE-funded org cannot pay an invoice it never receives as a GST-compliant document; #840 invitee onboarding path (role-picker forces unwanted profiles); #770 contract amendment UX (eight gaps; the foundation crons shipped); #738 B2C compliance tracker (phases 2+); #733 folder-structure debt; #664 "Recommended by org" explore badge; and the four audit master trackers #688 (schema SC-series), #677 (payments PM-series), #705 (pre-MVP infra), #701 (lifecycle/DPDP governance — HRIS scope dropped per #769, `checkConsent()` stub and DataBreach writer are its live items).

**Plus one new issue:** the launch-residuals register (§4).

---

## 4. Launch-residuals register

Residual tails from closed issues, consolidated in one place (mirrored as a single GitHub issue so each tail keeps a tracking home). None blocks the schema freeze; several are time-bound.

1. **`ENABLE_LIVE_PAYOUTS` flip** (#776, ADR 11) — the go-live runbook gate; everything upstream already runs real.
2. **Wallet auto-top-up mandate** (#777 §C) — when built, cap `autoTopUpAmountPaise` at ₹15,000/charge (RBI AFA-free ceiling), tokenize, and send the 24-hour pre-debit notice. Notify-only stands until then.
3. **TdsAdjustment FVU / Form 140–144 export** (#778 §F) — build at the first quarterly filing that covers a §393-era deduction; confirm the numeric payment codes against the final CBDT challan/RPU schema at that time (public concordances conflict: 194-O cited as both 1035 and 1010).
4. **`ENABLE_TDS_ADMIN_VIEW`** (#778) — flip when finance asks for the surface.
5. **Multi-collaborator refund journal** (#812/#773) — the single-consultant path posts inline; the collaborator split reversal is still manual.
6. **Dunning-suspend cascade decision** (#812/#779) — `ENABLE_DUNNING_SUSPEND` is off by default; decide the default before self-serve tenants.
7. **Razorpay dispute reconcile via contest/accept APIs** — the reconcile cron still routes Razorpay disputes to manual review; the APIs exist (see `11-disputes.md` §3).
8. **Poller-side `COMPLETED → reversed` re-poll** (#812) — webhook path covers it; add the poller path before high-value NEFT/RTGS payouts go live.
9. **Waitlist `organizationId` population + Stream channel org metadata** (#674) — the remaining org-scope splits.
10. **`/billing` vs `/credits` surface decision** (#712 item 4) — two pages exist; docs and UX disagree on the single-surface design.
11. **Dispute admin-assignment UI** (#269) — columns shipped pre-freeze in this PR; the admin surface remains.
12. **Org-creation wizard slug field** (#719) — Settings-page control shipped; the wizard nicety remains.
13. **`ScimToken.expiresAt` enforcement** — column exists, expiry check does not.
14. **Milestone holds for recurring events** (#630) — re-file narrowly if delivery-risk on multi-session events materializes.
15. **Slack `SLACK_OPS_WEBHOOK_URL` secret provisioning** — the workflows now call the notify script, which no-ops with a visible warning until the secret exists in repo settings.
16. **MSME deadline anchor + §16 interest** — `computeMsmePaymentDeadline` keys off invoice date (defensible proxy for acceptance) and alerts only; the statutory interest is not computed (see `07-payout-pipeline.md` §5).
17. **Pre-run RazorpayX balance check** — funding the business account ahead of a batch run stays a runbook prerequisite until a balance-check step exists.

---

## 5. How this was verified

Schema claims were checked against `prisma/schema.prisma` directly; cron claims against `jobs/**` and `.github/workflows/*.yml`; webhook claims against `app/api/webhooks/razorpay-dispatch.ts` and `app/api/webhooks/utils.ts`; merge claims against `git log` on `dev`. Every Closes tag in the PR corresponds to a row in §2 with its evidence. Two prior triage claims were *overturned* by this verification — the dispute `closed` mis-map was claimed fixed but was not (now fixed in this PR), and #722's seed fix was claimed needed but the premise no longer exists — which is the strongest argument for keeping the verify-then-tag discipline.
