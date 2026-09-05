/**
 * @jest-environment node
 */

/**
 * The cancel route must actually refund. There was no test that it did.
 *
 * Both existing cancel-route suites stub `appointment.findMany -> []`, which
 * makes the payment lookup come back empty and kills the entire refund block —
 * so every check on those suites was compatible with the refund path being
 * dead. It was: resolving the booking context AFTER the cancel transaction
 * meant the transaction had already stamped every SCHEDULED/RESCHEDULED slot
 * CANCELLED, the "next undelivered session" came back empty, and every
 * consultee-initiated cancellation silently fell to the 0% tier.
 *
 * The prisma stub here models that ordering honestly: `appointment.findMany`
 * answers with live slots before `$transaction` runs and with CANCELLED slots
 * afterwards, exactly as the database would. A resolver called on the wrong
 * side of the transaction therefore scores 0% and these tests fail.
 */

const mockAppointmentFindUnique = jest.fn();
const mockAppointmentFindMany = jest.fn();
const mockPaymentFindMany = jest.fn();
const mockRefundBookingPayment = jest.fn();
const mockRecordSystemError = jest.fn();
const mockGetSession = jest.fn();
const mockMembershipFindUnique = jest.fn();

/** Flipped by the $transaction stub, mirroring the slot terminalisation. */
let txCommitted = false;

const txStub = {
  consultation: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
  },
  subscription: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
  },
  webinar: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
  },
  class: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
  },
  appointmentParticipant: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  // transitionSlotCompletion reads the from-status, then moves the cohort with
  // updateManyAndReturn so each moved id gets its own history row.
  slotOfAppointment: {
    findMany: jest.fn().mockResolvedValue([]),
    updateManyAndReturn: jest
      .fn()
      .mockResolvedValue([{ id: "slot-1" }, { id: "slot-2" }]),
  },
  // The cancel route reads the open proposals, then CASes each by id.
  rescheduleRequest: {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue({ status: "PENDING_REVIEW" }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) => {
      const out = await fn(txStub);
      // The cancel transaction terminalises every live slot. Anything reading
      // "which session is still owed" after this point sees nothing.
      txCommitted = true;
      return out;
    },
    appointment: {
      findUnique: (...a: unknown[]) => mockAppointmentFindUnique(...a),
      findMany: (...a: unknown[]) => mockAppointmentFindMany(...a),
    },
    payment: { findMany: (...a: unknown[]) => mockPaymentFindMany(...a) },
    dispute: { findFirst: jest.fn().mockResolvedValue(null) },
    // #1166 — what `isOrgAdminOfAppointment` reads.
    membership: {
      findUnique: (...a: unknown[]) => mockMembershipFindUnique(...a),
    },
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
  getSession: (...a: unknown[]) => mockGetSession(...a),
}));

jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => mockRefundBookingPayment(...a),
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

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => mockRecordSystemError(...a),
}));

jest.mock("../../lib/activity/log-activity", () => ({
  logConsultationCancelled: jest.fn().mockResolvedValue(undefined),
  logSubscriptionCancelled: jest.fn().mockResolvedValue(undefined),
}));

import { POST as cancelHandler } from "@/app/api/appointments/[appointmentId]/cancel/route";

const HOUR = 3_600_000;
const APPT = "appt-1";
const CONSULTANT_USER = "consultant-1";
const CONSULTEE_USER = "consultee-1";
const CONSULTANT_PROFILE = "cp-1";
const CONSULTEE_PROFILE = "ce-1";

/** ₹5,000. */
const GROSS = 500_000;

function makeParams(id: string) {
  return { params: Promise.resolve({ appointmentId: id }) };
}

function makeRequest(body?: Record<string, unknown>) {
  return new Request(`http://localhost/api/appointments/${APPT}/cancel`, {
    method: "POST",
    ...(body
      ? {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }
      : {}),
  }) as never;
}

