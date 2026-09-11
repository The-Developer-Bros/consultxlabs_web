/**
 * @jest-environment node
 */

/**
 * The ledger reconciler's known-drift baseline.
 *
 * The reconciler had been red for twelve consecutive runs on 59 seed-origin
 * findings, so a real discrepancy would have been invisible in the noise. The
 * baseline fixes that — but a baseline is also the obvious way to accidentally
 * switch off a money alarm, so these tests pin the properties that stop it:
 * entries are keyed to a specific entity, and they expire.
 */
import {
  applyLedgerBaseline,
  findingIdentity,
  LEDGER_BASELINE,
  type BaselineEntry,
} from "../../lib/payments/ledger/baseline";

const NOW = new Date("2026-08-01T00:00:00Z");

const entry = (over: Partial<BaselineEntry> = {}): BaselineEntry => ({
  kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
  entityId: "payout_known",
  reason: "seed artifact",
  expires: "2026-10-31",
  ...over,
});

describe("findingIdentity", () => {
  it("keys on the kind plus the entity the finding points at", () => {
    expect(
      findingIdentity({
        kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
        payoutId: "po_1",
      }),
    ).toBe("COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN:po_1");
  });

  it("falls back through the id fields in a stable order", () => {
    expect(
      findingIdentity({ kind: "INVOICE_TOTAL_MISMATCH", invoiceId: "inv_1" }),
    ).toBe("INVOICE_TOTAL_MISMATCH:inv_1");
    expect(
      findingIdentity({
        kind: "LEDGER_BALANCE_SNAPSHOT_DRIFT",
        details: { accountId: "CASH|_|_|INR" },
      }),
    ).toBe("LEDGER_BALANCE_SNAPSHOT_DRIFT:CASH|_|_|INR");
  });
});

describe("applyLedgerBaseline", () => {
  it("excuses a baselined finding without dropping it from the report", () => {
    const findings = [
      { kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN", payoutId: "payout_known" },
    ];

    const { active, baselined } = applyLedgerBaseline(findings, NOW, [entry()]);

    expect(active).toHaveLength(0);
    // Still reported — the run just doesn't page.
    expect(baselined).toHaveLength(1);
  });

  it("does NOT excuse the same kind on a different entity", () => {
    const findings = [
      { kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN", payoutId: "payout_known" },
      { kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN", payoutId: "payout_NEW" },
    ];

    const { active, baselined } = applyLedgerBaseline(findings, NOW, [entry()]);

    // This is the property that makes the baseline safe: baselining one
    // payout must never blanket-excuse a whole class of finding.
    expect(active).toEqual([
      { kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN", payoutId: "payout_NEW" },
    ]);
    expect(baselined).toHaveLength(1);
  });

  it("stops excusing a finding once its entry has expired", () => {
    const findings = [
      { kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN", payoutId: "payout_known" },
    ];

    const { active, baselined, expired } = applyLedgerBaseline(findings, NOW, [
      entry({ expires: "2026-07-31" }), // yesterday
    ]);

    // An allowlist that outlives its own deadline is just a disabled check.
    expect(active).toHaveLength(1);
    expect(baselined).toHaveLength(0);
    expect(expired).toHaveLength(1);
  });

  it("treats an entry expiring today as still live", () => {
    const { active } = applyLedgerBaseline(
      [
        {
          kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
          payoutId: "payout_known",
        },
      ],
      NOW,
      [entry({ expires: "2026-08-01" })],
    );
    expect(active).toHaveLength(0);
  });

  it("leaves findings untouched when the baseline is empty", () => {
    const findings = [{ kind: "LEDGER_TXN_IMBALANCE", paymentId: "pay_1" }];
    const { active } = applyLedgerBaseline(findings, NOW, []);
    expect(active).toEqual(findings);
  });
});

describe("the checked-in baseline", () => {
  it("gives every entry an expiry and an entity id", () => {
    for (const e of LEDGER_BASELINE) {
      expect(e.entityId).not.toBe("");
      expect(e.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.reason.length).toBeGreaterThan(0);
    }
  });

  it("never baselines an imbalanced transaction", () => {
    // Σ(DEBIT) != Σ(CREDIT) on a single transaction means the double-entry
    // invariant itself broke. There is no circumstance in which that is
    // "known drift" to be waved through.
    const forbidden = ["LEDGER_TXN_IMBALANCE", "MONEY_VALUE_WITHIN_SAFE_RANGE"];
    expect(
      LEDGER_BASELINE.filter((e) => forbidden.includes(e.kind)),
    ).toHaveLength(0);
  });
});
