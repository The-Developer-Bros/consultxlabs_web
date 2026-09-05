/**
 * @jest-environment node
 */

/**
 * #1319 — the number the cancel dialog quotes and the number the cancel pays.
 *
 * The preview route exists for exactly one reason: to tell somebody, before
 * they click, what cancelling will return to them. That promise is only worth
 * something if the two agree, and until now nothing checked that they did.
 * Both sides computed the same four steps — notice tier, snapshot policy,
 * per-session proration, clamp to the refundable balance — inline, in two
 * files, with two sets of comments explaining the same reasoning. Two copies of
 * a money rule drift; that is what copies do.
 *
 * `quoteBookingRefund` is now the single implementation and both routes call
 * it, but a shared function is only half the guarantee: each route still feeds
 * it, and each route could feed it differently. So this suite drives the real
 * GET and the real POST over one prisma stub and compares the quote the buyer
 * read against the amount `refundBookingPayment` was actually asked for, across
 * a matrix of snapshot tiers, notice windows, paid amounts and prior partial
 * refunds.
 *
 * The stub models the ordering the database imposes, borrowed from
 * `cancel-route-refund.test.ts`: live slots before the cancel transaction
 * commits, CANCELLED afterwards. The preview therefore has to run first, which
 * is also the only order a real buyer can produce.
 */

const mockAppointmentFindUnique = jest.fn();
const mockAppointmentFindMany = jest.fn();
const mockPaymentFindMany = jest.fn();
const mockPaymentFindFirst = jest.fn();
const mockRefundBookingPayment = jest.fn();
const mockGetSession = jest.fn();

/** Flipped by the $transaction stub, mirroring the slot terminalisation. */
let txCommitted = false;

const txStub = {
  // The CAS helpers read the from-status just before the compare-and-set, so
  // every booking model answers a findUnique as well as the updateMany.
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
  // #1322 — the participant edge is terminalised and the status history
  // appended inside the same cancel transaction.
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
      txCommitted = true;
      return out;
    },
    appointment: {
      findUnique: (...a: unknown[]) => mockAppointmentFindUnique(...a),
      findMany: (...a: unknown[]) => mockAppointmentFindMany(...a),
    },
    payment: {
      findMany: (...a: unknown[]) => mockPaymentFindMany(...a),
      findFirst: (...a: unknown[]) => mockPaymentFindFirst(...a),
    },
    dispute: { findFirst: jest.fn().mockResolvedValue(null) },
    membership: { findUnique: jest.fn().mockResolvedValue(null) },
  },
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}));

// #1328 put a per-user limiter on the cancel route. This suite cancels the
// same booking as the same user once per case, which is a rate the limiter is
// right to refuse and this suite is not testing.
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
}));

jest.mock("../../lib/payments/operations/booking-refund", () => ({
  // Only the charge is stubbed. `fundingRailForIntent` stays real, because the
  // rail the preview names is part of what this suite is comparing and a
  // stubbed derivation would only ever agree with itself.
  ...jest.requireActual("../../lib/payments/operations/booking-refund"),
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
  recordSystemError: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/activity/log-activity", () => ({
  logConsultationCancelled: jest.fn().mockResolvedValue(undefined),
  logSubscriptionCancelled: jest.fn().mockResolvedValue(undefined),
}));

import { POST as cancelHandler } from "@/app/api/appointments/[appointmentId]/cancel/route";
import { GET as previewHandler } from "@/app/api/appointments/[appointmentId]/cancel/preview/route";
import type { CancellationPolicySnapshot } from "@/lib/payments/operations/cancellation-policy";

const HOUR = 3_600_000;
const APPT = "appt-1";
const CONSULTANT_USER = "consultant-1";
const CONSULTEE_USER = "consultee-1";
const CONSULTANT_PROFILE = "cp-1";
const CONSULTEE_PROFILE = "ce-1";

/**
 * Both routes read the appointment through their own select, so the stub
 * answers a superset: `requestedBy` carries both the preview's `userId` and the
 * cancel route's nested `user.id`, and likewise for the consultant profile.
 */
