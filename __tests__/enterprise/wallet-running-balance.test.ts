/**
 * @jest-environment node
 */

/**
 * The org wallet ledger's "Balance" column.
 *
 * The column has always been rendered and no endpoint ever produced the field.
 * Because the client validates with a required `z.number()`, the miss did not
 * degrade to "₹NaN" — it threw, so the Wallet tab sat on "Loading…" forever for
 * any org that had ever moved money. These pin the arithmetic that now fills it.
 */

import {
  withRunningBalance,
  signedDeltaPaise,
} from "../../lib/api/organizations/wallet";

describe("signedDeltaPaise", () => {
  it("credits add and debits subtract", () => {
    expect(
      signedDeltaPaise([
        { direction: "CREDIT", amountPaise: 500_00 },
        { direction: "DEBIT", amountPaise: 200_00 },
      ]),
    ).toBe(300_00);
  });

  it("reads BigInt columns, which is how LedgerEntry.amountPaise actually arrives", () => {
    // LedgerEntry is not in the money result extension's boundary map, so the
    // column reaches this code as a BigInt rather than a number.
    expect(
      signedDeltaPaise([
        { direction: "CREDIT", amountPaise: BigInt(1000) },
        { direction: "DEBIT", amountPaise: BigInt(250) },
      ]),
    ).toBe(750);
  });

  it("is 0 for an account with no entries", () => {
    expect(signedDeltaPaise([])).toBe(0);
  });
});

describe("withRunningBalance", () => {
  // Newest first, which is the order the ledger query returns.
  const page = [
    { id: "c", deltaPaise: -200_00 }, // spend
    { id: "b", deltaPaise: 500_00 }, // top-up
    { id: "a", deltaPaise: 100_00 }, // top-up
  ];

  it("walks backwards from the balance after the newest row", () => {
    // 100_00 + 500_00 - 200_00 = 400_00 in the account.
    const rows = withRunningBalance(page, 400_00);

    expect(rows.map((r) => [r.id, r.balanceAfter])).toEqual([
      ["c", 400_00], // after the spend
      ["b", 600_00], // before it
      ["a", 100_00], // after the very first top-up
    ]);
  });

  it("lands the oldest row on its own delta, so the ledger reconciles to zero", () => {
    // The strongest statement of correctness: subtracting the last row's own
    // delta from its balanceAfter must leave an empty account.
    const rows = withRunningBalance(page, 400_00);
    const oldest = rows[rows.length - 1];
    expect(oldest.balanceAfter - oldest.deltaPaise).toBe(0);
  });

  it("keeps page 2 continuous with page 1", () => {
    // Page 1 holds the newest row; page 2 starts where it left off, which is
    // the whole-journal balance minus every delta newer than the page.
    const journal = 400_00;
    const pageOne = withRunningBalance(page.slice(0, 1), journal);
    const newerDelta = page.slice(0, 1).reduce((a, r) => a + r.deltaPaise, 0);
    const pageTwo = withRunningBalance(page.slice(1), journal - newerDelta);

    const lastOfPageOne = pageOne[pageOne.length - 1];
    // The next row's balance differs from the previous one by exactly the
    // previous row's delta — no gap, no double-count at the page seam.
    expect(lastOfPageOne.balanceAfter - lastOfPageOne.deltaPaise).toBe(
      pageTwo[0].balanceAfter,
    );
  });

  it("does not mutate the rows it is given", () => {
    const input = [{ id: "x", deltaPaise: 5 }];
    withRunningBalance(input, 5);
    expect(input[0]).not.toHaveProperty("balanceAfter");
  });

  it("returns an empty page unchanged", () => {
    expect(withRunningBalance([], 1234)).toEqual([]);
  });
});
