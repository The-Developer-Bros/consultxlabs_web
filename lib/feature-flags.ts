/**
 * Feature flags for gradual feature rollout.
 *
 * Flags are read from process.env at module load time. Setting a flag in the
 * deployment environment requires a redeploy — this is intentional. We don't
 * want runtime flag flips for billing-affecting features.
 *
 * To enable a flag locally, add it to your `.env` file or set it in your
 * shell before running `npm run dev`.
 */

/**
 * Hosting organizations (agencies that host multiple experts and capture
 * a slice of every booking via a 3-way revenue split).
 *
 * The schema (`Organization.canHost`, `MemberRole.EXPERT`,
 * `OrganizationEarnings`), code paths, and API routes for hosting orgs
 * all exist in this codebase but are gated by this flag. When false (the
 * default pre-MVP):
 *   - POST /api/organizations rejects `canHost=true` with 400 HOST_ORGS_GATED
 *   - POST /api/organizations/[id]/members rejects `role === "EXPERT"`
 *   - The org-create wizard hides the "host consultants" capability checkbox
 *     (the render sites read this server flag and pass hostOrgsEnabled to the
 *     wizard; the 400 gate above stays as the server-side backstop) — #863
 *
 * NOT gated by this flag: the public /explore/enterprise/organisations
 * directory. It used to be, which was a category error — this is a payments
 * flag, and because the create gate above also blocks `canHost=true`, a
 * directory filtered on canHost could never be non-empty while the flag was
 * off. Discovery is now controlled solely by the owner-set
 * `Organization.isPublic` opt-in; orgs of every capability can be listed.
 *   - The host earnings/payout surfaces stay gated
 *   - The Experts tab and the Payouts nav item are hidden — but note those
 *     are gated on the org's own `canHost`, not on this flag; an org can
 *     only have `canHost=true` because the create gate above let it through
 *   - The earnings split in lib/payments/payouts/earnings-service.ts takes
 *     the sponsor-only path even if the org has `canHost=true`
 *
 * To enable for a real hosting org customer:
 *   1. Set `ENABLE_HOST_ORGS=true` in the deployment environment
 *   2. Redeploy
 *   3. Verify the rejection paths above now succeed
 *   4. See Issue #646 for the full hosting-org follow-up checklist
 *
 * The flag is intentionally NOT a runtime toggle — flipping it mid-stream
 * would mean some payments use sponsor-only split logic and others use
 * the 3-way split, which is a compliance nightmare.
 *
 * Renamed from `ENABLE_PROVIDER_ORGS` in the Arch-4 terminology purge —
 * "provider" is dead vocabulary; the capability is `canHost` and the
 * kind label is `HOST`. No back-compat shim because the app is pre-launch.
 */
export const ENABLE_HOST_ORGS = process.env.ENABLE_HOST_ORGS === "true";

/**
 * Live payout *disbursement* gate (#776 §B). The whole payout pipeline runs
 * (batches, ledger, TDS, status machine) but gateway submission is held until a
 * post-MVP sandbox proof + go-live (`docs/enterprise/50-operations/06-live-payout-go-live-runbook.md`).
 * While false, org/consultant payouts sit PROCESSING — surfaced honestly in the
 * UI as "pending platform enablement", never as a failure. Server-only; the home
 * action-center + payout surfaces read it on the server and pass the boolean down.
 */
export const ENABLE_LIVE_PAYOUTS = process.env.ENABLE_LIVE_PAYOUTS === "true";

/**
 * Section 194-O withholding base (#1132). OFF by default — flipping it changes
 * how much tax is withheld from real consultants, so it needs written CA
 * sign-off first.
 *
 * Today the base is `payout.amount`, i.e. the consultant's share NET of our
 * platform commission. Section 194-O — now s.393(1) Table Sl. 8(v) of the
 * Income-tax Act 2025 — requires deduction on the GROSS amount of the sale, and
 * CBDT Circulars 17/2020 and 20/2021 are explicit that the operator's retained
 * commission is not deductible from that base. So the current computation
 * under-withholds by the commission fraction, with s.201 interest at 1%/month
 * and a 30% expense disallowance as the downside.
 *
 * When true, the payout path sums `ConsultantEarnings.grossAmount` over the
 * earnings in the payout and uses that as the base, and applies the statutory
 * ₹5,00,000 exemption (see TDS_194O_EXEMPTION_PAISE) which only holds when all
 * three limbs are satisfied: individual/HUF, cumulative ≤ ₹5L, and PAN on file.
 *
 * Requires TDS_ENGINE=194O as well — the gross base is a refinement of the
 * 194-O engine, not an independent one.
 *
 * PRECONDITIONS FOR ENABLING (both, not just the first):
 *
 *   1. Written CA approval of the gross base and the three-limb ₹5L threshold.
 *
 *   2. The cumulative-gross read must be made race-safe. `priorGrossAgg` counts
 *      earnings that are already PAID, and earnings only become PAID when a
 *      completion webhook lands. `processApprovedPayouts` serialises its own
 *      workers, but completion webhooks do not serialise against it, and the
 *      schema permits several payouts per consultant per financial year. Two
 *      payouts either side of an in-flight PROCESSING one can therefore both
 *      read a prior-gross below ₹5L and both under-withhold. Reserve the
 *      cumulative gross atomically per (consultant, financial year), or include
 *      locked in-flight payouts in the aggregate, before flipping this on.
 *
 * Until then the legacy base (consultant share net of platform commission) and
 * the 194J ₹50,000 threshold remain in force, which over-withholds relative to
 * the statute rather than under-withholding — the safe direction to be wrong in.
 */
