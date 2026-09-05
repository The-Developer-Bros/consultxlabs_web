/**
 * @jest-environment node
 */

/**
 * Authorization & Access Control Tests
 *
 * Covers:
 * - authorizeEventAccess: consultant, consultee, stranger, admin for all 4 event types
 * - Reschedule route: participant check via if-else chain, ADMIN/STAFF bypass
 * - Cancel route: participant check, ADMIN/STAFF bypass, stranger gets 403
 *
 * Verifies Part 1 Bug 02 (allocate/validate auth), Part 1 Bug 03 (reschedule auth),
 * Part 2 Bug 01 (if-else if chain for mutually exclusive event types),
 * Part 2 Bug 02 (reschedule auth returns proper 403),
 * Part 2 Bug 04 (cancel auth)
 */

// ─── Module Mocks ───────────────────────────────────────────────────────────

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findUnique: jest.fn() },
    subscription: { findUnique: jest.fn() },
    webinar: { findUnique: jest.fn() },
    class: { findUnique: jest.fn() },
    $transaction: jest.fn(),
    // #1006 — cancel resolves the refund facts across the WHOLE booking, so it
    // reads every appointment of the parent request, not just the one it was
    // handed. #1003 — group-event cancel reads the attendee roster off the
    // payments to notify them. Both default to empty here; the refund paths
    // have their own suites.
    appointment: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    payment: { findMany: jest.fn().mockResolvedValue([]) },
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

