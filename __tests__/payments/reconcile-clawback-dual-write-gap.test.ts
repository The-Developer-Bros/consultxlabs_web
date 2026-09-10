/**
 * @jest-environment node
 */

/**
 * #1408 — the clawback dual-write detector compares AMOUNTS, not presence.
 * `OrganizationPayout.clawbackAmountPaise` is a running total, so a payout
 * clawed back twice whose second `Dr CASH / Cr ORG_PAYABLE` posting was
 * swallowed still carries a `clawback:*` transaction. The old payout-id Set
 * read that as clean and the journal quietly under-recorded recovered cash.
 *
 * The finding builder is pure, so this drives it directly rather than standing
 * up a whole reconciler run.
 */

import { clawbackDualWriteGapFindings } from "../../scripts/reconcile/reconcile-ledgers";

const PAYOUT = {
  id: "orgpo_1",
  organizationId: "org_1",
  // Two clawbacks: 30_000 + 20_000 paise.
  clawbackAmountPaise: 50_000,
};

describe("#1408 — cumulative clawback postings vs the stamped counter", () => {
  it("two clawbacks, only the first posted → flagged with the partial delta", () => {
    const findings = clawbackDualWriteGapFindings(
      [PAYOUT],
      new Map([["orgpo_1", 30_000]]),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "LEDGER_DUAL_WRITE_GAP",
      payoutId: "orgpo_1",
      organizationId: "org_1",
      expectedPaise: 50_000,
      actualPaise: 30_000,
      deltaPaise: 20_000,
    });
    // Presence alone would have cleared this row.
    expect(String(findings[0].details?.note)).toContain("exceeds");
  });

  it("both clawbacks posted → clean", () => {
    expect(
      clawbackDualWriteGapFindings([PAYOUT], new Map([["orgpo_1", 50_000]])),
    ).toEqual([]);
  });

  // Shortfall-only, so a non-positive counter is never a gap. The reconciler
  // query already filters `clawbackAmountPaise > 0`; this pins the guard in the
  // helper so a future caller with a looser query cannot manufacture findings.
  it("a zero or negative stamped counter is never flagged", () => {
    for (const clawbackAmountPaise of [0, -1]) {
      expect(
        clawbackDualWriteGapFindings(
          [{ ...PAYOUT, clawbackAmountPaise }],
          new Map(),
        ),
      ).toEqual([]);
    }
  });

  it("nothing posted at all → the total gap, same kind", () => {
    const findings = clawbackDualWriteGapFindings([PAYOUT], new Map());

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "LEDGER_DUAL_WRITE_GAP",
      actualPaise: 0,
      deltaPaise: 50_000,
    });
  });
});
