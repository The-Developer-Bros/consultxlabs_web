---
title: Route migration table
band: 50-operations
audience: sde2
status: live
last-reviewed: 2026-07-31
---

# Route migration table

> **How to read this table.** Two columns: **Old** = the pre-Arch-4
> path you may remember (or find in an old branch); **Now** = where that
> capability lives today. `same` = path unchanged (Notes say what else
> moved). **removed** = no successor — the Notes name the surface that
> absorbed it. **not yet landed** = the `Now` path is anticipated by an
> audit-action constant in `lib/enterprise/audit-actions.ts` but **no
> route file ships it** — do not link code to it. To verify a row:
> `ls app/api/<path>/route.ts` for the **Now** side (present ⇒ live,
> absent ⇒ removed/not-landed), and cross-check the live table in
> [`./01-api-reference.md`](01-api-reference.md).

Map every pre-Arch-4 enterprise API route to its current home. Rows
with "removed" in the "Now" column have no successor — the capability
moved to a different surface or the feature was rolled up into an
existing route. Rows marked **not yet landed** name a target route that
the audit-action constants anticipate but that doesn't exist in the
tree yet (don't link to it from code).

_Last reconciled against the filesystem: 2026-06-05 (post v2 mega-audit,
#777/#778/#779)._

## Core org record

The org record collapsed `OrganizationProfile` into `Organization`, so the profile route is gone and the main record route's response shape changed.

| Old | Now | Notes |
|-----|-----|-------|
| `GET/PATCH/DELETE /api/organizations/[orgId]` | same | Model merged (OrganizationProfile is gone); response shape changed (capability booleans instead of `kind`). |
| `GET /api/organizations/[orgId]/profile` | **removed** | OrganizationProfile merged into Organization. Use `/api/organizations/[orgId]`. |

## Billing / wallet / credits

The credit-pool model became the wallet, so every `/credits*` route now resolves to a `/billing-account/wallet*` successor backed by the ledger.

| Old | Now | Notes |
|-----|-----|-------|
| `GET /api/organizations/[orgId]/billing` | same (still live) + `GET /api/organizations/[orgId]/billing-account` | `GET /billing` was **not** removed — it's the aggregated dashboard snapshot (month-to-date / outstanding / pending). Per-account detail (balance, creditLimit, fundingSource) moved to `/billing-account`. `billingMode` replaced by `BillingAccount.fundingSource`. |
| `PATCH /api/organizations/[orgId]/billing` | `PATCH /api/organizations/[orgId]/billing-account` | Now gated OWNER ∨ BILLING_ADMIN (`requireOrgBillingAdminOrOwner`). |
| `GET /api/organizations/[orgId]/credits` | `GET /api/organizations/[orgId]/billing-account/wallet` | `OrgCreditPool` → `BillingAccount.walletBalance`. |
| `POST /api/organizations/[orgId]/credits/purchase` | `POST /api/organizations/[orgId]/billing-account/wallet/top-ups` | `OrgCreditPurchase` → `WalletTopUp` keyed by `providerOrderId @unique`; webhook confirm posts a `TOPUP` txn (`Dr CASH / Cr WALLET`). |
| `GET /api/organizations/[orgId]/credits/ledger` | `GET /api/organizations/[orgId]/billing-account/wallet` | `OrgCreditLedger` → the org's WALLET-account `LedgerEntry` rows (the journal is the history). |
| `GET /api/organizations/[orgId]/credits/purchases` | `GET /api/organizations/[orgId]/billing-account/wallet/top-ups` | — |
| `GET /api/organizations/[orgId]/credits/purchases/[id]` | `GET /api/organizations/[orgId]/billing-account/wallet/top-ups/[topUpId]` | — |

## Invoices + POs

Invoices and purchase orders moved under the `/billing-account` prefix, with paths otherwise unchanged.

| Old | Now | Notes |
|-----|-----|-------|
| `GET /api/organizations/[orgId]/invoices` | `GET /api/organizations/[orgId]/billing-account/invoices` | — |
| `POST /api/organizations/[orgId]/invoices` | `POST /api/organizations/[orgId]/billing-account/invoices` | — |
| `GET/PATCH /api/organizations/[orgId]/invoices/[invoiceId]` | `GET/PATCH /api/organizations/[orgId]/billing-account/invoices/[invoiceId]` | — |
| `POST /api/organizations/[orgId]/invoices/[invoiceId]/pay` | `POST /api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay` | Webhook posts an `INVOICE_PAID` `LedgerTransaction` (`Dr CASH / Cr ORG_RECEIVABLE`). |
| `GET /api/organizations/[orgId]/purchase-orders` | `GET /api/organizations/[orgId]/billing-account/purchase-orders` | — |
| `POST /api/organizations/[orgId]/purchase-orders` | `POST /api/organizations/[orgId]/billing-account/purchase-orders` | — |
| `GET/PATCH/DELETE /api/organizations/[orgId]/purchase-orders/[poId]` | `GET/PATCH/DELETE /api/organizations/[orgId]/billing-account/purchase-orders/[poId]` | — |

## Contracts and programs

The single-contract and seats models were replaced by multi-contract collections and the `Program`/`ProgramAssignment` pair, so most rows here are new routes with no old ancestor.

| Old | Now | Notes |
|-----|-----|-------|
| `GET /api/organizations/[orgId]/contract` | **removed** | Multiple contracts per org now; use `GET /contracts` list. |
| `PATCH /api/organizations/[orgId]/contract` | **removed** | — |
| _(new)_ | `GET/POST /api/organizations/[orgId]/contracts` | — |
| _(new)_ | `GET/PATCH/DELETE /api/organizations/[orgId]/contracts/[contractId]` | PATCH now carries the term-lock + TERMINATED cascade (#777 §B / #779 §A). |
| _(new, #779)_ | `POST /api/organizations/[orgId]/contracts/[contractId]/supersede` | Immutable-contract amend/renew; mints a successor + re-points programs. |
| `GET /api/organizations/[orgId]/seats` | **removed** | Seats replaced by `Program` + `ProgramAssignment`. |
| _(new)_ | `GET/POST /api/organizations/[orgId]/programs` | — |
| _(new)_ | `GET/PATCH/DELETE /api/organizations/[orgId]/programs/[programId]` | PATCH adds money-config lock + `archived` (#777 §B); DELETE emits `PROGRAM_DELETED` (was the conflated `PROGRAM_PAUSED`). |
| _(new)_ | `GET/POST /api/organizations/[orgId]/programs/[programId]/assignments` | — |
| _(new)_ | `GET/PATCH/DELETE /api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]` | — |

## Members and consultants

The separate consultant and learner collections folded into a role-filtered `/members` endpoint, and the in-org apply-to-deliver approval workflow was removed entirely.

| Old | Now | Notes |
|-----|-----|-------|
| `GET/POST /api/organizations/[orgId]/members` | same | Role vocabulary is `OWNER / MAINTAINER / MANAGER / EXPERT / LEARNER / SUPPORT`. Strings crossing the API boundary are narrowed with `MemberRoleSchema` (lib/labels/org-labels.ts); no legacy aliases accepted. |
| `GET/PATCH/DELETE /api/organizations/[orgId]/members/[memberId]` | same | — |
| `GET /api/organizations/[orgId]/consultants` | `GET /api/organizations/[orgId]/members?role=EXPERT` | Role filter on the unified `/members` endpoint. |
| `GET /api/organizations/[orgId]/learners` | `GET /api/organizations/[orgId]/members?role=LEARNER` | — |
| `POST /api/organizations/[orgId]/consultants/[consultantId]/approve` | **removed** | The Arch-4 refactor dropped the in-org "apply to deliver" workflow. EXPERT entry is now invite-driven (see `expert-lifecycle`); there is no approval step on the Membership row. `Membership.applicationNote / appliedAt / approvedAt / approvedBy` are gone, and `EXPERT_APPLIED / EXPERT_APPROVED / EXPERT_REJECTED` audit actions were deleted. |
| `POST /api/organizations/[orgId]/consultants/[consultantId]/reject` | `DELETE /api/organizations/[orgId]/members/[memberId]` | Use member removal (`status = REMOVED`) instead of reject; there is no pending-expert queue anymore. |

## Earnings / payouts / rate cards

Most earnings and payout paths are unchanged; the rate-card surface went plural and append-only, so a "patch" is now a new card that closes the old one.

| Old | Now | Notes |
|-----|-----|-------|
| `GET /api/organizations/[orgId]/earnings` | same | Response fields snapshotted: `rateCardIdApplied`, `platformBpsApplied`, etc. |
| `GET /api/organizations/[orgId]/payouts` | same | — |
| `POST /api/organizations/[orgId]/payouts` | same | Now OWNER (was MANAGER). |
| `GET/PATCH /api/organizations/[orgId]/payouts/[payoutId]` | same | — |
| `GET /api/organizations/[orgId]/payout-account` | same | — |
| `PUT /api/organizations/[orgId]/payout-account` | same | — |
| `GET /api/organizations/[orgId]/rate-card` | `GET /api/organizations/[orgId]/rate-cards` | Plural; multiple cards with `effectiveFrom/To`. |
| `PATCH /api/organizations/[orgId]/rate-card` | `POST /api/organizations/[orgId]/rate-cards` | "Patching" is now an append (new card with new bps + close old one). |

## SSO

The SSO routes are largely stable; provider verification moved inline into BetterAuth on first sign-in, and the domain-claims route lost its `/sso` prefix.

| Old | Now | Notes |
|-----|-----|-------|
| `GET/PATCH /api/organizations/[orgId]/sso` | same | Response shape unchanged; `defaultRoleForAutoJoin` now values `MemberRole`. |
| `GET/POST /api/organizations/[orgId]/sso/providers` | same | — |
| `GET/DELETE /api/organizations/[orgId]/sso/providers/[providerId]` | same | — |
| `POST /api/organizations/[orgId]/sso/providers/[providerId]/verify` | **removed** | Verification is handled inline by BetterAuth's SSO plugin on first sign-in. |
| `GET /api/organizations/[orgId]/sso/domain-claims` | `GET /api/organizations/[orgId]/domain-claims` | Same location, kept for parity. |

## Plans + catalog

The org catalog surface landed in #1050, and #1053 replaced its delete
path with an archive. An org's catalog is its own `WebinarPlan` and
`ClassPlan` rows carrying `organizationId`; `ConsultationPlan` and
`SubscriptionPlan` declare a required `consultantProfileId` and so can
never be solely org-owned. The `CATALOG_PLAN_CREATED` /
`CATALOG_PLAN_DEACTIVATED` audit constants in
`lib/enterprise/audit-actions.ts` are emitted by the route.

| Old | Now | Notes |
|-----|-----|-------|
| `GET /api/organizations/[orgId]/plans` | `GET /api/organizations/[orgId]/catalog` | Landed in #1050. The pre-Arch-4 collection + per-plan CRUD (`.../plans/[planId]`) were deleted in `2b9da181` (no 501 stub left behind). Accepts `?includeArchived=true`. |
| `POST /api/organizations/[orgId]/plans` | `POST /api/organizations/[orgId]/catalog` | Discriminated on `kind` (`WEBINAR` \| `CLASS`); also accepts the buyer-facing positioning fields (ADR 24). |
| `DELETE /api/organizations/[orgId]/plans` | `DELETE /api/organizations/[orgId]/catalog` | **Archives** rather than deletes (#1053); `?restore=true` reverses it. The plan FK chain cascades to `Payment`, so a hard delete would destroy settled money rows. |
| `GET /api/organizations/[orgId]/plans/search` | — | Not landed and not planned; the catalog list is small enough to filter client-side. |

## Consent, analytics, activity, audit

HRIS (`/hris`, `/hris/sync`, `/hris/csv-upload`) is **not yet landed** —
there is no HRIS route file in the tree, and `HRIS_SYNC_*` is not even
present in `audit-actions.ts`. Removed from this table to stop pointing
code at a non-existent surface.

| Old | Now | Notes |
|-----|-----|-------|
| _(new)_ | `GET/POST/DELETE /api/organizations/[orgId]/consent` | DPDP artifact roster; DELETE = withdraw (§12). MANAGER. |
| _(new)_ | `GET /api/organizations/[orgId]/analytics` | Rollups. MANAGER. |
| _(new)_ | `GET /api/organizations/[orgId]/activity` | OrgAuditLog feed. MANAGER. |
| _(new)_ | `GET /api/organizations/[orgId]/audit` | Wider audit read (active member). |
| _(new)_ | `GET /api/organizations/[orgId]/audit/export` | CSV export, MAINTAINER; emits `AUDIT_LOG_EXPORTED`. |
| _(new, #779)_ | `POST /api/organizations/[orgId]/verification/resubmit` | Self-serve resubmit after admin REJECT. MAINTAINER. |
| _(new, #779)_ | `POST/DELETE /api/organizations/[orgId]/sso/break-glass` | Time-boxed IdP-outage escape hatch. OWNER. |
| _(new, #777)_ | `GET /api/organizations/[orgId]/checkout/overage-preview` | Advisory pre-checkout overage estimate. Active member. |
| _(new)_ | `GET/POST /api/organizations/[orgId]/data-exports` + `[exportId]/download` | DPDP §11 export bundles. OWNER ∨ BILLING_ADMIN. |

## Admin

The platform-admin status route was renamed to `/verify` and now multiplexes the full org status machine, including the REJECT action that feeds the resubmit loop.

| Old | Now | Notes |
|-----|-----|-------|
| `POST /api/admin/organizations/[orgId]/status` | `POST /api/admin/organizations/[orgId]/verify` | One route handles `VERIFY / REJECT / SUSPEND / REACTIVATE / DEACTIVATE` (REJECT added in #779 §A — keeps the org PENDING and feeds the self-serve resubmit loop). |
| `POST /api/admin/organizations/[orgId]/verify-consultants` | **removed** | Consultant verification is a separate flow on `ConsultantProfile.verificationStatus`. |

## New subsystems (no pre-Arch-4 ancestor)

These shipped after the migration baseline, so they have no "old" route
— listed here only so a porter knows they exist and aren't a rename of
something they remember.

- **SCIM config** — `GET/POST /scim/tokens`, `DELETE /scim/tokens/[tokenId]`,
  `GET/POST /scim/group-mappings`, `DELETE /scim/group-mappings/[mappingId]`
  (all OWNER).
- **Outbound webhooks** — `/webhooks` CRUD + `[endpointId]/rotate-secret`,
  `[endpointId]/deliveries` + `.../[deliveryId]/redeliver` (mixed
  OWNER / OWNER ∨ BILLING_ADMIN / MANAGER — see `api-reference`).
- **Domain-claim verify** — `POST /domain-claims/[domain]/verify` (OWNER).
- **Stream exports** — `GET /stream/channels`, `GET /stream/calls` (MANAGER).
- **Read surfaces** — `/reimbursements` (+`/export`), `/disputes`,
  `/documents`, `/trials`, `/appointments`, `/recordings`,
  `/billing-account/invoices/[invoiceId]/pdf` (all MANAGER).

## Removed outright

- `GET /api/organizations/[orgId]/credits/pool` — `OrgCreditPool` is
  gone; use `BillingAccount.walletBalance` via `/billing-account`.
- Any route that referenced `OrganizationProfile.*` columns — merged
  into `Organization` directly.
- Any route that emitted the old `OrgAuditAction` enum value — the
  column is now a free-form string, values come from
  `lib/enterprise/audit-actions.ts`.

## Related docs

- `api-reference` — the live route table with min-roles and
  audit actions.
- `roles-and-permissions` — role catalog + the `MemberRoleSchema`
  narrowing pattern at the API boundary.
- `wallet-and-topups` — credit-pool → wallet migration.
