/**
 * Comprehensive tests for SlotAllocationService
 *
 * Covers:
 * - allocate() mode routing (auto, manual, requested, invalid)
 * - Manual allocation: duplicate detection, slot count validation, appointment creation
 * - Requested slot allocation: verification, tentative flag clearing
 * - Auto allocation: slot finding, reschedule detection, scheduling period
 * - fetchEventData: config extraction, consultant validation, date ordering
 * - createAppointments: grouping, defensive checks, single-appointment events
 * - updateEventStatus: per-event-type status and scheduling period logic
 * - deleteExistingAppointments: full vs tentative-only deletion
 * - Error handling and edge cases
 */

import "./setup";

// ─── Module Mocks ───────────────────────────────────────────────────────────

// Mock prisma (relative path required — @/ aliases fail in jest.mock)
// #908 — read/validate now run on the BASE client outside the write txn, so the
// base mock carries appointment.findMany too. beforeEach points these read fns
// at the same mockTx instances so existing per-test wiring still drives them.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    consultation: { findUnique: jest.fn() },
    subscription: { findUnique: jest.fn() },
    webinar: { findUnique: jest.fn() },
    class: { findUnique: jest.fn() },
    appointment: { findMany: jest.fn() },
    // #1065 — a reschedule reads the initiator's stated placement preference
    // before searching. Unstubbed it resolves undefined, which is the "no
    // preference" case every test here means.
    rescheduleRequest: { findFirst: jest.fn() },
  },
  ALLOCATION_TX_MAX_WAIT_MS: 8000,
  ALLOCATION_TX_TIMEOUT_MS: 30000,
}));

// Mock appointmentlock to avoid @upstash/redis ESM import issues in Jest
jest.mock("../../utils/appointmentlock", () => ({
  lockAutoAllocate: jest
    .fn()
    .mockResolvedValue({ key: "mock-key", value: "mock-value" }),
  unlockAutoAllocate: jest.fn().mockResolvedValue(undefined),
  // #898 follow-up — consultee-scoped lock used in the allocate paths.
  lockConsulteeBooking: jest
    .fn()
    .mockResolvedValue({ key: "mock-consultee-key", value: "mock-value" }),
  unlockConsulteeBooking: jest.fn().mockResolvedValue(undefined),
}));

// Mock SlotValidationService to isolate unit under test.
// RV-2 — keep the real isOccupiedByLiveAppointment export; the allocator imports
// it from this module and findAvailableSlots calls it to drop expired holds.
const mockValidateFn = jest.fn();
// #908 — the short write txn re-checks conflicts via revalidateConflicts.
const mockRevalidateConflictsFn = jest.fn();
jest.mock("../../utils/slotAllocation/SlotValidationService", () => ({
  ...jest.requireActual("../../utils/slotAllocation/SlotValidationService"),
  SlotValidationService: jest.fn().mockImplementation(() => ({
    validate: mockValidateFn,
    revalidateConflicts: mockRevalidateConflictsFn,
  })),
}));

import prisma from "@/lib/prisma";
import { SlotAllocationService } from "@/utils/slotAllocation/SlotAllocationService";
import {
  ScheduleType,
  DayOfWeek,
  AppointmentsType,
  AppointmentStatus,
} from "@prisma/client";
import {
  makeWeeklyAvailabilitySlot,
  makeCustomAvailabilitySlot,
} from "./__mocks__/booking.mockData";
// Mocked above; imported (not require()d) so the lock-scope pin below stays
// free of a require-style import.
import { lockAutoAllocate as mockLockAutoAllocate } from "../../utils/appointmentlock";

// ─── Mock Transaction Factory ───────────────────────────────────────────────

function makeMockTx() {
  return {
    // #836 — updateEventStatus routes through the CAS transition helpers,
    // which call updateMany and read the returned count.
    consultation: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    subscription: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    webinar: {
      findUnique: jest.fn(),
      update: jest.fn(),
      // Guarded transitions (transitionWebinarEvent) use WHERE-guarded updateMany
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    class: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // #440 — createAppointments denormalizes the consultant onto each slot.
    consultantProfile: {
      findFirst: jest.fn().mockResolvedValue({ id: "consultant-profile-1" }),
    },
    appointment: {
      findMany: jest.fn().mockResolvedValue([]),
      // #1499 — createAppointments reads the originating appointment to
      // inherit the policy version the booking was sold under. Null here:
      // these fixtures predate the FK, so the created rows carry no policy.
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: "apt-1",
        slotsOfAppointment: [],
      }),
      // #898 — REUSE path: createAppointments updates the preserved 1:1
      // (consultation/webinar) appointment instead of creating a second row.
      update: jest.fn().mockResolvedValue({
        id: "reused-apt",
        slotsOfAppointment: [],
      }),
      delete: jest.fn(),
      // B-P1-05 — the payment guard rides in the delete's WHERE clause, so
      // deleteExistingAppointments deletes appointments via deleteMany.
      // count: 1 = "deleted" (no payment appeared); tests override to 0 for
      // the payment-appeared race.
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    appointmentParticipant: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    slotOfAppointment: {
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
      // ADR B10 — the multi-tab guard is now derived server-side from "this
      // event has no confirmed slots" rather than from a client flag that was
      // never true, so it runs on the ordinary allocation paths too.
      count: jest.fn().mockResolvedValue(0),
    },
    // pg_advisory_xact_lock inside guardInitialAllocationInTx.
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

// ─── Event Data Factories ───────────────────────────────────────────────────

function makeConsultantProfile(overrides: any = {}) {
  return {
    user: { id: "consultant-1", timezone: "UTC" },
    scheduleType: ScheduleType.WEEKLY,
    slotsOfAvailabilityWeekly: [
      makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 9, 11),
    ],
    slotsOfAvailabilityCustom: [],
    ...overrides,
  };
}

function makeConsultationEvent(overrides: any = {}) {
  return {
    id: "consult-1",
    consultationPlan: {
      consultantProfileId: "consultant-profile-1",
      durationInHours: 1,
      consultantProfile: makeConsultantProfile(),
    },
    requestedBy: { user: { id: "consultee-1" } },
    appointment: null,
    ...overrides,
  };
}

function makeSubscriptionEvent(overrides: any = {}) {
  return {
    id: "sub-1",
    subscriptionPlan: {
      consultantProfileId: "consultant-profile-1",
      durationInMonths: 1,
      sessionsPerWeek: 1,
      sessionDurationInHours: 1,
      consultantProfile: makeConsultantProfile(),
    },
    requestedBy: { user: { id: "consultee-1" } },
    schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00Z"),
    schedulingPeriodEndsAt: new Date("2025-01-10T00:00:00Z"), // 1 week → requires 2 slots
    appointments: [],
    ...overrides,
  };
}

function makeWebinarEvent(overrides: any = {}) {
  return {
    id: "webinar-1",
    webinarPlan: {
      consultantProfileId: "consultant-profile-1",
      durationInHours: 1,
      consultantProfile: makeConsultantProfile(),
    },
    ...overrides,
  };
}

function makeClassEvent(overrides: any = {}) {
  return {
    id: "class-1",
    classPlan: {
      consultantProfileId: "consultant-profile-1",
      durationInMonths: 1,
      sessionsPerWeek: 1,
      sessionDurationInHours: 1,
      consultantProfile: makeConsultantProfile(),
      classContents: [],
    },
    schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00Z"),
    schedulingPeriodEndsAt: new Date("2025-01-10T00:00:00Z"), // 1 week → requires 2 slots
    appointments: [],
    ...overrides,
  };
}

// ─── Test Setup ─────────────────────────────────────────────────────────────

let mockTx: ReturnType<typeof makeMockTx>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));

  mockTx = makeMockTx();
  (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) =>
    callback(mockTx),
  );

  // #908 — reads (lock pre-fetches, fetchEventData, existing-appts,
  // findAvailableSlots) now run on the BASE client OUTSIDE the write txn. Point
  // the base client's read fns at the same mockTx instances so existing
  // per-test `mockTx.<type>.findUnique` / `mockTx.appointment.findMany` wiring
  // keeps driving them; writes still go through the txn's mockTx.
  (prisma as any).appointment = mockTx.appointment;
  (prisma as any).consultation.findUnique = mockTx.consultation.findUnique;
  (prisma as any).subscription.findUnique = mockTx.subscription.findUnique;
  (prisma as any).webinar.findUnique = mockTx.webinar.findUnique;
  (prisma as any).class.findUnique = mockTx.class.findUnique;

  // Default full-event reads so getConsultantProfileId / getConsulteeUserId /
  // fetchEventData all resolve from one mock (factories carry the scalar
  // consultantProfileId + requestedBy.user.id those pre-fetches read). Tests
  // override per type as needed (including null for not-found cases).
  mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
  mockTx.subscription.findUnique.mockResolvedValue(makeSubscriptionEvent());
  mockTx.webinar.findUnique.mockResolvedValue(makeWebinarEvent());
  mockTx.class.findUnique.mockResolvedValue(makeClassEvent());

  mockValidateFn.mockReset();
  mockValidateFn.mockResolvedValue({
    isValid: true,
    errors: [],
    warnings: [],
  });
  mockRevalidateConflictsFn.mockReset();
  mockRevalidateConflictsFn.mockResolvedValue({
    isValid: true,
    errors: [],
    warnings: [],
  });
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── allocate() - Mode Routing ──────────────────────────────────────────────