function consultationAppointment() {
  return {
    id: APPT,
    appointmentType: "CONSULTATION",
    organizationId: null,
    consultationId: "cons-1",
    subscriptionId: null,
    cancellationPolicySnapshot: null,
    slotsOfAppointment: [{ startsAt: new Date(Date.now() + 120 * HOUR) }],
    consultation: {
      id: "cons-1",
      requestedById: CONSULTEE_PROFILE,
      consultationPlan: {
        title: "Strategy call",
        consultantProfileId: CONSULTANT_PROFILE,
        consultantProfile: { user: { id: CONSULTANT_USER, name: "Dr Who" } },
      },
      requestedBy: { user: { id: CONSULTEE_USER, name: "Ada" } },
    },
    subscription: null,
    webinar: null,
    class: null,
  };
}

function subscriptionAppointment() {
  return {
    ...consultationAppointment(),
    appointmentType: "SUBSCRIPTION",
    consultationId: null,
    subscriptionId: "sub-1",
    consultation: null,
    subscription: {
      id: "sub-1",
      requestedById: CONSULTEE_PROFILE,
      subscriptionPlan: {
        title: "Monthly plan",
        consultantProfileId: CONSULTANT_PROFILE,
        consultantProfile: { user: { id: CONSULTANT_USER, name: "Dr Who" } },
      },
      requestedBy: { user: { id: CONSULTEE_USER, name: "Ada" } },
    },
  };
}

/**
 * The booking as the database would answer it: live slots until the cancel
 * transaction commits, terminalised afterwards.
 */
function bookingRows(opts: {
  liveSlotHours?: number[];
  completedSlotHours?: number[];
  /** Sessions terminalised BEFORE this cancellation — a session the plan held. */
  cancelledSlotHours?: number[];
  /** Past sessions with no MeetingSession row (offline, most likely held). */
  unverifiedSlotHours?: number[];
  paymentRefunds?: { amountPaise: number; status: string }[];
  noPayment?: boolean;
  /** Defaults to a gateway-funded payment. */
  paymentAmount?: number;
  paymentIntent?: string;
}) {
  const live = (opts.liveSlotHours ?? []).map((h) => ({
    startsAt: new Date(Date.now() + h * HOUR),
    completionStatus: txCommitted ? "CANCELLED" : "SCHEDULED",
  }));
  const done = (opts.completedSlotHours ?? []).map((h) => ({
    startsAt: new Date(Date.now() + h * HOUR),
    completionStatus: "COMPLETED",
  }));
  const gone = (opts.cancelledSlotHours ?? []).map((h) => ({
    startsAt: new Date(Date.now() + h * HOUR),
    completionStatus: "CANCELLED",
  }));
  const unverified = (opts.unverifiedSlotHours ?? []).map((h) => ({
    startsAt: new Date(Date.now() + h * HOUR),
    completionStatus: "UNVERIFIED",
  }));
  return [
    {
      id: APPT,
      cancellationPolicySnapshot: null,
      payment: opts.noPayment
        ? []
        : [
            {
              id: "pay-1",
              amount: opts.paymentAmount ?? GROSS,
              paymentIntent: opts.paymentIntent ?? "pi_gateway_1",
              refunds: opts.paymentRefunds ?? [],
              disputes: [],
            },
          ],
      slotsOfAppointment: [...done, ...gone, ...unverified, ...live],
    },
  ];
}

function sessionAs(role: "consultant" | "consultee" | "admin") {
  if (role === "admin") {
    return {
      user: {
        id: "admin-1",
        name: "Ops",
        role: "ADMIN",
        consultantProfileId: null,
        consulteeProfileId: null,
      },
    };
  }
  return {
    user:
      role === "consultant"
        ? {
            id: CONSULTANT_USER,
            name: "Dr Who",
            consultantProfileId: CONSULTANT_PROFILE,
            consulteeProfileId: null,
          }
        : {
            id: CONSULTEE_USER,
            name: "Ada",
            consultantProfileId: null,
            consulteeProfileId: CONSULTEE_PROFILE,
          },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  txCommitted = false;
  txStub.consultation.updateMany.mockResolvedValue({ count: 1 });
  txStub.subscription.updateMany.mockResolvedValue({ count: 1 });
  txStub.slotOfAppointment.findMany.mockResolvedValue([]);
  txStub.slotOfAppointment.updateManyAndReturn.mockResolvedValue([
    { id: "slot-1" },
    { id: "slot-2" },
  ]);
  txStub.rescheduleRequest.findMany.mockResolvedValue([]);
  mockPaymentFindMany.mockResolvedValue([]);
  mockMembershipFindUnique.mockResolvedValue(null);
  mockRecordSystemError.mockResolvedValue(undefined);
  mockRefundBookingPayment.mockImplementation(
    async ({ amountPaise }: { amountPaise: number }) => ({
      refundId: "r1",
      amountRefundedPaise: amountPaise,
      rail: "GATEWAY",
    }),
  );
});

