/**
 * @jest-environment node
 */

/**
 * #812 §P0 — basePaise carve bookkeeping. FAILing a CHARGE_MEMBER side-charge
 * must return the carved basePaise to the org's parent accrual (restore);
 * the recovery edges (retry / late capture) must take it back out (recarve).
 * An already-invoiced parent must never have its leg silently diverged from
 * the issued document — those return "invoiced" for the caller to surface.
 */

import {
  restoreOverageBaseCarve,
  recarveOverageBase,
} from "@/lib/payments/billing/overage-base-carve";
import { transitionOverage } from "@/lib/payments/billing/overage-transitions";

interface MockOpts {
  event?: object | null;
  parent?: object | null;
  legUpdateManyCount?: number;
  parentUpdateManyCount?: number;
}

function mockTx(opts: MockOpts = {}) {
  const event =
    opts.event === undefined
      ? {
          id: "ov1",
          basePaise: 300,
          overageBehavior: "CHARGE_MEMBER",
          payment: { id: "side1", parentPaymentId: "parent1" },
        }
      : opts.event;
  const parent =
    opts.parent === undefined
      ? { id: "parent1", billableToOrgInvoiceId: null }
      : opts.parent;
  const legUpdate = jest.fn().mockResolvedValue({});
  const legUpdateMany = jest
    .fn()
    .mockResolvedValue({ count: opts.legUpdateManyCount ?? 1 });
  const paymentUpdate = jest.fn().mockResolvedValue({});
  const paymentUpdateMany = jest
    .fn()
    .mockResolvedValue({ count: opts.parentUpdateManyCount ?? 1 });
  return {
    legUpdate,
    legUpdateMany,
    paymentUpdate,
    paymentUpdateMany,
    tx: {
      overageEvent: {
        findFirst: jest.fn().mockResolvedValue(event),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      payment: {
        findUnique: jest.fn().mockResolvedValue(parent),
        update: paymentUpdate,
        updateMany: paymentUpdateMany,
      },
      paymentLeg: { update: legUpdate, updateMany: legUpdateMany },
    } as never,
  };
}

describe("restoreOverageBaseCarve", () => {
  it("increments the parent (guarded on uninvoiced) and the leg by basePaise", async () => {
    const m = mockTx();
    await expect(
      restoreOverageBaseCarve(m.tx, { overageEventId: "ov1" }),
    ).resolves.toBe("restored");
    // TOCTOU guard: the invoiced check rides the parent UPDATE's WHERE.
    expect(m.paymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "parent1", billableToOrgInvoiceId: null },
      data: { amount: { increment: 300 } },
    });
    expect(m.legUpdate).toHaveBeenCalledWith({
      where: {
        paymentId_source: { paymentId: "parent1", source: "INVOICE_ACCRUAL" },
      },
      data: { amountPaise: { increment: 300 } },
    });
  });

  it("returns invoiced (no leg writes) when the guarded parent update matches no row", async () => {
    const m = mockTx({
      parent: { id: "parent1", billableToOrgInvoiceId: "inv1" },
      parentUpdateManyCount: 0,
    });
    await expect(
      restoreOverageBaseCarve(m.tx, { overageEventId: "ov1" }),
    ).resolves.toBe("invoiced");
    expect(m.legUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["zero basePaise", { id: "ov1", basePaise: 0, overageBehavior: "CHARGE_MEMBER", payment: { id: "s", parentPaymentId: "p" } }],
    ["CHARGE_ORG event", { id: "ov1", basePaise: 300, overageBehavior: "CHARGE_ORG", payment: { id: "s", parentPaymentId: "p" } }],
    ["no parent linkage", { id: "ov1", basePaise: 300, overageBehavior: "CHARGE_MEMBER", payment: { id: "s", parentPaymentId: null } }],
    ["missing event", null],
  ])("is a no-op for %s", async (_label, event) => {
    const m = mockTx({ event });
    await expect(
      restoreOverageBaseCarve(m.tx, { overageEventId: "ov1" }),
    ).resolves.toBe("none");
    expect(m.legUpdate).not.toHaveBeenCalled();
  });

  it("resolves the event via the side payment id too", async () => {
    const m = mockTx();
    await restoreOverageBaseCarve(m.tx, { sidePaymentId: "side1" });
    expect(
      (m.tx as never as { overageEvent: { findFirst: jest.Mock } }).overageEvent
        .findFirst,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ where: { paymentId: "side1" } }),
    );
  });
});

describe("recarveOverageBase", () => {
  it("decrements the parent (guarded on uninvoiced) then the leg (guarded)", async () => {
    const m = mockTx();
    await expect(
      recarveOverageBase(m.tx, { overageEventId: "ov1" }),
    ).resolves.toBe("recarved");
    expect(m.paymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "parent1", billableToOrgInvoiceId: null },
      data: { amount: { decrement: 300 } },
    });
    expect(m.legUpdateMany).toHaveBeenCalledWith({
      where: {
        paymentId: "parent1",
        source: "INVOICE_ACCRUAL",
        amountPaise: { gte: 300 },
      },
      data: { amountPaise: { decrement: 300 } },
    });
  });

  it("returns invoiced when the guarded parent update matches no row", async () => {
    const m = mockTx({
      parent: { id: "parent1", billableToOrgInvoiceId: "inv1" },
      parentUpdateManyCount: 0,
    });
    await expect(
      recarveOverageBase(m.tx, { overageEventId: "ov1" }),
    ).resolves.toBe("invoiced");
    expect(m.legUpdateMany).not.toHaveBeenCalled();
  });

  it("throws (rolling the tx back) when the leg lacks the restored base on an uninvoiced parent", async () => {
    const m = mockTx({ legUpdateManyCount: 0 });
    await expect(
      recarveOverageBase(m.tx, { overageEventId: "ov1" }),
    ).rejects.toThrow(/missing the restored basePaise/);
  });
});

describe("transitionOverage fromIn narrowing (#812)", () => {
  function txWithSpy() {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    return { updateMany, tx: { overageEvent: { updateMany } } as never };
  }

  it("narrows the guard to the requested subset", async () => {
    const m = txWithSpy();
    await transitionOverage(m.tx, { paymentId: "s1" }, "CHARGED", undefined, {
      fromIn: ["FAILED"],
    });
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { paymentId: "s1", chargeStatus: { in: ["FAILED"] } },
      data: { chargeStatus: "CHARGED" },
    });
  });

  it("never widens beyond ALLOWED_FROM — illegal entries are intersected away", async () => {
    const m = txWithSpy();
    // REVERSED is not a legal source for CHARGED; only FAILED survives.
    await transitionOverage(m.tx, { paymentId: "s1" }, "CHARGED", undefined, {
      fromIn: ["FAILED", "REVERSED" as never],
    });
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { paymentId: "s1", chargeStatus: { in: ["FAILED"] } },
      data: { chargeStatus: "CHARGED" },
    });
  });
});
