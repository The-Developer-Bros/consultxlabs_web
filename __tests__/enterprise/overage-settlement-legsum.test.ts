/**
 * @jest-environment node
 */

/**
 * #785 — CHARGE_ORG overage must keep Σ(legs) == Payment.amount.
 *
 * The over-cap pass-through (basePaise) is already inside the base
 * INVOICE_ACCRUAL leg (coveredPaise + basePaise == price) AND the rollup sums
 * BOTH leg sources into the invoice — so the overage leg must CARVE basePaise
 * out of the base leg, not pile on top (which double-billed the org by basePaise
 * and broke the leg-sum invariant). Only the surcharge is genuinely-additional.
 */

import { recordOverageAtCheckout } from "@/lib/payments/billing/overage-settlement";
import type { Tx } from "@/lib/prisma";

// jest.mock resolves via jest's resolver (no `@/` path mapping) — use relative
// paths that resolve to the same module files the SUT imports as `@/…`.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  // only the MEMBER notify fire-and-forget touches the outer client; null ctx
  // short-circuits it (.then(ctx => if(!ctx) return)).
  default: { programAssignment: { findUnique: () => Promise.resolve(null) } },
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgProgramOverageDue: jest.fn().mockResolvedValue(undefined),
}));

type Leg = { source: string; amountPaise: number };

/** Stateful mock tx that maintains the payment's legs + amount in memory. */
function makeTx(opts: {
  price: number;
  cap: number;
  used: number;
  surchargeBps?: number | null;
  priceCap?: number | null;
  overageBehavior?: "CHARGE_ORG" | "CHARGE_MEMBER";
  /** #1458 — which funding rail wrote the parent's base leg. */
  baseSource?: "INVOICE_ACCRUAL" | "WALLET" | "LICENSE";
}) {
  const legs: Leg[] = [
    {
      source: opts.baseSource ?? "INVOICE_ACCRUAL",
      // A licence leg is deliberately zero-value: the contract already paid.
      amountPaise: opts.baseSource === "LICENSE" ? 0 : opts.price,
    },
  ];
  const payment = { amount: opts.price };
  const children: { amount: number }[] = [];
  let childSeq = 0;
  return {
    state: { legs, payment, children },
    tx: {
      program: {
        findFirst: jest.fn().mockResolvedValue({
          licensedSeatConfig: {
            overageBehavior: opts.overageBehavior ?? "CHARGE_ORG",
            priceCapPerEngagementPaise: opts.priceCap ?? null,
            coveredEngagementsPerCycle: opts.cap,
            overageSurchargeBps: opts.surchargeBps ?? null,
            maxOveragePerCyclePaise: null,
          },
          creditPoolConfig: null,
        }),
      },
      overageEvent: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { marginalPaise: 0 } }),
        create: jest.fn().mockResolvedValue({ id: "ev1" }),
      },
      bookingUtilization: {
        findUnique: jest.fn().mockResolvedValue({ id: "bu1" }),
      },
      paymentLeg: {
        findUnique: jest.fn(async ({ where }: any) => {
          const src = where.paymentId_source.source;
          return legs.find((l) => l.source === src) ?? null;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const src = where.paymentId_source.source;
          const leg = legs.find((l) => l.source === src)!;
          if (data.amountPaise?.decrement != null)
            leg.amountPaise -= data.amountPaise.decrement;
        }),
        create: jest.fn(async ({ data }: any) => {
          legs.push({ source: data.source, amountPaise: data.amountPaise });
        }),
      },
      payment: {
        create: jest.fn(async ({ data }: any) => {
          children.push({ amount: data.amount });
          return { id: `child${++childSeq}` };
        }),
        update: jest.fn(async ({ data }: any) => {
          if (data.amount?.increment != null)
            payment.amount += data.amount.increment;
          if (data.amount?.decrement != null)
            payment.amount -= data.amount.decrement;
        }),
        findUnique: jest.fn(async () => ({ amount: payment.amount })),
      },
    },
  };
}

