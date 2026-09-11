/**
 * @jest-environment node
 */

/**
 * Read-side audit-log scrub. Catches engineering-noise patterns
 * (Prisma error syntax, stack frames, JSON dumps) and redacts them
 * before the row reaches an org-visible surface. See
 * `lib/enterprise/audit-sanitize.ts` for the regex catalogue.
 *
 * The bug this prevents: an OWNER seeing
 *   "Data export bundle failed: Invalid `prisma.organization.findUnique()`
 *    invocation: { where: { id: ..., ? AND?: ProgramWhereInput | ... } }"
 * in their audit log — internal schema leakage to a tenant.
 */

import {
  sanitizeAuditDescription,
  sanitizeAuditDetails,
} from "@/lib/enterprise/audit-sanitize";

describe("sanitizeAuditDescription", () => {
  describe("safe rows pass through", () => {
    it("returns clean prose unchanged", () => {
      const safe = "Organization 'Wipro Mod' created by OWNER";
      expect(sanitizeAuditDescription(safe)).toBe(safe);
    });

    it("preserves PO + INR amount text", () => {
      const safe = "PO WZ-2026-0042 created (INR 500,000)";
      expect(sanitizeAuditDescription(safe)).toBe(safe);
    });

    it("preserves role-transition rows", () => {
      expect(sanitizeAuditDescription("Role: LEARNER → MANAGER")).toBe(
        "Role: LEARNER → MANAGER",
      );
    });

    it("empty + null guard", () => {
      expect(sanitizeAuditDescription("")).toBe("");
    });
  });

  describe("redacts Prisma error noise (#org-info-leak)", () => {
    it("redacts the canonical 'Invalid prisma.x.findUnique() invocation' shape", () => {
      const noisy =
        "Data export bundle failed: Invalid `prisma.organization.findUnique()` invocation: { where: { id: 'abc' } }";
      const out = sanitizeAuditDescription(noisy);
      // Prefix preserved, noisy tail replaced
      expect(out.startsWith("Data export bundle failed:")).toBe(true);
      expect(out).toContain("[redacted");
      expect(out).not.toContain("prisma.organization.findUnique");
    });

    it("redacts Prisma schema enum names (WhereInput, RelationFilter, …)", () => {
      const noisy =
        "Failed update: AND?: ProgramWhereInput | ProgramWhereInput[], status?: EnumProgramStatusFilter | ProgramStatus";
      const out = sanitizeAuditDescription(noisy);
      expect(out).toContain("[redacted");
      expect(out).not.toContain("ProgramWhereInput");
      expect(out).not.toContain("EnumProgramStatusFilter");
    });

    it("redacts the LicensedSeatConfigNullableScalarRelationFilter case from the screenshot", () => {
      const noisy =
        "Data export bundle failed: licensedSeatConfig?: LicensedSeatConfigNullableScalarRelationFilter | LicensedSeatConfigWhereInput | Null";
      const out = sanitizeAuditDescription(noisy);
      expect(out).toContain("[redacted");
      expect(out).not.toContain("LicensedSeatConfigNullableScalarRelationFilter");
    });
  });

  describe("redacts stack frames", () => {
    it("strips Node-style 'at ... (file:line:col)' frames", () => {
      const stack =
        "Job failed at processExport (/app/scripts/process-data-exports.ts:312:14)";
      expect(sanitizeAuditDescription(stack)).toContain("[redacted");
    });

    it("strips node:internal/ frames", () => {
      const stack = "Worker crashed: node:internal/process/task_queues:95:5";
      expect(sanitizeAuditDescription(stack)).toContain("[redacted");
    });
  });

  describe("redacts JSON payload dumps", () => {
    it("strips long JSON blobs out of description", () => {
      const noisy =
        'Webhook payload: { "event_id": "evt_abc1234567890abcdef1234567890abcdef1234567890", "status": "failed" }';
      expect(sanitizeAuditDescription(noisy)).toContain("[redacted");
    });
  });

  describe("idempotent", () => {
    it("running sanitize twice gives the same result", () => {
      const noisy =
        "Data export bundle failed: Invalid `prisma.organization.findUnique()` invocation";
      const once = sanitizeAuditDescription(noisy);
      const twice = sanitizeAuditDescription(once);
      expect(twice).toBe(once);
    });
  });

  describe("preserves user-visible prefix", () => {
    it("keeps 'Data export bundle failed:' lead, replaces the noisy tail", () => {
      const noisy =
        "Data export bundle failed: Invalid `prisma.organization.findUnique()` invocation: { where: ... }";
      const out = sanitizeAuditDescription(noisy);
      expect(out).toMatch(/^Data export bundle failed:/);
    });

    it("drops everything when the prefix itself is noise", () => {
      // No clean header — the whole string is engineering goop. Result
      // is the bare redaction placeholder.
      const noisy =
        "Invalid `prisma.payment.findFirst()` invocation: { where: PaymentWhereInput }";
      const out = sanitizeAuditDescription(noisy);
      expect(out).not.toMatch(/^Invalid `prisma/);
      expect(out).toContain("[redacted");
    });
  });
});

describe("sanitizeAuditDetails", () => {
  it("strips `error` / `stack` / `prismaError` keys", () => {
    const out = sanitizeAuditDetails({
      exportId: "abc-123",
      error: "Invalid prisma...",
      stack: "at processExport (file.ts:1:1)",
      prismaError: "P2002",
    });
    expect(out).toEqual({ exportId: "abc-123" });
  });

  it("preserves benign keys", () => {
    const out = sanitizeAuditDetails({
      invoiceId: "inv_1",
      poNumber: "PO-1",
      totalAmountPaise: 100000,
    });
    expect(out).toEqual({
      invoiceId: "inv_1",
      poNumber: "PO-1",
      totalAmountPaise: 100000,
    });
  });

  it("returns null for non-object input", () => {
    expect(sanitizeAuditDetails(null)).toBeNull();
    expect(sanitizeAuditDetails(undefined)).toBeNull();
    expect(sanitizeAuditDetails([])).toBeNull();
    expect(sanitizeAuditDetails("string")).toBeNull();
  });
});
