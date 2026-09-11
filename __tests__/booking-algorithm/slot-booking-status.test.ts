/**
 * getSlotBookingStatus — the function behind every coloured cell in the
 * availability grid, previously at ~18% statement coverage with no direct test.
 *
 * The status vocabulary is available / partially-booked / fully-booked, decided
 * by what fraction of the interval is covered by merged appointment ranges
 * against FULLY_BOOKED_THRESHOLD (0.99).
 */

import "./setup";
import {
  BOOKING_STATUS,
  buildAppointmentIndex,
  getSlotBookingStatus,
  type AppointmentSlot,
} from "../../utils/timeSlotsProcessing";

const at = (iso: string) => new Date(iso);
const booking = (startIso: string, endIso: string): AppointmentSlot => ({
  startsAt: at(startIso),
  endsAt: at(endIso),
});

// One 30-minute atom, the unit the grid actually renders.
const SLOT_START = at("2026-08-03T09:00:00Z");
const SLOT_END = at("2026-08-03T09:30:00Z");

describe("getSlotBookingStatus", () => {
  it("reports available when nothing overlaps", () => {
    expect(getSlotBookingStatus(SLOT_START, SLOT_END, [])).toBe(
      BOOKING_STATUS.AVAILABLE,
    );
  });

  it("reports available when a booking merely abuts the slot", () => {
    const slots = [
      booking("2026-08-03T08:30:00Z", "2026-08-03T09:00:00Z"),
      booking("2026-08-03T09:30:00Z", "2026-08-03T10:00:00Z"),
    ];
    expect(getSlotBookingStatus(SLOT_START, SLOT_END, slots)).toBe(
      BOOKING_STATUS.AVAILABLE,
    );
  });

  it("reports fully booked on an exact cover", () => {
    const slots = [booking("2026-08-03T09:00:00Z", "2026-08-03T09:30:00Z")];
    expect(getSlotBookingStatus(SLOT_START, SLOT_END, slots)).toBe(
      BOOKING_STATUS.FULLY_BOOKED,
    );
  });

  it("reports fully booked when a longer appointment spans it", () => {
    const slots = [booking("2026-08-03T08:00:00Z", "2026-08-03T11:00:00Z")];
    expect(getSlotBookingStatus(SLOT_START, SLOT_END, slots)).toBe(
      BOOKING_STATUS.FULLY_BOOKED,
    );
  });

  it("reports partially booked when only part of the slot is taken", () => {
    const slots = [booking("2026-08-03T09:00:00Z", "2026-08-03T09:15:00Z")];
    expect(getSlotBookingStatus(SLOT_START, SLOT_END, slots)).toBe(
      BOOKING_STATUS.PARTIALLY_BOOKED,
    );
  });

  it("merges adjacent bookings into a full cover", () => {
    // Two halves that together cover the atom must read fully-booked, not
    // partially — the merge step is what makes that true.
    const slots = [
      booking("2026-08-03T09:00:00Z", "2026-08-03T09:15:00Z"),
      booking("2026-08-03T09:15:00Z", "2026-08-03T09:30:00Z"),
    ];
    expect(getSlotBookingStatus(SLOT_START, SLOT_END, slots)).toBe(
      BOOKING_STATUS.FULLY_BOOKED,
    );
  });

  it("does not let overlapping bookings double-count into a false full cover", () => {
    // Both cover the same first half; the slot is genuinely half free.
    const slots = [
      booking("2026-08-03T09:00:00Z", "2026-08-03T09:15:00Z"),
      booking("2026-08-03T09:05:00Z", "2026-08-03T09:15:00Z"),
    ];
    expect(getSlotBookingStatus(SLOT_START, SLOT_END, slots)).toBe(
      BOOKING_STATUS.PARTIALLY_BOOKED,
    );
  });

  it("treats a sub-second gap as fully booked (the 0.99 threshold)", () => {
    const slots = [
      booking("2026-08-03T09:00:00Z", "2026-08-03T09:14:59Z"),
      booking("2026-08-03T09:15:00Z", "2026-08-03T09:30:00Z"),
    ];
    expect(getSlotBookingStatus(SLOT_START, SLOT_END, slots)).toBe(
      BOOKING_STATUS.FULLY_BOOKED,
    );
  });

  it("agrees with itself whether or not the bucket index is supplied", () => {
    // The route passes a prebuilt index; the fallback path scans directly.
    // A divergence here would make the same data render two different colours.
    const slots = [
      booking("2026-08-03T09:00:00Z", "2026-08-03T09:15:00Z"),
      booking("2026-08-03T10:00:00Z", "2026-08-03T10:30:00Z"),
    ];
    const index = buildAppointmentIndex(slots);

    expect(getSlotBookingStatus(SLOT_START, SLOT_END, slots, index)).toBe(
      getSlotBookingStatus(SLOT_START, SLOT_END, slots),
    );
    expect(getSlotBookingStatus(SLOT_START, SLOT_END, slots, index)).toBe(
      BOOKING_STATUS.PARTIALLY_BOOKED,
    );
  });

  it("falls back to available on malformed input rather than blocking a slot", () => {
    expect(
      getSlotBookingStatus(at("invalid"), SLOT_END, []),
    ).toBe(BOOKING_STATUS.AVAILABLE);
    expect(getSlotBookingStatus(SLOT_END, SLOT_START, [])).toBe(
      BOOKING_STATUS.AVAILABLE,
    );
  });
});

describe("buildAppointmentIndex", () => {
  it("buckets a booking into every 30-minute window it touches", () => {
    const long = booking("2026-08-03T09:00:00Z", "2026-08-03T10:30:00Z");
    const index = buildAppointmentIndex([long]);

    // Three atoms covered: 09:00, 09:30, 10:00 — and not 10:30, which the
    // booking only abuts (half-open interval).
    const bucketOf = (iso: string) =>
      Math.floor(at(iso).getTime() / (30 * 60 * 1000));

    expect(index.get(bucketOf("2026-08-03T09:00:00Z"))).toHaveLength(1);
    expect(index.get(bucketOf("2026-08-03T09:30:00Z"))).toHaveLength(1);
    expect(index.get(bucketOf("2026-08-03T10:00:00Z"))).toHaveLength(1);
    expect(index.get(bucketOf("2026-08-03T10:30:00Z"))).toBeUndefined();
  });

  it("ignores malformed rows instead of throwing", () => {
    const index = buildAppointmentIndex([
      { startsAt: null, endsAt: null } as unknown as AppointmentSlot,
      booking("2026-08-03T09:00:00Z", "2026-08-03T09:30:00Z"),
    ]);
    expect([...index.values()].flat()).toHaveLength(1);
  });
});