const callArgs = (price: number) => ({
  programAssignmentId: "asg1",
  utilization: {
    programType: "LICENSED_SEAT" as const,
    engagementsConsumedDelta: 1,
    engagementsUsedAfter: 6,
    consumedPaiseAfter: 0,
    creditBudgetPaise: null,
  },
  bookingPricePaise: price,
  currency: "INR" as const,
  paymentId: "pay1",
  userId: "user1",
  organizationId: "org1",
  paymentGateway: "RAZORPAY" as const,
});

const sum = (legs: Leg[]) => legs.reduce((s, l) => s + l.amountPaise, 0);

describe("recordOverageAtCheckout — CHARGE_ORG leg-sum invariant (#785)", () => {
  it("no surcharge: carves basePaise out of the base leg, amount unchanged", async () => {
    const { state, tx } = makeTx({ price: 500_000, cap: 5, used: 5 });
    await recordOverageAtCheckout({ tx: tx as any, ...callArgs(500_000) });

    // base leg carved to 0 (whole over-cap engagement), overage holds the marginal
    expect(state.legs).toEqual([
      { source: "INVOICE_ACCRUAL", amountPaise: 0 },
      { source: "OVERAGE_INVOICE_ACCRUAL", amountPaise: 500_000 },
    ]);
    expect(state.payment.amount).toBe(500_000); // surcharge=0 → no bump
    expect(sum(state.legs)).toBe(state.payment.amount); // Σlegs == amount
    // the rollup sums BOTH sources → must equal price, NOT 2×price
    expect(sum(state.legs)).toBe(500_000);
  });

  it("with surcharge: carves base, bumps amount by the surcharge only", async () => {
    const { state, tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      surchargeBps: 2500, // +25%
    });
    await recordOverageAtCheckout({ tx: tx as any, ...callArgs(100_000) });

    // base carved to 0; overage = base+surcharge = 125_000; amount bumped by 25_000
    expect(state.legs).toEqual([
      { source: "INVOICE_ACCRUAL", amountPaise: 0 },
      { source: "OVERAGE_INVOICE_ACCRUAL", amountPaise: 125_000 },
    ]);
    expect(state.payment.amount).toBe(125_000); // price + surcharge
    expect(sum(state.legs)).toBe(state.payment.amount);
  });

  it("partial over-cap (priceCap < price): base leg keeps the covered remainder", async () => {
    // priceCap caps the marginal at 40_000 of a 100_000 booking → covered 60_000.
    const { state, tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      priceCap: 40_000,
    });
    await recordOverageAtCheckout({ tx: tx as any, ...callArgs(100_000) });

    expect(state.legs).toEqual([
      { source: "INVOICE_ACCRUAL", amountPaise: 60_000 }, // 100k − 40k carved
      { source: "OVERAGE_INVOICE_ACCRUAL", amountPaise: 40_000 },
    ]);
    expect(state.payment.amount).toBe(100_000); // no surcharge → unchanged
    expect(sum(state.legs)).toBe(state.payment.amount); // covered + overage == price
  });
});