describe("allocate() - Mode routing", () => {
  it("should return error for manual mode with no slots", async () => {
    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Slots are required");
  });

  it("should return error for manual mode with empty slots array", async () => {
    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Slots are required");
  });

  it("should return error for invalid allocation mode", async () => {
    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "invalid" as any,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid allocation mode");
  });

  it("should catch and wrap errors from inner methods", async () => {
    (prisma.$transaction as jest.Mock).mockRejectedValue(
      new Error("DB connection failed"),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("DB connection failed");
  });

  it("should handle non-Error throws gracefully", async () => {
    // #908 — slot parse/validate now runs before the write txn, so use a valid
    // slot count (2 = one 1h call) to reach the txn that rejects with a non-Error.
    (prisma.$transaction as jest.Mock).mockRejectedValue("string error");

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Allocation failed");
  });
});

// ─── Manual Allocation ──────────────────────────────────────────────────────

describe("Manual allocation", () => {
  it("should return error when event not found", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(null);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "nonexistent",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("consultation not found");
  });

  it("should reject duplicate slots", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: [
        "2025-01-06T10:00:00Z",
        "2025-01-06T10:00:00Z", // duplicate
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Duplicate slots detected");
    expect(result.error).toContain("2 slots provided but only 1 are unique");
  });

  it("should reject slot count not divisible by slotsPerCall", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    // 1-hour session needs 2 slots, but providing 3
    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: [
        "2025-01-06T10:00:00Z",
        "2025-01-06T10:30:00Z",
        "2025-01-06T11:00:00Z",
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid slot count");
    expect(result.error).toContain("multiples of 2 slots");
  });

  it("should reject when validation fails", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    mockValidateFn.mockResolvedValue({
      isValid: false,
      errors: ["Slots conflict with existing appointment"],
      warnings: [],
    });

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed");
    expect(result.error).toContain("Slots conflict");
  });

  it("should create appointment on successful validation", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(true);
    expect(mockTx.appointment.create).toHaveBeenCalled();
  });

  it("should create slot records with 30-minute duration", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const createCall = mockTx.appointment.create.mock.calls[0][0];
    const slotsToCreate = createCall.data.slotsOfAppointment.create;

    expect(slotsToCreate).toHaveLength(2);
    // Each slot should have 30-minute offset between startsAt and endsAt
    const slot1Start = new Date(slotsToCreate[0].startsAt).getTime();
    const slot1End = new Date(slotsToCreate[0].endsAt).getTime();
    expect(slot1End - slot1Start).toBe(30 * 60 * 1000);
  });

  it("should connect both consultant and consultee to appointment", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const createCall = mockTx.appointment.create.mock.calls[0][0];
    const userConnect =
      createCall.data.slotsOfAppointment.create[0].user.connect;

    expect(userConnect).toEqual(
      expect.arrayContaining([{ id: "consultant-1" }, { id: "consultee-1" }]),
    );
  });

  it("should set correct appointment type for consultation", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const createCall = mockTx.appointment.create.mock.calls[0][0];
    expect(createCall.data.appointmentType).toBe(AppointmentsType.CONSULTATION);
  });

  it("should connect appointment to consultation via relation field", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const createCall = mockTx.appointment.create.mock.calls[0][0];
    expect(createCall.data.consultation).toEqual({
      connect: { id: "consult-1" },
    });
  });

  it("should update consultation status to APPROVED", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(mockTx.consultation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "consult-1" }),
        data: expect.objectContaining({
          status: AppointmentStatus.APPROVED,
        }),
      }),
    );
  });

  it("should delete existing appointments before creating new ones", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    // Simulate existing appointments to delete
    // First findMany: reschedule detection (needs slotsOfAppointment)
    // Second findMany: deleteExistingAppointments full-delete path
    mockTx.appointment.findMany.mockResolvedValue([
      { id: "old-apt-1", slotsOfAppointment: [] },
    ]);

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    // B-P1-05 — the delete carries its own payment guard in the WHERE clause.
    expect(mockTx.appointment.deleteMany).toHaveBeenCalledWith({
      where: { id: "old-apt-1", payment: { none: {} } },
    });
  });

  it("should return validation warnings on success", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    mockValidateFn.mockResolvedValue({
      isValid: true,
      errors: [],
      warnings: ["Week of Jan 6 is fully booked"],
    });

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(true);
    expect(result.warnings).toContain("Week of Jan 6 is fully booked");
  });

  it("should handle subscription manual allocation with correct appointment type", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(makeSubscriptionEvent());

    await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const createCall = mockTx.appointment.create.mock.calls[0][0];
    expect(createCall.data.appointmentType).toBe(AppointmentsType.SUBSCRIPTION);
    expect(createCall.data.subscription).toEqual({
      connect: { id: "sub-1" },
    });
  });

  it("should create multiple appointments for subscription with multiple calls", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscriptionEvent({
        schedulingPeriodEndsAt: new Date("2025-01-17T00:00:00Z"), // 2 weeks → requires 4 slots
      }),
    );

    // 4 slots → 2 appointments of 2 slots each (1hr sessions)
    await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: [
        "2025-01-06T10:00:00Z",
        "2025-01-06T10:30:00Z",
        "2025-01-13T10:00:00Z",
        "2025-01-13T10:30:00Z",
      ],
    });

    expect(mockTx.appointment.create).toHaveBeenCalledTimes(2);
  });
});

// ─── Requested Slot Allocation ──────────────────────────────────────────────

describe("Requested slot allocation", () => {
  it("should return error when event not found", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(null);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "nonexistent",
      mode: "requested",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("consultation not found");
  });

  it("should return error when no requested slots found", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({ appointment: null }),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "requested",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No requested slots found");
  });

  it("should return error when no appointments exist in DB", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        appointment: {
          slotsOfAppointment: [{ startsAt: new Date("2025-01-06T10:00:00Z") }],
        },
      }),
    );
    // appointment.findMany returns empty — no actual appointments in DB
    mockTx.appointment.findMany.mockResolvedValue([]);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "requested",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No appointments found");
    expect(result.error).toContain("resubmit their request");
  });

  it("should refuse to reuse requested times once a slot is awaiting reschedule", async () => {
    // A reschedule flips isTentative/completionStatus but leaves startsAt at the
    // ORIGINAL time, and fetchEventData reads requestedSlots from those rows —
    // so accepting here would re-confirm the time the consultee asked to move.
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        appointment: {
          slotsOfAppointment: [
            { startsAt: new Date("2025-01-06T10:00:00Z") },
            { startsAt: new Date("2025-01-06T10:30:00Z") },
          ],
        },
      }),
    );
    mockTx.appointment.findMany.mockResolvedValue([
      {
        id: "apt-1",
        slotsOfAppointment: [
          { id: "s1", completionStatus: "RESCHEDULED" },
          { id: "s2", completionStatus: "RESCHEDULED" },
        ],
      },
    ]);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "requested",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Cannot reuse requested times");
    expect(result.error).toContain("2 slot(s) are awaiting reschedule");
    // The status write must not have happened.
    expect(mockTx.slotOfAppointment.updateMany).not.toHaveBeenCalled();
  });

  it("should return error when appointment slot count mismatches requested", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        appointment: {
          slotsOfAppointment: [
            { startsAt: new Date("2025-01-06T10:00:00Z") },
            { startsAt: new Date("2025-01-06T10:30:00Z") },
          ],
        },
      }),
    );
    // One 30-minute row in the DB appointment, but 2 atoms requested.
    mockTx.appointment.findMany.mockResolvedValue([
      {
        id: "apt-1",
        slotsOfAppointment: [
          {
            id: "s1",
            startsAt: new Date("2025-01-06T10:00:00Z"),
            endsAt: new Date("2025-01-06T10:30:00Z"),
          },
        ],
      },
    ]);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "requested",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Appointment mismatch");
    expect(result.error).toContain("cover 1 half-hour atoms");
    expect(result.error).toContain("2 were requested");
  });

  // #1319 — the gate counts COVERED atoms, not rows. A legacy 60-minute row
  // (76 of 87 production consultations) covers the two atoms the consultee
  // requested, so approval must not be refused as a "mismatch".
  it("accepts a legacy 60-minute row as the two atoms it covers", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        appointment: {
          slotsOfAppointment: [
            { startsAt: new Date("2025-01-06T10:00:00Z") },
            { startsAt: new Date("2025-01-06T10:30:00Z") },
          ],
        },
      }),
    );
    mockTx.appointment.findMany.mockResolvedValue([
      {
        id: "apt-1",
        slotsOfAppointment: [
          {
            id: "s1",
            startsAt: new Date("2025-01-06T10:00:00Z"),
            endsAt: new Date("2025-01-06T11:00:00Z"),
          },
        ],
      },
    ]);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "requested",
    });

    // Asserting success, not merely the absence of one error string: the
    // negative form passes for any other failure and proves nothing about the
    // legacy row being accepted.
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("should return error when validation fails for requested slots", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        appointment: {
          slotsOfAppointment: [
            { startsAt: new Date("2025-01-06T10:00:00Z") },
            { startsAt: new Date("2025-01-06T10:30:00Z") },
          ],
        },
      }),
    );
    mockTx.appointment.findMany.mockResolvedValue([
      {
        id: "apt-1",
        slotsOfAppointment: [{ id: "s1" }, { id: "s2" }],
      },
    ]);
    mockValidateFn.mockResolvedValue({
      isValid: false,
      errors: ["Slots are in the past"],
      warnings: [],
    });

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "requested",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed");
  });

  it("should clear isTentative flag on all appointment slots", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        appointment: {
          slotsOfAppointment: [
            { startsAt: new Date("2025-01-06T10:00:00Z") },
            { startsAt: new Date("2025-01-06T10:30:00Z") },
          ],
        },
      }),
    );
    mockTx.appointment.findMany.mockResolvedValue([
      {
        id: "apt-1",
        slotsOfAppointment: [{ id: "s1" }, { id: "s2" }],
      },
    ]);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "requested",
    });

    expect(result.success).toBe(true);
    expect(mockTx.slotOfAppointment.updateMany).toHaveBeenCalledWith({
      where: { appointmentId: { in: ["apt-1"] } },
      data: { isTentative: false },
    });
  });

  it("should update event status on success", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        appointment: {
          slotsOfAppointment: [
            { startsAt: new Date("2025-01-06T10:00:00Z") },
            { startsAt: new Date("2025-01-06T10:30:00Z") },
          ],
        },
      }),
    );
    mockTx.appointment.findMany.mockResolvedValue([
      {
        id: "apt-1",
        slotsOfAppointment: [{ id: "s1" }, { id: "s2" }],
      },
    ]);

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "requested",
    });

    expect(mockTx.consultation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "consult-1" }),
        data: expect.objectContaining({
          status: AppointmentStatus.APPROVED,
        }),
      }),
    );
  });

  it("should return existing appointments on success", async () => {
    const existingApts = [
      {
        id: "apt-1",
        slotsOfAppointment: [{ id: "s1" }, { id: "s2" }],
      },
    ];
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        appointment: {
          slotsOfAppointment: [
            { startsAt: new Date("2025-01-06T10:00:00Z") },
            { startsAt: new Date("2025-01-06T10:30:00Z") },
          ],
        },
      }),
    );
    mockTx.appointment.findMany.mockResolvedValue(existingApts);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "requested",
    });

    expect(result.success).toBe(true);
    expect(result.appointments).toBe(existingApts);
  });
});