jest.mock("../../lib/payments/operations/event-refunds", () => ({
  refundWholeEventPayments: jest.fn().mockResolvedValue({
    refundsIssued: 0,
    refundedPaise: 0,
    childRefundIds: [],
    failures: [],
  }),
}));
jest.mock("../../lib/novu", () => ({
  notifyAppointmentCancelled: jest.fn().mockResolvedValue(undefined),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { authorizeEventAccess, isPrivileged } from "@/lib/auth-helpers";
import { POST as rescheduleHandler } from "@/app/api/appointments/[appointmentId]/reschedule/route";
import { POST as cancelHandler } from "@/app/api/appointments/[appointmentId]/cancel/route";

// ─── Session Factories ──────────────────────────────────────────────────────

function makeSession(overrides: Record<string, any> = {}) {
  return {
    user: {
      id: "user-1",
      name: "Test User",
      role: "CONSULTEE",
      consultantProfileId: null,
      consulteeProfileId: null,
      staffProfileId: null,
      adminProfileId: null,
      ...overrides,
    },
  } as any;
}

function consultantSession() {
  return makeSession({
    id: "consultant-user",
    role: "CONSULTANT",
    consultantProfileId: "cp-001",
    consulteeProfileId: null,
  });
}

function consulteeSession() {
  return makeSession({
    id: "consultee-user",
    role: "CONSULTEE",
    consultantProfileId: null,
    consulteeProfileId: "ce-001",
  });
}

function strangerSession() {
  return makeSession({
    id: "stranger-user",
    role: "CONSULTEE",
    consultantProfileId: null,
    consulteeProfileId: "ce-stranger",
  });
}

function adminSession() {
  return makeSession({
    id: "admin-user",
    role: "ADMIN",
    consultantProfileId: null,
    consulteeProfileId: null,
    adminProfileId: "admin-001",
  });
}

function staffSession() {
  return makeSession({
    id: "staff-user",
    role: "STAFF",
    consultantProfileId: null,
    consulteeProfileId: null,
    staffProfileId: "staff-001",
  });
}

// ─── Request Helpers ────────────────────────────────────────────────────────

function makeRescheduleRequest(appointmentId: string, type: string) {
  return new Request(
    `http://localhost/api/appointments/${appointmentId}/reschedule?type=${type}`,
    { method: "POST" },
  ) as any;
}

function makeCancelRequest(appointmentId: string, body?: Record<string, any>) {
  const url = `http://localhost/api/appointments/${appointmentId}/cancel`;
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

// ─── Appointment Factories ──────────────────────────────────────────────────

const FUTURE_DATE = new Date(Date.now() + 48 * 60 * 60 * 1000);

function makeSlot(id: string, startsAt: Date) {
  return {
    id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
    isTentative: false,
    appointmentId: "apt-1",
    createdAt: new Date(),
  };
}

function makeConsultationAppointment() {
  return {
    id: "apt-1",
    appointmentType: "CONSULTATION",
    slotsOfAppointment: [makeSlot("slot-1", FUTURE_DATE)],
    consultation: {
      id: "cons-1",
      consultationPlan: {
        title: "Test Plan",
        consultantProfileId: "cp-001",
        consultantProfile: {
          id: "cp-001",
          user: { id: "consultant-user", name: "Dr. Smith" },
        },
      },
      requestedById: "ce-001",
      requestedBy: {
        id: "ce-001",
        user: { id: "consultee-user", name: "John Doe" },
      },
    },
    subscription: null,
    webinar: null,
    class: null,
  };
}

function makeSubscriptionAppointment() {
  return {
    id: "apt-1",
    appointmentType: "SUBSCRIPTION",
    slotsOfAppointment: [makeSlot("slot-1", FUTURE_DATE)],
    consultation: null,
    subscription: {
      id: "sub-1",
      subscriptionPlan: {
        title: "Monthly Plan",
        consultantProfileId: "cp-001",
        consultantProfile: {
          id: "cp-001",
          user: { id: "consultant-user", name: "Dr. Smith" },
        },
      },
      requestedById: "ce-001",
      requestedBy: {
        id: "ce-001",
        user: { id: "consultee-user", name: "John Doe" },
      },
    },
    webinar: null,
    class: null,
  };
}

function makeWebinarAppointment() {
  return {
    id: "apt-1",
    appointmentType: "WEBINAR",
    slotsOfAppointment: [makeSlot("slot-1", FUTURE_DATE)],
    consultation: null,
    subscription: null,
    webinar: {
      id: "web-1",
      status: "SCHEDULED",
      webinarPlan: {
        consultantProfileId: "cp-001",
      },
    },
    class: null,
  };
}

function makeClassAppointment() {
  return {
    id: "apt-1",
    appointmentType: "CLASS",
    slotsOfAppointment: [makeSlot("slot-1", FUTURE_DATE)],
    consultation: null,
    subscription: null,
    webinar: null,
    class: {
      id: "cls-1",
      status: "SCHEDULED",
      classPlan: {
        consultantProfileId: "cp-001",
      },
    },
  };
}

// ─── Mock Transaction ───────────────────────────────────────────────────────

function makeMockTx(appointmentData: any = null) {
  return {
    appointment: {
      findUnique: jest.fn().mockResolvedValue(appointmentData),
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
    },
    consultation: {
      update: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
      // B2 — the cancel/reschedule CAS guards use updateMany.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    subscription: {
      update: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
      // B2 — the cancel/reschedule CAS guards use updateMany.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    webinar: {
      update: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
      // B2 — the cancel/reschedule CAS guards use updateMany.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    class: {
      update: jest.fn(),
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
    appointmentParticipant: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    // Cancel closes any live reschedule proposal so the appointment's
    // openForAppointmentId reservation is released.
    rescheduleRequest: {
      // The cancel route reads the open proposals, then CASes each by id.
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ status: "PENDING_REVIEW" }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({ id: "reschedule-request-1" }),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Unit Tests: authorizeEventAccess
// ═══════════════════════════════════════════════════════════════════════════════

describe("authorizeEventAccess", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── ADMIN/STAFF bypass ─────────────────────────────────────────────────

  describe("privileged bypass", () => {
    it("should allow ADMIN without any DB lookup", async () => {
      const result = await authorizeEventAccess(
        adminSession(),
        "consultation",
        "any-id",
      );
      expect(result).toBeNull();
      expect(prisma.consultation.findUnique).not.toHaveBeenCalled();
    });

    it("should allow STAFF without any DB lookup", async () => {
      const result = await authorizeEventAccess(
        staffSession(),
        "webinar",
        "any-id",
      );
      expect(result).toBeNull();
      expect(prisma.webinar.findUnique).not.toHaveBeenCalled();
    });
  });

  // ─── CONSULTATION ─────────────────────────────────────────────────────

  describe("consultation", () => {
    it("should allow consultant who owns the plan", async () => {
      (prisma.consultation.findUnique as jest.Mock).mockResolvedValue({
        requestedById: "ce-001",
        consultationPlan: { consultantProfileId: "cp-001" },
      });

      const result = await authorizeEventAccess(
        consultantSession(),
        "consultation",
        "cons-1",
      );
      expect(result).toBeNull();
    });

    it("should allow consultee who requested the consultation", async () => {
      (prisma.consultation.findUnique as jest.Mock).mockResolvedValue({
        requestedById: "ce-001",
        consultationPlan: { consultantProfileId: "cp-001" },
      });

      const result = await authorizeEventAccess(
        consulteeSession(),
        "consultation",
        "cons-1",
      );
      expect(result).toBeNull();
    });

    it("should reject stranger with 403", async () => {
      (prisma.consultation.findUnique as jest.Mock).mockResolvedValue({
        requestedById: "ce-001",
        consultationPlan: { consultantProfileId: "cp-001" },
      });

      const result = await authorizeEventAccess(
        strangerSession(),
        "consultation",
        "cons-1",
      );
      expect(result).not.toBeNull();
      const body = await result!.json();
      expect(result!.status).toBe(403);
      expect(body.error).toContain("not authorized");
    });

    it("should reject when consultation not found", async () => {
      (prisma.consultation.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await authorizeEventAccess(
        consulteeSession(),
        "consultation",
        "nonexistent",
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });
  });

  // ─── SUBSCRIPTION ─────────────────────────────────────────────────────

  describe("subscription", () => {
    it("should allow consultant who owns the plan", async () => {
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({
        requestedById: "ce-001",
        subscriptionPlan: { consultantProfileId: "cp-001" },
      });

      const result = await authorizeEventAccess(
        consultantSession(),
        "subscription",
        "sub-1",
      );
      expect(result).toBeNull();
    });

    it("should allow consultee who requested the subscription", async () => {
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({
        requestedById: "ce-001",
        subscriptionPlan: { consultantProfileId: "cp-001" },
      });

      const result = await authorizeEventAccess(
        consulteeSession(),
        "subscription",
        "sub-1",
      );
      expect(result).toBeNull();
    });

    it("should reject stranger with 403", async () => {
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({
        requestedById: "ce-001",
        subscriptionPlan: { consultantProfileId: "cp-001" },
      });

      const result = await authorizeEventAccess(
        strangerSession(),
        "subscription",
        "sub-1",
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });
  });

  // ─── WEBINAR ──────────────────────────────────────────────────────────

  describe("webinar", () => {
    it("should allow consultant who owns the webinar plan", async () => {
      (prisma.webinar.findUnique as jest.Mock).mockResolvedValue({
        webinarPlan: { consultantProfileId: "cp-001" },
      });

      const result = await authorizeEventAccess(
        consultantSession(),
        "webinar",
        "web-1",
      );
      expect(result).toBeNull();
    });

    it("should reject consultee (webinar has no requestedById)", async () => {
      (prisma.webinar.findUnique as jest.Mock).mockResolvedValue({
        webinarPlan: { consultantProfileId: "cp-001" },
      });

      const result = await authorizeEventAccess(
        consulteeSession(),
        "webinar",
        "web-1",
      );
      // Consultee can't access webinar since it only checks consultantProfileId
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it("should reject stranger with 403", async () => {
      (prisma.webinar.findUnique as jest.Mock).mockResolvedValue({
        webinarPlan: { consultantProfileId: "cp-001" },
      });

      const result = await authorizeEventAccess(
        strangerSession(),
        "webinar",
        "web-1",
      );
      expect(result!.status).toBe(403);
    });
  });

  // ─── CLASS ────────────────────────────────────────────────────────────

  describe("class", () => {
    it("should allow consultant who owns the class plan", async () => {
      (prisma.class.findUnique as jest.Mock).mockResolvedValue({
        classPlan: { consultantProfileId: "cp-001" },
      });

      const result = await authorizeEventAccess(
        consultantSession(),
        "class",
        "cls-1",
      );
      expect(result).toBeNull();
    });

    it("should reject consultee (class has no requestedById)", async () => {
      (prisma.class.findUnique as jest.Mock).mockResolvedValue({
        classPlan: { consultantProfileId: "cp-001" },
      });

      const result = await authorizeEventAccess(
        consulteeSession(),
        "class",
        "cls-1",
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it("should reject stranger with 403", async () => {
      (prisma.class.findUnique as jest.Mock).mockResolvedValue({
        classPlan: { consultantProfileId: "cp-001" },
      });

      const result = await authorizeEventAccess(
        strangerSession(),
        "class",
        "cls-1",
      );
      expect(result!.status).toBe(403);
    });
  });

  // ─── Mutually exclusive if-else if chain (Part 2 Bug 01) ──────────────

  describe("if-else if chain prevents cross-type lookup", () => {
    it("should only query consultation table for consultation type", async () => {
      (prisma.consultation.findUnique as jest.Mock).mockResolvedValue({
        requestedById: "ce-001",
        consultationPlan: { consultantProfileId: "cp-001" },
      });

      await authorizeEventAccess(consultantSession(), "consultation", "cons-1");

      expect(prisma.consultation.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.subscription.findUnique).not.toHaveBeenCalled();
      expect(prisma.webinar.findUnique).not.toHaveBeenCalled();
      expect(prisma.class.findUnique).not.toHaveBeenCalled();
    });

    it("should only query webinar table for webinar type", async () => {
      (prisma.webinar.findUnique as jest.Mock).mockResolvedValue({
        webinarPlan: { consultantProfileId: "cp-001" },
      });

      await authorizeEventAccess(consultantSession(), "webinar", "web-1");

      expect(prisma.webinar.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.consultation.findUnique).not.toHaveBeenCalled();
      expect(prisma.subscription.findUnique).not.toHaveBeenCalled();
      expect(prisma.class.findUnique).not.toHaveBeenCalled();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Unit Tests: isPrivileged helper
// ═══════════════════════════════════════════════════════════════════════════════

describe("isPrivileged", () => {
  it("should return true for ADMIN", () => {
    expect(isPrivileged("ADMIN")).toBe(true);
  });

  it("should return true for STAFF", () => {
    expect(isPrivileged("STAFF")).toBe(true);
  });

  it("should return false for CONSULTANT", () => {
    expect(isPrivileged("CONSULTANT")).toBe(false);
  });

  it("should return false for CONSULTEE", () => {
    expect(isPrivileged("CONSULTEE")).toBe(false);
  });

  it("should return false for null/undefined", () => {
    expect(isPrivileged(null)).toBe(false);
    expect(isPrivileged(undefined)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Reschedule Route — Authorization
// ═══════════════════════════════════════════════════════════════════════════════

describe("Reschedule Route — Authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return 401 when not authenticated", async () => {
    (getSession as jest.Mock).mockResolvedValue(null);

    const req = makeRescheduleRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(401);
  });

  it("should return 403 when stranger reschedules consultation", async () => {
    (getSession as jest.Mock).mockResolvedValue(strangerSession());
    const mockTx = makeMockTx(makeConsultationAppointment());
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRescheduleRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("not authorized");
  });

  it("should return 403 when stranger reschedules subscription", async () => {
    (getSession as jest.Mock).mockResolvedValue(strangerSession());
    const mockTx = makeMockTx(makeSubscriptionAppointment());
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRescheduleRequest("apt-1", "SUBSCRIPTION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(403);
  });

  it("should return 403 when stranger reschedules webinar", async () => {
    (getSession as jest.Mock).mockResolvedValue(strangerSession());
    const mockTx = makeMockTx(makeWebinarAppointment());
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRescheduleRequest("apt-1", "WEBINAR");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(403);
  });

  it("should return 403 when stranger reschedules class", async () => {
    (getSession as jest.Mock).mockResolvedValue(strangerSession());
    const mockTx = makeMockTx(makeClassAppointment());
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRescheduleRequest("apt-1", "CLASS");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(403);
  });

  it("should allow consultant to reschedule own consultation", async () => {
    (getSession as jest.Mock).mockResolvedValue(consultantSession());
    const mockTx = makeMockTx(makeConsultationAppointment());
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRescheduleRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
  });

  it("should allow consultee to reschedule own consultation", async () => {
    (getSession as jest.Mock).mockResolvedValue(consulteeSession());
    const mockTx = makeMockTx(makeConsultationAppointment());
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRescheduleRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
  });

  it("should allow ADMIN to reschedule any appointment", async () => {
    (getSession as jest.Mock).mockResolvedValue(adminSession());
    const mockTx = makeMockTx(makeWebinarAppointment());
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRescheduleRequest("apt-1", "WEBINAR");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
  });

  it("should allow STAFF to reschedule any appointment", async () => {
    (getSession as jest.Mock).mockResolvedValue(staffSession());
    const mockTx = makeMockTx(makeClassAppointment());
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRescheduleRequest("apt-1", "CLASS");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
  });

  it("should reject consultee from rescheduling webinar (consultant-only)", async () => {
    (getSession as jest.Mock).mockResolvedValue(consulteeSession());
    const mockTx = makeMockTx(makeWebinarAppointment());
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRescheduleRequest("apt-1", "WEBINAR");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(403);
  });

  it("should reject consultee from rescheduling class (consultant-only)", async () => {
    (getSession as jest.Mock).mockResolvedValue(consulteeSession());
    const mockTx = makeMockTx(makeClassAppointment());
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeRescheduleRequest("apt-1", "CLASS");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cancel Route — Authorization
// ═══════════════════════════════════════════════════════════════════════════════

describe("Cancel Route — Authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return 401 when not authenticated", async () => {
    (getSession as jest.Mock).mockResolvedValue(null);

    const req = makeCancelRequest("apt-1");
    const res = await cancelHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(401);
  });

  it("should return 403 when stranger cancels consultation", async () => {
    (getSession as jest.Mock).mockResolvedValue(strangerSession());
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeConsultationAppointment(),
    );

    const req = makeCancelRequest("apt-1");
    const res = await cancelHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("not authorized");
  });

  it("should return 403 when stranger cancels subscription", async () => {
    (getSession as jest.Mock).mockResolvedValue(strangerSession());
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeSubscriptionAppointment(),
    );

    const req = makeCancelRequest("apt-1");
    const res = await cancelHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(403);
  });

  it("should return 403 when stranger cancels webinar", async () => {
    (getSession as jest.Mock).mockResolvedValue(strangerSession());
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeWebinarAppointment(),
    );

    const req = makeCancelRequest("apt-1");
    const res = await cancelHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(403);
  });

  it("should return 403 when stranger cancels class", async () => {
    (getSession as jest.Mock).mockResolvedValue(strangerSession());
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeClassAppointment(),
    );

    const req = makeCancelRequest("apt-1");
    const res = await cancelHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(403);
  });

  it("should allow consultant to cancel own consultation", async () => {
    (getSession as jest.Mock).mockResolvedValue(consultantSession());
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeConsultationAppointment(),
    );
    const mockTx = makeMockTx();
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeCancelRequest("apt-1");
    const res = await cancelHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
  });

  it("should allow consultee to cancel own consultation", async () => {
    (getSession as jest.Mock).mockResolvedValue(consulteeSession());
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeConsultationAppointment(),
    );
    const mockTx = makeMockTx();
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeCancelRequest("apt-1");
    const res = await cancelHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
  });

  it("should allow ADMIN to cancel any appointment", async () => {
    (getSession as jest.Mock).mockResolvedValue(adminSession());
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeWebinarAppointment(),
    );
    const mockTx = makeMockTx();
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );

    const req = makeCancelRequest("apt-1");
    const res = await cancelHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
  });

  it("should reject consultee from cancelling webinar (consultant-only)", async () => {
    (getSession as jest.Mock).mockResolvedValue(consulteeSession());
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeWebinarAppointment(),
    );

    const req = makeCancelRequest("apt-1");
    const res = await cancelHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(403);
  });
});
