/**
 * isValidOvernightSlot — the grid route's shape gate for stored slot rows.
 *
 * A row with end <= start is only legitimate as the legacy same-day-midnight
 * storage of an overnight availability window (10:00 → 00:00 meaning
 * 10:00 → 24:00). The pre-audit version accepted ANY end-at-midnight row no
 * matter how far back it sat, so a corrupt multi-day-negative row
 * (e.g. Aug 25 10:00 → Aug 21 00:00) passed as "legitimate overnight" and was
 * painted onto the grid instead of dropped as the corruption it is.
 */

import "./setup";

import { isValidOvernightSlot } from "@/utils/timeSlotsProcessing";

describe("isValidOvernightSlot", () => {
  it("accepts a normal forward slot", () => {
    expect(
      isValidOvernightSlot(
        new Date("2026-08-21T10:00:00Z"),
        new Date("2026-08-21T10:30:00Z"),
      ),
    ).toBe(true);
  });

  it("accepts a true overnight slot that crosses midnight", () => {
    expect(
      isValidOvernightSlot(
        new Date("2026-08-21T22:00:00Z"),
        new Date("2026-08-22T02:00:00Z"),
      ),
    ).toBe(true);
  });

  it("accepts the legacy same-day-midnight form within 24h", () => {
    // 10:00 → 00:00 stored WITHOUT the day roll-over means 10:00 → 24:00.
    expect(
      isValidOvernightSlot(
        new Date("2026-08-21T10:00:00Z"),
        new Date("2026-08-21T00:00:00Z"),
      ),
    ).toBe(true);
  });

  it("accepts a near-midnight legacy form (23:59 → 00:00 same day)", () => {
    expect(
      isValidOvernightSlot(
        new Date("2026-08-21T23:59:00Z"),
        new Date("2026-08-21T00:00:00Z"),
      ),
    ).toBe(true);
  });

  it("rejects a corrupt multi-day-negative row that ends at midnight", () => {
    // Five days BEFORE the start — the shape the old check waved through.
    expect(
      isValidOvernightSlot(
        new Date("2026-08-25T10:00:00Z"),
        new Date("2026-08-21T00:00:00Z"),
      ),
    ).toBe(false);
  });

  it("rejects a same-day-midnight row more than 24h before the start", () => {
    expect(
      isValidOvernightSlot(
        new Date("2026-08-22T00:30:00Z"),
        new Date("2026-08-21T00:00:00Z"),
      ),
    ).toBe(false);
  });

  it("rejects a zero-length row", () => {
    expect(
      isValidOvernightSlot(
        new Date("2026-08-21T00:00:00Z"),
        new Date("2026-08-21T00:00:00Z"),
      ),
    ).toBe(false);
  });

  it("rejects an inverted row that does not end at midnight", () => {
    expect(
      isValidOvernightSlot(
        new Date("2026-08-21T10:00:00Z"),
        new Date("2026-08-21T09:00:00Z"),
      ),
    ).toBe(false);
  });
});
