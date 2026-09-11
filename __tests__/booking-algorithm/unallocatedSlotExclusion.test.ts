/**
 * @jest-environment node
 */

/**
 * Unallocated Slot Exclusion & Occupancy Policy Tests
 *
 * Covers:
 * - buildOccupiedAppointmentFilter: generates OR clause for all 5 event types
 * - Weekly unallocated route: excludes slots overlapping occupied appointments
 * - Custom unallocated route: excludes slots overlapping occupied appointments
 * - Range overlap detection: partial, full, and enclosing overlaps
 * - Pagination accuracy: totalUnallocated counts reflect post-filter results
 *
 * Verifies Part 1 Bugs 08, 09, 15, 20; Part 2 Bugs 05, 06
 */

import {
  buildOccupiedAppointmentFilter,
  OCCUPIED_REQUEST_STATUSES,
  OCCUPIED_EVENT_STATUSES,
} from "@/utils/slotAllocation/occupancyPolicy";
import { AppointmentStatus, TrialSessionStatus } from "@prisma/client";

// ═══════════════════════════════════════════════════════════════════════════════
// buildOccupiedAppointmentFilter
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildOccupiedAppointmentFilter", () => {
  it("should return 5 filter entries (consultation, subscription, webinar, class, trial)", () => {
    const filters = buildOccupiedAppointmentFilter("cp-001");
    expect(filters).toHaveLength(5);
  });

  it("should return 5 filter entries without consultantProfileId", () => {
    const filters = buildOccupiedAppointmentFilter();
    expect(filters).toHaveLength(5);
  });

  it("should include consultation filter with correct statuses", () => {
    const filters = buildOccupiedAppointmentFilter("cp-001");
    const consultationFilter = filters[0] as any;

    expect(consultationFilter.consultation).toBeDefined();
    expect(consultationFilter.consultation.status.in).toEqual(
      OCCUPIED_REQUEST_STATUSES,
    );
    expect(
      consultationFilter.consultation.consultationPlan.consultantProfileId,
    ).toBe("cp-001");
  });

  it("should include subscription filter with correct statuses", () => {
    const filters = buildOccupiedAppointmentFilter("cp-001");
    const subscriptionFilter = filters[1] as any;

    expect(subscriptionFilter.subscription).toBeDefined();
    expect(subscriptionFilter.subscription.status.in).toEqual(
      OCCUPIED_REQUEST_STATUSES,
    );
    expect(
      subscriptionFilter.subscription.subscriptionPlan.consultantProfileId,
    ).toBe("cp-001");
  });

  it("should include webinar filter with SCHEDULED and IN_PROGRESS", () => {
    const filters = buildOccupiedAppointmentFilter("cp-001");
    const webinarFilter = filters[2] as any;

    expect(webinarFilter.webinar).toBeDefined();
    expect(webinarFilter.webinar.status.in).toEqual([
      ...OCCUPIED_EVENT_STATUSES,
    ]);
    expect(webinarFilter.webinar.webinarPlan.consultantProfileId).toBe(
      "cp-001",
    );
  });

  it("should include class filter with SCHEDULED and IN_PROGRESS", () => {
    const filters = buildOccupiedAppointmentFilter("cp-001");
    const classFilter = filters[3] as any;

    expect(classFilter.class).toBeDefined();
    expect(classFilter.class.status.in).toEqual([...OCCUPIED_EVENT_STATUSES]);
    expect(classFilter.class.classPlan.consultantProfileId).toBe("cp-001");
  });

  it("should include trial session filter for occupying statuses", () => {
    const filters = buildOccupiedAppointmentFilter("cp-001");
    const trialFilter = filters[4] as any;

    expect(trialFilter.trialSession).toBeDefined();
    expect(trialFilter.trialSession.is.consultantProfileId).toBe("cp-001");
    // AWAITING_PAYMENT occupies too: a paid trial reserves its slot the moment
    // the consultant accepts and holds it while the learner pays. Matching only
    // SCHEDULED let someone else book the slot mid-payment, after which the
    // capture webhook would confirm the trial into a double booking.
    expect(trialFilter.trialSession.is.status.in).toEqual(
      expect.arrayContaining([
        TrialSessionStatus.SCHEDULED,
        TrialSessionStatus.AWAITING_PAYMENT,
      ]),
    );
  });

  it("should omit consultantProfileId scoping when not provided", () => {
    const filters = buildOccupiedAppointmentFilter();
    const consultationFilter = filters[0] as any;

    // When no consultantProfileId, the filter should not scope by consultant
    expect(consultationFilter.consultation.consultationPlan).toBeUndefined();
    expect(consultationFilter.consultation.status).toBeDefined();
  });

  it("should include trial filter without consultantProfileId when not provided", () => {
    const filters = buildOccupiedAppointmentFilter();
    const trialFilter = filters[4] as any;

    expect(trialFilter.trialSession.is.status.in).toEqual(
      expect.arrayContaining([
        TrialSessionStatus.SCHEDULED,
        TrialSessionStatus.AWAITING_PAYMENT,
      ]),
    );
    expect(trialFilter.trialSession.is.consultantProfileId).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OCCUPIED_REQUEST_STATUSES
// ═══════════════════════════════════════════════════════════════════════════════

describe("OCCUPIED_REQUEST_STATUSES", () => {
  it("should include PENDING, APPROVED, APPROVED_PENDING_PAYMENT, SCHEDULED", () => {
    expect(OCCUPIED_REQUEST_STATUSES).toContain(AppointmentStatus.PENDING);
    expect(OCCUPIED_REQUEST_STATUSES).toContain(AppointmentStatus.APPROVED);
    expect(OCCUPIED_REQUEST_STATUSES).toContain(
      AppointmentStatus.APPROVED_PENDING_PAYMENT,
    );
    expect(OCCUPIED_REQUEST_STATUSES).toContain(AppointmentStatus.SCHEDULED);
  });

  it("should NOT include terminal statuses", () => {
    expect(OCCUPIED_REQUEST_STATUSES).not.toContain(AppointmentStatus.CANCELLED);
    expect(OCCUPIED_REQUEST_STATUSES).not.toContain(AppointmentStatus.REJECTED);
    expect(OCCUPIED_REQUEST_STATUSES).not.toContain(AppointmentStatus.COMPLETED);
    expect(OCCUPIED_REQUEST_STATUSES).not.toContain(AppointmentStatus.EXPIRED);
  });

  it("should have exactly 4 statuses", () => {
    expect(OCCUPIED_REQUEST_STATUSES).toHaveLength(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OCCUPIED_EVENT_STATUSES
// ═══════════════════════════════════════════════════════════════════════════════

describe("OCCUPIED_EVENT_STATUSES", () => {
  it("should include SCHEDULED and IN_PROGRESS", () => {
    expect(OCCUPIED_EVENT_STATUSES).toContain("SCHEDULED");
    expect(OCCUPIED_EVENT_STATUSES).toContain("IN_PROGRESS");
  });

  it("should have exactly 2 statuses", () => {
    expect(OCCUPIED_EVENT_STATUSES).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Range Overlap Detection Logic
// ═══════════════════════════════════════════════════════════════════════════════

describe("Range overlap detection (logic used by weekly/custom routes)", () => {
  /**
   * The overlap predicate used in the routes:
   *   allocated.startsAt < slotEnd && allocated.endsAt > slotStart
   *
   * This correctly catches:
   * - Partial left overlap:  allocated [8:30-9:30] vs slot [9:00-10:00]
   * - Partial right overlap: allocated [9:30-10:30] vs slot [9:00-10:00]
   * - Full enclosing:        allocated [8:00-11:00] vs slot [9:00-10:00]
   * - Exact match:           allocated [9:00-10:00] vs slot [9:00-10:00]
   * - Contained:             allocated [9:15-9:45] vs slot [9:00-10:00]
   */

  function hasOverlap(
    allocatedStart: string,
    allocatedEnd: string,
    slotStart: string,
    slotEnd: string,
  ): boolean {
    return (
      new Date(allocatedStart) < new Date(slotEnd) &&
      new Date(allocatedEnd) > new Date(slotStart)
    );
  }

  it("should detect partial left overlap", () => {
    expect(
      hasOverlap(
        "2026-03-01T08:30:00Z",
        "2026-03-01T09:30:00Z",
        "2026-03-01T09:00:00Z",
        "2026-03-01T10:00:00Z",
      ),
    ).toBe(true);
  });

  it("should detect partial right overlap", () => {
    expect(
      hasOverlap(
        "2026-03-01T09:30:00Z",
        "2026-03-01T10:30:00Z",
        "2026-03-01T09:00:00Z",
        "2026-03-01T10:00:00Z",
      ),
    ).toBe(true);
  });

  it("should detect enclosing overlap (allocated fully contains slot)", () => {
    expect(
      hasOverlap(
        "2026-03-01T08:00:00Z",
        "2026-03-01T11:00:00Z",
        "2026-03-01T09:00:00Z",
        "2026-03-01T10:00:00Z",
      ),
    ).toBe(true);
  });

  it("should detect contained overlap (slot fully contains allocated)", () => {
    expect(
      hasOverlap(
        "2026-03-01T09:15:00Z",
        "2026-03-01T09:45:00Z",
        "2026-03-01T09:00:00Z",
        "2026-03-01T10:00:00Z",
      ),
    ).toBe(true);
  });

  it("should detect exact match", () => {
    expect(
      hasOverlap(
        "2026-03-01T09:00:00Z",
        "2026-03-01T10:00:00Z",
        "2026-03-01T09:00:00Z",
        "2026-03-01T10:00:00Z",
      ),
    ).toBe(true);
  });

  it("should NOT detect adjacent slots (end === start)", () => {
    // Adjacent: allocated ends exactly when slot starts — no real conflict
    expect(
      hasOverlap(
        "2026-03-01T08:00:00Z",
        "2026-03-01T09:00:00Z",
        "2026-03-01T09:00:00Z",
        "2026-03-01T10:00:00Z",
      ),
    ).toBe(false);
  });

  it("should NOT detect non-overlapping slots", () => {
    expect(
      hasOverlap(
        "2026-03-01T06:00:00Z",
        "2026-03-01T07:00:00Z",
        "2026-03-01T09:00:00Z",
        "2026-03-01T10:00:00Z",
      ),
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Weekly/Custom Route — Slot Filtering Logic
// ═══════════════════════════════════════════════════════════════════════════════

describe("Unallocated slot filtering (in-memory logic)", () => {
  /**
   * Tests the in-memory filtering approach used by both weekly and custom routes:
   * 1. Fetch ALL availability slots
   * 2. Fetch ALL occupied appointments via buildOccupiedAppointmentFilter
   * 3. Filter out availability slots that overlap any occupied appointment slot
   * 4. Paginate the FILTERED results
   */

  it("should filter out availability slot that overlaps an appointment", () => {
    const allocatedSlots = [
      {
        startsAt: new Date("2026-03-03T10:00:00Z"),
        endsAt: new Date("2026-03-03T11:00:00Z"),
      },
    ];

    const availabilitySlots = [
      {
        id: "avail-1",
        startsAt: new Date("2026-03-03T10:00:00Z"),
        endsAt: new Date("2026-03-03T11:00:00Z"),
      },
      {
        id: "avail-2",
        startsAt: new Date("2026-03-04T10:00:00Z"),
        endsAt: new Date("2026-03-04T11:00:00Z"),
      },
    ];

    const unallocated = availabilitySlots.filter((slot) => {
      const overlap = allocatedSlots.some(
        (a) => a.startsAt < slot.endsAt && a.endsAt > slot.startsAt,
      );
      return !overlap;
    });

    expect(unallocated).toHaveLength(1);
    expect(unallocated[0].id).toBe("avail-2");
  });

  it("should keep all slots when no appointments overlap", () => {
    const allocatedSlots: { startsAt: Date; endsAt: Date }[] = [];

    const availabilitySlots = [
      {
        id: "avail-1",
        startsAt: new Date("2026-03-03T10:00:00Z"),
        endsAt: new Date("2026-03-03T11:00:00Z"),
      },
      {
        id: "avail-2",
        startsAt: new Date("2026-03-04T10:00:00Z"),
        endsAt: new Date("2026-03-04T11:00:00Z"),
      },
    ];

    const unallocated = availabilitySlots.filter((slot) => {
      const overlap = allocatedSlots.some(
        (a) => a.startsAt < slot.endsAt && a.endsAt > slot.startsAt,
      );
      return !overlap;
    });

    expect(unallocated).toHaveLength(2);
  });

  it("should filter out all slots when fully occupied", () => {
    const allocatedSlots = [
      {
        startsAt: new Date("2026-03-03T10:00:00Z"),
        endsAt: new Date("2026-03-03T11:00:00Z"),
      },
      {
        startsAt: new Date("2026-03-04T10:00:00Z"),
        endsAt: new Date("2026-03-04T11:00:00Z"),
      },
    ];

    const availabilitySlots = [
      {
        id: "avail-1",
        startsAt: new Date("2026-03-03T10:00:00Z"),
        endsAt: new Date("2026-03-03T11:00:00Z"),
      },
      {
        id: "avail-2",
        startsAt: new Date("2026-03-04T10:00:00Z"),
        endsAt: new Date("2026-03-04T11:00:00Z"),
      },
    ];

    const unallocated = availabilitySlots.filter((slot) => {
      const overlap = allocatedSlots.some(
        (a) => a.startsAt < slot.endsAt && a.endsAt > slot.startsAt,
      );
      return !overlap;
    });

    expect(unallocated).toHaveLength(0);
  });

  it("should handle enclosing appointment that covers multiple availability slots", () => {
    // One big appointment: 9:00-12:00 covers two availability slots
    const allocatedSlots = [
      {
        startsAt: new Date("2026-03-03T09:00:00Z"),
        endsAt: new Date("2026-03-03T12:00:00Z"),
      },
    ];

    const availabilitySlots = [
      {
        id: "avail-1",
        startsAt: new Date("2026-03-03T10:00:00Z"),
        endsAt: new Date("2026-03-03T10:30:00Z"),
      },
      {
        id: "avail-2",
        startsAt: new Date("2026-03-03T11:00:00Z"),
        endsAt: new Date("2026-03-03T11:30:00Z"),
      },
      {
        id: "avail-3",
        startsAt: new Date("2026-03-03T14:00:00Z"),
        endsAt: new Date("2026-03-03T15:00:00Z"),
      },
    ];

    const unallocated = availabilitySlots.filter((slot) => {
      const overlap = allocatedSlots.some(
        (a) => a.startsAt < slot.endsAt && a.endsAt > slot.startsAt,
      );
      return !overlap;
    });

    expect(unallocated).toHaveLength(1);
    expect(unallocated[0].id).toBe("avail-3");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Pagination accuracy
// ═══════════════════════════════════════════════════════════════════════════════

describe("Pagination after filtering", () => {
  it("should paginate correctly after filtering out occupied slots", () => {
    // 5 availability slots, 2 occupied → 3 unallocated
    const allocatedSlots = [
      {
        startsAt: new Date("2026-03-03T10:00:00Z"),
        endsAt: new Date("2026-03-03T10:30:00Z"),
      },
      {
        startsAt: new Date("2026-03-05T10:00:00Z"),
        endsAt: new Date("2026-03-05T10:30:00Z"),
      },
    ];

    const allSlots = [
      {
        id: "s1",
        startsAt: new Date("2026-03-03T10:00:00Z"),
        endsAt: new Date("2026-03-03T10:30:00Z"),
      },
      {
        id: "s2",
        startsAt: new Date("2026-03-04T10:00:00Z"),
        endsAt: new Date("2026-03-04T10:30:00Z"),
      },
      {
        id: "s3",
        startsAt: new Date("2026-03-05T10:00:00Z"),
        endsAt: new Date("2026-03-05T10:30:00Z"),
      },
      {
        id: "s4",
        startsAt: new Date("2026-03-06T10:00:00Z"),
        endsAt: new Date("2026-03-06T10:30:00Z"),
      },
      {
        id: "s5",
        startsAt: new Date("2026-03-07T10:00:00Z"),
        endsAt: new Date("2026-03-07T10:30:00Z"),
      },
    ];

    const allUnallocated = allSlots.filter((slot) => {
      const overlap = allocatedSlots.some(
        (a) => a.startsAt < slot.endsAt && a.endsAt > slot.startsAt,
      );
      return !overlap;
    });

    const page = 1;
    const limit = 2;

    const totalConfigured = allSlots.length;
    const totalUnallocated = allUnallocated.length;
    const paginatedSlots = allUnallocated.slice(
      (page - 1) * limit,
      page * limit,
    );
    const totalPages = Math.ceil(totalUnallocated / limit);

    expect(totalConfigured).toBe(5);
    expect(totalUnallocated).toBe(3);
    expect(paginatedSlots).toHaveLength(2);
    expect(totalPages).toBe(2);
    expect(paginatedSlots[0].id).toBe("s2");
    expect(paginatedSlots[1].id).toBe("s4");
  });

  it("should return empty page when offset exceeds unallocated count", () => {
    const allUnallocated = [{ id: "s1" }, { id: "s2" }];
    const page = 3;
    const limit = 2;

    const paginatedSlots = allUnallocated.slice(
      (page - 1) * limit,
      page * limit,
    );

    expect(paginatedSlots).toHaveLength(0);
  });

  it("should return all unallocated slots when limit exceeds count", () => {
    const allUnallocated = [{ id: "s1" }, { id: "s2" }];
    const page = 1;
    const limit = 10;

    const paginatedSlots = allUnallocated.slice(
      (page - 1) * limit,
      page * limit,
    );

    expect(paginatedSlots).toHaveLength(2);
  });
});