function appointmentRow(kind: "consultation" | "subscription") {
  const consultantProfile = {
    userId: CONSULTANT_USER,
    user: { id: CONSULTANT_USER, name: "Dr Who" },
  };
  const requestedBy = {
    userId: CONSULTEE_USER,
    user: { id: CONSULTEE_USER, name: "Ada" },
  };
  const base = {
    id: APPT,
    organizationId: null,
    webinarId: null,
    classId: null,
    webinar: null,
    class: null,
    slotsOfAppointment: [{ startsAt: new Date(Date.now() + 120 * HOUR) }],
  };

  if (kind === "subscription") {
    return {
      ...base,
      appointmentType: "SUBSCRIPTION",
      consultationId: null,
      subscriptionId: "sub-1",
      consultation: null,
      subscription: {
        id: "sub-1",
        requestedById: CONSULTEE_PROFILE,
        requestedBy,
        subscriptionPlan: {
          title: "Monthly plan",
          consultantProfileId: CONSULTANT_PROFILE,
          consultantProfile,
        },
      },
    };
  }

  return {
    ...base,
    appointmentType: "CONSULTATION",
    consultationId: "cons-1",
    subscriptionId: null,
    subscription: null,
    consultation: {
      id: "cons-1",
      requestedById: CONSULTEE_PROFILE,
      requestedBy,
      consultationPlan: {
        title: "Strategy call",
        consultantProfileId: CONSULTANT_PROFILE,
        consultantProfile,
      },
    },
  };
}

type Case = {
  name: string;
  kind: "consultation" | "subscription";
  snapshot: CancellationPolicySnapshot | null;
  /** Hours until each undelivered session. */
  liveSlotHours: number[];
  /** Hours (negative = past) of each already-delivered session. */
  completedSlotHours?: number[];
  grossPaise: number;
  priorRefundPaise?: number;
  actor: "consultee" | "consultant";
};

/** The booking as the database answers it, before and after the cancel tx. */
function bookingRows(c: Case) {
  const live = c.liveSlotHours.map((h) => ({
    startsAt: new Date(Date.now() + h * HOUR),
    completionStatus: txCommitted ? "CANCELLED" : "SCHEDULED",
  }));
  const done = (c.completedSlotHours ?? []).map((h) => ({
    startsAt: new Date(Date.now() + h * HOUR),
    completionStatus: "COMPLETED",
  }));
  return [
    {
      id: APPT,
      cancellationPolicySnapshot: c.snapshot,
      payment: [
        {
          id: "pay-1",
          amount: c.grossPaise,
          paymentIntent: "pi_gateway_1",
          refunds: c.priorRefundPaise
            ? [{ amountPaise: c.priorRefundPaise, status: "SUCCEEDED" }]
            : [],
          disputes: [],
        },
      ],
      slotsOfAppointment: [...done, ...live],
    },
  ];
}

