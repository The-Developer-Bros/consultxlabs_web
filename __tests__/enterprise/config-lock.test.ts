/**
 * @jest-environment node
 */

/**
 * #777 §B — derived money-config lock. Pins the "editable until in use, locked
 * once anything rides on it" rule that keeps the safe-field edit honest without
 * a configLockedAt column (deferred to v4 #779 §A).
 */

import {
  isProgramMoneyConfigLocked,
  isContractTermsLocked,
} from "@/lib/enterprise/config-lock";

describe("isProgramMoneyConfigLocked", () => {
  it("unlocked when nothing rides on the program", () => {
    expect(
      isProgramMoneyConfigLocked({
        assignmentCount: 0,
        bookingCount: 0,
        overageEventCount: 0,
      }),
    ).toBe(false);
  });

  it("locks on the first assignment", () => {
    expect(
      isProgramMoneyConfigLocked({
        assignmentCount: 1,
        bookingCount: 0,
        overageEventCount: 0,
      }),
    ).toBe(true);
  });

  it("locks on a booking even without a standing assignment row", () => {
    expect(
      isProgramMoneyConfigLocked({
        assignmentCount: 0,
        bookingCount: 1,
        overageEventCount: 0,
      }),
    ).toBe(true);
  });

  it("locks on an overage event", () => {
    expect(
      isProgramMoneyConfigLocked({
        assignmentCount: 0,
        bookingCount: 0,
        overageEventCount: 1,
      }),
    ).toBe(true);
  });
});

describe("program lock precedence (#779)", () => {
  // Mirrors getProgramLockState's pure composition: the persisted
  // configLockedAt timestamp is authoritative; the derived signal predicate is
  // the belt-and-braces fallback. Kept DB-free by exercising the boolean
  // combination directly.
  const isLocked = (
    configLockedAt: Date | null,
    signals: Parameters<typeof isProgramMoneyConfigLocked>[0],
  ): boolean => configLockedAt != null || isProgramMoneyConfigLocked(signals);

  const NO_SIGNALS = {
    assignmentCount: 0,
    bookingCount: 0,
    overageEventCount: 0,
  };

  it("explicit timestamp wins even with zero derived signals", () => {
    expect(isLocked(new Date(), NO_SIGNALS)).toBe(true);
  });

  it("derived fallback still locks when counts > 0 even if timestamp is null", () => {
    expect(
      isLocked(null, { ...NO_SIGNALS, assignmentCount: 1 }),
    ).toBe(true);
  });

  it("unlocked only when timestamp is null AND nothing rides on the program", () => {
    expect(isLocked(null, NO_SIGNALS)).toBe(false);
  });
});

describe("isContractTermsLocked", () => {
  it("DRAFT with nothing issued is editable", () => {
    expect(
      isContractTermsLocked({
        status: "DRAFT",
        invoiceCount: 0,
        liveAssignmentCount: 0,
      }),
    ).toBe(false);
  });

  it("any non-DRAFT status locks (terms committed at signing)", () => {
    expect(
      isContractTermsLocked({
        status: "ACTIVE",
        invoiceCount: 0,
        liveAssignmentCount: 0,
      }),
    ).toBe(true);
  });

  it("DRAFT but already invoiced locks", () => {
    expect(
      isContractTermsLocked({
        status: "DRAFT",
        invoiceCount: 1,
        liveAssignmentCount: 0,
      }),
    ).toBe(true);
  });

  it("DRAFT with live assignments locks", () => {
    expect(
      isContractTermsLocked({
        status: "DRAFT",
        invoiceCount: 0,
        liveAssignmentCount: 2,
      }),
    ).toBe(true);
  });
});
