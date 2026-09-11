// #503 item 1 — getTimezoneOffsetMinutes over a real IANA lookup, with
// DST-boundary behaviour pinned via the `at` parameter.

// slotTimeUtils imports the Prisma enum as a value; stub the client so
// jsdom never loads the engine.
jest.mock("@prisma/client", () => ({
  DayOfWeek: {
    SUNDAY: "SUNDAY",
    MONDAY: "MONDAY",
    TUESDAY: "TUESDAY",
    WEDNESDAY: "WEDNESDAY",
    THURSDAY: "THURSDAY",
    FRIDAY: "FRIDAY",
    SATURDAY: "SATURDAY",
  },
  Prisma: {},
}));

import { getTimezoneOffsetMinutes } from "@/utils/slotAllocation/slotTimeUtils";

describe("getTimezoneOffsetMinutes", () => {
  it("IST is +330 year-round (no DST)", () => {
    expect(
      getTimezoneOffsetMinutes("Asia/Kolkata", new Date("2026-01-15T12:00:00Z")),
    ).toBe(330);
    expect(
      getTimezoneOffsetMinutes("Asia/Kolkata", new Date("2026-07-15T12:00:00Z")),
    ).toBe(330);
  });

  it("America/New_York is -300 in winter (EST) and -240 in summer (EDT)", () => {
    expect(
      getTimezoneOffsetMinutes(
        "America/New_York",
        new Date("2026-01-15T12:00:00Z"),
      ),
    ).toBe(-300);
    expect(
      getTimezoneOffsetMinutes(
        "America/New_York",
        new Date("2026-07-15T12:00:00Z"),
      ),
    ).toBe(-240);
  });

  it("flips exactly at the 2026 US spring-forward boundary (Mar 8, 07:00 UTC)", () => {
    expect(
      getTimezoneOffsetMinutes(
        "America/New_York",
        new Date("2026-03-08T06:59:00Z"), // 01:59 EST
      ),
    ).toBe(-300);
    expect(
      getTimezoneOffsetMinutes(
        "America/New_York",
        new Date("2026-03-08T07:00:00Z"), // 03:00 EDT
      ),
    ).toBe(-240);
  });

  it("flips exactly at the 2026 US fall-back boundary (Nov 1, 06:00 UTC)", () => {
    expect(
      getTimezoneOffsetMinutes(
        "America/New_York",
        new Date("2026-11-01T05:59:00Z"), // 01:59 EDT
      ),
    ).toBe(-240);
    expect(
      getTimezoneOffsetMinutes(
        "America/New_York",
        new Date("2026-11-01T06:00:00Z"), // 01:00 EST
      ),
    ).toBe(-300);
  });

  it("handles the +14 extreme (Pacific/Kiritimati) without clamping", () => {
    expect(
      getTimezoneOffsetMinutes(
        "Pacific/Kiritimati",
        new Date("2026-06-01T00:00:00Z"),
      ),
    ).toBe(840);
  });

  it("returns 0 for an invalid timezone string", () => {
    expect(getTimezoneOffsetMinutes("Not/AZone")).toBe(0);
    expect(getTimezoneOffsetMinutes("")).toBe(0);
  });

  it("half-hour and 45-minute offsets are exact", () => {
    expect(
      getTimezoneOffsetMinutes("Asia/Kathmandu", new Date("2026-06-01T00:00:00Z")),
    ).toBe(345);
    expect(
      getTimezoneOffsetMinutes(
        "Australia/Adelaide",
        new Date("2026-01-15T00:00:00Z"), // ACDT (southern-hemisphere summer)
      ),
    ).toBe(630);
  });
});
