/**
 * Idempotency-Key lifecycle for allocation attempts. A retry of the SAME
 * payload must reuse the key (the server replays the original batch, #837);
 * any change to mode, event, or slots must mint a fresh key.
 */

import "./setup";

import {
  computeAttemptFingerprint,
  resolveAttemptKey,
} from "@/hooks/scheduling/useSlotAllocation";
// eslint-disable-next-line jest/no-mocks-import -- shared fixture builders, not module mocks (suite-wide pattern)
import { makeConsecutiveTimeSlots } from "./__mocks__/booking.mockData";
import type { TimeSlot } from "@/lib/scheduling/calendarUtils";

const slots = makeConsecutiveTimeSlots(
  "2026-08-03T09:00:00.000Z",
  2,
) as TimeSlot[];

describe("computeAttemptFingerprint", () => {
  it("is stable regardless of slot order", () => {
    const reversed = [...slots].reverse();
    expect(computeAttemptFingerprint("manual", "e1", slots)).toBe(
      computeAttemptFingerprint("manual", "e1", reversed),
    );
  });

  it("differs across modes, events, and slot sets", () => {
    const fp = computeAttemptFingerprint("manual", "e1", slots);
    expect(computeAttemptFingerprint("auto", "e1", slots)).not.toBe(fp);
    expect(computeAttemptFingerprint("manual", "e2", slots)).not.toBe(fp);
    expect(
      computeAttemptFingerprint(
        "manual",
        "e1",
        makeConsecutiveTimeSlots("2026-08-04T09:00:00.000Z", 2) as TimeSlot[],
      ),
    ).not.toBe(fp);
  });
});

describe("resolveAttemptKey", () => {
  it("reuses the key for an identical retry", () => {
    const fp = computeAttemptFingerprint("manual", "e1", slots);
    const first = resolveAttemptKey(null, fp);
    const retry = resolveAttemptKey(first, fp);
    expect(retry.key).toBe(first.key);
  });

  it("mints a new key when the payload changes", () => {
    const first = resolveAttemptKey(
      null,
      computeAttemptFingerprint("manual", "e1", slots),
    );
    const changed = resolveAttemptKey(
      first,
      computeAttemptFingerprint("manual", "e1", [
        ...slots,
        ...(makeConsecutiveTimeSlots(
          "2026-08-05T09:00:00.000Z",
          2,
        ) as TimeSlot[]),
      ]),
    );
    expect(changed.key).not.toBe(first.key);
  });

  it("mints a new key when the mode changes", () => {
    const manual = resolveAttemptKey(
      null,
      computeAttemptFingerprint("manual", "e1", slots),
    );
    const auto = resolveAttemptKey(
      manual,
      computeAttemptFingerprint("auto", "e1", []),
    );
    expect(auto.key).not.toBe(manual.key);
  });

  it("keys look like UUIDs", () => {
    const attempt = resolveAttemptKey(
      null,
      computeAttemptFingerprint("auto", "e1", []),
    );
    expect(attempt.key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
