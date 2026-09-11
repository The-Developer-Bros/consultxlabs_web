/**
 * @jest-environment node
 */

/**
 * #813 review follow-up — pins recordTdsReversal's three safety properties:
 * integer-floor proportion (no float drift, tiny slices round DOWN to zero),
 * the dedup/cap against double-reversal on a second cascade, and the
 * filed-aware (FY, quarter) policy. Pure unit test over a stubbed tx — the
 * helper's reads/writes are the only prisma surface it touches.
 */

import {
  recordTdsReversal,
  getIndianFinancialYear,
  getIndianFYQuarter,
} from "@/lib/payments/tax/tds-service";

type Row = Record<string, unknown>;

function makeTx(original: Row | null, priorReversals: Row[] = []) {
  const created: Row[] = [];
  const adjustments: Row[] = [];
  const tx = {
    tDSRecord: {
      findFirst: jest.fn(async () => original),
      findMany: jest.fn(async () => priorReversals),
      create: jest.fn(async ({ data }: { data: Row }) => {
        created.push(data);
        return { id: "tdsr_new", ...data };
      }),
    },
    // #778 §D — every reversal also emits the TdsAdjustment filing artifact.
    tdsAdjustment: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        adjustments.push(data);
        return { id: "tdsadj_new", ...data };
      }),
    },
  };
  return { tx: tx as never, created, adjustments };
}

const ORIGINAL = {
  id: "tdsr_1",
  payoutId: "po_1",
  consultantProfileId: "cp_1",
  financialYear: "2025-26",
  quarter: 2,
  cumulativeAmountCredited: 100_000,
  tdsDeducted: 1_000,
  tdsRateBps: 1000,
  tdsSection: "194J",
  isReversal: false,
  reportedInForm26Q: false,
};

const PARAMS = {
  payoutId: "po_1",
  consultantProfileId: "cp_1",
  earningsId: "earn_1",
  refundAmountPaise: 10_000,
  paymentAmountPaise: 10_000,
};

describe("recordTdsReversal", () => {
  it("full refund reverses the full withholding, copying FY+quarter from an unfiled original", async () => {
    const { tx, created } = makeTx({ ...ORIGINAL });
    const result = await recordTdsReversal(tx, PARAMS);

    expect(result).not.toBeNull();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      tdsDeducted: -1_000,
      isReversal: true,
      // unfiled original → corrected in place: original's FY/quarter pair
      financialYear: "2025-26",
      quarter: 2,
      tdsSection: "194J",
      payoutId: "po_1",
      earningsId: "earn_1",
    });
  });

  it("stamps the CURRENT IST FY+quarter when the original is already filed in 26Q", async () => {
    const { tx, created } = makeTx({ ...ORIGINAL, reportedInForm26Q: true });
    await recordTdsReversal(tx, PARAMS);

    expect(created).toHaveLength(1);
    // filed original → adjust-against-future-liability: both fields from now
    expect(created[0].financialYear).toBe(getIndianFinancialYear());
    expect(created[0].quarter).toBe(getIndianFYQuarter());
  });

  it("caps a second cascade at zero — no double reversal after a full reversal exists", async () => {
    const { tx, created } = makeTx({ ...ORIGINAL }, [{ tdsDeducted: -1_000 }]);
    const result = await recordTdsReversal(tx, PARAMS);

    expect(result).toBeNull();
    expect(created).toHaveLength(0);
  });

  it("caps accumulated partial reversals at the original withholding", async () => {
    // 600 already reversed; a 70% refund wants floor(700) but only 400 remains.
    const { tx, created } = makeTx({ ...ORIGINAL }, [{ tdsDeducted: -600 }]);
    await recordTdsReversal(tx, {
      ...PARAMS,
      refundAmountPaise: 7_000,
    });

    expect(created).toHaveLength(1);
    expect(created[0].tdsDeducted).toBe(-400);
  });

  it("floors tiny slices to zero instead of float-rounding up (3334/10000 of 1 paisa)", async () => {
    const { tx, created } = makeTx({ ...ORIGINAL, tdsDeducted: 1 });
    const result = await recordTdsReversal(tx, {
      ...PARAMS,
      refundAmountPaise: 3_334,
    });

    // Math.round(0.3334) would have created a 0-paise record path; floor no-ops.
    expect(result).toBeNull();
    expect(created).toHaveLength(0);
  });

  it("no-ops when there is no original withholding", async () => {
    const { tx, created } = makeTx(null);
    const result = await recordTdsReversal(tx, PARAMS);

    expect(result).toBeNull();
    expect(created).toHaveLength(0);
  });
});
