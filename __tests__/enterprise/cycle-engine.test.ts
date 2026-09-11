/**
 * @jest-environment node
 */

/**
 * #779 §A — pure cycle-engine helpers. Pins the date-math (month-end edges,
 * quarterly/annual), the term-clamp rule, and the roll-vs-close decision table
 * so the advance-program-cycles cron's branching stays honest without a DB.
 */

import {
  decideCycleTransition,
  nextPeriodEnd,
  resolveProgramCycle,
} from "@/lib/enterprise/cycle-engine";

// UTC dates throughout so the test is timezone-stable.
const d = (iso: string) => new Date(iso);

describe("nextPeriodEnd", () => {
  it("advances one month", () => {
    expect(nextPeriodEnd(d("2026-01-15T00:00:00.000Z"), "MONTHLY")).toEqual(
      d("2026-02-15T00:00:00.000Z"),
    );
  });

  it("clamps a month-end overflow (Jan-31 → Feb-28 in a non-leap year)", () => {
    const out = nextPeriodEnd(d("2026-01-31T00:00:00.000Z"), "MONTHLY");
    expect(out.getUTCMonth()).toBe(1); // February
    expect(out.getUTCDate()).toBe(28);
  });

  it("clamps Jan-31 → Feb-29 in a leap year", () => {
    const out = nextPeriodEnd(d("2028-01-31T00:00:00.000Z"), "MONTHLY");
    expect(out.getUTCMonth()).toBe(1);
    expect(out.getUTCDate()).toBe(29);
  });

  it("advances a quarter with month-end clamp (Aug-31 → Nov-30)", () => {
    const out = nextPeriodEnd(d("2026-08-31T00:00:00.000Z"), "QUARTERLY");
    expect(out.getUTCMonth()).toBe(10); // November
    expect(out.getUTCDate()).toBe(30);
  });

  it("advances a plain quarter", () => {
    expect(nextPeriodEnd(d("2026-01-15T00:00:00.000Z"), "QUARTERLY")).toEqual(
      d("2026-04-15T00:00:00.000Z"),
    );
  });

  it("advances a year", () => {
    expect(nextPeriodEnd(d("2026-03-10T00:00:00.000Z"), "ANNUAL")).toEqual(
      d("2027-03-10T00:00:00.000Z"),
    );
  });

  it("clamps Feb-29 → Feb-28 on an annual step into a non-leap year", () => {
    const out = nextPeriodEnd(d("2028-02-29T00:00:00.000Z"), "ANNUAL");
    expect(out.getUTCMonth()).toBe(1);
    expect(out.getUTCDate()).toBe(28);
  });

  it("does not mutate the input", () => {
    const start = d("2026-01-15T00:00:00.000Z");
    nextPeriodEnd(start, "MONTHLY");
    expect(start).toEqual(d("2026-01-15T00:00:00.000Z"));
  });
});

describe("decideCycleTransition", () => {
  const base = {
    successorPeriodStart: d("2026-02-01T00:00:00.000Z"),
    successorPeriodEnd: d("2026-03-01T00:00:00.000Z"),
    contractStatus: "ACTIVE" as const,
    contractAutoRenew: true,
    contractEffectiveTo: null as Date | null,
  };

  it("ROLLs when contract is ACTIVE + autoRenew + open-ended term", () => {
    expect(decideCycleTransition(base)).toEqual({
      action: "ROLL",
      reason: "AUTORENEW",
    });
  });

  it("CLOSEs when the contract is not ACTIVE", () => {
    expect(
      decideCycleTransition({ ...base, contractStatus: "EXPIRED" }),
    ).toEqual({ action: "CLOSE", reason: "CONTRACT_INACTIVE" });
  });

  it("CLOSEs when autoRenew is off (even if ACTIVE)", () => {
    expect(
      decideCycleTransition({ ...base, contractAutoRenew: false }),
    ).toEqual({ action: "CLOSE", reason: "AUTORENEW_OFF" });
  });

  it("CLOSEs (CLAMPED) when the successor would outlive effectiveTo", () => {
    expect(
      decideCycleTransition({
        ...base,
        contractEffectiveTo: d("2026-02-15T00:00:00.000Z"),
      }),
    ).toEqual({ action: "CLOSE", reason: "CLAMPED" });
  });

  it("ROLLs when the successor end lands exactly on effectiveTo (boundary)", () => {
    expect(
      decideCycleTransition({
        ...base,
        contractEffectiveTo: d("2026-03-01T00:00:00.000Z"),
      }),
    ).toEqual({ action: "ROLL", reason: "AUTORENEW" });
  });

  it("contract-inactive check beats the clamp check", () => {
    // An expired contract with a too-short term still reports CONTRACT_INACTIVE,
    // not CLAMPED — the inactive branch is evaluated first.
    expect(
      decideCycleTransition({
        ...base,
        contractStatus: "TERMINATED",
        contractEffectiveTo: d("2026-02-15T00:00:00.000Z"),
      }),
    ).toEqual({ action: "CLOSE", reason: "CONTRACT_INACTIVE" });
  });
});

describe("resolveProgramCycle", () => {
  it("reads the cycle from a licensed-seat config", () => {
    expect(
      resolveProgramCycle({
        licensedSeatConfig: { cycle: "MONTHLY" },
        creditPoolConfig: null,
      }),
    ).toBe("MONTHLY");
  });

  it("reads the cycle from a credit-pool config", () => {
    expect(
      resolveProgramCycle({
        licensedSeatConfig: null,
        creditPoolConfig: { cycle: "ANNUAL" },
      }),
    ).toBe("ANNUAL");
  });

  it("returns null for a malformed program with neither config", () => {
    expect(
      resolveProgramCycle({
        licensedSeatConfig: null,
        creditPoolConfig: null,
      }),
    ).toBeNull();
  });
});
