---
title: Feature flags and rollout
band: 30-programs-and-lifecycle
audience: sde2
status: live
last-reviewed: 2026-06-05
---

# Feature flags and rollout

This document covers the six module-level feature flags in `lib/feature-flags.ts` (their purpose, default, and the surfaces they gate when off), the non-module `process.env` gates that live next to the code they guard, and the capability-gated UI plus WIP-banner pattern that the layer ships behind. It is for anyone flipping a flag for a customer go-live or trying to understand why a fully wired surface is dark, and it was last verified against code on 2026-06-05 (#776/#777).

Flags are read from `process.env` at module load, so setting one requires a redeploy. That is deliberate: a runtime flip on a billing-affecting feature would let some payments mid-stream take one settlement path while others take another. To enable a flag locally, add it to `.env` (or export it) before running `npm run dev`.

## Module flags (`lib/feature-flags.ts`)

Six flags are exported from the module, and each one is the literal expression `process.env.X === "true"`, so an absent or empty value means off. The table below gives each flag's default, purpose, and the surfaces it dark-fails when off.

| Flag                          | Default  | Purpose                                                                                                                                                      | Gated surfaces when OFF                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_HOST_ORGS`            | off      | Hosting orgs (agencies hosting experts, 3-way split).                                                                                                        | `POST /organizations` rejects `canHost=true` with 400 `HOST_ORGS_GATED`; `POST …/members` rejects `role=EXPERT`; the org-create wizard hides the host capability (server flag threaded to the wizard); the public org directory shows a "coming soon" state; the host routes stay gated; `/experts` + `/payouts` nav hidden; `earnings-service` takes the sponsor-only split.                                          |
| `ENABLE_LIVE_PAYOUTS`         | off      | Live payout **disbursement** gate (#776 §B).                                                                                                                 | The whole pipeline runs (batches, ledger, TDS, status machine) but gateway submission is held; org/consultant payouts sit `PROCESSING`, surfaced honestly as "pending platform enablement", **never** as a failure. Server-only — the home action-center + payout surfaces read it server-side and pass the boolean down.                                                                                              |
| `ENABLE_DUNNING_SUSPEND`      | off      | Dunning cascade that suspends an org with an overdue invoice.                                                                                                | `lib/payments/operations/checkout.ts` skips the suspend gate, so an org with an overdue invoice keeps booking. Decide before self-serve tenants (#812/#779).                                                                                                                                                                                                                                                           |
| `ENABLE_TDS_194O_GROSS`       | off      | Section 194-O withholding computed on the GROSS sale amount, with the three-limb ₹5,00,000 exemption.                                                        | The legacy base (consultant share net of platform commission) and the 194J ₹50,000 threshold stay in force. Flipping this changes real withholding, so it needs written CA sign-off first — see #1132.                                                                                                                                                                                                                 |
| `TDS_ENGINE`                  | `LEGACY` | Withholding engine selector (`LEGACY` \| `194O`). Read inline at payout time; flipping to `194O` also requires `ENABLE_TDS_194O_GROSS` + CA sign-off (#738). | Non-module env gate read in `lib/payments/payouts/payout-service.ts`.                                                                                                                                                                                                                                                                                                                                                  |
| `ENABLE_CONSOLIDATED_INVOICE` | off      | Monthly invoice-accrual settlement cron (`settle-invoice-accruals`).                                                                                         | Absent means off — accrual rows accumulate until finance enables it. Documented here because it gates real money movement despite living outside `feature-flags.ts`.                                                                                                                                                                                                                                                   |
| `DPDP_SWEEPER_DELETE`         | absent   | Consent-retention sweeper delete mode.                                                                                                                       | Absent = report-only. Intentional default; see required-secrets doc.                                                                                                                                                                                                                                                                                                                                                   |
| `RATE_CARD_SCOPED_RESOLUTION` | off      | Lets settlement forward the booking's contract and plan scope to the rate-card resolver (#1335). On only when the value is exactly `on`.                     | Off, `resolveOrgSplit()` passes org scope alone, so a contract- or plan-scoped `RateCard` can exist and never be selected — only the per-expert override, the org default and the hardcoded 10/10/80 are reachable. Read per call by `isScopedRateCardResolutionEnabled()` in `lib/api/organizations/rate-card.ts`; flipping it changes which card settles live money, so audit the org's existing scoped cards first. |

> **Other non-module gates** live in `.github/workflows/*.yml` (`ENABLE_IRP_UPLOADER`, `ENABLE_STRIPE_PAYOUTS`) and are tracked in `50-operations/07-required-secrets.md`.
> | `ENABLE_TDS_ADMIN_VIEW` | off | Admin TDS dashboard + Form 26Q filing surfaces. | `app/api/admin/tds/route.ts` returns 404 (hides from discovery). TDS data is still captured continuously by the payout pipeline; only the _filing workflow_ (mark-as-filed, decrypted-PAN view) is gated. |
> | `ENABLE_BETTERSTACK_TELEMETRY` | off | Better Stack Telemetry log sink for operational events (#776 §K). | `recordSystemEvent`/`recordSystemError` always write the `SystemEvent` table (source of truth); the flag (plus `BETTERSTACK_SOURCE_TOKEN` + `BETTERSTACK_INGEST_URL`) only adds the fire-and-forget side-channel that ships those events so a stuck payout / failed reconcile / HMAC failure can page someone. Never on the critical path. |

`ENABLE_HOST_ORGS` is the broadest of the six — flipping it off doesn't just
hide a page, it changes the **split math** and dark-fails a whole capability.
Worth drawing the blast radius so a go-live engineer sees everything one flag
governs:

```mermaid
flowchart TD
  F{"ENABLE_HOST_ORGS<br/>=== 'true'?"}
  F -- OFF (default) --> OFF["host capability dark"]
  OFF --> A["POST /organizations rejects canHost=true → 400 HOST_ORGS_GATED"]
  OFF --> B["POST …/members rejects role=EXPERT"]
  OFF --> C["wizard hides the host checkbox"]
  OFF --> D["…/{payouts,payout-account,earnings,rate-cards} → 501"]
  OFF --> E["/experts + /payouts nav hidden"]
  OFF --> G["earnings-service takes the SPONSOR-only split (no 3-way)"]
  F -- ON --> ON["hosting orgs live: 3-way split, EXPERT memberships, payout surfaces"]
```

> 🔒 **`ENABLE_HOST_ORGS` was renamed from `ENABLE_PROVIDER_ORGS`** in the Arch-4
> terminology purge (the rationale is preserved verbatim in the flag's own
> doc-comment, `lib/feature-flags.ts:39`) — "provider" is dead vocabulary; the
> capability is `canHost` and the kind label is `HOST`. No back-compat shim
> (pre-launch). This is the only historical alias worth knowing; nothing reads
> the old name.

> **What this design survived — the PROVIDER→HOST purge.** "Provider" was the
> Arch-3 word for a hosting org, and it was load-bearing in a flag name, a
> capability boolean, an enum label, and a wall of copy. The purge renamed all
> of it in one sweep with **no compatibility shim** — viable only because the
> app is pre-launch, so no persisted `ENABLE_PROVIDER_ORGS` value exists in any
> deployed env to honour. The doc-comment at `lib/feature-flags.ts:39` is the
> single surviving mention of the old name, kept deliberately so a `git log -S`
> for "PROVIDER" lands somewhere that explains the rename instead of a silent
> gap. Post-launch, this rename would have needed a dual-read shim and a
> migration window.

Each flag's go-live checklist lives in its module doc-comment (and a tracking
issue: host #646/#662, live-payout `docs/enterprise/50-operations/06-live-payout-go-live-runbook.md`,
IRP #713, TDS #737). None is a runtime toggle.

## Non-module env gates

The gates below are read inline at the point of use rather than re-exported from `lib/feature-flags.ts`, because each one gates a single call-site and centralising it would only add indirection.

| Env var                     | Read at                                                   | Effect                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_STRIPE_PAYOUTS`     | `app/api/webhooks/stripe/route.ts`                        | When `!= "true"`, inbound Stripe Connect `transfer.*` / payout webhook events are logged-and-ignored (the platform settles via Razorpay; Stripe Connect payout rails are not live).                                                                                                                                         |
| `ENABLE_IRP_UPLOADER`       | `jobs/compliance/irp-uploader.ts` + its workflow          | IRP (Invoice Registration Portal) live e-invoice submission. Read directly from `process.env`, **not** exported from `lib/feature-flags.ts`. Off ⇒ the job short-circuits so CI doesn't burn minutes on a stub; sub-₹5cr orgs ride the `{ status: "FAILED", reason: "STUB" }` return (they don't need an IRN to claim ITC). |
| `ENABLE_MOCK_PAYMENTS`      | `lib/payments/operations/mock.ts`                         | Test/dev only — when `"true"`, the mock payment operator stands in for the real gateway so flows run without hitting Razorpay. Must stay off in production.                                                                                                                                                                 |
| `MAX_INVOICE_BOOKING_PAISE` | `lib/enterprise/governance.ts#getInvoiceCreditLimitPaise` | Numeric override (not a boolean). Sets the starter credit limit for new, not-yet-verified INVOICE-funded orgs for staged ramps; falls back to ₹50,000 (`50_000_00`) when unset/non-positive. Defends the "book everything then ghost" abuse pattern (#687).                                                                 |

## Capability-gated UI

The dashboard sidebar reads the org's `canSponsor` / `canHost` / `fundingSource`
booleans and the caller's `MemberRole`, and hides pages that would 404/403/501.
See [dashboard pages](04-dashboard-pages.md) for the full matrix. Capability
gating is a **navigation-level hide only** — the API gates stay role-based, so a
MAINTAINER on a `canHost=false` org who hand-crafts `GET …/payouts` gets a 501
(host endpoints) or empty data, not a leak. A `canSponsor=false` org never sees
`/contracts`, `/programs`, `/billing`, `/purchase-orders`; a `canHost=false` org
never sees `/experts` or `/payouts`.

## WIP banners — partial implementations stay visible

The enterprise grid has permutations whose schema + API are wired but whose
end-to-end financial/dashboard surface is still in flight. Rather than hide them
(and risk forgetting to re-enable), we keep them selectable and mount a WIP
banner at the call site linking the open issue — the gap stays auditable. The
component is `components/enterprise/EnterpriseWipBanner.tsx`; the matching
server-side `TODO(#NNN)` comments sit next to the schemas that accept these
values so a surface sweep finds every permutation in one search. When a
permutation's downstream effect ships, drop the banner and its `TODO(#NNN)` in
the same commit.

## Plan visibility (`OrgPlanVisibility`)

Org-owned plans (`ConsultationPlan` / `SubscriptionPlan` / `WebinarPlan` /
`ClassPlan` with `organizationId` set) carry an `OrgPlanVisibility` enum
(`PUBLIC` / `ORG_ONLY` / `ORG_AND_PUBLIC`, default `PUBLIC`). Public marketplace
endpoints filter via `lib/api/plans/visibility.ts` so an `ORG_ONLY` plan never
leaks to `/explore/**`; org-internal catalog surfaces deliberately skip the
filter. Full detail in [public pages & discovery](05-public-pages-and-discovery.md).

## Data-residency flag

Not a feature flag per se: `Organization.dataResidencyRegion: DataRegion` is read
at write time for audit logs + consent artifacts. Rows written against an `IN`
org must never replicate to US-hosted infra. v1 enforces this at the application
layer via a `lib/compliance/` helper; a DB-trigger backstop is a future PR.

## Rollout sequence

The layer ships in one piece, because there is no per-funding-source flag — wallet, invoice, and license all share one already-deployed schema. A new customer is brought up in this order:

1. Onboard the sponsor org, starting on `PERSONAL` or `WALLET` funding.
2. Invite members in the LEARNER role.
3. Run a first test booking that exercises the full `PaymentLeg` path.
4. Optionally upgrade the org to `INVOICE` or `LICENSE` funding once a contract is signed.
5. Optionally enable `canHost` once host-side KYC clears, which also requires `ENABLE_HOST_ORGS`.

## Related docs

- [Organization types](../00-foundations/02-organization-types.md) — the capability booleans.
- [Dashboard pages](04-dashboard-pages.md) — page-by-page visibility matrix.
- [Public pages & discovery](05-public-pages-and-discovery.md) — `OrgPlanVisibility` filtering.
- [Scenarios & examples](../60-scenarios-and-verdicts/01-scenarios-and-examples.md) — worked end-to-end flows.
