/**
 * @jest-environment node
 */

/**
 * #715/#716 — post-collection overage credit-back. A CHARGED overage may now
 * transition to REVERSED (credit-back on full refund), but ONLY via the
 * CHARGED-scoped guard: the uncollected reversal path (reverseBookingUtilization)
 * must NOT flip a CHARGED event, and a replay against an already-REVERSED event
 * must match zero rows. The guard IS the filter, so these are all assertions on
 * the updateMany WHERE clause the transition builds.
 */

import { transitionOverage } from "@/lib/payments/billing/overage-transitions";
import type { OverageChargeStatus } from "@prisma/client";

function mockTx(count = 1) {
  const updateMany = jest.fn().mockResolvedValue({ count });
  return { updateMany, tx: { overageEvent: { updateMany } } as never };
}

describe("transitionOverage — CHARGED → REVERSED credit-back (#715/#716)", () => {
  it("allows CHARGED → REVERSED and stamps reversedAt when scoped to CHARGED", async () => {
    const m = mockTx(1);
    const reversedAt = new Date("2026-07-17T00:00:00Z");
    const moved = await transitionOverage(
      m.tx,
      { id: "ov1" },
      "REVERSED",
      { reversedAt },
      { fromIn: ["CHARGED"] },
    );
    expect(moved).toBe(1);
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { id: "ov1", chargeStatus: { in: ["CHARGED"] } },
      data: { chargeStatus: "REVERSED", reversedAt },
    });
  });

  it("does NOT flip a CHARGED event on the uncollected path (fromIn excludes CHARGED)", async () => {
    const m = mockTx(0);
    // Mirrors reverseBookingUtilization's narrowed guard.
    await transitionOverage(m.tx, { bookingUtilizationId: "bu1" }, "REVERSED", undefined, {
      fromIn: ["PENDING", "ACCRUED", "FAILED"],
    });
    const call = m.updateMany.mock.calls[0][0];
    expect(call.where.chargeStatus.in).not.toContain("CHARGED");
    expect(call.where.chargeStatus.in).toEqual(
      expect.arrayContaining(["PENDING", "ACCRUED", "FAILED"]),
    );
  });

  it("fromIn is intersected with the legal from-set, never widened", async () => {
    const m = mockTx(0);
    // REVERSED legally accepts PENDING/ACCRUED/FAILED/CHARGED; a caller asking
    // for BLOCKED (illegal) gets it filtered out, not honored.
    await transitionOverage(m.tx, { id: "ov1" }, "REVERSED", undefined, {
      fromIn: ["CHARGED", "BLOCKED" as OverageChargeStatus],
    });
    const call = m.updateMany.mock.calls[0][0];
    expect(call.where.chargeStatus.in).toEqual(["CHARGED"]);
  });

  it("replay against an already-REVERSED event matches zero rows (idempotent)", async () => {
    const m = mockTx(0); // guard filters the REVERSED row out
    const moved = await transitionOverage(
      m.tx,
      { id: "ov1" },
      "REVERSED",
      { reversedAt: new Date() },
      { fromIn: ["CHARGED"] },
    );
    expect(moved).toBe(0);
  });

  it("keeps the default REVERSED guard (uncollected) available without fromIn", async () => {
    const m = mockTx(1);
    await transitionOverage(m.tx, { id: "ov1" }, "REVERSED");
    const call = m.updateMany.mock.calls[0][0];
    // Default guard now spans the whole legal set including CHARGED — callers
    // that must exclude CHARGED pass fromIn (as reverseBookingUtilization does).
    expect(call.where.chargeStatus.in).toEqual(
      expect.arrayContaining(["PENDING", "ACCRUED", "FAILED", "CHARGED"]),
    );
  });
});
