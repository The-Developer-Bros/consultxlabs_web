/**
 * @jest-environment node
 */

/**
 * #1446 — Phase 2 of `handlePaymentSuccess` runs in `after()`, on a warm
 * instance whose single Prisma connection (PG_POOL_MAX=1) is shared with the
 * next inbound request. A Novu trigger that hangs used to hold that instance
 * for 39 s while the chat-channel step waited for the connection and died at
 * the 3 s connect timeout.
 *
 * Both steps are now bounded, and the notifications are awaited before the
 * channel step begins. This pins the two properties that follow from that: a
 * hanging channel step cannot outlive its deadline (and leaves the stamp NULL,
 * which is the reconcile sweep's queue), and hanging Novu triggers cannot
 * delay the channel step past theirs.
 */

const withSerializableRetry = jest.fn(async (fn: () => unknown) => fn());
jest.mock("../../lib/db/serializable-retry", () => ({
  __esModule: true,
  withSerializableRetry: (fn: () => unknown) => withSerializableRetry(fn),
}));

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const CONSULTANT_USER = "consultant-user-1";
const CONSULTEE_USER = "user-1";
const START = new Date("2026-10-01T09:00:00.000Z");
const END = new Date("2026-10-01T10:00:00.000Z");

const consultationCreate = jest.fn();
const webhookAppointmentCreate = jest.fn();
const webhookTx = {
  payment: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  consultation: {
    create: consultationCreate,
    updateMany: jest.fn(),
    findUnique: jest.fn(),
  },
  appointment: {
    create: webhookAppointmentCreate,
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  slotOfAppointment: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
  },
  appointmentParticipant: {
    createMany: jest.fn().mockResolvedValue({ count: 2 }),
    updateMany: jest.fn().mockResolvedValue({ count: 2 }),
  },
};

const baseAppointmentFindUnique = jest.fn();
const baseSlotFindFirst = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(webhookTx),
    // Phase 2's email + earnings reads: null keeps both steps out of the way,
    // so the only work left in flight is the pair this file is about.
    payment: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    appointment: {
      findUnique: (...a: unknown[]) => baseAppointmentFindUnique(...a),
    },
    slotOfAppointment: {
      findFirst: (...a: unknown[]) => baseSlotFindFirst(...a),
    },
    class: {
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    webinar: {
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));

jest.mock("../../lib/payments/operations/refund", () => ({
  __esModule: true,
  refundPayment: jest.fn().mockResolvedValue({ id: "rfnd" }),
}));
jest.mock("../../lib/payments/payouts", () => ({
  __esModule: true,
  createEarningsFromPayment: jest.fn(),
  reverseEarningsForPayment: jest.fn(),
}));
jest.mock("../../lib/email", () => ({
  __esModule: true,
  sendPaymentSuccessEmail: jest.fn(),
  sendPaymentFailedEmail: jest.fn(),
}));

const notifyPaymentSuccess = jest.fn();
const notifyAppointmentBooked = jest.fn();
jest.mock("../../lib/novu", () => ({
  __esModule: true,
  notifyPaymentSuccess: (...a: unknown[]) => notifyPaymentSuccess(...a),
  notifyPaymentFailed: jest.fn(),
  notifyAppointmentBooked: (...a: unknown[]) => notifyAppointmentBooked(...a),
}));
jest.mock("../../lib/referrals/service", () => ({
  __esModule: true,
  processQualifyingAction: jest.fn(),
  processConsultantBookingReferral: jest.fn(),
}));

const ensureChannelsForAppointment = jest.fn();
jest.mock("../../lib/payments/webhooks/ensure-channels", () => ({
  __esModule: true,
  ensureChannelsForAppointment: (...a: unknown[]) =>
    ensureChannelsForAppointment(...a),
}));

const streamWarn = jest.fn();
jest.mock("../../lib/stream-logger", () => ({
  __esModule: true,
  streamLogger: {
    info: jest.fn(),
    warn: (...a: unknown[]) => streamWarn(...a),
    error: jest.fn(),
  },
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemError: () => Promise.resolve(),
}));
jest.mock("../../schemas/webhooks/metadata", () => ({
  __esModule: true,
  normalizeLegacySlotKeys: (m: unknown) => m,
  validateWebhookMetadata: jest.fn(),
}));
jest.mock("../../lib/events/capacity", () => ({
  __esModule: true,
  getWebinarCapacity: jest.fn(),
  getClassCapacity: jest.fn(),
}));

import { handlePaymentSuccess } from "../../lib/payments/webhooks/handlers";
import { validateWebhookMetadata } from "../../schemas/webhooks/metadata";

const PLAN_TITLE = "Career Strategy Deep Dive";

const METADATA = {
  appointmentType: "CONSULTATION",
  userId: CONSULTEE_USER,
  planId: "plan-1",
  startsAt: START.toISOString(),
  endsAt: END.toISOString(),
};

/** A promise that never settles — the 39 s call, without the wait. */
function hangs(): Promise<never> {
  return new Promise<never>(() => {});
}