// ─── Auto Allocation ────────────────────────────────────────────────────────

describe("Auto allocation", () => {
  it("should return error when event not found", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(null);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "nonexistent",
      mode: "auto",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("consultation not found");
  });

  it("should throw when consultant has no availability slots", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        consultationPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInHours: 1,
          consultantProfile: makeConsultantProfile({
            slotsOfAvailabilityWeekly: [],
          }),
        },
      }),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No availability slots configured");
  });

  it("should find and allocate consecutive slots for consultation", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
    // Should create exactly 1 appointment for consultation
    expect(mockTx.appointment.create).toHaveBeenCalledTimes(1);
    // Appointment should have 2 slots (1hr ÷ 30min = 2)
    const createCall = mockTx.appointment.create.mock.calls[0][0];
    expect(createCall.data.slotsOfAppointment.create).toHaveLength(2);
  });

  it("should find consecutive slots for webinar", async () => {
    mockTx.webinar.findUnique.mockResolvedValue(makeWebinarEvent());

    const result = await SlotAllocationService.allocate({
      eventType: "webinar",
      eventId: "webinar-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
    expect(mockTx.appointment.create).toHaveBeenCalledTimes(1);
  });

  // #898 follow-up — auto-allocate selection is consultee-aware: it folds the
  // consultee's existing bookings (with ANY consultant) into bookedSlots, so it
  // picks slots free for BOTH parties instead of consultant-free ones that then
  // fail the consultee-conflict validation.
  it("#898: skips a consultee-busy block and picks the next mutually-free one", async () => {
    // Consultant is free all Monday 9–11 (two 1h blocks: 09:00 and 10:00).
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        consultationPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInHours: 1,
          consultantProfile: makeConsultantProfile({
            slotsOfAvailabilityWeekly: [
              makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 9, 10),
              makeWeeklyAvailabilitySlot(DayOfWeek.TUESDAY, 9, 10),
            ],
          }),
        },
        requestedBy: { user: { id: "consultee-1" } },
      }),
    );

    // The CONSULTEE is already booked (with another consultant) every Monday
    // 09:00 in the search window → auto-allocate must skip Monday and pick the
    // mutually-free Tuesday block.
    const consulteeBusy: any[] = [];
    for (let week = 0; week < 8; week++) {
      const d = new Date("2025-01-06T09:00:00Z");
      d.setUTCDate(d.getUTCDate() + week * 7);
      consulteeBusy.push({ startsAt: new Date(d) });
    }

    mockTx.appointment.findMany
      .mockResolvedValueOnce([]) // reschedule check
      .mockResolvedValueOnce([]) // consultant booked slots — none
      .mockResolvedValueOnce([{ slotsOfAppointment: consulteeBusy }]) // #898 consultee-busy query
      .mockResolvedValue([]); // delete

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
    const createCall = mockTx.appointment.create.mock.calls[0][0];
    const starts = createCall.data.slotsOfAppointment.create.map((s: any) =>
      new Date(s.startsAt).toISOString(),
    );
    // Booked the mutually-free Tuesday block, not a consultant-free Monday slot
    // that would have failed the consultee-conflict validation (#898). Without
    // the consultee-aware selection, auto-allocate would have picked Monday.
    expect(starts.every((t: string) => t.startsWith("2025-01-07"))).toBe(true);
  });

  it("should fail auto-allocation when all slots are booked", async () => {
    // Consultant has only 1-hour availability (2 blocks: 9:00, 9:30)
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        consultationPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInHours: 1,
          consultantProfile: makeConsultantProfile({
            slotsOfAvailabilityWeekly: [
              makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 9, 10),
            ],
          }),
        },
      }),
    );

    // Book ALL 8 weeks of Monday 9:00 slots so none are available
    const bookedSlots: any[] = [];
    for (let week = 0; week < 8; week++) {
      const d = new Date("2025-01-06T09:00:00Z");
      d.setUTCDate(d.getUTCDate() + week * 7);
      bookedSlots.push({ startsAt: new Date(d) });
    }

    mockTx.appointment.findMany
      .mockResolvedValueOnce([]) // reschedule check
      .mockResolvedValueOnce([{ slotsOfAppointment: bookedSlots }]) // booked slots
      .mockResolvedValue([]); // delete

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("consecutive slots available");
  });

  // ── RV-2: allocator agrees with validator on expired pending-payment holds ──
  it("RV-2: does not treat an expired pending-payment hold as booked", async () => {
    // Consultant has a single 1-hour Monday block; only Mon 09:00-10:00 is
    // allocatable each week.
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        consultationPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInHours: 1,
          consultantProfile: makeConsultantProfile({
            slotsOfAvailabilityWeekly: [
              makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 9, 10),
            ],
          }),
        },
      }),
    );

    // Every Monday 09:00 across the 8-week search window is "occupied" — but by
    // an APPROVED_PENDING_PAYMENT consultation whose payment has expired. The
    // validator already skips these (orphaned-payment fix); pre-RV-2 the
    // allocator did not, so the two disagreed and auto-allocate failed.
    const blockedSlots: any[] = [];
    for (let week = 0; week < 8; week++) {
      const d = new Date("2025-01-06T09:00:00Z");
      d.setUTCDate(d.getUTCDate() + week * 7);
      blockedSlots.push({ startsAt: new Date(d) });
    }

    mockTx.appointment.findMany
      .mockResolvedValueOnce([]) // reschedule check
      .mockResolvedValueOnce([
        {
          id: "expired-hold",
          slotsOfAppointment: blockedSlots,
          consultation: { status: AppointmentStatus.APPROVED_PENDING_PAYMENT },
          subscription: null,
          payment: [
            {
              paymentStatus: "PENDING",
              expiresAt: new Date("2024-01-01T00:00:00Z"),
            },
          ], // expired
        },
      ])
      .mockResolvedValue([]); // delete

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    // The expired hold is not a live blocker → the slot is free → allocation
    // succeeds, matching what /validate would accept for the same slot.
    expect(result.success).toBe(true);
    expect(mockTx.appointment.create).toHaveBeenCalled();
  });

  it("RV-2: still treats a non-expired pending-payment hold as booked", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        consultationPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInHours: 1,
          consultantProfile: makeConsultantProfile({
            slotsOfAvailabilityWeekly: [
              makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 9, 10),
            ],
          }),
        },
      }),
    );

    const blockedSlots: any[] = [];
    for (let week = 0; week < 8; week++) {
      const d = new Date("2025-01-06T09:00:00Z");
      d.setUTCDate(d.getUTCDate() + week * 7);
      blockedSlots.push({ startsAt: new Date(d) });
    }

    mockTx.appointment.findMany
      .mockResolvedValueOnce([]) // reschedule check
      .mockResolvedValueOnce([
        {
          id: "live-hold",
          slotsOfAppointment: blockedSlots,
          consultation: { status: AppointmentStatus.APPROVED_PENDING_PAYMENT },
          subscription: null,
          payment: [
            {
              paymentStatus: "PENDING",
              expiresAt: new Date("2026-12-31T00:00:00Z"),
            },
          ], // not expired
        },
      ])
      .mockResolvedValue([]); // delete

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    // A live hold blocks every Monday → no slot free → allocation fails.
    expect(result.success).toBe(false);
    expect(result.error).toContain("consecutive slots available");
  });

  // ── Per-day cap parity (#1189 B-P2 adjacent): auto-allocate may stack up to
  // the validator's per-day cap on one day. A class with more sessions per
  // week than available days was UNALLOCATABLE by auto (one-placement-per-day
  // cursor found 1/day) while manual + validatePerDaySessionCap allow 2/day.
  it("stacks two class sessions on one day when available days < sessionsPerWeek", async () => {
    mockTx.class.findUnique.mockResolvedValue(
      makeClassEvent({
        classPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInMonths: 1,
          sessionsPerWeek: 3,
          sessionDurationInHours: 1,
          totalSessions: 8, // authoritative plan count → 8 × 2 slots = 16
          consultantProfile: makeConsultantProfile({
            // Only TWO available days per week for a THREE-per-week class.
            slotsOfAvailabilityWeekly: [
              makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 9, 11),
              makeWeeklyAvailabilitySlot(DayOfWeek.TUESDAY, 9, 11),
            ],
          }),
        },
        schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00Z"),
        schedulingPeriodEndsAt: new Date("2025-01-27T00:00:00Z"),
        appointments: [],
      }),
    );
    mockTx.appointment.findMany.mockResolvedValue([]); // no existing bookings

    const result = await SlotAllocationService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "auto",
    });

    // 8 sessions × 2 slots = 16 slots demanded; only 6 allocatable days exist
    // in the window, so the demand is satisfiable ONLY by placing two sessions
    // on some days (the validator's ≤2/day cap). The old one-per-day cursor
    // found at most 6 sessions and failed with "Could only find 12 of 16".
    expect(result.success).toBe(true);
    expect(mockTx.appointment.create).toHaveBeenCalledTimes(8);

    const sessionStarts = mockTx.appointment.create.mock.calls.map(
      (call: any[]) =>
        new Date(call[0].data.slotsOfAppointment.create[0].startsAt),
    );
    // Two sessions stacked on the first Monday (09:00 and 10:00) — the
    // per-day-cap behavior the validator already allowed.
    const jan6 = sessionStarts.filter((d: Date) =>
      d.toISOString().startsWith("2025-01-06"),
    );
    expect(jan6.map((d: Date) => d.toISOString()).sort()).toEqual([
      "2025-01-06T09:00:00.000Z",
      "2025-01-06T10:00:00.000Z",
    ]);
    // Every placement stays inside the scheduling period.
    for (const d of sessionStarts) {
      expect(d.getTime()).toBeLessThan(
        new Date("2025-01-27T00:00:00Z").getTime(),
      );
    }
  });

  it("still caps subscriptions at one session per day", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscriptionEvent({
        subscriptionPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInMonths: 1,
          sessionsPerWeek: 3,
          sessionDurationInHours: 1,
          consultantProfile: makeConsultantProfile({
            slotsOfAvailabilityWeekly: [
              makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 9, 12),
            ],
          }),
        },
        schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00Z"),
        schedulingPeriodEndsAt: new Date("2025-01-13T00:00:00Z"),
        appointments: [],
      }),
    );
    mockTx.appointment.findMany.mockResolvedValue([]);

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "auto",
    });

    // 2 weeks × 3 sessions × 2 slots = 12 slots demanded, but a subscription
    // holds at most ONE session per day (MAX_SUBSCRIPTION_SESSIONS_PER_DAY)
    // and only one Monday exists in the window → auto must refuse rather
    // than stack same-day sessions the validator would reject.
    expect(result.success).toBe(false);
    expect(result.error).toContain("Could only find 2 of 12");
  });

  // ── Bounded occupancy reads (#908 family): selection only needs FUTURE
  // occupancy — buildConsecutiveBlock rejects any candidate before `now` — so
  // the reads are bounded to live intervals instead of the consultant's whole
  // history, and tombstoned slots never block.
  it("bounds occupancy reads to live intervals and excludes slot tombstones", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    mockTx.appointment.findMany.mockResolvedValue([]);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });
    expect(result.success).toBe(true);

    const findManyCalls = mockTx.appointment.findMany.mock.calls;
    // Call #1: reschedule detection. Calls #2/#3: findAvailableSlots'
    // consultant and consultee occupancy reads.
    expect(findManyCalls.length).toBeGreaterThanOrEqual(3);

    for (const index of [1, 2]) {
      const { where, include } = findManyCalls[index][0];
      const boundedArm = where.AND.find(
        (clause: any) => clause.slotsOfAppointment?.some?.endsAt !== undefined,
      )?.slotsOfAppointment.some;
      expect(boundedArm).toBeDefined();
      // Live intervals only — past slots can never collide with a candidate.
      expect(boundedArm.endsAt).toHaveProperty("gt");
      // Tombstoned slots are not bookings.
      expect(boundedArm.deletedAt).toBeNull();
      // The include mirrors the tombstone exclusion: bookedSlots is built
      // from the RETURNED children, so an unfiltered include would let a
      // deleted child of a qualifying appointment block selection
      // (CodeRabbit triage). Past children are deliberately admitted —
      // candidates before `now` are rejected anyway.
      expect(include.slotsOfAppointment).toMatchObject({
        where: { deletedAt: null },
      });
    }
  });

  it("should validate found slots before creating appointments", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    mockValidateFn.mockResolvedValue({
      isValid: false,
      errors: ["Conflict detected"],
      warnings: [],
    });

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed");
    // Should not create appointments when validation fails
    expect(mockTx.appointment.create).not.toHaveBeenCalled();
  });

  it("should detect reschedule when tentative slots exist", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    // First findMany returns existing appointments with tentative slots
    mockTx.appointment.findMany
      .mockResolvedValueOnce([
        {
          id: "old-apt",
          slotsOfAppointment: [
            { isTentative: true, startsAt: new Date() },
            { isTentative: true, startsAt: new Date() },
          ],
        },
      ])
      .mockResolvedValue([]); // booked slots and delete queries

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
  });

  it("should reject slots outside scheduling period for subscription", async () => {
    // Create subscription with narrow period that doesn't match availability
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscriptionEvent({
        // Period is in the past — no slots can be "in the future" AND in this period
        schedulingPeriodStartsAt: new Date("2024-01-06T00:00:00Z"),
        schedulingPeriodEndsAt: new Date("2024-02-02T23:59:59Z"),
        subscriptionPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInMonths: 1,
          sessionsPerWeek: 1,
          sessionDurationInHours: 1,
          consultantProfile: makeConsultantProfile(),
        },
      }),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "auto",
    });

    expect(result.success).toBe(false);
    // Should fail because no future slots exist in past period
    expect(result.error).toBeDefined();
  });

  it("should update webinar status to SCHEDULED", async () => {
    mockTx.webinar.findUnique.mockResolvedValue(makeWebinarEvent());

    await SlotAllocationService.allocate({
      eventType: "webinar",
      eventId: "webinar-1",
      mode: "auto",
    });

    // Guarded transition: WHERE-guarded updateMany (EVENT_ALLOWED_FROM),
    // so a CANCELLED/COMPLETED webinar can no longer be resurrected.
    expect(mockTx.webinar.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "webinar-1",
          status: expect.objectContaining({ in: expect.any(Array) }),
        }),
        data: expect.objectContaining({ status: "SCHEDULED" }),
      }),
    );
  });

  it("should pass transaction with 60-second timeout", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    // $transaction receives callback and options
    const txCall = (prisma.$transaction as jest.Mock).mock.calls[0];
    // The second argument should be the options (our mock ignores it, but it was passed)
    // Since we mock $transaction to only use the callback, verify it was called
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

// ─── fetchEventData (tested indirectly) ─────────────────────────────────────

describe("fetchEventData - config extraction", () => {
  it("should throw for missing consultant profile", async () => {
    mockTx.consultation.findUnique.mockResolvedValue({
      id: "consult-1",
      consultationPlan: {
        consultantProfileId: "consultant-profile-1",
        durationInHours: 1,
        consultantProfile: null, // missing!
      },
      requestedBy: { user: { id: "consultee-1" } },
      appointment: null,
    });

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Consultant profile not found");
  });

  it("should throw for invalid date range (start >= end)", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscriptionEvent({
        schedulingPeriodStartsAt: new Date("2025-02-01T00:00:00Z"),
        schedulingPeriodEndsAt: new Date("2025-01-01T00:00:00Z"), // before start!
      }),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid date range");
    expect(result.error).toContain("must be before");
  });

  it("should extract durationInHours for consultation config", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        consultationPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInHours: 1.5, // 3 slots needed
          consultantProfile: makeConsultantProfile(),
        },
      }),
    );

    // 1.5-hour session needs 3 consecutive slots
    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: [
        "2025-01-06T10:00:00Z",
        "2025-01-06T10:30:00Z",
        "2025-01-06T11:00:00Z",
      ],
    });

    expect(result.success).toBe(true);
  });

  it("should extract subscription config including sessionsPerWeek and scheduling period", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(makeSubscriptionEvent());

    await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    // Validate that the validator received the correct config
    expect(mockValidateFn).toHaveBeenCalledWith(
      "subscription",
      "sub-1",
      expect.any(Array),
      expect.objectContaining({ userId: "consultant-1" }),
      expect.objectContaining({
        sessionsPerWeek: 1,
        sessionDurationInHours: 1,
        schedulingPeriodStartsAt: expect.any(Date),
        schedulingPeriodEndsAt: expect.any(Date),
      }),
      expect.any(Array), // appointmentIdsToExclude
      // #676 AE-1 — consulteeUserId threaded for the conflict scan, now inside
      // the options object that brought validate() back under the param limit.
      { consulteeUserId: "consultee-1" },
    );
  });

  it("should extract webinar config with durationInHours", async () => {
    mockTx.webinar.findUnique.mockResolvedValue(makeWebinarEvent());

    await SlotAllocationService.allocate({
      eventType: "webinar",
      eventId: "webinar-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(mockValidateFn).toHaveBeenCalledWith(
      "webinar",
      "webinar-1",
      expect.any(Array),
      expect.objectContaining({ userId: "consultant-1" }),
      expect.objectContaining({ durationInHours: 1 }),
      expect.any(Array), // appointmentIdsToExclude
      // consulteeUserId moved into the options object when validate() came back
      // under the parameter limit. Still undefined here: #676 AE-1 — a group
      // event has no single consultee.
      { consulteeUserId: undefined },
    );
  });

  it("should extract class config from the PLAN session duration, not the classContents average", async () => {
    mockTx.class.findUnique.mockResolvedValue(
      makeClassEvent({
        classPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInMonths: 2,
          sessionsPerWeek: 2,
          sessionDurationInHours: 1.5,
          consultantProfile: makeConsultantProfile(),
          // Curriculum items deliberately disagree with the plan (average
          // 1.0h): they describe content coverage, not session length. The
          // allocator must follow the plan — crud-with-plan writes slots at
          // the plan duration and /validate validates against it.
          classContents: [{ hoursAllotted: 1 }, { hoursAllotted: 1 }],
        },
        // 1 week with sessionsPerWeek=2, 1.5hr sessions (3 slots each) → requires 6 slots
        schedulingPeriodEndsAt: new Date("2025-01-10T00:00:00Z"),
      }),
    );

    await SlotAllocationService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "manual",
      // Plan duration 1.5 hours → 3 slots per call, 2 calls = 6 slots.
      // Under the old contents-average derivation (1.0h → 2 slots/call) this
      // selection would have been rejected as a non-multiple of 2.
      slots: [
        "2025-01-06T10:00:00Z",
        "2025-01-06T10:30:00Z",
        "2025-01-06T11:00:00Z",
        "2025-01-08T10:00:00Z",
        "2025-01-08T10:30:00Z",
        "2025-01-08T11:00:00Z",
      ],
    });

    expect(mockValidateFn).toHaveBeenCalledWith(
      "class",
      "class-1",
      expect.any(Array),
      expect.any(Object),
      expect.objectContaining({
        sessionsPerWeek: 2,
        sessionDurationInHours: 1.5,
      }),
      expect.any(Array), // appointmentIdsToExclude
      // consulteeUserId moved into the options object when validate() came back
      // under the parameter limit. Still undefined here: #676 AE-1 — a group
      // event has no single consultee.
      { consulteeUserId: undefined },
    );
  });
});

