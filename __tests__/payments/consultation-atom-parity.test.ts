/**
 * @jest-environment node
 */

/**
 * #1319 / #1071 — the two writers that can create a paid consultation must
 * produce the same rows.
 *
 * `handleConsultationCheckout` chunks the session into 30-minute atoms and
 * connects both the consultant and the consultee to each one. The webhook
 * capture fallback (`createConsultation`, reached when a capture arrives with
 * no `appointmentId` on the payment) used to mint ONE row spanning the whole
 * session with only the buyer attached — not an atom run, and invisible to the
 * consultant-scoped conflict filter, so the allocator would double-book on it.
 *
 * Both now call `buildContiguousSlotAtomsForWindow`. This pins that they still
 * agree, for a two-hour booking, on every field a reader depends on.
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
const CONSULTANT_PROFILE = "consultant-profile-1";
const START = new Date("2026-10-01T09:00:00.000Z");
const END = new Date("2026-10-01T11:00:00.000Z"); // exactly two hours

type SlotAtom = {
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  consultantProfileId: string;
  user: { connect: Array<{ id: string }> };
};

// --- webhook-side transaction stub ------------------------------------------
const webhookAppointmentCreate = jest.fn();
const consultationCreate = jest.fn();
const webhookTx = {
  // #1439 — the confirmation stamp is a CAS, so the tx writer is updateMany.
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
  // #1319 A9 — the creators shadow-write participant rows in the same tx.
  appointmentParticipant: {
    createMany: jest.fn().mockResolvedValue({ count: 2 }),
    updateMany: jest.fn().mockResolvedValue({ count: 2 }),
  },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(webhookTx),
    payment: { update: jest.fn().mockResolvedValue({}) },
    appointment: { findUnique: jest.fn().mockResolvedValue(null) },
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
jest.mock("../../lib/novu", () => ({
  __esModule: true,
  notifyPaymentSuccess: jest.fn(),
  notifyPaymentFailed: jest.fn(),
  notifyAppointmentBooked: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  __esModule: true,
  processQualifyingAction: jest.fn(),
  processConsultantBookingReferral: jest.fn(),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  __esModule: true,
  addUserToEventChannel: jest.fn(),
}));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  __esModule: true,
  createDirectMessageChannel: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({
  __esModule: true,
  streamLogger: { info: jest.fn(), error: jest.fn() },
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

// Checkout-side guards that talk to the world rather than to `tx`.
jest.mock("../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../lib/payments/utils/slot-validation", () => ({
  __esModule: true,
  validateSlotTiming: jest.fn().mockReturnValue(null),
}));

import { handlePaymentSuccess } from "../../lib/payments/webhooks/handlers";
import { handleConsultationCheckout } from "../../lib/payments/operations/checkout";
import { validateWebhookMetadata } from "../../schemas/webhooks/metadata";
import type { Tx } from "../../lib/prisma";
import type { CheckoutInput } from "../../schemas/checkout";

const METADATA = {
  appointmentType: "CONSULTATION",
  userId: CONSULTEE_USER,
  planId: "plan-1",
  startsAt: START.toISOString(),
  endsAt: END.toISOString(),
};

/** Materialise the nested `create` payload into rows the caller can read back. */
function materialise(atoms: SlotAtom[]) {
  return atoms.map((atom, i) => ({
    ...atom,
    id: `slot-${i}`,
    appointmentId: "appt-1",
    completionStatus: "SCHEDULED",
    deletedAt: null,
  }));
}

function nestedAtoms(create: jest.Mock): SlotAtom[] {
  const nested = create.mock.calls[0][0].data.slotsOfAppointment.create;
  return Array.isArray(nested) ? nested : [nested];
}

async function runWebhookCreator(): Promise<SlotAtom[]> {
  // `clearMocks` wipes implementations between tests, so every default the
  // webhook transaction needs is (re)installed here rather than at module scope.
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
  webhookTx.slotOfAppointment.updateMany.mockResolvedValue({ count: 4 });
  webhookTx.slotOfAppointment.update.mockResolvedValue({});
  webhookTx.payment.findUnique.mockResolvedValue({
    id: "pay1",
    paymentIntent: "order1",
    amount: 10000,
    paymentStatus: "PENDING",
    userId: CONSULTEE_USER,
    currency: "INR",
    appointmentId: null, // LEGACY shape — no appointment made at checkout
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
      consultantProfileId: CONSULTANT_PROFILE,
      consultantProfile: { userId: CONSULTANT_USER },
    },
  });
  webhookAppointmentCreate.mockImplementation(async (args: unknown) => {
    const data = (
      args as { data: { slotsOfAppointment: { create: SlotAtom[] } } }
    ).data;
    return {
      id: "appt-1",
      slotsOfAppointment: materialise(data.slotsOfAppointment.create),
    };
  });
  webhookTx.appointment.findUnique.mockResolvedValue({
    id: "appt-1",
    consultation: { id: "cons-1" },
    subscription: null,
    webinar: null,
    class: null,
    slotsOfAppointment: [],
  });
  (validateWebhookMetadata as jest.Mock).mockReturnValue(METADATA);

  await handlePaymentSuccess(
    "order1",
    METADATA as unknown as Record<string, string>,
    10000,
  );

  expect(webhookAppointmentCreate).toHaveBeenCalledTimes(1);
  return nestedAtoms(webhookAppointmentCreate);
}

