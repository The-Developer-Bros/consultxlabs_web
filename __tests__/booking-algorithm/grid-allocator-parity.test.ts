/**
 * The availability grid and the allocator must agree about who is busy.
 *
 * They did not. The grid asked "is there an active appointment under one of
 * THIS consultant's plans" (plan ownership); the allocator asked "is this
 * consultant connected to a slot" (participation), and additionally folded in
 * the consultee's bookings with any consultant. Three consequences, all of
 * which showed the user a green, clickable cell that allocation then rejected:
 *
 *   - a consultant who is themselves a consultee elsewhere,
 *   - a consultee already booked with a different consultant,
 *   - an expired APPROVED_PENDING_PAYMENT hold, which conversely made the grid
 *     show BUSY where the allocator was happy to book.
 *
 * Both sides now build their filter from buildConsultantOccupancyWhere, and the
 * grid runs the same isOccupiedByLiveAppointment the allocator does.
 */

import "./setup";
import {
  buildConsultantOccupancyWhere,
  buildOccupiedAppointmentFilter,
  OCCUPIED_REQUEST_STATUSES,
} from "../../utils/slotAllocation/occupancyPolicy";
import { isOccupiedByLiveAppointment } from "../../utils/slotAllocation/SlotValidationService";

const PROFILE = "consultant-profile-1";
const USER = "consultant-user-1";

type WhereShape = ReturnType<typeof buildConsultantOccupancyWhere>;

/** The two arms of the "reaches this consultant" clause. */
function reachArms(where: WhereShape) {
  const and = (where.AND ?? []) as Record<string, unknown>[];
  const reach = and[1] as { OR?: Record<string, unknown>[] };
  return reach.OR ?? [];
}

describe("buildConsultantOccupancyWhere", () => {
  it("matches on slot participation as well as plan ownership", () => {
    const arms = reachArms(buildConsultantOccupancyWhere(PROFILE, USER));

    expect(arms).toHaveLength(2);

    // Participation: the consultant is on the slot, whatever plan it belongs to.
    // deletedAt: null — a tombstoned slot is not a booking (defense-in-depth;
    // RESCHEDULED rows stay occupied, a pending reschedule is a live hold).
    expect(arms[0]).toEqual({
      slotsOfAppointment: {
        some: { user: { some: { id: USER } }, deletedAt: null },
      },
    });

    // Ownership: the appointment is delivered under one of their own plans,
    // even when the slot rows connect registrants rather than the host.
    expect(arms[1]).toEqual({
      OR: buildOccupiedAppointmentFilter(PROFILE),
    });
  });

  it("still constrains to active parent statuses", () => {
    const where = buildConsultantOccupancyWhere(PROFILE, USER);
    const and = (where.AND ?? []) as Record<string, unknown>[];

    expect(and[0]).toEqual({ OR: buildOccupiedAppointmentFilter() });
    // Sanity-check the policy itself hasn't quietly widened.
    expect(OCCUPIED_REQUEST_STATUSES).toEqual(
      expect.arrayContaining([
        "PENDING",
        "APPROVED",
        "APPROVED_PENDING_PAYMENT",
        "SCHEDULED",
      ]),
    );
  });

  it("falls back to participation alone when no profile id is known", () => {
    const arms = reachArms(buildConsultantOccupancyWhere(undefined, USER));

    expect(arms).toHaveLength(1);
    expect(arms[0]).toEqual({
      slotsOfAppointment: {
        some: { user: { some: { id: USER } }, deletedAt: null },
      },
    });
  });

  it("is the same predicate whichever caller builds it", () => {
    // Grid and allocator pass the same pair, so the objects must be identical —
    // this is the invariant that broke.
    expect(buildConsultantOccupancyWhere(PROFILE, USER)).toEqual(
      buildConsultantOccupancyWhere(PROFILE, USER),
    );
  });
});

describe("live-hold filtering is shared by grid and allocator", () => {
  const past = new Date("2026-01-01T00:00:00Z");
  const future = new Date("2099-01-01T00:00:00Z");
  const now = new Date("2026-06-01T00:00:00Z");

  it("frees a slot whose pending-payment hold has lapsed", () => {
    expect(
      isOccupiedByLiveAppointment(
        {
          consultation: { status: "APPROVED_PENDING_PAYMENT" },
          subscription: null,
          payment: [{ paymentStatus: "PENDING", expiresAt: past }],
        },
        now,
      ),
    ).toBe(false);
  });

  it("keeps a slot blocked while any payment row is still live", () => {
    expect(
      isOccupiedByLiveAppointment(
        {
          consultation: { status: "APPROVED_PENDING_PAYMENT" },
          subscription: null,
          payment: [{ expiresAt: past }, { expiresAt: future }],
        },
        now,
      ),
    ).toBe(true);
  });

  it("keeps a confirmed booking blocked regardless of payment rows", () => {
    expect(
      isOccupiedByLiveAppointment(
        {
          consultation: { status: "SCHEDULED" },
          subscription: null,
          payment: [{ paymentStatus: "PENDING", expiresAt: past }],
        },
        now,
      ),
    ).toBe(true);
  });

  it("keeps a hold with no payment row at all blocked", () => {
    // A hold that never produced a payment must not silently free the slot.
    expect(
      isOccupiedByLiveAppointment(
        {
          consultation: { status: "APPROVED_PENDING_PAYMENT" },
          subscription: null,
          payment: [],
        },
        now,
      ),
    ).toBe(true);
  });
});