export const ENABLE_TDS_194O_GROSS =
  process.env.ENABLE_TDS_194O_GROSS === "true";

/**
 * IRP (Invoice Registration Portal) live e-invoice integration.
 *
 * ClearTax GSP connector is wired (`lib/compliance/irp.ts`,
 * `jobs/compliance/irp-uploader.ts`) but live submission is gated until
 * CA/legal team signs off on production credentials and the >₹5cr AATO
 * threshold actually applies to the platform. The scheduled GitHub
 * Action (`.github/workflows/irp-uploader.yml`) short-circuits when this
 * flag is false so we don't burn CI minutes hitting a stubbed connector.
 *
 * Sub-₹5cr orgs ride along on the stub `{ status: "FAILED", reason: "STUB" }`
 * return and don't need IRN to claim ITC. When the platform crosses the
 * threshold (or onboards a customer who does):
 *   1. Set the `ENABLE_IRP_UPLOADER=true` repo VARIABLE on GitHub Actions
 *   2. Set CLEARTAX_API_KEY + CLEARTAX_GSP_TOKEN + CLEARTAX_GSTIN
 *      secrets on GitHub Actions
 *   3. Run the workflow once manually (workflow_dispatch) to confirm
 *   4. See Issue #713 for the full IRP rollout checklist
 *
 * No exported const: the only gate is the CI repo variable read in
 * `.github/workflows/irp-uploader.yml` (`vars.ENABLE_IRP_UPLOADER`). The former
 * `export const ENABLE_IRP_UPLOADER` had zero importers — removed to avoid
 * implying an app-runtime gate that never existed.
 */

/**
 * Admin TDS dashboard + Form 26Q filing surfaces.
 *
 * `app/api/admin/tds/route.ts` exposes TDS deduction summaries,
 * consultant-level breakdowns, and (ADMIN-only) decrypted PAN for the
 * Form 26Q quarterly filing. The data is captured continuously by the
 * payout pipeline, but the *filing workflow* (mark-as-filed, decrypted
 * PAN view) is gated until the finance team is ready to operate it.
 *
 * When false (default): the endpoint returns 404, hiding it from
 * casual discovery. Summary/breakdown can still be reached by other
 * surfaces that read TDSRecord directly if needed for reporting.
 *
 * To enable when finance is ready to file:
 *   1. Set `ENABLE_TDS_ADMIN_VIEW=true` in the deployment environment
 *   2. Confirm the assigned ADMIN's session has the decryption key
 *   3. See Issue #737 for the Form 26Q quarterly cadence
 */
export const ENABLE_TDS_ADMIN_VIEW =
  process.env.ENABLE_TDS_ADMIN_VIEW === "true";

/**
 * Better Stack Telemetry (logs) sink for operational events (#776 §K).
 *
 * `recordSystemEvent`/`recordSystemError` always write the `SystemEvent`
 * table (source of truth). When this flag is on AND `BETTERSTACK_SOURCE_TOKEN`
 * + `BETTERSTACK_INGEST_URL` are set, those recorders ALSO ship the event to
 * Better Stack Telemetry so a failed reconcile / stuck payout / webhook-queue
 * backlog / HMAC failure can actually page someone instead of rotting in a
 * table nobody queries.
 *
 * Off by default: the sink is a fire-and-forget side channel, never on the
 * critical path. To enable:
 *   1. Create a Telemetry source in Better Stack; copy its source token +
 *      ingesting host.
 *   2. Set `ENABLE_BETTERSTACK_TELEMETRY=true`, `BETTERSTACK_SOURCE_TOKEN`,
 *      and `BETTERSTACK_INGEST_URL` in the deployment environment.
 *   3. Redeploy and confirm events land on the source's live tail.
 */
export const ENABLE_BETTERSTACK_TELEMETRY =
  process.env.ENABLE_BETTERSTACK_TELEMETRY === "true";

/**
 * Dunning stage-3 booking-suspend cascade (#812).
 *
 * The dunning cron always sends reminders and marks invoices OVERDUE. When this
 * flag is ON, its final stage also stamps `OrganizationInvoice.dunningSuspendedAt`
 * and the checkout path blocks new sponsored bookings for an org with a
 * suspended overdue invoice (paying it lifts the block). When OFF (default),
 * dunning notifies only — no auto-suspend.
 *
 * Read on the server at both gate sites (jobs/billing/dunning.ts +
 * lib/payments/operations/checkout.ts). Previously read as raw `process.env` at
 * both; centralized here so the flag inventory is complete.
 */
export const ENABLE_DUNNING_SUSPEND =
  process.env.ENABLE_DUNNING_SUSPEND === "true";