describe("recordOverageAtCheckout — CHARGE_ORG on the WALLET rail (#1458)", () => {
  it("leaves the payment at the wallet debit, adds no leg, and records the overage as collected", async () => {
    const walletDebit = 258_326;
    const { state, tx } = makeTx({
      price: walletDebit,
      cap: 5,
      used: 5,
      baseSource: "WALLET",
    });
    await recordOverageAtCheckout({
      tx: tx as unknown as Tx,
      ...callArgs(walletDebit),
    });

    // The wallet already took the whole price at commit, so the marginal is
    // collected: no OVERAGE_INVOICE_ACCRUAL leg, no amount bump.
    expect(state.legs).toEqual([
      { source: "WALLET", amountPaise: walletDebit },
    ]);
    expect(state.payment.amount).toBe(walletDebit);
    // The cancellation quote is a percentage of Payment.amount and the refund
    // cascade splits it across the legs, so one WALLET leg equal to amount is
    // what makes a 100% refund return exactly the debit and not a paisa more.
    expect(sum(state.legs)).toBe(state.payment.amount);
    expect(tx.paymentLeg.create).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();

    expect(tx.overageEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          overageBehavior: "CHARGE_ORG",
          chargeStatus: "CHARGED",
          paymentId: "pay1",
          settledAt: expect.any(Date),
        }),
      }),
    );
  });

  // A licence is a flat fee settled at contract time, so its leg is ₹0 while
  // Payment.amount stays at the full price. Adding an overage leg re-arms the
  // leg-sum comparison the licence carve had suppressed, and the booking used
  // to die at COMMIT on assert_payment_legs_ok instead of saying why.
  it("LICENSE + CHARGE_ORG is refused rather than made additive", async () => {
    const { state, tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      baseSource: "LICENSE",
    });

    await expect(
      recordOverageAtCheckout({
        tx: tx as unknown as Tx,
        ...callArgs(100_000),
      }),
    ).rejects.toMatchObject({ code: "OVERAGE_UNSUPPORTED_FUNDING" });

    expect(tx.paymentLeg.create).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(state.legs).toEqual([{ source: "LICENSE", amountPaise: 0 }]);
  });
});

describe("recordOverageAtCheckout — CHARGE_MEMBER parent carve (#785)", () => {
  it("carves basePaise off the org parent; member child pays the marginal (no double-collect)", async () => {
    const { state, tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      surchargeBps: 2500, // +25% → member owes 125_000
      overageBehavior: "CHARGE_MEMBER",
    });
    await recordOverageAtCheckout({ tx: tx as any, ...callArgs(100_000) });

    // org parent: base leg + amount shed basePaise (100_000) → org pays coveredPaise (0)
    expect(state.legs).toEqual([{ source: "INVOICE_ACCRUAL", amountPaise: 0 }]);
    expect(state.payment.amount).toBe(0);
    expect(sum(state.legs)).toBe(state.payment.amount); // parent stays consistent
    // member side-charge holds the full marginal (base + surcharge)
    expect(state.children).toEqual([{ amount: 125_000 }]);
    // total collected = org(0) + member(125_000) = price(100_000) + surcharge(25_000),
    // NOT price + marginal (200_000) — basePaise is no longer double-collected.
    const totalCollected = sum(state.legs) + state.children[0].amount;
    expect(totalCollected).toBe(125_000);
  });

  it("partial over-cap: org parent keeps the covered remainder, member pays the capped marginal", async () => {
    const { state, tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      priceCap: 40_000, // marginal capped at 40_000 → covered 60_000
      overageBehavior: "CHARGE_MEMBER",
    });
    await recordOverageAtCheckout({ tx: tx as any, ...callArgs(100_000) });

    expect(state.legs).toEqual([
      { source: "INVOICE_ACCRUAL", amountPaise: 60_000 }, // covered remainder
    ]);
    expect(state.payment.amount).toBe(60_000);
    expect(state.children).toEqual([{ amount: 40_000 }]); // member pays the overage
    // org(60_000) + member(40_000) == price(100_000), no double-collect.
    expect(sum(state.legs) + state.children[0].amount).toBe(100_000);
  });

  it("OverageEvent + side-Payment mirror the booking currency (no hardcoded INR)", async () => {
    const { tx } = makeTx({
      price: 100_000,
      cap: 5,
      used: 5,
      overageBehavior: "CHARGE_MEMBER",
    });
    await recordOverageAtCheckout({
      tx: tx as unknown as Tx,
      ...callArgs(100_000),
      currency: "USD" as const,
    });

    expect(tx.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currency: "USD" }),
      }),
    );
    expect(tx.overageEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currency: "USD",
          overageBehavior: "CHARGE_MEMBER",
        }),
      }),
    );
  });
});