// ─── updateEventStatus (tested indirectly) ──────────────────────────────────

describe("updateEventStatus", () => {
  it("should set APPROVED for subscription with existing scheduling period", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(makeSubscriptionEvent());

    await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(mockTx.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "sub-1" }),
        data: expect.objectContaining({
          status: AppointmentStatus.APPROVED,
        }),
      }),
    );
    // Should NOT overwrite existing scheduling period
    const updateData = mockTx.subscription.updateMany.mock.calls[0][0].data;
    expect(updateData.schedulingPeriodStartsAt).toBeUndefined();
  });

  it("should create scheduling period for subscription when not configured", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscriptionEvent({
        schedulingPeriodStartsAt: null,
        schedulingPeriodEndsAt: null,
        subscriptionPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInMonths: 1,
          sessionsPerWeek: 1,
          sessionDurationInHours: 1,
          consultantProfile: makeConsultantProfile(),
        },
      }),
    );

    await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const updateData = mockTx.subscription.updateMany.mock.calls[0][0].data;
    expect(updateData.schedulingPeriodStartsAt).toBeDefined();
    expect(updateData.schedulingPeriodEndsAt).toBeDefined();
  });

  it("should set SCHEDULED for webinar without scheduling period", async () => {
    mockTx.webinar.findUnique.mockResolvedValue(makeWebinarEvent());

    await SlotAllocationService.allocate({
      eventType: "webinar",
      eventId: "webinar-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const updateData = mockTx.webinar.updateMany.mock.calls[0][0].data;
    expect(updateData.status).toBe("SCHEDULED");
    // Webinar should NOT have scheduling period fields
    expect(updateData.schedulingPeriodStartsAt).toBeUndefined();
    expect(updateData.schedulingPeriodEndsAt).toBeUndefined();
  });

  it("should set SCHEDULED with scheduling period for class", async () => {
    // Use a class without pre-set scheduling period — updateEventStatus should
    // derive schedulingPeriodStartsAt/EndsAt from the first allocated slot
    mockTx.class.findUnique.mockResolvedValue(
      makeClassEvent({
        schedulingPeriodStartsAt: null,
        schedulingPeriodEndsAt: null,
      }),
    );

    await SlotAllocationService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    // Guarded transition: status rides transitionClassEvent's updateMany
    const updateCall = mockTx.class.updateMany.mock.calls[0][0];
    expect(updateCall.data.status).toBe("SCHEDULED");
    expect(updateCall.data.schedulingPeriodStartsAt).toBeDefined();
    expect(updateCall.data.schedulingPeriodEndsAt).toBeDefined();
  });

  // #1060 — allocating a DRAFT used to 409 and roll back the whole allocation:
  // the transition targeted SCHEDULED against EVENT_ALLOWED_FROM.SCHEDULED,
  // which deliberately excludes DRAFT so a reschedule cannot publish an
  // unpublished offering. A draft matched zero rows, so "Set schedule" — the
  // one affordance that gives a draft its first session — always failed.
  //
  // The two properties pull in opposite directions, so both are pinned:
  // allocation must TOLERATE a draft, and must not PUBLISH one.
  describe.each([
    ["webinar", "webinar-1"],
    ["class", "class-1"],
  ] as const)("allocating a DRAFT %s", (eventType, eventId) => {
    /** Guarded updateMany matches nothing (a DRAFT row); the re-read says why. */
    function arrangeDraft() {
      const model = mockTx[eventType as "webinar" | "class"];
      model.updateMany.mockResolvedValue({ count: 0 });
      model.findUnique.mockResolvedValue(
        eventType === "webinar"
          ? makeWebinarEvent({ status: "DRAFT" })
          : makeClassEvent({ status: "DRAFT" }),
      );
      return model;
    }

    it("succeeds — a draft can be given its first session", async () => {
      arrangeDraft();

      const result = await SlotAllocationService.allocate({
        eventType,
        eventId,
        mode: "manual",
        slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
      });

      expect(result.success).toBe(true);
    });

    it("does not publish it — every status write is guarded against DRAFT", async () => {
      const model = arrangeDraft();

      await SlotAllocationService.allocate({
        eventType,
        eventId,
        mode: "manual",
        slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
      });

      // Publishing is a separate, deliberate act; allocation only adds
      // sessions. Any write that sets SCHEDULED must carry a WHERE a DRAFT row
      // cannot satisfy, so it matched nothing.
      const publishing = model.updateMany.mock.calls.filter(
        ([args]: [{ data?: { status?: string } }]) =>
          args.data?.status === "SCHEDULED",
      );
      expect(publishing.length).toBeGreaterThan(0);
      for (const [args] of publishing) {
        expect(args.where.status.in).not.toContain("DRAFT");
      }
    });

    it("still refuses to resurrect a CANCELLED event", async () => {
      // Tolerating DRAFT must not reopen the resurrection hole the guard was
      // added to close (#836) — the re-read is what distinguishes them.
      const model = mockTx[eventType as "webinar" | "class"];
      model.updateMany.mockResolvedValue({ count: 0 });
      model.findUnique.mockResolvedValue(
        eventType === "webinar"
          ? makeWebinarEvent({ status: "CANCELLED" })
          : makeClassEvent({ status: "CANCELLED" }),
      );

      const result = await SlotAllocationService.allocate({
        eventType,
        eventId,
        mode: "manual",
        slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
      });

      expect(result.success).toBe(false);
    });
  });
});

