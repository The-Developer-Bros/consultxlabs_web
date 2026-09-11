/**
 * #1076 — day/week caps bucket on the EVENT's scheduling timezone, so a viewer
 * elsewhere could be told "this day is full" about a day that is not the one
 * under their cursor. The bucket helpers below name the bucket and translate
 * its span onto the viewer's clock; these tests pin the bounds (including
 * across a DST transition, where start+24h is the wrong answer) and the
 * silence when both zones agree.
 *
 * #1132 — and the 409 relabel: a slot conflict must render as itself instead
 * of "this request was already allocated".
 */

import "./setup";

import {
  dailyLimitReached,
  isPreservedAllocationMessage,
  limitBucketNote,
  oneSessionPerDay,
  schedulingDayBucket,
  schedulingWeekBucket,
  weeklyLimitReached,
} from "@/lib/scheduling/allocationMessages";

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A zone that is definitely not the one this process runs in. */
const foreignZone = () =>
  viewerZone() === "America/New_York" ? "Asia/Kolkata" : "America/New_York";

describe("schedulingDayBucket", () => {
  it("spans the scheduling day, not the viewer's", () => {
    // 19:00Z on Aug 3 is already Aug 4 in IST.
    const bucket = schedulingDayBucket(
      new Date("2026-08-03T19:00:00.000Z"),
      "Asia/Kolkata",
    );
    expect(bucket.kind).toBe("day");
    expect(bucket.label).toBe("Aug 4, 2026");
    expect(bucket.start.toISOString()).toBe("2026-08-03T18:30:00.000Z");
    expect(bucket.end.toISOString()).toBe("2026-08-04T18:30:00.000Z");
  });

  it("defaults to the platform scheduling timezone when none is given", () => {
    const bucket = schedulingDayBucket(new Date("2026-08-03T19:00:00.000Z"));
    expect(bucket.timeZone).toBe("Asia/Kolkata");
    expect(bucket.label).toBe("Aug 4, 2026");
  });

  it("is 23 hours long on a spring-forward day", () => {
    // US DST starts 2026-03-08; that day has 23 hours, so start + 24h would
    // report a bucket that ends an hour into the next day.
    const bucket = schedulingDayBucket(
      new Date("2026-03-08T18:00:00.000Z"),
      "America/New_York",
    );
    expect(bucket.label).toBe("Mar 8, 2026");
    expect(bucket.end.getTime() - bucket.start.getTime()).toBe(23 * 3_600_000);
  });
});

describe("schedulingWeekBucket", () => {
  it("runs Sunday to Sunday in the scheduling timezone", () => {
    const bucket = schedulingWeekBucket(
      new Date("2026-08-05T09:00:00.000Z"), // Wednesday
      "Asia/Kolkata",
    );
    expect(bucket.kind).toBe("week");
    expect(bucket.label).toBe("week of Aug 2, 2026");
    expect(bucket.start.toISOString()).toBe("2026-08-01T18:30:00.000Z");
    expect(bucket.end.toISOString()).toBe("2026-08-08T18:30:00.000Z");
  });

  it("is 167 hours long across a spring-forward week", () => {
    const bucket = schedulingWeekBucket(
      new Date("2026-03-10T12:00:00.000Z"),
      "America/New_York",
    );
    expect(bucket.label).toBe("week of Mar 8, 2026");
    expect(bucket.end.getTime() - bucket.start.getTime()).toBe(167 * 3_600_000);
  });
});

describe("limitBucketNote", () => {
  it("says nothing when the viewer already sees the scheduling day", () => {
    const bucket = schedulingDayBucket(
      new Date("2026-08-03T09:00:00.000Z"),
      viewerZone(),
    );
    expect(limitBucketNote(bucket)).toBe("");
  });

  it("says nothing when no bucket is supplied", () => {
    // Call sites that cannot name a bucket keep the plain message.
    expect(limitBucketNote(undefined)).toBe("");
  });

  it("names the day bucket and its viewer-local span when the zones differ", () => {
    const zone = foreignZone();
    const bucket = schedulingDayBucket(
      new Date("2026-08-03T09:00:00.000Z"),
      zone,
    );
    const note = limitBucketNote(bucket);
    expect(note).toContain(`Days are counted in ${zone}`);
    expect(note).toContain(bucket.label);
    expect(note).toContain("on your clock");
  });

  it("names the week bucket when the zones differ", () => {
    const zone = foreignZone();
    const note = limitBucketNote(
      schedulingWeekBucket(new Date("2026-08-05T09:00:00.000Z"), zone),
    );
    expect(note).toContain(`Weeks are counted in ${zone}`);
    expect(note).toContain("week of");
  });
});

describe("cap messages carry the bucket", () => {
  const zone = foreignZone();
  const at = new Date("2026-08-05T09:00:00.000Z");

  it("appends the note to the weekly, daily and one-per-day rejections", () => {
    expect(
      weeklyLimitReached(2, schedulingWeekBucket(at, zone)).description,
    ).toContain(`Weeks are counted in ${zone}`);
    expect(
      dailyLimitReached(2, schedulingDayBucket(at, zone)).description,
    ).toContain(`Days are counted in ${zone}`);
    expect(
      oneSessionPerDay(schedulingDayBucket(at, zone)).description,
    ).toContain(`Days are counted in ${zone}`);
  });

  it("leaves the bucket-less messages exactly as they were", () => {
    expect(weeklyLimitReached(2).description).toBe(
      "You can only schedule 2 sessions per week. This week is full — choose a different week.",
    );
    expect(dailyLimitReached(1).description).toBe(
      "You can only schedule 1 session per day. Choose a different day.",
    );
  });
});

describe("isPreservedAllocationMessage", () => {
  it("recognises the server's slot-conflict wording verbatim", () => {
    // SlotAllocationService wraps SlotValidationService's error, so the whole
    // string is what reaches the dialog.
    expect(
      isPreservedAllocationMessage(
        "Slot taken during allocation: [CONFLICT] Slot already booked: 2026-08-05 09:00",
      ),
    ).toBe(true);
    expect(
      isPreservedAllocationMessage("[CONFLICT] Slot already booked: 10:00"),
    ).toBe(true);
  });

  it("leaves a genuine already-allocated 409 to be relabelled", () => {
    expect(
      isPreservedAllocationMessage(
        "This subscription has already been allocated",
      ),
    ).toBe(false);
    expect(isPreservedAllocationMessage("Allocation already in progress")).toBe(
      false,
    );
  });
});
