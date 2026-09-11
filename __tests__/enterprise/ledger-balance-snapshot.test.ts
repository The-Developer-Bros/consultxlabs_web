/**
 * @jest-environment node
 */

/**
 * Maintained ledger balance snapshot (#776 / ARCH #2). postLedgerTxn folds each
 * posting's signed delta into LedgerAccountBalance inside the same tx;
 * ledgerBalancePaise reads the O(1) snapshot (journal scan only as a fallback).
 * These assert the fold math + the read path via a mocked db client.
 */

import {
  postLedgerTxn,
  ledgerBalancePaise,
  ledgerAccountId,
} from "@/lib/payments/ledger/post";

function mockDb() {
  const balanceUpserts: Array<{ accountId: string; delta: bigint; count: bigint }> = [];
  return {
    balanceUpserts,
    ledgerTransaction: {
      findUnique: jest.fn().mockResolvedValue(null), // not idempotent-hit
      create: jest.fn().mockResolvedValue({ id: "txn-1" }),
    },
    ledgerAccount: { upsert: jest.fn().mockResolvedValue({}) },
    ledgerAccountBalance: {
      upsert: jest.fn().mockImplementation(async ({ where, create, update }) => {
        balanceUpserts.push({
          accountId: where.accountId,
          delta: update.balancePaise.increment ?? create.balancePaise,
          count: update.entrySeq.increment ?? create.entrySeq,
        });
        return {};
      }),
      findUnique: jest.fn(),
    },
    ledgerEntry: { groupBy: jest.fn() },
  };
}

describe("postLedgerTxn — balance snapshot fold", () => {
  it("folds each account's signed delta (DEBIT +, CREDIT −) once", async () => {
    const db = mockDb();
    await postLedgerTxn(db as never, {
      idempotencyKey: "k1",
      kind: "TOPUP",
      postings: [
        { account: { kind: "CASH" }, direction: "DEBIT", amountPaise: 100 },
        {
          account: { kind: "WALLET", organizationId: "org1" },
          direction: "CREDIT",
          amountPaise: 100,
        },
      ],
    });

    const byId = Object.fromEntries(
      db.balanceUpserts.map((u) => [u.accountId, u]),
    );
    expect(byId[ledgerAccountId({ kind: "CASH" })].delta).toBe(BigInt(100));
    expect(
      byId[ledgerAccountId({ kind: "WALLET", organizationId: "org1" })].delta,
    ).toBe(BigInt(-100));
    // One entry folded per account.
    expect(db.balanceUpserts.every((u) => u.count === BigInt(1))).toBe(true);
  });

  it("aggregates multiple postings to the SAME account before upserting", async () => {
    const db = mockDb();
    await postLedgerTxn(db as never, {
      idempotencyKey: "k2",
      kind: "BOOKING",
      postings: [
        { account: { kind: "CASH" }, direction: "DEBIT", amountPaise: 30 },
        { account: { kind: "CASH" }, direction: "DEBIT", amountPaise: 70 },
        { account: { kind: "PLATFORM_FEE" }, direction: "CREDIT", amountPaise: 100 },
      ],
    });
    const cash = db.balanceUpserts.find(
      (u) => u.accountId === ledgerAccountId({ kind: "CASH" }),
    );
    // 30 + 70 folded into one upsert, count 2.
    expect(cash?.delta).toBe(BigInt(100));
    expect(cash?.count).toBe(BigInt(2));
  });

  it("does not touch balances on an idempotency hit", async () => {
    const db = mockDb();
    db.ledgerTransaction.findUnique.mockResolvedValueOnce({ id: "existing" });
    const res = await postLedgerTxn(db as never, {
      idempotencyKey: "dup",
      kind: "TOPUP",
      postings: [
        { account: { kind: "CASH" }, direction: "DEBIT", amountPaise: 10 },
        { account: { kind: "WALLET", organizationId: "o" }, direction: "CREDIT", amountPaise: 10 },
      ],
    });
    expect(res.created).toBe(false);
    expect(db.ledgerAccountBalance.upsert).not.toHaveBeenCalled();
  });
});

describe("ledgerBalancePaise — snapshot read", () => {
  it("returns the snapshot balance without scanning the journal", async () => {
    const db = mockDb();
    db.ledgerAccountBalance.findUnique.mockResolvedValue({
      balancePaise: BigInt(4200),
    });
    const bal = await ledgerBalancePaise(db as never, { kind: "CASH" });
    expect(bal).toBe(4200);
    expect(db.ledgerEntry.groupBy).not.toHaveBeenCalled();
  });

  it("falls back to the journal scan when no snapshot row exists", async () => {
    const db = mockDb();
    db.ledgerAccountBalance.findUnique.mockResolvedValue(null);
    db.ledgerEntry.groupBy.mockResolvedValue([
      { direction: "DEBIT", _sum: { amountPaise: BigInt(500) } },
      { direction: "CREDIT", _sum: { amountPaise: BigInt(200) } },
    ]);
    const bal = await ledgerBalancePaise(db as never, { kind: "CASH" });
    expect(bal).toBe(300);
    expect(db.ledgerEntry.groupBy).toHaveBeenCalledTimes(1);
  });
});