describe("a consultee cancelling a paid consultation gets their money back", () => {
  it("refunds the full amount five days out", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(res.status).toBe(200);
    // The regression: resolved after the transaction this was 0. The rail
    // rides along so the confirmation can name where the money went rather
    // than promising a card nobody charged (defect 1).
    expect(body.refund).toEqual({
      amountRefundedPaise: GROSS,
      refundPct: 100,
      status: "REFUNDED",
      rail: "GATEWAY",
    });
    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-1", amountPaise: GROSS }),
    );
  });

  it("applies the mid-tier inside the day", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [6] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund.refundPct).toBe(50);
    expect(body.refund.amountRefundedPaise).toBe(GROSS / 2);
  });

  it("refunds nothing inside the final two hours", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [1] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund).toEqual({
      amountRefundedPaise: 0,
      refundPct: 0,
      status: "POLICY_ZERO",
    });
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("clamps to what is still refundable after an earlier partial refund", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({
        liveSlotHours: [120],
        paymentRefunds: [{ amountPaise: 200_000, status: "SUCCEEDED" }],
      }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // 100% of gross would exceed the balance, the operation would reject the
    // whole request, and the buyer would get nothing instead of the remainder.
    expect(body.refund.amountRefundedPaise).toBe(GROSS - 200_000);
  });
});

describe("a consultant cancelling always refunds in full", () => {
  it("ignores the clock", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultant"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [1] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund.refundPct).toBe(100);
    expect(body.refund.amountRefundedPaise).toBe(GROSS);
  });
});