function sessionAs(role: "consultee" | "consultant") {
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

function makeParams(id: string) {
  return { params: Promise.resolve({ appointmentId: id }) };
}

/** The tiers a platform-default booking is quoted against. */
const DEFAULT_SNAPSHOT: CancellationPolicySnapshot = {
  version: 1,
  source: "PLATFORM_DEFAULT",
  tiers: [
    { hoursBefore: 24, refundPct: 100 },
    { hoursBefore: 2, refundPct: 50 },
    { hoursBefore: 0, refundPct: 0 },
  ],
  consultantInitiatedPct: 100,
};

/** A stricter org-shaped snapshot: nothing is ever fully refundable. */
const STRICT_SNAPSHOT: CancellationPolicySnapshot = {
  version: 1,
  source: "ORG_DEFAULT",
  tiers: [
    { hoursBefore: 72, refundPct: 80 },
    { hoursBefore: 24, refundPct: 40 },
    { hoursBefore: 0, refundPct: 10 },
  ],
  consultantInitiatedPct: 100,
  orgPolicyText: "Acme cancellation terms",
};

/** A two-step snapshot whose thresholds are deliberately out of order. */
const UNSORTED_SNAPSHOT: CancellationPolicySnapshot = {
  version: 1,
  source: "ORG_DEFAULT",
  tiers: [
    { hoursBefore: 1, refundPct: 25 },
    { hoursBefore: 48, refundPct: 90 },
  ],
  consultantInitiatedPct: 100,
};

const CASES: Case[] = [
  {
    name: "platform default, five days out, whole price",
    kind: "consultation",
    snapshot: DEFAULT_SNAPSHOT,
    liveSlotHours: [120],
    grossPaise: 500_000,
    actor: "consultee",
  },
  {
    name: "platform default, six hours out, mid tier",
    kind: "consultation",
    snapshot: DEFAULT_SNAPSHOT,
    liveSlotHours: [6],
    grossPaise: 500_000,
    actor: "consultee",
  },
  {
    name: "platform default, inside the final two hours",
    kind: "consultation",
    snapshot: DEFAULT_SNAPSHOT,
    liveSlotHours: [1],
    grossPaise: 500_000,
    actor: "consultee",
  },
  {
    name: "no snapshot at all falls back to the platform tiers",
    kind: "consultation",
    snapshot: null,
    liveSlotHours: [6],
    grossPaise: 500_000,
    actor: "consultee",
  },
  {
    name: "consultant-initiated inside the zero tier still refunds in full",
    kind: "consultation",
    snapshot: DEFAULT_SNAPSHOT,
    liveSlotHours: [1],
    grossPaise: 500_000,
    actor: "consultant",
  },
  {
    name: "strict org tiers, four days out",
    kind: "consultation",
    snapshot: STRICT_SNAPSHOT,
    liveSlotHours: [96],
    grossPaise: 333_333,
    actor: "consultee",
  },
  {
    name: "strict org tiers, thirty hours out",
    kind: "consultation",
    snapshot: STRICT_SNAPSHOT,
    liveSlotHours: [30],
    grossPaise: 333_333,
    actor: "consultee",
  },
  {
    name: "strict org tiers, inside the day, never fully unrefundable",
    kind: "consultation",
    snapshot: STRICT_SNAPSHOT,
    liveSlotHours: [3],
    grossPaise: 333_333,
    actor: "consultee",
  },
  {
    name: "unsorted tiers resolve to the highest threshold cleared",
    kind: "consultation",
    snapshot: UNSORTED_SNAPSHOT,
    liveSlotHours: [50],
    grossPaise: 250_000,
    actor: "consultee",
  },
  {
    name: "a prior partial refund clamps the remainder",
    kind: "consultation",
    snapshot: DEFAULT_SNAPSHOT,
    liveSlotHours: [120],
    grossPaise: 500_000,
    priorRefundPaise: 200_000,
    actor: "consultee",
  },
  {
    name: "a prior partial refund below the tiered amount is untouched",
    kind: "consultation",
    snapshot: DEFAULT_SNAPSHOT,
    liveSlotHours: [6],
    grossPaise: 500_000,
    priorRefundPaise: 100_000,
    actor: "consultee",
  },
  {
    name: "a subscription half consumed prorates the base",
    kind: "subscription",
    snapshot: DEFAULT_SNAPSHOT,
    liveSlotHours: [120, 300, 480],
    completedSlotHours: [-200, -100, -50],
    grossPaise: 900_000,
    actor: "consultee",
  },
  {
    name: "a subscription prorating to an indivisible base rounds down",
    kind: "subscription",
    snapshot: STRICT_SNAPSHOT,
    liveSlotHours: [96, 200],
    completedSlotHours: [-10],
    grossPaise: 100_001,
    actor: "consultee",
  },
  {
    name: "a prorated subscription also clamped by a prior refund",
    kind: "subscription",
    snapshot: DEFAULT_SNAPSHOT,
    liveSlotHours: [120, 300],
    completedSlotHours: [-40, -20],
    grossPaise: 800_000,
    priorRefundPaise: 350_000,
    actor: "consultee",
  },
  {
    name: "a subscription with every session still owed refunds the whole price",
    kind: "subscription",
    snapshot: DEFAULT_SNAPSHOT,
    liveSlotHours: [120, 300, 480, 600],
    grossPaise: 640_000,
    actor: "consultee",
  },
];

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
  mockPaymentFindFirst.mockResolvedValue({
    currency: "INR",
    paymentIntent: "pi_gateway_1",
  });
  mockRefundBookingPayment.mockImplementation(
    async ({ amountPaise }: { amountPaise: number }) => ({
      refundId: "r1",
      amountRefundedPaise: amountPaise,
      rail: "GATEWAY",
    }),
  );
});

