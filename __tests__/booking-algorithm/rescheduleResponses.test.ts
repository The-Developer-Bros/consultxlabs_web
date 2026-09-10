/**
 * @jest-environment node
 */

/**
 * Reschedule Response Correctness Tests
 *
 * Covers:
 * - Part 2 Bug 02: Auth failure returns proper HTTP 403 (not 200 with nested JSON)
 * - Part 2 Bug 03: Type mismatch returns proper HTTP 400
 * - derivedType fallback when no ?type query param
 * - 24-hour policy enforcement with precise time boundaries
 * - Response shape correctness: success, rescheduleType, slotsAffected, message
 */

// ─── Module Mocks ───────────────────────────────────────────────────────────

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    appointment: { findUnique: jest.fn() },
    slotOfAppointment: { findMany: jest.fn(), deleteMany: jest.fn() },
    // #1008 — reschedule/cancel routes read prisma.dispute.findFirst.
    dispute: { findFirst: jest.fn().mockResolvedValue(null) },
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
}));
jest.mock("../../utils/appointmentlock", () => ({
  __esModule: true,
  withAppointmentLock: jest.fn(
    async (_id: string, fn: () => Promise<unknown>) => fn(),
  ),
  BookingLockUnavailableError: class extends Error {},
  AppointmentBusyError: class extends Error {},
}));
jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(),
}));