describe("a platform cancellation is not the buyer's choice", () => {
  it("settles an admin cancellation at the consultant tier", async () => {
    // Requiring the actor to BE the consultant meant an admin cancelling in
    // the final hours settled a buyer who never asked at 0%, while
    // cancel-user-engagements.ts settles the same platform act at 100%.
    mockGetSession.mockResolvedValue(sessionAs("admin"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [1] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund.refundPct).toBe(100);
    expect(body.refund.amountRefundedPaise).toBe(GROSS);
  });
});

describe("subscriptions", () => {
  it("refunds an untouched plan on the next session's tier", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(subscriptionAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [72, 96, 120] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund.amountRefundedPaise).toBe(GROSS);
  });

  it("refunds a paid but never-allocated plan in full", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(subscriptionAppointment());
    mockAppointmentFindMany.mockImplementation(async () => bookingRows({}));

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // No session was ever scheduled, so notice is infinite, not negative.
    // Treating it as negative made cancelling EARLIER score worse than later.
    expect(body.refund.refundPct).toBe(100);
    expect(body.refund.amountRefundedPaise).toBe(GROSS);
  });

  it("prorates a partly-consumed plan to the undelivered share (#1006)", async () => {
    // This case used to escalate to MANUAL_REVIEW and refund ₹0, which killed
    // the remaining sessions while returning nothing. #1006 replaced the
    // escalation with the linear rule: the base is the undelivered share, and
    // the frozen policy tier applies to that base.
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(subscriptionAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ completedSlotHours: [-48], liveSlotHours: [72, 96] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // 1 of 3 delivered, next session 72h out, so the 100% tier applies to
    // two-thirds of the price: floor(500000 × 2/3) = 333333.
    const undeliveredShare = Math.floor((GROSS * 2) / 3);
    expect(body.refund.status).toBe("REFUNDED");
    expect(body.refund.refundPct).toBe(100);
    expect(body.refund.amountRefundedPaise).toBe(undeliveredShare);
    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: undeliveredShare }),
    );
    // The rule is agreed now, so nothing is owed to an ops queue.
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });

  it("measures the undelivered share against the WHOLE plan, not the surviving part", async () => {
    // A session cancelled earlier still belongs to the plan the buyer bought.
    // Summing only completed + live drops it out of the denominator, and the
    // remaining share is then measured against a plan that has shrunk.
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(subscriptionAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({
        completedSlotHours: [-48],
        cancelledSlotHours: [-24],
        liveSlotHours: [72, 96],
      }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // 4 sessions bought, 2 still owed: the 100% tier applies to HALF the price.
    // Against a completed+live denominator of 3 this would pay floor(2/3) —
    // ₹833 more than the plan's per-session price justifies.
    expect(body.refund.amountRefundedPaise).toBe(GROSS / 2);
    expect(body.refund.amountRefundedPaise).not.toBe(
      Math.floor((GROSS * 2) / 3),
    );
  });

  it("counts an unverified past session as delivered, not as owed", async () => {
    // UNVERIFIED is "past, no MeetingSession row" — an offline session that most
    // likely happened. It is neither COMPLETED nor live, so a completed+live
    // denominator made a 30%-consumed plan score 7/7 and refund the whole price.
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(subscriptionAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({
        unverifiedSlotHours: [-72, -48, -24],
        liveSlotHours: [72, 96, 120, 144, 168, 192, 216],
      }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund.refundPct).toBe(100);
    expect(body.refund.amountRefundedPaise).toBe(Math.floor((GROSS * 7) / 10));
    expect(body.refund.amountRefundedPaise).not.toBe(GROSS);
  });
});

describe("#1161 — a credit-funded booking refunds as a credit restoration", () => {
  /** Fully covered by referral credits: zero captured, synthetic intent. */
  const freeFunded = {
    paymentAmount: 0,
    paymentIntent: "free_1730000000000_ab12cd34",
  };

  it("restores in full and reports what came back, not a hardcoded zero", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120], ...freeFunded }),
    );
    mockRefundBookingPayment.mockResolvedValue({
      refundId: "r-internal",
      amountRefundedPaise: 25_000,
      rail: "INTERNAL",
    });

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // The restoration rail is reached at all — the amount floor on the payment
    // lookup used to make this branch dead code.
    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-1" }),
    );
    expect(body.refund.status).toBe("REFUNDED");
    expect(body.refund.amountRefundedPaise).toBe(25_000);
  });

  it("escalates a partial window instead of guessing a partial restoration", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    // Inside the day: a partial tier, which credit restoration has no rule for.
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [12], ...freeFunded }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
    expect(body.refund.status).toBe("MANUAL_REVIEW");
    expect(body.refund.requiresManualReview).toBe(true);
    expect(mockRecordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({ category: "PAYMENT" }),
    );
  });

  it("surfaces a failed restoration rather than reporting it as refunded", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120], ...freeFunded }),
    );
    mockRefundBookingPayment.mockRejectedValue(
      new Error("no refundable balance"),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.refund.status).toBe("FAILED");
    expect(body.refund.requiresManualReview).toBe(true);
  });
});

describe("#1166 — an admin of the funding org acts on the payer side", () => {
  function orgFundedAppointment() {
    return { ...consultationAppointment(), organizationId: "org-1" };
  }

  it("lets an OWNER of the funding org cancel, and tiers them as the buyer", async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: "org-owner-1",
        name: "Org Owner",
        consultantProfileId: null,
        consulteeProfileId: null,
      },
    });
    mockAppointmentFindUnique.mockResolvedValue(orgFundedAppointment());
    mockMembershipFindUnique.mockResolvedValue({
      status: "ACTIVE",
      role: "OWNER",
    });
    // Inside the final two hours: the buyer's own tier pays nothing here, while
    // the consultant tier would pay in full. The org admin must score as the
    // buyer they act for.
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [1] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.refund.refundPct).toBe(0);
    expect(body.refund.amountRefundedPaise).toBe(0);
  });

  it("refuses an EXPERT of the same org", async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: "org-expert-1",
        name: "Org Expert",
        consultantProfileId: null,
        consulteeProfileId: null,
      },
    });
    mockAppointmentFindUnique.mockResolvedValue(orgFundedAppointment());
    mockMembershipFindUnique.mockResolvedValue({
      status: "ACTIVE",
      role: "EXPERT",
    });
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));

    expect(res.status).toBe(403);
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("refuses an invited-but-inactive admin", async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: "org-owner-2",
        name: "Pending Owner",
        consultantProfileId: null,
        consulteeProfileId: null,
      },
    });
    mockAppointmentFindUnique.mockResolvedValue(orgFundedAppointment());
    mockMembershipFindUnique.mockResolvedValue({
      status: "INVITED",
      role: "OWNER",
    });
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));

    expect(res.status).toBe(403);
  });
});