// ─── createAppointments (tested indirectly) ─────────────────────────────────

describe("createAppointments - grouping and validation", () => {
  it("should group 4 slots into 2 appointments for 1-hour sessions", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscriptionEvent({
        schedulingPeriodEndsAt: new Date("2025-01-17T00:00:00Z"), // 2 weeks → requires 4 slots
      }),
    );

    await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: [
        "2025-01-06T10:00:00Z",
        "2025-01-06T10:30:00Z",
        "2025-01-13T10:00:00Z",
        "2025-01-13T10:30:00Z",
      ],
    });

    expect(mockTx.appointment.create).toHaveBeenCalledTimes(2);

    // First appointment: first 2 slots
    const call1 = mockTx.appointment.create.mock.calls[0][0];
    expect(call1.data.slotsOfAppointment.create).toHaveLength(2);

    // Second appointment: next 2 slots
    const call2 = mockTx.appointment.create.mock.calls[1][0];
    expect(call2.data.slotsOfAppointment.create).toHaveLength(2);
  });

  it("should group 6 slots into 2 appointments for 1.5-hour sessions", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscriptionEvent({
        subscriptionPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInMonths: 1,
          sessionsPerWeek: 1,
          sessionDurationInHours: 1.5, // 3 slots per call
          consultantProfile: makeConsultantProfile(),
        },
        schedulingPeriodEndsAt: new Date("2025-01-17T00:00:00Z"), // 2 weeks → requires 6 slots
      }),
    );

    await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: [
        "2025-01-06T10:00:00Z",
        "2025-01-06T10:30:00Z",
        "2025-01-06T11:00:00Z",
        "2025-01-13T10:00:00Z",
        "2025-01-13T10:30:00Z",
        "2025-01-13T11:00:00Z",
      ],
    });

    expect(mockTx.appointment.create).toHaveBeenCalledTimes(2);
    // Each appointment has 3 slots
    expect(
      mockTx.appointment.create.mock.calls[0][0].data.slotsOfAppointment.create,
    ).toHaveLength(3);
    expect(
      mockTx.appointment.create.mock.calls[1][0].data.slotsOfAppointment.create,
    ).toHaveLength(3);
  });

  it("should set isTentative to false on all created slots", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const slotsCreated =
      mockTx.appointment.create.mock.calls[0][0].data.slotsOfAppointment.create;
    for (const slot of slotsCreated) {
      expect(slot.isTentative).toBe(false);
    }
  });

  // #1499 — a session allocated after checkout must cite the policy VERSION the
  // booking was sold under, read off the originating appointment. Resolving one
  // afresh here would hand the buyer whatever ladder the org has published
  // since, which is exactly what immutable versions exist to prevent.
  it("should inherit the originating appointment's cancellation policy", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    mockTx.appointment.findFirst.mockResolvedValue({
      cancellationPolicyId: "policy-abc",
    });

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(mockTx.appointment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cancellationPolicyId: "policy-abc" }),
      }),
    );
  });

  it("should only connect consultant when no consultee (webinar)", async () => {
    mockTx.webinar.findUnique.mockResolvedValue(makeWebinarEvent());

    await SlotAllocationService.allocate({
      eventType: "webinar",
      eventId: "webinar-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const userConnect =
      mockTx.appointment.create.mock.calls[0][0].data.slotsOfAppointment
        .create[0].user.connect;
    expect(userConnect).toEqual([{ id: "consultant-1" }]);
  });

  it("should include slotsOfAppointment in create response", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const createCall = mockTx.appointment.create.mock.calls[0][0];
    expect(createCall.include).toEqual({ slotsOfAppointment: true });
  });
});

// ─── deleteExistingAppointments (tested indirectly) ─────────────────────────

