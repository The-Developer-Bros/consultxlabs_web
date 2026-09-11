/**
 * @jest-environment node
 */

/**
 * #1181 — approval payments carry their appointment.
 *
 * Approval-flow mints used to leave appointmentId null, which made three
 * guards inert (the duplicate-payment walk over appointment.payment, the
 * approval route's own hasPayment check and its PaidWithoutAppointmentError)
 * and sent the capture webhook down the legacy-create path — building a twin
 * Appointment for a one-to-one Consultation. State-based prisma mock (same
 * idiom as cancel-pending-checkout.test.ts): here we pin that
 *
 *  1. the mint threads appointmentId into both the gateway metadata and the
 *     Payment row, exactly like direct checkout;
 *  2. the duplicate-payment guard now MATCHES a PENDING payment already
 *     hanging off the same appointment and REUSES it (same intent, no second
 *     gateway order) instead of minting a parallel one;
 *  3. a SUCCEEDED payment still refuses; an EXPIRED one falls through to a
 *     fresh mint;
 *  4. both approval routes actually pass the appointment through (source
 *     contract, so a revert fails loudly).
 */

import fs from "fs";
import path from "path";
import {
  AppointmentStatus,
  Currency,
  PaymentStatus,
  TrialSessionStatus,
} from "@prisma/client";

const CUID = "clw0000000000000000000000";
const PLAN_CUID = "clw1111111111111111111111";
const APPT_CUID = "clw2222222222222222222222";
const CONS_CUID = "clw3333333333333333333333";

interface State {
  user: Record<string, unknown> | null;
  consultationPlan: Record<string, unknown> | null;
  /** What the duplicate guard's walk over consultation.appointment.payment finds. */
  appointmentPayments: Array<Record<string, unknown>>;
  /** Whether the consultation is still payable, which gates the re-mint. */
  consultationStatus: string;
  /** What findExistingLivePayment's trial arm reads off TrialSession.payment. */
  trialPayment?: Record<string, unknown> | null;
  trialStatus?: string;
}

let state: State;

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(async () => state.user),
    },
    consultationPlan: {
      findUnique: jest.fn(async () => state.consultationPlan),
    },
    consultation: {
      // Hydrates the include shape findExistingLivePayment walks.
      findUnique: jest.fn(async () => ({
        id: CONS_CUID,
        status: state.consultationStatus,
        appointment: { id: APPT_CUID, payment: state.appointmentPayments },
      })),
    },
    payment: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "pay-new",
        ...data,
      })),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => ({ ...where, ...data }),
      ),
    },
    trialSession: {
      // Hydrates the include shape findExistingLivePayment's trial arm walks.
      findUnique: jest.fn(async () => ({
        id: "trial-1",
        status: state.trialStatus,
        payment: state.trialPayment,
      })),
    },
    subscriptionPlan: {
      // Trial pricing reads the parent subscription plan (trialPriceInPaise
      // fallback path in calculateAmount).
      findUnique: jest.fn(async () => ({
        title: "Trial Plan",
        price: 500_000,
        priceCurrency: Currency.INR,
        trialEnabled: true,
        trialPriceInPaise: 250_000,
      })),
    },
  },
}));

const mockCreatePaymentIntent = jest.fn();

jest.mock("../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: (...a: unknown[]) =>
    mockCreatePaymentIntent(...(a as [])),
}));

jest.mock("../../utils/appointmentlock", () => ({
  __esModule: true,
  APPROVAL_LOCK_TTL_MS: 45_000,
  lockApprovalPaymentMint: jest.fn(async () => ({ key: "k", token: "t" })),
  unlockApproval: jest.fn(async () => undefined),
}));
jest.mock("../../lib/redis", () => ({
  __esModule: true,
  acquireLock: jest.fn(async () => "lock-token"),
  releaseLock: jest.fn(async () => undefined),
}));

import prisma from "../../lib/prisma";
import {
  ApprovalWindowLapsedError,
  createApprovalPaymentIntent,
} from "../../lib/payments/operations/approval-payment";

const mockedPaymentCreate = prisma.payment.create as jest.Mock;
const mockedPaymentUpdate = prisma.payment.update as jest.Mock;

function freshState(): State {
  return {
    user: { id: CUID, consulteeProfile: { id: "consultee-1" } },
    consultationPlan: {
      title: "Career Clarity",
      price: 500_000,
      priceCurrency: Currency.INR,
    },
    appointmentPayments: [],
    consultationStatus: AppointmentStatus.APPROVED_PENDING_PAYMENT,
    trialStatus: TrialSessionStatus.AWAITING_PAYMENT,
  };
}

