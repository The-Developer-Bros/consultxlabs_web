/**
 * Toast queue reducer for the allocation hook. The old single `pendingToast`
 * slot let a later same-tick toast clobber an earlier one; the queue keeps
 * order and only drops consecutive duplicates (which also absorbs React
 * StrictMode double-invoked updaters).
 */

import "./setup";

import { enqueueToast } from "@/hooks/scheduling/useSlotAllocation";
import type { AllocationToast } from "@/lib/scheduling/allocationMessages";

const msg = (title: string, description = "d"): AllocationToast => ({
  title,
  description,
  variant: "default",
});

describe("enqueueToast", () => {
  it("appends messages in order", () => {
    let q: AllocationToast[] = [];
    q = enqueueToast(q, msg("one"));
    q = enqueueToast(q, msg("two"));
    q = enqueueToast(q, msg("three"));
    expect(q.map((m) => m.title)).toEqual(["one", "two", "three"]);
  });

  it("drops a consecutive duplicate", () => {
    let q: AllocationToast[] = [];
    q = enqueueToast(q, msg("same"));
    q = enqueueToast(q, msg("same"));
    expect(q).toHaveLength(1);
  });

  it("keeps identical messages that are NOT consecutive", () => {
    let q: AllocationToast[] = [];
    q = enqueueToast(q, msg("same"));
    q = enqueueToast(q, msg("other"));
    q = enqueueToast(q, msg("same"));
    expect(q.map((m) => m.title)).toEqual(["same", "other", "same"]);
  });

  it("treats a different variant or description as a different message", () => {
    let q: AllocationToast[] = [];
    q = enqueueToast(q, msg("same", "a"));
    q = enqueueToast(q, msg("same", "b"));
    q = enqueueToast(q, { ...msg("same", "b"), variant: "destructive" });
    expect(q).toHaveLength(3);
  });

  it("does not mutate the input queue", () => {
    const original: AllocationToast[] = [msg("one")];
    const next = enqueueToast(original, msg("two"));
    expect(original).toHaveLength(1);
    expect(next).toHaveLength(2);
    expect(next).not.toBe(original);
  });
});