describe("deleteExistingAppointments", () => {
  it("should delete all existing appointments for manual allocation", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    // findMany for reschedule detection and delete returns existing appointments
    // Must include slotsOfAppointment for reschedule detection in manualAllocate
    mockTx.appointment.findMany.mockResolvedValue([
      { id: "old-1", slotsOfAppointment: [] },
      { id: "old-2", slotsOfAppointment: [] },
    ]);

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    // B-P1-05 — the delete carries its own payment guard: a Payment that
    // commits between the earlier read and this write must not be
    // cascade-destroyed (Payment.appointment is onDelete: Cascade).
    expect(mockTx.appointment.deleteMany).toHaveBeenCalledWith({
      where: { id: "old-1", payment: { none: {} } },
    });
    expect(mockTx.appointment.deleteMany).toHaveBeenCalledWith({
      where: { id: "old-2", payment: { none: {} } },
    });
  });

  // ── B-P1-05: the delete refuses when a payment appeared mid-transaction ────
  it("B-P1-05: full-delete keeps the appointment and strips only its slots when a payment appeared", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    // Both appointments read as payment-less. The guarded delete of "old-2"
    // then matches ZERO rows — a checkout's Payment committed between the
    // read and the delete (the race). "old-1" deletes normally.
    mockTx.appointment.findMany.mockResolvedValue([
      {
        id: "old-1",
        slotsOfAppointment: [
          {
            id: "s1",
            isTentative: false,
            user: [{ id: "consultant-1" }],
            startsAt: new Date("2025-01-06T10:00:00Z"),
            endsAt: new Date("2025-01-06T10:30:00Z"),
            meetingSession: null,
          },
        ],
        _count: { payment: 0 },
      },
      { id: "old-2", slotsOfAppointment: [], _count: { payment: 0 } },
    ]);
    mockTx.appointment.deleteMany.mockImplementation(async ({ where }: any) =>
      where.id === "old-2" ? { count: 0 } : { count: 1 },
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(true);
    // The raced appointment was KEPT (no unconditional delete) and, being a
    // consultation's 1:1 appointment holding the @unique event FK, the new
    // slots were attached to it via update (REUSE) instead of create.
    expect(mockTx.appointment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "old-2" } }),
    );
    expect(mockTx.appointment.create).not.toHaveBeenCalled();
    // Its sessionless slots were stripped so they no longer block availability.
    expect(mockTx.slotOfAppointment.deleteMany).toHaveBeenCalledWith({
      where: { appointmentId: "old-2", meetingSession: { is: null } },
    });
  });

  it("should not delete when no existing appointments", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    mockTx.appointment.findMany.mockResolvedValue([]);

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(mockTx.appointment.delete).not.toHaveBeenCalled();
  });

  // ── AE-4: partial reschedule returns the freed appointment ids ─────────────
  it("AE-4: returns deletedAppointmentIds whose tentative slots were freed", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    const tentativeAppointment = {
      id: "rescheduled-apt",
      slotsOfAppointment: [
        { id: "s1", isTentative: true },
        { id: "s2", isTentative: true },
      ],
      _count: { payment: 0 },
    };

    // Call #1 — reschedule detection (tentative slots present → isReschedule).
    mockTx.appointment.findMany.mockResolvedValueOnce([tentativeAppointment]);
    // Call #2 — deleteExistingAppointments(onlyTentative) re-fetch.
    mockTx.appointment.findMany.mockResolvedValueOnce([tentativeAppointment]);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(true);
    // The freed ids must be threaded up to the AllocationResult.
    expect(result.deletedAppointmentIds).toEqual(["rescheduled-apt"]);
    // And only tentative slots were removed (partial reschedule path).
    expect(mockTx.slotOfAppointment.deleteMany).toHaveBeenCalledWith({
      where: { appointmentId: "rescheduled-apt", isTentative: true },
    });
  });

  // ── Enrolled learners must survive a tentative-path reschedule ─────────────
  // Scheduling a class created via crud-with-plan runs the onlyTentative path
  // (its placeholder slots are tentative). The enrolled learner lives only on
  // the slot↔user M2M, so deleteExistingAppointments must capture them and
  // reconnectEnrolledUsers must re-link them to the new slots — otherwise the
  // paid learner silently loses the class.
  it("reconnects enrolled learners after a class tentative reschedule", async () => {
    mockTx.class.findUnique.mockResolvedValue(makeClassEvent());

    // One tentative session (2 slots for a 1h class) the learner is enrolled in.
    const tentativeClassAppt = {
      id: "class-apt-1",
      slotsOfAppointment: [
        {
          id: "ts1",
          isTentative: true,
          user: [{ id: "consultant-1" }, { id: "learner-1" }],
          startsAt: new Date("2025-01-06T10:00:00Z"),
          endsAt: new Date("2025-01-06T10:30:00Z"),
        },
        {
          id: "ts2",
          isTentative: true,
          user: [{ id: "consultant-1" }, { id: "learner-1" }],
          startsAt: new Date("2025-01-06T10:30:00Z"),
          endsAt: new Date("2025-01-06T11:00:00Z"),
        },
      ],
      _count: { payment: 0 },
    };
    mockTx.appointment.findMany.mockResolvedValue([tentativeClassAppt]);
    // New appointment must expose BOTH slots (a 1h class session = 2×30-min
    // slots) so reconnect re-links the learner to every new slot (#898 #6).
    mockTx.appointment.create.mockResolvedValue({
      id: "new-class-apt",
      slotsOfAppointment: [{ id: "new-slot-1" }, { id: "new-slot-1b" }],
    });

    const result = await SlotAllocationService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(true);
    // The enrolled learner is reconnected to BOTH new slots...
    for (const slotId of ["new-slot-1", "new-slot-1b"]) {
      expect(mockTx.slotOfAppointment.update).toHaveBeenCalledWith({
        where: { id: slotId },
        data: { user: { connect: [{ id: "learner-1" }] } },
      });
    }
    // ...and the consultant is NOT in the reconnect set (already connected).
    const reconnectCalls = mockTx.slotOfAppointment.update.mock.calls;
    const connectedIds = reconnectCalls.flatMap((c: any[]) =>
      (c[0]?.data?.user?.connect ?? []).map((u: { id: string }) => u.id),
    );
    expect(connectedIds).not.toContain("consultant-1");
  });

  // Same hazard via the full-delete branch: re-scheduling a CONFIRMED,
  // not-yet-started class (no tentative slots, no past sessions) deletes its
  // session appointments and recreates them — enrolled learners must be
  // captured and reconnected here too.
  it("reconnects enrolled learners when a confirmed class is re-scheduled (full-delete)", async () => {
    mockTx.class.findUnique.mockResolvedValue(makeClassEvent());

    // One confirmed (non-tentative), future session the learner is enrolled in.
    const confirmedClassAppt = {
      id: "confirmed-class-apt",
      slotsOfAppointment: [
        {
          id: "cs1",
          isTentative: false,
          user: [{ id: "consultant-1" }, { id: "learner-1" }],
          startsAt: new Date("2025-01-06T10:00:00Z"),
          endsAt: new Date("2025-01-06T10:30:00Z"),
        },
        {
          id: "cs2",
          isTentative: false,
          user: [{ id: "consultant-1" }, { id: "learner-1" }],
          startsAt: new Date("2025-01-06T10:30:00Z"),
          endsAt: new Date("2025-01-06T11:00:00Z"),
        },
      ],
      _count: { payment: 0 },
    };
    mockTx.appointment.findMany.mockResolvedValue([confirmedClassAppt]);
    mockTx.appointment.create.mockResolvedValue({
      id: "new-class-apt-2",
      slotsOfAppointment: [{ id: "new-slot-2" }, { id: "new-slot-2b" }],
    });

    const result = await SlotAllocationService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(true);
    // Both new slots (1h session = 2×30-min) re-link the learner (#898 #6).
    for (const slotId of ["new-slot-2", "new-slot-2b"]) {
      expect(mockTx.slotOfAppointment.update).toHaveBeenCalledWith({
        where: { id: slotId },
        data: { user: { connect: [{ id: "learner-1" }] } },
      });
    }
  });

  it("AE-4: returns an empty deletedAppointmentIds on a non-reschedule allocation", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    mockTx.appointment.findMany.mockResolvedValue([]);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(true);
    expect(result.deletedAppointmentIds).toEqual([]);
  });

  // ── B8: full-delete must NOT delete payment-bearing appointments ───────────
  // Deleting one cascades to its Payment, which is Restrict-referenced by
  // ConsultantEarnings → FK violation. This is the real subscription bug: the
  // checkout placeholder (zero slots, signup Payment) reaches full-delete on
  // initial allocation. Preserve it; just strip its slots. Subscription is 1:N
  // (subscriptionId not @unique), so createAppointments adds a fresh row — no
  // REUSE (contrast the consultation/webinar REUSE tests below). #898 moved
  // this off the consultation fixture, which now exercises REUSE instead.
  it("B8: preserves a payment-bearing subscription placeholder on full-delete, deletes only its slots", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(makeSubscriptionEvent());

    // Placeholder: zero slots, carries the signup Payment.
    mockTx.appointment.findMany.mockResolvedValue([
      { id: "placeholder-apt", slotsOfAppointment: [], _count: { payment: 1 } },
    ]);

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(true);
    // The placeholder Appointment (and its Payment + ConsultantEarnings) survives.
    expect(mockTx.appointment.delete).not.toHaveBeenCalledWith({
      where: { id: "placeholder-apt" },
    });
    // Its slots are freed via deleteMany scoped to the appointment id —
    // excluding held-session slots (#1169 PR 1, Recording cascade guard).
    expect(mockTx.slotOfAppointment.deleteMany).toHaveBeenCalledWith({
      where: {
        appointmentId: "placeholder-apt",
        meetingSession: { is: null },
      },
    });
    // 1:N event → a fresh appointment row is created (no REUSE).
    expect(mockTx.appointment.create).toHaveBeenCalled();
    expect(mockTx.appointment.update).not.toHaveBeenCalled();
  });

  it("B8: still hard-deletes a non-payment appointment on full-delete", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(makeSubscriptionEvent());

    mockTx.appointment.findMany.mockResolvedValue([
      { id: "no-pay-1", slotsOfAppointment: [], _count: { payment: 0 } },
    ]);

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(true);
    // B-P1-05 — hard delete survives, but as a payment-guarded deleteMany:
    // the WHERE re-checks at write time so a Payment committing mid-txn can
    // never be cascade-destroyed.
    expect(mockTx.appointment.deleteMany).toHaveBeenCalledWith({
      where: { id: "no-pay-1", payment: { none: {} } },
    });
  });

  // ── #898: 1:1 events must REUSE the preserved payment-bearing appointment ───
  // For consultation/webinar (consultationId/webinarId @unique) the kept
  // appointment still holds the unique event FK, so createAppointments must
  // UPDATE it (attach new slots) rather than CREATE a second row — a fresh
  // create P2002s and rolls back the reschedule. (Gemini critical + CodeRabbit
  // major; both bots' literal suggestions were wrong — see PR triage.)
  it("#898: REUSEs a payment-bearing consultation appointment on full-delete (update, not create)", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    // Paid consultation appointment (slots already stripped) reaches full-delete.
    mockTx.appointment.findMany.mockResolvedValue([
      {
        id: "paid-consult-apt",
        slotsOfAppointment: [],
        _count: { payment: 1 },
      },
    ]);
    mockTx.appointment.update.mockResolvedValue({
      id: "paid-consult-apt",
      slotsOfAppointment: [{ id: "reused-slot-1" }, { id: "reused-slot-2" }],
    });

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(true);
    // New slots attach to the SAME appointment (REUSE)...
    expect(mockTx.appointment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "paid-consult-apt" } }),
    );
    // ...and NO second row is created on the @unique consultationId (no P2002).
    expect(mockTx.appointment.create).not.toHaveBeenCalled();
    // The appointment is preserved (slots stripped), never hard-deleted.
    // #1169 PR 1 — held-session slots are excluded from the strip so a
    // MeetingSession (and its Recording) can never be cascade-deleted.
    expect(mockTx.slotOfAppointment.deleteMany).toHaveBeenCalledWith({
      where: {
        appointmentId: "paid-consult-apt",
        meetingSession: { is: null },
      },
    });
    expect(mockTx.appointment.delete).not.toHaveBeenCalledWith({
      where: { id: "paid-consult-apt" },
    });
  });

  // The realistic consultation/webinar reschedule marks slots tentative first,
  // so it re-allocates through the onlyTentative branch — which carries the same
  // 1:1 P2002 hazard (#898 decision A: fix BOTH branches). Webinar also moves
  // its paid attendees to the new slots (notify-only; re-confirm/refund deferred).
  it("#898: REUSEs a payment-bearing webinar appointment on the tentative path and re-links attendees", async () => {
    mockTx.webinar.findUnique.mockResolvedValue(makeWebinarEvent());

    // One webinar appointment, all-tentative slots (a reschedule in flight),
    // carrying multiple attendee payments and two enrolled attendees.
    mockTx.appointment.findMany.mockResolvedValue([
      {
        id: "paid-webinar-apt",
        slotsOfAppointment: [
          {
            id: "ws1",
            isTentative: true,
            user: [
              { id: "consultant-1" },
              { id: "attendee-1" },
              { id: "attendee-2" },
            ],
            startsAt: new Date("2025-01-06T10:00:00Z"),
            endsAt: new Date("2025-01-06T10:30:00Z"),
          },
          {
            id: "ws2",
            isTentative: true,
            user: [
              { id: "consultant-1" },
              { id: "attendee-1" },
              { id: "attendee-2" },
            ],
            startsAt: new Date("2025-01-06T10:30:00Z"),
            endsAt: new Date("2025-01-06T11:00:00Z"),
          },
        ],
        _count: { payment: 3 },
      },
    ]);
    mockTx.appointment.update.mockResolvedValue({
      id: "paid-webinar-apt",
      slotsOfAppointment: [{ id: "reused-ws-1" }, { id: "reused-ws-2" }],
    });
    // B-P1-05 — the onlyTentative branch now deletes via a payment-guarded
    // deleteMany; this appointment carries payments, so the DB would answer
    // count 0 (refused) and the appointment is kept for REUSE.
    mockTx.appointment.deleteMany.mockResolvedValue({ count: 0 });

    const result = await SlotAllocationService.allocate({
      eventType: "webinar",
      eventId: "webinar-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(true);
    // REUSE the one appointment (no P2002 on the @unique webinarId).
    expect(mockTx.appointment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "paid-webinar-apt" } }),
    );
    expect(mockTx.appointment.create).not.toHaveBeenCalled();
    // Both paid attendees are re-linked to the new slots; the consultant is not
    // re-added (already connected).
    for (const slotId of ["reused-ws-1", "reused-ws-2"]) {
      const call = mockTx.slotOfAppointment.update.mock.calls.find(
        (c: any[]) => c[0]?.where?.id === slotId,
      );
      expect(call).toBeDefined();
      const connectedIds = (call![0].data.user.connect as { id: string }[]).map(
        (u) => u.id,
      );
      expect(connectedIds).toEqual(
        expect.arrayContaining(["attendee-1", "attendee-2"]),
      );
      expect(connectedIds).not.toContain("consultant-1");
    }
  });

  // #898 decision C: preservePastSlots must not hard-delete a payment-bearing
  // appointment either. A sibling past session makes isInProgressReallocation
  // true, routing the zero-slot paid placeholder through this branch; without
  // the guard its unconditional delete would trip the same Payment→
  // ConsultantEarnings FK rollback as B8.
  it("#898: preservePastSlots preserves a payment-bearing placeholder (defense-in-depth)", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscriptionEvent({
        schedulingPeriodEndsAt: new Date("2025-01-17T00:00:00Z"), // 2 weeks → 4 slots
      }),
    );

    // A sibling appointment with a completed (past) session → in-progress
    // reallocation; plus the paid zero-slot placeholder that must survive.
    mockTx.appointment.findMany.mockResolvedValue([
      {
        id: "past-session-apt",
        slotsOfAppointment: [
          {
            id: "past-1",
            isTentative: false,
            user: [{ id: "consultant-1" }, { id: "consultee-1" }],
            startsAt: new Date("2024-12-30T10:00:00Z"),
            endsAt: new Date("2024-12-30T10:30:00Z"),
          },
          {
            id: "past-2",
            isTentative: false,
            user: [{ id: "consultant-1" }, { id: "consultee-1" }],
            startsAt: new Date("2024-12-30T10:30:00Z"),
            endsAt: new Date("2024-12-30T11:00:00Z"),
          },
        ],
        _count: { payment: 0 },
      },
      {
        id: "paid-placeholder",
        slotsOfAppointment: [],
        _count: { payment: 1 },
      },
    ]);

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: ["2025-01-13T10:00:00Z", "2025-01-13T10:30:00Z"],
    });

    expect(result.success).toBe(true);
    // The paid placeholder reaches preservePastSlots with no slots left, but the
    // guard keeps it (an unconditional delete would FK-rollback the tx).
    expect(mockTx.appointment.delete).not.toHaveBeenCalledWith({
      where: { id: "paid-placeholder" },
    });
    // The past session is preserved too (its past slots remain).
    expect(mockTx.appointment.delete).not.toHaveBeenCalledWith({
      where: { id: "past-session-apt" },
    });
  });
});