function primePhase1() {
  webhookTx.payment.update.mockResolvedValue({});
  webhookTx.payment.updateMany.mockResolvedValue({ count: 1 });
  webhookTx.appointment.update.mockResolvedValue({});
  webhookTx.consultation.updateMany.mockResolvedValue({ count: 1 });
  webhookTx.consultation.findUnique.mockResolvedValue({
    id: "cons-1",
    status: "PENDING",
  });
  webhookTx.slotOfAppointment.findMany.mockResolvedValue([]);
  webhookTx.slotOfAppointment.findFirst.mockResolvedValue(null);
  webhookTx.slotOfAppointment.updateMany.mockResolvedValue({ count: 2 });
  webhookTx.slotOfAppointment.update.mockResolvedValue({});
  webhookTx.payment.findUnique.mockResolvedValue({
    id: "pay1",
    paymentIntent: "order1",
    amount: 10000,
    paymentStatus: "PENDING",
    userId: CONSULTEE_USER,
    currency: "INR",
    appointmentId: null,
    user: {
      id: CONSULTEE_USER,
      email: "b@x.com",
      name: "Buyer",
      consulteeProfile: { id: "consultee-profile-1" },
    },
  });
  consultationCreate.mockResolvedValue({
    id: "cons-1",
    consultationPlan: {
      consultantProfileId: "consultant-profile-1",
      consultantProfile: { userId: CONSULTANT_USER },
    },
  });
  webhookAppointmentCreate.mockResolvedValue({
    id: "appt-1",
    slotsOfAppointment: [{ id: "slot-0" }],
  });
  webhookTx.appointment.findUnique.mockResolvedValue({
    id: "appt-1",
    consultation: { id: "cons-1" },
    subscription: null,
    webinar: null,
    class: null,
    slotsOfAppointment: [],
  });
  // Phase 2's notification read + the session time the template needs.
  baseAppointmentFindUnique.mockResolvedValue({
    organizationId: null,
    organization: null,
    consultation: {
      consultationPlan: {
        title: PLAN_TITLE,
        consultantProfile: { user: { id: CONSULTANT_USER, name: "Dr Who" } },
      },
    },
    subscription: null,
    webinar: null,
    class: null,
  });
  baseSlotFindFirst.mockResolvedValue({ startsAt: START });
  (validateWebhookMetadata as jest.Mock).mockReturnValue(METADATA);
}

/**
 * Drive the handler with fake timers so a deadline can be reached without the
 * suite actually waiting five seconds, then let the trailing microtasks (the
 * fire-and-forget channel IIFE) run.
 */
async function runPastDeadlines() {
  jest.useFakeTimers();
  try {
    const done = handlePaymentSuccess(
      "order1",
      METADATA as unknown as Record<string, string>,
      10000,
    );
    // Well past both 5 s deadlines, twice over.
    await jest.advanceTimersByTimeAsync(30_000);
    await done;
    await jest.advanceTimersByTimeAsync(30_000);
  } finally {
    jest.useRealTimers();
  }
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  primePhase1();
  notifyPaymentSuccess.mockResolvedValue(undefined);
  notifyAppointmentBooked.mockResolvedValue(undefined);
  ensureChannelsForAppointment.mockResolvedValue({ ensured: true });
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("#1484 — the payment-success payload names the plan, not its id", () => {
  it("both notification payloads carry the plan's title and never the planId", async () => {
    await handlePaymentSuccess(
      "order1",
      METADATA as unknown as Record<string, string>,
      10000,
    );

    for (const trigger of [notifyPaymentSuccess, notifyAppointmentBooked]) {
      expect(trigger).toHaveBeenCalledTimes(1);
      const payload = trigger.mock.calls[0][1] as { planTitle: string };
      expect(payload.planTitle).toBe(PLAN_TITLE);
      // The regression itself: `metadata.planId` won the `||`, so the buyer's
      // confirmation named a UUID.
      expect(payload.planTitle).not.toBe(METADATA.planId);
    }
  });

  it("falls back to a humanised appointment type, not an id, when the plan is unreadable", async () => {
    baseAppointmentFindUnique.mockResolvedValue(null);

    await handlePaymentSuccess(
      "order1",
      METADATA as unknown as Record<string, string>,
      10000,
    );

    // Both triggers read the same `resolvedPlanTitle`, and the primed slot
    // means the booked ping is not skipped — so the fallback has to hold on
    // both payloads, not just the first.
    for (const trigger of [notifyPaymentSuccess, notifyAppointmentBooked]) {
      const payload = trigger.mock.calls[0][1] as { planTitle: string };
      expect(payload.planTitle).toBe("Consultation");
      expect(payload.planTitle).not.toBe(METADATA.planId);
    }
  });
});

describe("#1446 — Phase 2 outbound steps are bounded", () => {
  it("a channel step that never resolves does not hold the handler, and leaves the stamp NULL", async () => {
    ensureChannelsForAppointment.mockReturnValue(hangs());

    await runPastDeadlines();

    expect(ensureChannelsForAppointment).toHaveBeenCalledWith("appt-1");
    // The stamp is written inside the step, at its very end, so a step that
    // never returns cannot have written it: `chatChannelEnsuredAt` stays NULL
    // and the appointment stays in the reconcile sweep's queue. What the
    // handler owes is the warning that says so, and its own return.
    expect(streamWarn).toHaveBeenCalledWith(
      expect.stringContaining("deadline"),
      expect.objectContaining({ appointmentId: "appt-1" }),
    );
  });

  it("Novu triggers that hang do not delay the channel step past their deadline", async () => {
    notifyPaymentSuccess.mockReturnValue(hangs());
    notifyAppointmentBooked.mockReturnValue(hangs());

    await runPastDeadlines();

    // The whole point of #1446: the channel step still ran. Before the fix the
    // triggers were unawaited and overlapped it; now they are awaited, and
    // their deadline is what lets the step start at all.
    expect(notifyPaymentSuccess).toHaveBeenCalled();
    expect(ensureChannelsForAppointment).toHaveBeenCalledWith("appt-1");
    // Awaited, so the step could only have started because the deadline fired.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("novu-trigger"),
    );
  });
});
