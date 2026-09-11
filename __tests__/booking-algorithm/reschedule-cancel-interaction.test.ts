/**
 * Where rescheduling and cancellation meet.
 *
 * Two things are load-bearing and neither is obvious from either file alone.
 */

import "./setup";
import { PLATFORM_DEFAULT_TIERS } from "../../lib/payments/operations/cancellation-policy";
import {
  RESCHEDULE_OPEN_STATUSES,
  SLOT_RESCHEDULABLE_FROM,
} from "../../lib/booking/transitions";

/**
 * Kept in sync by hand with the route constant. Importing the route would drag
 * in Prisma, Novu and Sentry for a single number.
 */
const MINIMUM_HOURS_BEFORE_RESCHEDULE = 24;

describe("the reschedule-then-cancel refund vector stays closed", () => {
  it("cannot reschedule into a better refund tier, because the thresholds coincide", () => {
    // Once a consultee can write a new startsAt, moving an imminent session
    // further out would raise the refund tier read at cancellation
    // (cancel/route.ts computes hoursUntilStart from the earliest slot). That
    // exploit is blocked only because you may not reschedule at all until you
    // are already 24h out — which is exactly where the 100% tier begins.
    //
    // Nothing enforces that these two numbers agree. If either moves
    // independently, the gap between them becomes exploitable, so assert it.
    const topTier = PLATFORM_DEFAULT_TIERS.reduce((best, tier) =>
      tier.refundPct >= best.refundPct && tier.hoursBefore <= best.hoursBefore
        ? tier
        : best,
    );
    const fullRefundTier = PLATFORM_DEFAULT_TIERS.find(
      (t) => t.refundPct === 100,
    );

    expect(fullRefundTier).toBeDefined();
    expect(fullRefundTier!.hoursBefore).toBeLessThanOrEqual(
      MINIMUM_HOURS_BEFORE_RESCHEDULE,
    );
    expect(topTier.refundPct).toBe(100);
  });

  it("has no tier between the reschedule cutoff and the full-refund cutoff", () => {
    // A tier at, say, 36h would mean rescheduling from 25h out to 40h out moved
    // the booking from one band to a better one.
    const better = PLATFORM_DEFAULT_TIERS.filter(
      (t) => t.hoursBefore > MINIMUM_HOURS_BEFORE_RESCHEDULE,
    );
    expect(better).toEqual([]);
  });
});

describe("cancel cleans up after a reschedule", () => {
  it("terminalizes the same slot states a reschedule can leave behind", () => {
    // Cancel filters on SLOT_RESCHEDULABLE_FROM rather than SCHEDULED alone, so
    // a slot released by a pending reschedule is cancelled with the rest. It
    // used to be skipped, leaving non-terminal rows on a dead booking — and
    // proposals hang off exactly those rows.
    expect(SLOT_RESCHEDULABLE_FROM).toEqual(
      expect.arrayContaining(["SCHEDULED", "RESCHEDULED"]),
    );
  });

  it("knows which proposal states are still live and must be closed", () => {
    expect(RESCHEDULE_OPEN_STATUSES).toEqual(
      expect.arrayContaining(["PENDING_REVIEW", "COUNTERED"]),
    );
    // A terminal state must never appear here, or cancel would "close" rows it
    // has no business touching and clear a lock it does not hold.
    expect(RESCHEDULE_OPEN_STATUSES).not.toContain("ACCEPTED");
    expect(RESCHEDULE_OPEN_STATUSES).not.toContain("AUTO_ACCEPTED");
  });
});

describe("DRAFT is only left by publishing", () => {
  it("does not let a reschedule publish an unpublished offering", async () => {
    const { EVENT_ALLOWED_FROM } = await import(
      "../../lib/booking/transitions"
    );
    // Reschedule re-stamps SCHEDULED. If DRAFT were in that allowed-from set,
    // rescheduling a draft would publish it as a side effect.
    expect(EVENT_ALLOWED_FROM.SCHEDULED).not.toContain("DRAFT");
  });

  it("has no way back into DRAFT", async () => {
    const { EVENT_ALLOWED_FROM } = await import(
      "../../lib/booking/transitions"
    );
    // Withdrawing a published offering is archivedAt, not a trip back to DRAFT,
    // so anything ever buyable keeps a stable public identity.
    expect(EVENT_ALLOWED_FROM.DRAFT).toEqual([]);
  });

  it("makes publishing its own explicit edge out of DRAFT", async () => {
    const { EVENT_PUBLISHABLE_FROM } = await import(
      "../../lib/booking/transitions"
    );
    expect(EVENT_PUBLISHABLE_FROM).toEqual(["DRAFT"]);
  });
});
