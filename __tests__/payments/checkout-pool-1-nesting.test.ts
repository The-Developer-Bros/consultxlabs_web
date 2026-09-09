/**
 * @jest-environment node
 */

/**
 * #1421 — checkout must never issue a query on the global Prisma client while
 * one of its own interactive transactions is open.
 *
 * Netlify runs this app with a pg pool of `PG_POOL_MAX=1` and a 3 s connect
 * timeout. An interactive `$transaction` checks out that single connection and
 * holds it until it commits, so any query sent to the global client in the
 * meantime queues for a connection that only the blocked transaction can
 * release. The request cannot make progress and pg gives up with "timeout
 * exceeded when trying to connect", which is exactly how every consultation
 * checkout failed on the deploy preview while sibling read routes on the same
 * deploy answered normally.
 *
 * `validateSlotAvailability` is the site that fired: it is called from inside
 * three separate transactions on the plain Razorpay consultation path, and its
 * DPDP consent gate used to read on the global client. The mock below models
 * the pool faithfully — a global-client call raised while a transaction is
 * open throws the same pg error the preview logged — so this test fails
 * against the unfixed code and passes once the gate reads through `tx`.
 */

import type { CheckoutInput } from "@/schemas/checkout";

let mockTxDepth = 0;
const mockGlobalTouches: string[] = [];

const mockTxClient = {
  consentArtifact: {
    findFirst: jest.fn(async () => ({ id: "consent-artifact-1" })),
  },
  slotOfAppointment: {
    findFirst: jest.fn(async () => null),
  },
  // #1463 — the self-hold lookup is a fourth read on this helper's path, and
  // it must ride the transaction client like every other one.
  appointment: {
    findMany: jest.fn(async (): Promise<never[]> => []),
  },
};

jest.mock("../../lib/prisma", () => {
  // Any model reached on the global client answers through this proxy, so the
  // test does not have to enumerate the models a future call site might touch.
  const globalModel = (model: string) =>
    new Proxy(
      {},
      {
        get: (_target, operation: string) => async (): Promise<null> => {
          mockGlobalTouches.push(`${model}.${operation}`);
          if (mockTxDepth > 0) {
            throw new Error("timeout exceeded when trying to connect");
          }
          return null;
        },
      },
    );

  const client: Record<string, unknown> = {
    $transaction: async (fn: (tx: unknown) => unknown) => {
      mockTxDepth += 1;
      try {
        return await fn(mockTxClient);
      } finally {
        mockTxDepth -= 1;
      }
    },
  };

  return {
    __esModule: true,
    default: new Proxy(client, {
      get: (target, prop: string) =>
        prop in target ? target[prop] : globalModel(prop),
    }),
  };
});

// Boundary mocks. `lib/payments/operations/checkout` transitively imports the
// auth stack through the payouts barrel, which is ESM-only and cannot be
// required under this Jest transform; the gateway and the Redis lock helpers
// are infrastructure this suite never exercises. Note that
// `lib/compliance/dpdp` is deliberately NOT mocked — its real body is the code
// under test.
jest.mock("../../lib/payments/payouts", () => ({
  __esModule: true,
  createEarningsFromPayment: jest.fn(),
}));

jest.mock("../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(),
  cancelPaymentIntent: jest.fn(),
}));

jest.mock("../../utils/appointmentlock", () => ({
  __esModule: true,
  CHECKOUT_WAIT_RETRY_CONFIG: { retryCount: 5 },
  CHECKOUT_LOCK_TTL_MS: {},
  EventFullError: class extends Error {},
  lockSlotBooking: jest.fn(),
  unlockSlotBooking: jest.fn(),
  lockEventCheckout: jest.fn(),
  unlockEventCheckout: jest.fn(),
  lockConsulteeBooking: jest.fn(),
  unlockConsulteeBooking: jest.fn(),
  extendLock: jest.fn(),
  extendSlotInterval: jest.fn(),
}));

import prisma, { type Tx } from "../../lib/prisma";
import { validateSlotAvailability } from "../../lib/payments/operations/checkout";

const HOUR_MS = 60 * 60 * 1000;

function slotInput(): CheckoutInput {
  const startsAt = new Date(Date.now() + 48 * HOUR_MS);
  const endsAt = new Date(startsAt.getTime() + HOUR_MS);
  return {
    appointmentType: "CONSULTATION",
    planId: "plan-1",
    paymentGateway: "RAZORPAY",
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  } as unknown as CheckoutInput;
}

/** The shape every real caller uses: the helper runs inside an open tx. */
function validateInsideTransaction(): Promise<{
  selfHoldAppointmentIds: string[];
}> {
  return prisma.$transaction(async (tx) =>
    validateSlotAvailability(
      tx as unknown as Tx,
      slotInput(),
      "consultee-user",
      "expert-user",
    ),
  );
}

describe("#1421 checkout does not starve the single-connection pool", () => {
  beforeEach(() => {
    mockTxDepth = 0;
    mockGlobalTouches.length = 0;
    mockTxClient.consentArtifact.findFirst.mockResolvedValue({
      id: "consent-artifact-1",
    });
  });

  it("runs the consent gate on the transaction client, not the global one", async () => {
    await expect(validateInsideTransaction()).resolves.toEqual({
      selfHoldAppointmentIds: [],
    });

    expect(mockTxClient.consentArtifact.findFirst).toHaveBeenCalledTimes(1);
    expect(mockGlobalTouches).toEqual([]);
  });

  it("still blocks a consultant who withdrew session-delivery consent", async () => {
    mockTxClient.consentArtifact.findFirst.mockResolvedValue(
      null as unknown as { id: string },
    );

    await expect(validateInsideTransaction()).rejects.toThrow(
      /withdrawn session-delivery consent/,
    );
    expect(mockGlobalTouches).toEqual([]);
  });
});