beforeEach(() => {
  state = freshState();
  jest.clearAllMocks();
  mockCreatePaymentIntent.mockResolvedValue({
    id: "order_new",
    client_secret: "order_new",
    amount: 500_000,
    currency: "INR",
    status: "created",
  });
});

function mintParams() {
  return {
    userId: CUID,
    appointmentType: "CONSULTATION" as const,
    consultationId: CONS_CUID,
    planId: PLAN_CUID,
    appointmentId: APPT_CUID,
    paymentGateway: "RAZORPAY" as const,
    startsAt: "2026-09-01T10:00:00.000Z",
    endsAt: "2026-09-01T10:30:00.000Z",
  };
}

describe("approval mint threads appointmentId (#1181)", () => {
  it("sends the real appointment id in the gateway metadata, not the pending sentinel", async () => {
    await createApprovalPaymentIntent(mintParams());

    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
    const intentArg = mockCreatePaymentIntent.mock.calls[0][0];
    expect(intentArg.metadata.appointmentId).toBe(APPT_CUID);
    expect(intentArg.metadata.isApprovalFlow).toBe("true");
  });

  it("stamps appointmentId onto the Payment row", async () => {
    const result = await createApprovalPaymentIntent(mintParams());

    expect(result.paymentIntentId).toBe("order_new");
    const created = mockedPaymentCreate.mock.calls[0][0].data;
    expect(created.appointmentId).toBe(APPT_CUID);
    expect(created.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(created.amount).toBe(500_000);
  });

  it("omits the metadata key entirely when there is no appointment yet", async () => {
    // Defect 17 — the second path still wrote the literal "pending", which the
    // Payment column stopped doing. Gateway notes are string-valued, so an
    // absent key IS that null: a reader can now tell "no appointment yet" from
    // an appointment whose id happens to read like a sentinel.
    const { appointmentId: _dropped, ...withoutAppointment } = mintParams();
    await createApprovalPaymentIntent(withoutAppointment);

    const intentArg = mockCreatePaymentIntent.mock.calls[0][0];
    expect(intentArg.metadata).not.toHaveProperty("appointmentId");
    expect(mockedPaymentCreate.mock.calls[0][0].data.appointmentId).toBeNull();
  });
});

describe("duplicate-payment guard sees approval payments (#1181)", () => {
  it("REUSES a PENDING payment hanging off the same appointment instead of minting a parallel order", async () => {
    state.appointmentPayments = [
      {
        paymentStatus: PaymentStatus.PENDING,
        paymentIntent: "order_existing",
        amount: 500_000,
        currency: Currency.INR,
      },
    ];

    const result = await createApprovalPaymentIntent(mintParams());

    // Same intent handed back — Razorpay's checkout url IS the order id, so
    // this reconstructs the original pay-link without a gateway round-trip.
    expect(result).toEqual({
      paymentIntentId: "order_existing",
      checkoutUrl: "order_existing",
      amount: 500_000,
      currency: Currency.INR,
    });
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(mockedPaymentCreate).not.toHaveBeenCalled();
  });

  it("refuses when the appointment's payment already SUCCEEDED", async () => {
    state.appointmentPayments = [
      {
        paymentStatus: PaymentStatus.SUCCEEDED,
        paymentIntent: "order_paid",
        amount: 500_000,
        currency: Currency.INR,
      },
    ];

    await expect(createApprovalPaymentIntent(mintParams())).rejects.toThrow(
      /already been paid/,
    );
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(mockedPaymentCreate).not.toHaveBeenCalled();
  });

  // #1319 review — an EXPIRED row is re-minted INTO, never duplicated: Payment
  // is unique on [userId, appointmentId], so a second create dies on P2002.
  it("re-mints a dead intent into the same Payment row", async () => {
    state.appointmentPayments = [
      {
        id: "pay-dead",
        paymentStatus: PaymentStatus.EXPIRED,
        paymentIntent: "order_dead",
        amount: 500_000,
        currency: Currency.INR,
        expiresAt: null,
      },
    ];

    const result = await createApprovalPaymentIntent(mintParams());

    expect(result.paymentIntentId).toBe("order_new");
    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
    expect(mockedPaymentCreate).not.toHaveBeenCalled();
    expect(mockedPaymentUpdate).toHaveBeenCalledTimes(1);
    const [{ where, data }] = mockedPaymentUpdate.mock.calls[0];
    expect(where).toEqual({ id: "pay-dead" });
    expect(data.paymentIntent).toBe("order_new");
    expect(data.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("re-mints a PENDING intent that is past its own window", async () => {
    state.appointmentPayments = [
      {
        id: "pay-lapsed",
        paymentStatus: PaymentStatus.PENDING,
        paymentIntent: "order_lapsed",
        amount: 500_000,
        currency: Currency.INR,
        expiresAt: new Date(Date.now() - 60_000),
      },
    ];

    const result = await createApprovalPaymentIntent(mintParams());

    expect(result.paymentIntentId).toBe("order_new");
    expect(mockedPaymentUpdate).toHaveBeenCalledTimes(1);
    expect(mockedPaymentCreate).not.toHaveBeenCalled();
  });

  it("refuses instead of re-minting once the sweep has moved the request on", async () => {
    state.consultationStatus = AppointmentStatus.REJECTED;
    state.appointmentPayments = [
      {
        id: "pay-dead",
        paymentStatus: PaymentStatus.EXPIRED,
        paymentIntent: "order_dead",
        amount: 500_000,
        currency: Currency.INR,
        expiresAt: null,
      },
    ];

    await expect(createApprovalPaymentIntent(mintParams())).rejects.toThrow(
      ApprovalWindowLapsedError,
    );
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(mockedPaymentUpdate).not.toHaveBeenCalled();
    expect(mockedPaymentCreate).not.toHaveBeenCalled();
  });

  // CodeRabbit triage — the trial arm of findExistingLivePayment returned
  // the TrialSession's payment UNFILTERED, so an EXPIRED order would have
  // been handed back as a "reusable" checkout link (a dead intent) instead
  // of minting fresh.
  it("trial arm: an EXPIRED trial payment is re-minted into its own row", async () => {
    state.trialPayment = {
      id: "pay-trial-dead",
      paymentStatus: PaymentStatus.EXPIRED,
      paymentIntent: "order_trial_dead",
      amount: 250_000,
      currency: Currency.INR,
      expiresAt: null,
    };

    await createApprovalPaymentIntent({
      ...mintParams(),
      appointmentType: "TRIAL" as never,
      consultationId: undefined,
      trialId: "trial-1",
    } as never);

    expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
    expect(mockedPaymentCreate).not.toHaveBeenCalled();
    expect(mockedPaymentUpdate.mock.calls[0][0].where).toEqual({
      id: "pay-trial-dead",
    });
  });

  it("trial arm: a PENDING trial payment is reused, not duplicated", async () => {
    state.trialPayment = {
      paymentStatus: PaymentStatus.PENDING,
      paymentIntent: "order_trial_live",
      amount: 250_000,
      currency: Currency.INR,
    };

    const result = await createApprovalPaymentIntent({
      ...mintParams(),
      appointmentType: "TRIAL" as never,
      consultationId: undefined,
      trialId: "trial-1",
    } as never);

    expect(result.paymentIntentId).toBe("order_trial_live");
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(mockedPaymentCreate).not.toHaveBeenCalled();
  });
});

describe("approval routes thread the appointment (source contract)", () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(process.cwd(), rel), "utf8");

  it("the consultation route passes its request-time appointment", () => {
    const src = read(
      "app/api/bookings/consultations/[consultationId]/route.ts",
    );
    const fn = src.slice(src.indexOf("async function generatePaymentLink"));
    expect(fn).toContain("appointmentId: appointment?.id ?? undefined");
  });

  it("the subscription route passes its first request-time appointment", () => {
    const src = read(
      "app/api/bookings/subscriptions/[subscriptionId]/route.ts",
    );
    const fn = src.slice(
      src.indexOf("async function generatePaymentLinkForSubscription"),
    );
    expect(fn).toContain("appointmentId,");
    expect(fn).toContain("subscription.appointments[0]?.id ?? undefined");
  });

  it('the metadata builder no longer carries the "pending" sentinel', () => {
    // Defect 17 — a behavioural assertion above proves the key is absent, but
    // the sentinel could come back as a different literal on the same line and
    // still pass it. Pin the source too so the revert is unmistakable.
    const src = read("lib/payments/operations/approval-payment.ts");
    expect(src).not.toContain('?? "pending"');
    expect(src).not.toContain('|| "pending"');
  });

  it("every approval mint site names appointmentId explicitly", () => {
    // The twin-prone default (leaving it unset) may only survive where no
    // appointment exists yet; the call sites must at least name the param.
    for (const rel of [
      "app/api/bookings/consultations/[consultationId]/route.ts",
      "app/api/bookings/subscriptions/[subscriptionId]/route.ts",
      "app/api/trials/[trialId]/route.ts",
    ]) {
      expect(read(rel)).toMatch(/appointmentId:/);
    }
  });
});