jest.mock("../../lib/novu", () => ({
  notifyAppointmentCancelled: jest.fn().mockResolvedValue(undefined),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { POST as rescheduleHandler } from "@/app/api/appointments/[appointmentId]/reschedule/route";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(
  appointmentId: string,
  type?: string,
  body?: Record<string, any>,
) {
  const typeParam = type ? `?type=${type}` : "";
  const url = `http://localhost/api/appointments/${appointmentId}/reschedule${typeParam}`;
  return new Request(url, {
    method: "POST",
    ...(body
      ? {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }
      : {}),
  }) as any;
}

function makeParams(appointmentId: string) {
  return { params: Promise.resolve({ appointmentId }) };
}

const FUTURE_DATE = new Date(Date.now() + 48 * 60 * 60 * 1000);
const NEAR_DATE = new Date(Date.now() + 12 * 60 * 60 * 1000);

function makeSlot(id: string, startsAt: Date, appointmentId = "apt-1") {
  return {
    id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
    isTentative: false,
    // Whole-series flows filter on SLOT_RESCHEDULABLE_FROM so a delivered
    // session can no longer brick the aggregate 24h gate. The column is
    // `@default(SCHEDULED)` and non-nullable, so real rows always carry it.
    completionStatus: "SCHEDULED",
    appointmentId,
    createdAt: new Date(),
  };
}

function makeConsultationAppointment(slotOverrides?: any[]) {
  return {
    id: "apt-1",
    appointmentType: "CONSULTATION",
    slotsOfAppointment: slotOverrides || [makeSlot("slot-1", FUTURE_DATE)],
    consultation: {
      id: "cons-1",
      consultationPlan: {
        title: "Test Plan",
        consultantProfileId: "cp-001",
        consultantProfile: { user: { id: "consultant-1", name: "Dr. Smith" } },
      },
      requestedById: "ce-001",
      requestedBy: { user: { id: "user-1", name: "John Doe" } },
    },
    subscription: null,
    webinar: null,
    class: null,
  };
}

function makeSubscriptionAppointment(slotOverrides?: any[]) {
  return {
    id: "apt-1",
    appointmentType: "SUBSCRIPTION",
    slotsOfAppointment: slotOverrides || [makeSlot("slot-1", FUTURE_DATE)],
    consultation: null,
    subscription: {
      id: "sub-1",
      subscriptionPlan: {
        title: "Monthly Plan",
        consultantProfileId: "cp-001",
        consultantProfile: { user: { id: "consultant-1", name: "Dr. Smith" } },
      },
      requestedById: "ce-001",
      requestedBy: { user: { id: "user-1", name: "John Doe" } },
    },
    webinar: null,
    class: null,
  };
}

function makeWebinarAppointment(slotOverrides?: any[]) {
  return {
    id: "apt-1",
    appointmentType: "WEBINAR",
    slotsOfAppointment: slotOverrides || [makeSlot("slot-1", FUTURE_DATE)],
    consultation: null,
    subscription: null,
    webinar: {
      id: "web-1",
      status: "SCHEDULED",
      webinarPlan: { consultantProfileId: "cp-001" },
    },
    class: null,
  };
}

function makeMockTx(appointmentData: any) {
  return {
    appointment: {
      findUnique: jest.fn().mockResolvedValue(appointmentData),
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
    },
    consultation: {
      update: jest.fn(),
      // Each transition helper reads the from-status before its CAS.
      findUnique: jest.fn().mockResolvedValue({ status: "APPROVED" }),
      // B2 — the cancel/reschedule CAS guards use updateMany.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    subscription: {
      update: jest.fn(),
      // Each transition helper reads the from-status before its CAS.
      findUnique: jest.fn().mockResolvedValue({ status: "APPROVED" }),
      // B2 — the cancel/reschedule CAS guards use updateMany.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      // #448 — a PARTIAL (slotIds) subscription reschedule only terminal-guards
      // via count (no status write); positive count keeps the route on the
      // happy path without flipping the whole subscription to PENDING.
      count: jest.fn().mockResolvedValue(1),
    },
    webinar: {
      update: jest.fn(),
      // Each transition helper reads the from-status before its CAS.
      findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
      // B2 — the cancel/reschedule CAS guards use updateMany.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    class: {
      update: jest.fn(),
      // Each transition helper reads the from-status before its CAS.
      findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
      // B2 — the cancel/reschedule CAS guards use updateMany.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // transitionSlotCompletion reads the from-status, then moves the cohort
    // with updateManyAndReturn so each moved id gets its history row.
    slotOfAppointment: {
      findMany: jest.fn().mockResolvedValue([]),
      updateManyAndReturn: jest.fn().mockResolvedValue([{ id: "slot-1" }]),
      deleteMany: jest.fn(),
    },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Auth failure returns proper HTTP 403
// ═══════════════════════════════════════════════════════════════════════════════

describe("Reschedule — Auth failure returns proper 403 (not 200 with nested JSON)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return HTTP 403 status code directly, not wrapped in 200", async () => {
    // Stranger session — not a participant
    (getSession as jest.Mock).mockResolvedValue({
      user: {
        id: "stranger",
        consultantProfileId: null,
        consulteeProfileId: "ce-stranger",
        role: "CONSULTEE",
      },
    });

    const appointment = makeConsultationAppointment();
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    // The critical check: HTTP status must be 403, NOT 200
    expect(res.status).toBe(403);

    const body = await res.json();
    // The error should be at the top level, not nested inside a data object
    expect(body.error).toBeDefined();
    expect(body.data).toBeUndefined();
  });

  it("should include meaningful error message in 403 response", async () => {
    (getSession as jest.Mock).mockResolvedValue({
      user: {
        id: "stranger",
        consultantProfileId: null,
        consulteeProfileId: "ce-stranger",
        role: "CONSULTEE",
      },
    });

    const appointment = makeConsultationAppointment();
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toContain("not authorized");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Type mismatch returns proper HTTP 400
// ═══════════════════════════════════════════════════════════════════════════════

describe("Reschedule — Type mismatch returns proper 400", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Authenticated as consultant (participant)
    (getSession as jest.Mock).mockResolvedValue({
      user: {
        id: "consultant-1",
        consultantProfileId: "cp-001",
        consulteeProfileId: null,
        role: "CONSULTANT",
      },
    });
  });

  it("should return 400 when query type WEBINAR doesn't match consultation", async () => {
    const appointment = makeConsultationAppointment();
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "WEBINAR");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("mismatch");
  });

  it("should return 400 when query type CONSULTATION doesn't match subscription", async () => {
    const appointment = makeSubscriptionAppointment();
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("mismatch");
  });

  it("should return 400 when query type CLASS doesn't match webinar", async () => {
    const appointment = makeWebinarAppointment();
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "CLASS");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("mismatch");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// derivedType fallback (no ?type query param)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Reschedule — derivedType fallback when no ?type param", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSession as jest.Mock).mockResolvedValue({
      user: {
        id: "consultant-1",
        consultantProfileId: "cp-001",
        consulteeProfileId: null,
        role: "CONSULTANT",
      },
    });
  });

  it("should succeed for consultation without ?type param", async () => {
    const appointment = makeConsultationAppointment();
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    // No type param at all
    const req = makeRequest("apt-1");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.rescheduleType).toBe("entire_booking");
  });

  it("should succeed for subscription without ?type param via derivedType", async () => {
    const appointment = makeSubscriptionAppointment();
    const mockTx = makeMockTx(appointment);
    // For subscription entire reschedule, the route calls findMany twice
    mockTx.appointment.findMany
      .mockResolvedValueOnce([
        { id: "apt-1", slotsOfAppointment: appointment.slotsOfAppointment },
      ])
      .mockResolvedValueOnce([{ id: "apt-1" }]);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.rescheduleType).toBe("entire_booking");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 24-hour policy enforcement
// ═══════════════════════════════════════════════════════════════════════════════

describe("Reschedule — 24-hour policy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSession as jest.Mock).mockResolvedValue({
      user: {
        id: "user-1",
        consultantProfileId: "cp-001",
        consulteeProfileId: null,
        role: "CONSULTANT",
      },
    });
  });

  it("should return 400 when slot is within 24 hours", async () => {
    const appointment = makeConsultationAppointment([
      makeSlot("slot-1", NEAR_DATE),
    ]);
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("24 hours");
  });

  it("should succeed when slot is beyond 24 hours", async () => {
    const appointment = makeConsultationAppointment([
      makeSlot("slot-1", FUTURE_DATE),
    ]);
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
  });

  it("should fail if ANY slot is within 24h even if others are far out", async () => {
    const appointment = makeSubscriptionAppointment([
      makeSlot("slot-1", FUTURE_DATE), // 48h out — OK
      makeSlot("slot-2", NEAR_DATE), // 12h out — too close
    ]);
    const mockTx = makeMockTx(appointment);
    // For subscription, route fetches all slots
    mockTx.appointment.findMany.mockResolvedValueOnce([
      { id: "apt-1", slotsOfAppointment: appointment.slotsOfAppointment },
    ]);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "SUBSCRIPTION", {
      slotIds: ["slot-1", "slot-2"],
    });
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("24 hours");
  });

  it("should allow reschedule at exactly 24h boundary", async () => {
    // Create slot exactly 25h from now (just past 24h limit)
    const justPast24h = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const appointment = makeConsultationAppointment([
      makeSlot("slot-1", justPast24h),
    ]);
    const mockTx = makeMockTx(appointment);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Response shape correctness
// ═══════════════════════════════════════════════════════════════════════════════

describe("Reschedule — Response shape", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSession as jest.Mock).mockResolvedValue({
      user: {
        id: "consultant-1",
        consultantProfileId: "cp-001",
        consulteeProfileId: null,
        role: "CONSULTANT",
      },
    });
  });

  it("should include success, rescheduleType, slotsAffected, message for consultation", async () => {
    const mockTx = makeMockTx(makeConsultationAppointment());
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        rescheduleType: "entire_booking",
        slotsAffected: expect.any(Number),
        message: expect.stringContaining("marked for rescheduling"),
      }),
    );
  });

  it("should return individual_session for single slotId in subscription", async () => {
    const appointment = makeSubscriptionAppointment();
    const mockTx = makeMockTx(appointment);
    mockTx.appointment.findMany.mockResolvedValueOnce([
      { id: "apt-1", slotsOfAppointment: appointment.slotsOfAppointment },
    ]);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "SUBSCRIPTION", {
      slotIds: ["slot-1"],
    });
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(body.rescheduleType).toBe("individual_session");
    expect(body.slotsAffected).toBe(1);
  });

  // #448 — a one-hour session is 2 × 30-min slots of the SAME appointment, so
  // rescheduling it is ONE session (individual_session), not multiple_sessions.
  it("should return individual_session for a one-hour (2-slot) session — #448", async () => {
    const twoSlots = [
      makeSlot("slot-1", FUTURE_DATE),
      makeSlot("slot-2", new Date(FUTURE_DATE.getTime() + 30 * 60 * 1000)),
    ];
    const appointment = makeSubscriptionAppointment(twoSlots);
    const mockTx = makeMockTx(appointment);
    mockTx.appointment.findMany.mockResolvedValueOnce([
      { id: "apt-1", slotsOfAppointment: twoSlots },
    ]);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "SUBSCRIPTION", {
      slotIds: ["slot-1", "slot-2"],
    });
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(body.rescheduleType).toBe("individual_session");
    expect(body.sessionsAffected).toBe(1);
    expect(body.slotsAffected).toBe(2);
  });

  it("should return multiple_sessions when slots span multiple appointments", async () => {
    const slotA = makeSlot("slot-1", FUTURE_DATE, "apt-1");
    const slotB = makeSlot(
      "slot-2",
      new Date(FUTURE_DATE.getTime() + 24 * 60 * 60 * 1000),
      "apt-2",
    );
    const appointment = makeSubscriptionAppointment([slotA]);
    const mockTx = makeMockTx(appointment);
    mockTx.appointment.findMany.mockResolvedValueOnce([
      { id: "apt-1", slotsOfAppointment: [slotA] },
      { id: "apt-2", slotsOfAppointment: [slotB] },
    ]);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("apt-1", "SUBSCRIPTION", {
      slotIds: ["slot-1", "slot-2"],
    });
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(body.rescheduleType).toBe("multiple_sessions");
    expect(body.sessionsAffected).toBe(2);
    expect(body.slotsAffected).toBe(2);
  });

  it("should return 404 for nonexistent appointment", async () => {
    const mockTx = makeMockTx(null);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRequest("nonexistent", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("nonexistent"));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });
});