describe("failure modes leave the cancellation standing", () => {
  it("reports a failed refund rather than swallowing it", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );
    mockRefundBookingPayment.mockRejectedValue(new Error("gateway down"));

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // "0 refunded at a 100% tier" is not self-explanatory — the client was
    // left inferring failure from it. The route says so instead.
    expect(body.refund).toEqual({
      amountRefundedPaise: 0,
      refundPct: 100,
      status: "FAILED",
    });
    // A failed refund on an already-cancelled booking is money owed, so it
    // lands on the durable ops surface, not only in Sentry.
    expect(mockRecordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({ category: "PAYMENT" }),
    );
  });

  it("distinguishes an exhausted balance from a failure", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({
        liveSlotHours: [120],
        paymentRefunds: [{ amountPaise: GROSS, status: "SUCCEEDED" }],
      }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // Nothing failed and nobody was paged; the money was already returned.
    expect(body.refund.status).toBe("NOTHING_REFUNDABLE");
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("mints no refund for a free booking", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120], noPayment: true }),
    );

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    expect(body.refund).toBeNull();
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("does not refund when the cancel loses its CAS race", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );
    txStub.consultation.updateMany.mockResolvedValue({ count: 0 });

    const res = await cancelHandler(makeRequest(), makeParams(APPT));

    expect(res.status).toBe(409);
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });
});

/**
 * #1322 A12 — the route wrote its four request statuses, its slots and its
 * open proposal with raw updateMany calls, so a successful cancel left no
 * BookingStatusHistory row at all and the cancelled slots kept
 * `deletedAt: null`, holding the consultant's calendar forever. The pin is on
 * the audit trail rather than on the call shape, because that is what was
 * empty in production.
 */
describe("a cancel leaves an audit trail", () => {
  it("records the request move and every slot it moved, tombstone included", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );
    txStub.consultation.findUnique.mockResolvedValue({ status: "APPROVED" });

    const res = await cancelHandler(
      makeRequest({ reason: "SCHEDULE_CONFLICT" }),
      makeParams(APPT),
    );
    expect(res.status).toBe(200);

    const historyRows = (
      txStub.bookingStatusHistory.create.mock.calls as [
        { data: Record<string, unknown> },
      ][]
    ).map(([args]) => args.data);

    expect(historyRows).toContainEqual(
      expect.objectContaining({
        entity: "CONSULTATION",
        entityId: "cons-1",
        fromStatus: "APPROVED",
        toStatus: "CANCELLED",
        actorUserId: CONSULTEE_USER,
        reason: "SCHEDULE_CONFLICT",
        appointmentId: APPT,
      }),
    );
    // One per slot the CAS actually moved — the ids come from the UPDATE's own
    // RETURNING, so a slot a racing writer pulled out never gets a row.
    expect(historyRows.filter((row) => row.entity === "SLOT")).toHaveLength(2);
    expect(txStub.slotOfAppointment.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { completionStatus: "CANCELLED", deletedAt: expect.any(Date) },
      }),
    );
  });

  it("keeps the 409 contract when the request has already moved", async () => {
    mockGetSession.mockResolvedValue(sessionAs("consultee"));
    mockAppointmentFindUnique.mockResolvedValue(consultationAppointment());
    mockAppointmentFindMany.mockImplementation(async () =>
      bookingRows({ liveSlotHours: [120] }),
    );
    txStub.consultation.updateMany.mockResolvedValue({ count: 0 });

    const res = await cancelHandler(makeRequest(), makeParams(APPT));
    const body = await res.json();

    // The helper throws ILLEGAL_TRANSITION; the client still sees the code it
    // has always keyed its retry copy off.
    expect(res.status).toBe(409);
    expect(body.code).toBe("NOT_CANCELLABLE");
    expect(txStub.bookingStatusHistory.create).not.toHaveBeenCalled();
  });
});
