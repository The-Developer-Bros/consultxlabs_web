/**
 * @jest-environment node
 */

/**
 * The class crud-with-plan arms must answer 409 for a slot overlap and 400 for
 * a frozen schedule — not 500.
 *
 * The webinar arms have mapped 23P01 (`slot_no_confirmed_overlap`) to a 409
 * since #784, but the class arms fell through to the generic catch, so a
 * consultant who double-booked themselves got "An error occurred" and a Sentry
 * page. The class POST was also the last crud-with-plan transaction still
 * running at Read Committed, which is what let the overlapping write reach the
 * constraint at all.
 */

const mockTx = {
  classPlan: { create: jest.fn(), update: jest.fn() },
  class: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  classContent: { deleteMany: jest.fn() },
  appointment: { findMany: jest.fn().mockResolvedValue([]) },
  payment: { count: jest.fn().mockResolvedValue(0) },
  collaborator: { findMany: jest.fn().mockResolvedValue([]) },
  slotOfAppointment: { findFirst: jest.fn().mockResolvedValue(null) },
};

const transaction = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (...args: unknown[]) => transaction(...args),
    consultantProfile: { findFirst: jest.fn() },
    classPlan: { findUnique: jest.fn() },
    class: { findUnique: jest.fn() },
    payment: { count: jest.fn() },
  },
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

jest.mock("../../lib/verification", () => ({
  __esModule: true,
  checkConsultantVerification: jest
    .fn()
    .mockResolvedValue({ isVerified: true, status: "VERIFIED" }),
}));

// schemas/plans pulls `bad-words` (ESM-only) in through utils/contentValidation
// at import time; the profanity/gibberish refinements are not what this test
// pins, so boundary-mock them rather than transform node_modules.
jest.mock("../../utils/contentValidation", () => ({
  __esModule: true,
  hasDuplicates: () => false,
  containsGibberish: () => false,
  containsProfanity: () => false,
  isProfanityFree: () => true,
  isMeaningfulText: () => true,
  validateSensibleContent: () => true,
  cleanProfanity: (text: string) => text,
}));

jest.mock("../../lib/topics", () => ({
  __esModule: true,
  findOrCreateTopics: jest.fn().mockResolvedValue(["topic-1"]),
  transformNestedPlanTopics: jest.fn((row: unknown) => row),
}));

import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { POST, PATCH } from "@/app/api/bookings/classes/crud-with-plan/route";

const base = prisma as unknown as Record<string, Record<string, jest.Mock>>;

/** Prisma's unmodelled-constraint shape: no `.code`, SQLSTATE in the message. */
function exclusionViolation(): Error {
  return new Error(
    'ERROR: conflicting key value violates exclusion constraint "slot_no_confirmed_overlap" (23P01)',
  );
}

const VALID_POST_BODY = {
  consultantProfileId: "cp-1",
  title: "Advanced Pottery",
  description: "A long enough description to satisfy the plan schema rules.",
  durationInMonths: 1,
  price: 5000,
  priceCurrency: "INR",
  maxParticipants: 10,
  language: "English",
  level: "BEGINNER",
  sessionsPerWeek: 1,
  sessionDurationInHours: 1,
  topics: ["pottery"],
  learningOutcomes: ["Throw a bowl"],
  startDate: "2026-03-02T10:00:00.000Z",
  classContents: [
    { title: "Week one", description: "Wedging clay", hoursAllotted: 1 },
  ],
};

function request(body: unknown) {
  return {
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTx.payment.count.mockReset().mockResolvedValue(0);
  mockTx.collaborator.findMany.mockReset().mockResolvedValue([]);
  mockTx.appointment.findMany.mockReset().mockResolvedValue([]);
  transaction.mockReset();
  transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback(mockTx),
  );
  base.consultantProfile.findFirst.mockResolvedValue({
    id: "cp-1",
    userId: "user-1",
    user: { timezone: "Asia/Kolkata" },
  });
  mockTx.classPlan.create.mockResolvedValue({
    id: "plan-1",
    title: "Advanced Pottery",
    topics: [],
    classContents: [],
    consultantProfile: { id: "cp-1" },
    faqs: [],
  });
});

describe("#784 — class POST maps an overlap to 409", () => {
  it("returns 409 when the session write trips slot_no_confirmed_overlap", async () => {
    mockTx.class.create.mockRejectedValue(exclusionViolation());

    const response = await POST(request(VALID_POST_BODY));

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.error).toMatch(/conflicts with another confirmed session/i);
  });

  it("runs the create transaction at Serializable", async () => {
    mockTx.class.create.mockResolvedValue({
      id: "class-1",
      classPlan: { topics: [], classContents: [] },
      appointments: [],
    });

    await POST(request(VALID_POST_BODY));

    expect(transaction).toHaveBeenCalled();
    const options = transaction.mock.calls[0][1];
    expect(options.isolationLevel).toBe("Serializable");
  });

  it("retries the transaction on a P2034 serialization abort", async () => {
    const abort = new Prisma.PrismaClientKnownRequestError("write conflict", {
      code: "P2034",
      clientVersion: "7.7.0",
    });
    transaction
      .mockRejectedValueOnce(abort)
      .mockImplementation(async (callback: (tx: unknown) => unknown) =>
        callback(mockTx),
      );
    mockTx.class.create.mockResolvedValue({
      id: "class-1",
      classPlan: { topics: [], classContents: [] },
      appointments: [],
    });

    const response = await POST(request(VALID_POST_BODY));

    expect(response.status).toBe(201);
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});

describe("#627/#784 — class PATCH maps its two rejections", () => {
  const patchBody = {
    id: "plan-1",
    classId: "class-1",
    startDate: "2026-04-06T10:00:00.000Z",
  };

  beforeEach(() => {
    base.classPlan.findUnique.mockResolvedValue({
      id: "plan-1",
      consultantProfile: { id: "cp-1", userId: "user-1" },
      topics: [],
      classContents: [],
      classes: [],
      sessionsPerWeek: 1,
      durationInMonths: 1,
      sessionDurationInHours: 1,
    });
    base.class.findUnique.mockResolvedValue({
      id: "class-1",
      schedulingPeriodStartsAt: new Date("2026-03-02T10:00:00.000Z"),
      schedulingPeriodEndsAt: new Date("2026-04-02T10:00:00.000Z"),
    });
    mockTx.classPlan.update.mockResolvedValue({
      id: "plan-1",
      topics: [],
      classContents: [],
      classes: [],
      consultantProfile: { id: "cp-1", userId: "user-1" },
    });
    mockTx.class.findUnique.mockResolvedValue({
      id: "class-1",
      schedulingPeriodStartsAt: new Date("2026-03-02T10:00:00.000Z"),
      schedulingPeriodEndsAt: new Date("2026-04-02T10:00:00.000Z"),
    });
    mockTx.class.update.mockResolvedValue({
      id: "class-1",
      classPlan: { topics: [], classContents: [] },
      appointments: [],
    });
  });

  it("returns 400 when a paid class's scheduling period is moved", async () => {
    // The payment count is now read INSIDE the transaction (#627).
    mockTx.payment.count.mockResolvedValue(1);

    const response = await PATCH(request(patchBody));

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toMatch(/reschedule workflow/i);
    // The move never reached the class row.
    expect(mockTx.class.update).not.toHaveBeenCalled();
  });

  it("returns 409 when the update trips slot_no_confirmed_overlap", async () => {
    mockTx.class.update.mockRejectedValue(exclusionViolation());

    const response = await PATCH(request(patchBody));

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.error).toMatch(/conflicts with another confirmed session/i);
  });
});