// ─── Partial reschedule slot count (bug #2) ──────────────────────────────────
// A reschedule's expected slot count must be the number of SESSIONS being
// rescheduled (tentative appointments × slotsPerCall), NOT the full session
// total. Commit 2b6be4c1 used calculateRequiredSlots (the full total), which
// wrongly rejected partial reschedules (e.g. 2 of 10 sessions).
describe("partial reschedule slot count", () => {
  // 0.5h subscription (slotsPerCall = 1) with 10 total sessions; only 2 of its
  // appointments carry tentative slots → a partial reschedule of 2 sessions.
  const partialReschedSub = () =>
    makeSubscriptionEvent({
      subscriptionPlan: {
        consultantProfileId: "consultant-profile-1",
        durationInMonths: 1,
        sessionsPerWeek: 2,
        sessionDurationInHours: 0.5,
        totalSessions: 10,
        consultantProfile: makeConsultantProfile(),
      },
    });
  const twoTentativeAppointments = [
    {
      id: "resched-1",
      slotsOfAppointment: [
        {
          id: "ts1",
          isTentative: true,
          startsAt: new Date(),
          endsAt: new Date(),
        },
      ],
      _count: { payment: 0 },
    },
    {
      id: "resched-2",
      slotsOfAppointment: [
        {
          id: "ts2",
          isTentative: true,
          startsAt: new Date(),
          endsAt: new Date(),
        },
      ],
      _count: { payment: 0 },
    },
  ];

  it("expects the rescheduled-session count (2), not the full total (10)", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(partialReschedSub());
    mockTx.appointment.findMany.mockResolvedValue(twoTentativeAppointments);

    // Provide the WRONG count (3). The error must reference the PARTIAL expected
    // count (2), proving it no longer demands the full session total (10).
    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: [
        "2025-01-06T09:00:00Z",
        "2025-01-06T09:30:00Z",
        "2025-01-06T10:00:00Z",
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("requires exactly 2 slots");
    expect(result.error).not.toContain("exactly 10");
  });

  it("accepts exactly the rescheduled-session count for a partial reschedule", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(partialReschedSub());
    mockTx.appointment.findMany.mockResolvedValue(twoTentativeAppointments);

    // Provide the correct partial count (2) → no longer rejected.
    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: ["2025-01-06T09:00:00Z", "2025-01-06T09:30:00Z"],
    });

    expect(result.success).toBe(true);
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("should handle 0.5-hour consultation (single slot)", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        consultationPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInHours: 0.5,
          consultantProfile: makeConsultantProfile(),
        },
      }),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z"],
    });

    expect(result.success).toBe(true);
    const slotsCreated =
      mockTx.appointment.create.mock.calls[0][0].data.slotsOfAppointment.create;
    expect(slotsCreated).toHaveLength(1);
  });

  it("should handle 2-hour webinar (4 slots)", async () => {
    mockTx.webinar.findUnique.mockResolvedValue(
      makeWebinarEvent({
        webinarPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInHours: 2,
          consultantProfile: makeConsultantProfile(),
        },
      }),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "webinar",
      eventId: "webinar-1",
      mode: "manual",
      slots: [
        "2025-01-06T10:00:00Z",
        "2025-01-06T10:30:00Z",
        "2025-01-06T11:00:00Z",
        "2025-01-06T11:30:00Z",
      ],
    });

    expect(result.success).toBe(true);
    expect(mockTx.appointment.create).toHaveBeenCalledTimes(1);
    expect(
      mockTx.appointment.create.mock.calls[0][0].data.slotsOfAppointment.create,
    ).toHaveLength(4);
  });

  it("should handle class with sessionsPerWeek mapping to sessionsPerWeek", async () => {
    mockTx.class.findUnique.mockResolvedValue(makeClassEvent());

    const result = await SlotAllocationService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(true);
    const createCall = mockTx.appointment.create.mock.calls[0][0];
    expect(createCall.data.appointmentType).toBe(AppointmentsType.CLASS);
    expect(createCall.data.class).toEqual({ connect: { id: "class-1" } });
  });

  it("should handle custom schedule consultant", async () => {
    const customConsultant = makeConsultantProfile({
      scheduleType: ScheduleType.CUSTOM,
      slotsOfAvailabilityWeekly: [],
      slotsOfAvailabilityCustom: [
        makeCustomAvailabilitySlot(
          "2025-01-06T10:00:00.000Z",
          "2025-01-06T12:00:00.000Z",
        ),
      ],
    });

    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        consultationPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInHours: 1,
          consultantProfile: customConsultant,
        },
      }),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
  });

  it("should pass the correct event type through the entire flow", async () => {
    // Test each event type routes to the correct Prisma model
    for (const eventType of [
      "consultation",
      "subscription",
      "webinar",
      "class",
    ] as const) {
      const freshTx = makeMockTx();
      (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
        cb(freshTx),
      );

      const eventFactories = {
        consultation: makeConsultationEvent,
        subscription: makeSubscriptionEvent,
        webinar: makeWebinarEvent,
        class: makeClassEvent,
      };

      // #908 — fetchEventData reads the BASE client (out of txn); writes go to
      // freshTx. Set the read on base prisma and assert the write on freshTx.
      (prisma as any)[eventType].findUnique.mockResolvedValue(
        eventFactories[eventType](),
      );

      const slots = ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"];

      await SlotAllocationService.allocate({
        eventType,
        eventId: `${eventType}-1`,
        mode: "manual",
        slots,
      });

      // Correct model was queried (read runs on the base client now)
      expect((prisma as any)[eventType].findUnique).toHaveBeenCalled();
      // Correct model was updated — ALL four types now go through
      // WHERE-guarded CAS transitions (updateMany): #836 for
      // consultation/subscription, EVENT_ALLOWED_FROM for webinar/class.
      expect(freshTx[eventType].updateMany).toHaveBeenCalled();
    }
  });
});

