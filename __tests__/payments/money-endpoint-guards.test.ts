/**
 * @jest-environment node
 */

/**
 * #677/PM-36 + PM-37 — money-endpoint throttling and dispute-evidence
 * deadline enforcement (source-contract idiom: the routes are thin HTTP
 * shells over mocked services, so we pin the wiring that matters).
 *
 * PM-36 — POST /api/admin/refunds, POST /api/payments/disputes,
 * org invoice create/pdf/pay must run moneyOpsLimiter.
 * PM-37 — evidence submission must reject past-due disputes with a typed
 * 410 BEFORE any gateway push.
 */
import { readFileSync } from "fs";
import path from "path";

import {
  evidenceDeadlinePassed,
  type EvidenceDeadlineInput,
} from "../../lib/payments/dispute-status";

const read = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), "utf8");

describe("PM-36 — moneyOpsLimiter wiring (source contract)", () => {
  const routeFiles = [
    "app/api/admin/refunds/route.ts",
    "app/api/payments/disputes/route.ts",
    "app/api/organizations/[orgId]/billing-account/invoices/route.ts",
    "app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pdf/route.ts",
    "app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay/route.ts",
  ];

  it.each(routeFiles)("%s applies moneyOpsLimiter", (rel) => {
    const src = read(rel);
    expect(src).toContain("moneyOpsLimiter");
    expect(src).toContain("applyRateLimit(");
    // The limiter import comes from the shared module, not a local copy.
    expect(src).toContain('from "@/lib/rate-limit"');

    // #1236-triage — pay/pdf must key per ACTOR (member id), not orgId:
    // one manager's PDF browsing cannot exhaust a billing admin's bucket.
    if (rel.includes("/pdf/") || rel.includes("/pay/")) {
      expect(src).toMatch(/applyRateLimit\(\s*moneyOpsLimiter,\s*access\.member\?\.id \?\? orgId/);
    }
  });

  it("moneyOpsLimiter exists with the documented budget", () => {
    const src = read("lib/rate-limit.ts");
    expect(src).toMatch(
      /export const moneyOpsLimiter = makeLimiter\(10, "1 m", "rl:money-ops"\)/,
    );
  });
});

describe("PM-37 — evidenceDeadlinePassed guard", () => {
  const base: EvidenceDeadlineInput = {
    status: "NEEDS_RESPONSE",
    dueBy: null,
    nowMs: new Date("2026-08-24T12:00:00Z").getTime(),
  };

  it("passes when no deadline is set", () => {
    expect(evidenceDeadlinePassed(base)).toBe(false);
  });

  it("passes while the deadline is in the future", () => {
    expect(
      evidenceDeadlinePassed({
        ...base,
        dueBy: new Date("2026-08-25T12:00:00Z"),
      }),
    ).toBe(false);
  });

  it("rejects once the deadline has passed", () => {
    expect(
      evidenceDeadlinePassed({
        ...base,
        dueBy: new Date("2026-08-23T12:00:00Z"),
      }),
    ).toBe(true);
  });

  it("terminal disputes are handled by the existing status gate, not this one", () => {
    // WON/LOST never reach the deadline check in the route; the helper stays
    // status-blind so the two guards stay independently testable.
    expect(
      evidenceDeadlinePassed({ ...base, status: "LOST", dueBy: null }),
    ).toBe(false);
  });
});

describe("PM-37 — disputes route enforces the guard before gateway push", () => {
  it("the route calls evidenceDeadlinePassed before submitDisputeEvidence", () => {
    const src = read("app/api/payments/disputes/route.ts");
    const guardIdx = src.indexOf("evidenceDeadlinePassed(");
    const submitIdx = src.indexOf("submitDisputeEvidence(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(submitIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(submitIdx);
    // Typed rejection, not a bare message.
    expect(src).toContain("EVIDENCE_DEADLINE_PASSED");
    expect(src).toMatch(/status:\s*410/);
    // Gateway-neutral guidance (this surface is Stripe-only; naming Razorpay
    // here was wrong recovery advice).
    expect(src).not.toContain("Contact Razorpay support");
    expect(src).toContain("payment-gateway support");
  });
});