/** Quote it, then cancel it, in that order — the only order a buyer can make. */
async function quoteThenCancel(c: Case) {
  mockGetSession.mockResolvedValue(sessionAs(c.actor));
  mockAppointmentFindUnique.mockResolvedValue(appointmentRow(c.kind));
  mockAppointmentFindMany.mockImplementation(async () => bookingRows(c));

  const previewRes = await previewHandler(
    new Request(`http://localhost/api/appointments/${APPT}/cancel/preview`),
    makeParams(APPT),
  );
  const preview = await previewRes.json();

  const cancelRes = await cancelHandler(
    new Request(`http://localhost/api/appointments/${APPT}/cancel`, {
      method: "POST",
    }) as never,
    makeParams(APPT),
  );
  const cancelled = await cancelRes.json();

  return { previewRes, preview, cancelRes, cancelled };
}

describe("the cancel preview quotes what the cancel actually pays", () => {
  it.each(CASES)("$name", async (c) => {
    const { previewRes, preview, cancelRes, cancelled } =
      await quoteThenCancel(c);

    expect(previewRes.status).toBe(200);
    expect(cancelRes.status).toBe(200);

    // The tier the buyer was shown is the tier they were charged.
    expect(preview.refundPct).toBe(cancelled.refund.refundPct);

    // And the number, which is the whole point.
    expect(preview.estimatedRefundPaise).toBe(
      cancelled.refund.amountRefundedPaise,
    );

    // A zero quote is a promise too: nothing is paid and nothing is attempted.
    // Reading the calls off the mock rather than branching keeps this one
    // assertion for both outcomes.
    expect(
      mockRefundBookingPayment.mock.calls.map(([arg]) => ({
        paymentId: (arg as { paymentId: string }).paymentId,
        amountPaise: (arg as { amountPaise: number }).amountPaise,
      })),
    ).toEqual(
      preview.estimatedRefundPaise > 0
        ? [{ paymentId: "pay-1", amountPaise: preview.estimatedRefundPaise }]
        : [],
    );

    // The route's own three-way: paid, or one of the two different zeros.
    expect(cancelled.refund.status).toBe(
      preview.estimatedRefundPaise > 0
        ? "REFUNDED"
        : preview.refundPct > 0
          ? "NOTHING_REFUNDABLE"
          : "POLICY_ZERO",
    );
  });
});

describe("the quote's own numbers hold up", () => {
  it("prorates a half-consumed subscription and says so", async () => {
    const c = CASES.find((x) => x.name.startsWith("a subscription half"))!;
    const { preview } = await quoteThenCancel(c);

    // Three of six sessions still owed, 100% tier: ₹9,000 × 3/6.
    expect(preview.prorated).toBe(true);
    expect(preview.refundPct).toBe(100);
    expect(preview.estimatedRefundPaise).toBe(450_000);
  });

  it("does not call a fully undelivered subscription prorated", async () => {
    const c = CASES.find((x) =>
      x.name.startsWith("a subscription with every"),
    )!;
    const { preview } = await quoteThenCancel(c);

    expect(preview.prorated).toBe(false);
    expect(preview.estimatedRefundPaise).toBe(640_000);
  });

  it("clamps to the balance left after an earlier partial refund", async () => {
    const c = CASES.find((x) => x.name.startsWith("a prior partial"))!;
    const { preview } = await quoteThenCancel(c);

    // 100% of ₹5,000 is ₹5,000, but ₹2,000 has already gone back.
    expect(preview.refundPct).toBe(100);
    expect(preview.estimatedRefundPaise).toBe(300_000);
  });

  it("reads a booking with no session ever scheduled as full notice", async () => {
    const c: Case = {
      name: "never scheduled",
      kind: "subscription",
      snapshot: DEFAULT_SNAPSHOT,
      liveSlotHours: [],
      grossPaise: 500_000,
      actor: "consultee",
    };
    const { preview, cancelled } = await quoteThenCancel(c);

    // No slot ever existed, so the buyer has infinite notice — not the "already
    // started" floor — and both sides must agree on that reading.
    expect(preview.refundPct).toBe(100);
    expect(preview.estimatedRefundPaise).toBe(500_000);
    expect(cancelled.refund.amountRefundedPaise).toBe(500_000);
  });
});