// ─── Manual allocation distributed lock (TEST-2) ────────────────────────────

describe("Manual allocation - distributed lock", () => {
  it("should acquire and release consultant-level lock for manual allocation", async () => {
    const {
      lockAutoAllocate,
      unlockAutoAllocate,
    } = require("../../utils/appointmentlock");

    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    // Lock should have been acquired with the consultant profile ID,
    // day-sharded (#860) by the earliest target slot's day.
    expect(lockAutoAllocate).toHaveBeenCalledWith(
      "consultant-profile-1",
      "2025-01-06",
    );
    // Lock should have been released in finally block
    expect(unlockAutoAllocate).toHaveBeenCalled();
  });

  /**
   * #1319 — the day shard is narrower than the weekly cap it has to hold. Two
   * manual allocations on different days of one week took different keys and
   * each cleared sessionsPerWeek on a stale count; #440's GiST constraint sees
   * overlap, never a count. Every weekly-capped type takes the wide key.
   */
  it("takes the consultant-wide lock when a weekly cap applies", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(makeSubscriptionEvent());

    await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(mockLockAutoAllocate).toHaveBeenCalledWith(
      "consultant-profile-1",
      undefined,
    );
  });

  it("should release lock even when transaction fails", async () => {
    const {
      lockAutoAllocate,
      unlockAutoAllocate,
    } = require("../../utils/appointmentlock");

    // Make the transaction throw
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(
      new Error("DB connection lost"),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(false);
    // Lock should still be released even after error
    expect(unlockAutoAllocate).toHaveBeenCalled();
  });

  it("should return 409 when lock acquisition fails", async () => {
    const { lockAutoAllocate } = require("../../utils/appointmentlock");

    // Simulate lock contention
    lockAutoAllocate.mockRejectedValueOnce(
      new Error("Lock acquisition failed: resource is locked"),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    expect(result.errorCode).toBe("LOCK_CONTENTION");
  });

  // #898 follow-up — the consultee-scoped lock serializes the consultee-conflict
  // check → write so one person can't be booked across two consultants at once.
  it("#898: acquires + releases the consultee lock around the allocation", async () => {
    const {
      lockConsulteeBooking,
      unlockConsulteeBooking,
    } = require("../../utils/appointmentlock");

    // #908 — pre-fetch + fetchEventData share one base-client read now; one
    // full event carries both consultantProfileId and requestedBy.user.id.
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({ requestedBy: { user: { id: "consultee-9" } } }),
    );

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(lockConsulteeBooking).toHaveBeenCalledWith("consultee-9");
    expect(unlockConsulteeBooking).toHaveBeenCalled();
  });

  it("#898: fails closed when the consultee lock can't be acquired", async () => {
    const {
      lockConsulteeBooking,
      unlockAutoAllocate,
    } = require("../../utils/appointmentlock");

    (prisma.consultation.findUnique as jest.Mock).mockResolvedValue({
      consultationPlan: { consultantProfileId: "consultant-profile-1" },
      requestedBy: { user: { id: "consultee-9" } },
    });
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    lockConsulteeBooking.mockRejectedValueOnce(
      new Error(
        "Lock contention: Another booking is in progress for this account.",
      ),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    // Fails closed (no booking on contention) and still releases the consultant
    // lock acquired before it.
    expect(result.success).toBe(false);
    expect(unlockAutoAllocate).toHaveBeenCalled();
  });
});

// ─── Auto allocation with IST timezone (TEST-1 integration) ─────────────────

describe("Auto allocation - timezone day shift", () => {
  it("should find slots for IST consultant with Monday availability", async () => {
    // IST consultant (UTC+5:30) with Monday 09:00-17:00 local
    // = UTC Monday 03:30-11:30
    // startTimeUtc = 210 (03:30), endTimeUtc = 690 (11:30)
    // utcOffsetMinutes = 330
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        consultationPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInHours: 1,
          consultantProfile: makeConsultantProfile({
            user: { id: "consultant-1", timezone: "Asia/Kolkata" },
            slotsOfAvailabilityWeekly: [
              makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 3, 11, 330),
            ],
          }),
        },
      }),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
    expect(mockTx.appointment.create).toHaveBeenCalledTimes(1);

    // Verify the created slots are on a Monday in UTC
    const createCall = mockTx.appointment.create.mock.calls[0][0];
    const firstSlot = createCall.data.slotsOfAppointment.create[0];
    const slotDate = new Date(firstSlot.startsAt);
    expect(slotDate.getUTCDay()).toBe(1); // Monday
    expect(slotDate.getUTCHours()).toBeGreaterThanOrEqual(3);
    expect(slotDate.getUTCHours()).toBeLessThan(11);
  });
});

// ── Allocation-resilience: cause-specific error codes ────────────────────────

describe("allocation resilience — error codes", () => {
  it("PERIOD_ENDED when scheduling period is in the past", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscriptionEvent({
        subscriptionPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInMonths: 1,
          sessionsPerWeek: 1,
          sessionDurationInHours: 1,
          consultantProfile: makeConsultantProfile({
            slotsOfAvailabilityWeekly: [
              makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 9, 10),
            ],
          }),
        },
        // Period ended before "now" (2025-01-01)
        schedulingPeriodStartsAt: new Date("2024-01-01T00:00:00Z"),
        schedulingPeriodEndsAt: new Date("2024-02-01T00:00:00Z"),
        appointments: [],
      }),
    );
    mockTx.appointment.findMany.mockResolvedValue([]);

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "auto",
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("PERIOD_ENDED");
    expect(result.error).toContain("scheduling period ended");
  });

  it("SLOT_SHORTAGE when period is future but availability falls short", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscriptionEvent({
        subscriptionPlan: {
          consultantProfileId: "consultant-profile-1",
          durationInMonths: 1,
          sessionsPerWeek: 3, // needs 3/week but only 1 hour/week available
          sessionDurationInHours: 1,
          totalSessions: 6,
          consultantProfile: makeConsultantProfile({
            slotsOfAvailabilityWeekly: [
              makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 9, 10), // only 1h/wk
            ],
          }),
        },
        schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00Z"),
        schedulingPeriodEndsAt: new Date("2025-01-27T00:00:00Z"),
        appointments: [],
      }),
    );
    mockTx.appointment.findMany.mockResolvedValue([]);

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "auto",
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("SLOT_SHORTAGE");
    expect(result.error).toContain("Could only find");
  });
});

// ─── #1206 — partial allocation ─────────────────────────────────────────────

describe("#1206 partial allocation", () => {
  // A plan sold 6 sessions; the consultant published one hour a week inside a
  // three-week period. The whole plan cannot fit, some of it can.
  const shortOnAvailability = () =>
    makeSubscriptionEvent({
      subscriptionPlan: {
        consultantProfileId: "consultant-profile-1",
        durationInMonths: 1,
        sessionsPerWeek: 3,
        sessionDurationInHours: 1,
        totalSessions: 6,
        consultantProfile: makeConsultantProfile({
          slotsOfAvailabilityWeekly: [
            makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 9, 10),
          ],
        }),
      },
      schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00Z"),
      schedulingPeriodEndsAt: new Date("2025-01-27T00:00:00Z"),
      appointments: [],
    });

  beforeEach(() => {
    mockTx.subscription.findUnique.mockResolvedValue(shortOnAvailability());
    mockTx.appointment.findMany.mockResolvedValue([]);
  });

  it("refuses by default and reports how many sessions WOULD fit", async () => {
    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "auto",
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("SLOT_SHORTAGE");
    expect(result.requiredSessions).toBe(6);
    // The offer the consultant is shown; > 0 or there is nothing to offer.
    expect(result.placeableSessions).toBeGreaterThan(0);
    expect(result.placeableSessions).toBeLessThan(6);
    expect(mockTx.appointment.create).not.toHaveBeenCalled();
  });

  it("places exactly the advertised count when the consultant allows it", async () => {
    const refusal = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "auto",
    });
    mockTx.appointment.create.mockClear();

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "auto",
      allowPartial: true,
    });

    expect(result.success).toBe(true);
    expect(result.partial).toBe(true);
    // LOAD-BEARING: the confirm dialog promises the number the refusal named.
    expect(result.placedSessions).toBe(refusal.placeableSessions);
    expect(result.requiredSessions).toBe(6);
    expect(result.unplacedSessions).toBe(6 - (result.placedSessions ?? 0));
    // One Appointment per placed session — the rest stay unallocated.
    expect(mockTx.appointment.create).toHaveBeenCalledTimes(
      result.placedSessions ?? 0,
    );
  });

  it("is ignored for a single-session consultation", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
      allowPartial: true,
    });

    expect(result.success).toBe(true);
    expect(result.partial).toBeUndefined();
  });
});