async function runCheckoutCreator(): Promise<SlotAtom[]> {
  const historyCreate = jest.fn().mockResolvedValue({});
  const checkoutAppointmentCreate = jest
    .fn()
    .mockResolvedValue({ id: "appt-2" });
  const tx = {
    consultationPlan: {
      findUnique: jest.fn().mockResolvedValue({
        id: "plan-1",
        price: 10000,
        consultantProfileId: CONSULTANT_PROFILE,
        consultantProfile: {
          userId: CONSULTANT_USER,
          user: { id: CONSULTANT_USER },
        },
      }),
    },
    slotOfAppointment: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
    consultation: { create: jest.fn().mockResolvedValue({ id: "cons-2" }) },
    appointment: { create: checkoutAppointmentCreate },
    appointmentParticipant: {
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    // #1333 — the handler opens the timeline in the same tx as the create.
    bookingStatusHistory: { create: historyCreate },
  } as unknown as Tx;

  await handleConsultationCheckout(
    tx,
    {
      planId: "plan-1",
      startsAt: START.toISOString(),
      endsAt: END.toISOString(),
    } as unknown as CheckoutInput,
    "consultee-profile-1",
    CONSULTEE_USER,
    false,
    null,
    // #1499 — the policy version the caller resolved; this suite only asserts atoms.
    "policy-1",
  );

  expect(checkoutAppointmentCreate).toHaveBeenCalledTimes(1);
  // #1333 — the opening timeline row is written by the handler itself, in the
  // same tx, naming the appointment it just created and the buyer as actor.
  expect(historyCreate).toHaveBeenCalledTimes(1);
  expect(historyCreate.mock.calls[0][0].data).toEqual(
    expect.objectContaining({
      entity: "CONSULTATION",
      entityId: "cons-2",
      fromStatus: "CREATED",
      toStatus: "PENDING",
      appointmentId: "appt-2",
      actorUserId: CONSULTEE_USER,
      organizationId: null,
    }),
  );
  return nestedAtoms(checkoutAppointmentCreate);
}

/** Field-by-field shape assertions shared by both writers. */
function assertTwoHourAtomRun(atoms: SlotAtom[]) {
  atoms.forEach((atom, i) => {
    expect(atom.startsAt.getTime()).toBe(START.getTime() + i * 30 * 60 * 1000);
    expect(atom.endsAt.getTime() - atom.startsAt.getTime()).toBe(
      30 * 60 * 1000,
    );
    expect(atom.consultantProfileId).toBe(CONSULTANT_PROFILE);
    // Both parties, or the consultant-scoped conflict filter cannot see it.
    expect(atom.user.connect.map((u) => u.id).sort()).toEqual(
      [CONSULTANT_USER, CONSULTEE_USER].sort(),
    );
  });
  // Contiguous: every atom starts where the previous one ended.
  for (let i = 1; i < atoms.length; i++) {
    expect(atoms[i].startsAt.getTime()).toBe(atoms[i - 1].endsAt.getTime());
  }
}

describe("#1319 — webhook and checkout consultation writers agree", () => {
  it("the webhook capture fallback writes a four-atom run with both users", async () => {
    const atoms = await runWebhookCreator();
    expect(atoms).toHaveLength(4);
    assertTwoHourAtomRun(atoms);
  });

  it("checkout writes the same four-atom run with both users", async () => {
    const atoms = await runCheckoutCreator();
    expect(atoms).toHaveLength(4);
    assertTwoHourAtomRun(atoms);
  });

  it("the two atom sets are identical apart from the tentative flag", async () => {
    const fromWebhook = await runWebhookCreator();
    const fromCheckout = await runCheckoutCreator();

    // Checkout births tentative and the capture webhook flips it; the fallback
    // only ever runs post-capture, so it births confirmed. Everything else has
    // to match exactly.
    expect(fromWebhook.map((a) => a.isTentative)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(fromCheckout.map((a) => a.isTentative)).toEqual([
      true,
      true,
      true,
      true,
    ]);

    const strip = (atoms: SlotAtom[]) =>
      atoms.map(({ isTentative: _isTentative, ...rest }) => rest);
    expect(strip(fromWebhook)).toEqual(strip(fromCheckout));
  });
});
