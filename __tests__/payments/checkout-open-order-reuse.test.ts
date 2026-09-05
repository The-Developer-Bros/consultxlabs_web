/**
 * @jest-environment node
 */

/**
 * Rec C (bugs/finances/checkout-webhooks-idempotency.md Q2) — a checkout
 * remount or new tab mints a FRESH clientIdempotencyKey, which #828's
 * same-key replay cannot dedupe, so the old flow minted a parallel Razorpay
 * order for the same user+plan (parallel charges). handleCheckout must adopt
 * the open fresh PENDING payment instead of minting.
 *
 * State-based prisma mock (same idiom as cancel-pending-checkout.test.ts):
 * payment.findFirst evaluates the reuse WHERE faithfully against an
 * in-memory store so freshness/scoping actually decide, and the full
 * handleCheckout webinar flow runs under mocked locks/gateway so "no second
 * Razorpay order" is asserted on the real call graph.
 */

let txClient: Record<string, any>;

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(async (fn: any, _opts?: unknown) => fn(txClient)),
    payment: {
      // #1220-triage — the reuse lookup fetches the newest scope-matching
      // candidates; window/amount gates run in-code and rejects get
      // superseded via updateMany.
      findMany: jest.fn(async ({ where }: any) =>
        reuseState.rows.filter((row) => matchesReuseWhere(row, where)),
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    webinar: {
      findUnique: jest.fn(async () => webinarRow()),
    },
  },
}));

jest.mock("../../utils/appointmentlock", () => ({
  __esModule: true,
  LockContentionError: class extends Error {},
  EventCheckoutLockUnavailableError: class extends Error {},
  BookingLockUnavailableError: class extends Error {},
  EventFullError: class extends Error {},
  EventCheckoutBusyError: class extends Error {},
  ConsulteeBookingBusyError: class extends Error {},
  SlotLockError: class extends Error {},
  CHECKOUT_LOCK_TTL_MS: {
    CONSULTATION: 60_000,
    SUBSCRIPTION: 120_000,
    WEBINAR: 120_000,
    CLASS: 600_000,
  },
  CHECKOUT_WAIT_RETRY_CONFIG: { retryCount: 5 },
  lockSlotBooking: jest.fn(async () => []),
  unlockSlotBooking: jest.fn(async () => undefined),
  lockEventCheckout: jest.fn(async () => ({
    key: "event-checkout",
    value: "v",
    ttl: 120000,
    acquiredAt: Date.now(),
    client: {},
  })),
  unlockEventCheckout: jest.fn(async () => undefined),
  lockConsulteeBooking: jest.fn(async () => ({
    key: "consultee-booking",
    value: "v",
    ttl: 150000,
    acquiredAt: Date.now(),
    client: {},
  })),
  unlockConsulteeBooking: jest.fn(async () => undefined),
  extendLock: jest.fn(async () => true),
  extendSlotInterval: jest.fn(async () => true),
}));

jest.mock("../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(),
  cancelPaymentIntent: jest.fn(),
}));
jest.mock("../../lib/profiles/ensure-consultee-profile", () => ({
  __esModule: true,
  ensureConsulteeProfile: jest.fn(),
}));
jest.mock("../../lib/events/capacity", () => ({
  __esModule: true,
  getClassCapacity: jest.fn(() => ({ isFull: false })),
  getWebinarCapacity: jest.fn(() => ({ isFull: false })),
}));
jest.mock("../../lib/payments/tax/tax-engine", () => ({
  __esModule: true,
  determineTax: jest.fn(() => ({ taxAmount: 0 })),
  appointmentTypeToServiceType: jest.fn(() => "WEBINAR"),
}));
jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/currency", () => ({
  __esModule: true,
  getExchangeRates: jest.fn(),
}));
jest.mock("../../lib/scheduling/schedulingTimezone", () => ({
  __esModule: true,
  resolveSchedulingTimezone: jest.fn(() => "Asia/Kolkata"),
}));
jest.mock("../../lib/referrals/service", () => ({
  __esModule: true,
  applyCreditsToPayment: jest.fn(),
  getUserCredits: jest.fn(async () => ({ totalAvailable: 0 })),
  processQualifyingAction: jest.fn(),
  processConsultantBookingReferral: jest.fn(),
}));
jest.mock("../../lib/payments/payouts", () => ({
  __esModule: true,
  createEarningsFromPayment: jest.fn(),
}));
jest.mock("../../lib/api/organizations/wallet", () => ({
  __esModule: true,
  walletDebit: jest.fn(),
}));
jest.mock("../../lib/payments/wallet-freeze", () => ({
  __esModule: true,
  isWalletFrozen: jest.fn(async () => false),
  WalletFrozenError: class extends Error {},
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemError: jest.fn(),
}));
jest.mock("../../lib/api/organizations/program-helpers", () => ({
  __esModule: true,
  recordBookingUtilization: jest.fn(),
  ProgramAssignmentLimitError: class extends Error {},
}));
jest.mock("../../lib/payments/billing/overage-settlement", () => ({
  __esModule: true,
  recordOverageAtCheckout: jest.fn(),
}));
jest.mock("../../lib/enterprise/governance", () => ({
  __esModule: true,
  getInvoiceCreditLimitPaise: jest.fn(() => null),
  assertVerifiedDomainOrThrow: jest.fn(),
}));
jest.mock("../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn(async () => true),
}));
jest.mock("../../lib/feature-flags", () => ({
  __esModule: true,
  ENABLE_DUNNING_SUSPEND: false,
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  __esModule: true,
  notifyOrgProgramExhausted: jest.fn(),
  notifyOrgProgramCapNear: jest.fn(),
}));
// #1499 — checkout now resolves a policy VERSION id rather than freezing Json.
jest.mock("../../lib/payments/operations/cancellation-policy-store", () => ({
  __esModule: true,
  // #1513 review — the platform row is provisioned on the global client just
  // before the booking transaction opens, so the mock has to answer that too.
  ensurePlatformCancellationPolicy: jest.fn(async () => "policy-platform"),
  resolveCheckoutCancellationPolicyId: jest.fn(async () => "policy-1"),
}));

import prisma from "../../lib/prisma";
import { createPaymentIntent } from "../../lib/payments/index";
import {
  unlockConsulteeBooking,
  unlockEventCheckout,
} from "../../utils/appointmentlock";
import { handleCheckout } from "../../lib/payments/operations/checkout";

// ---------------------------------------------------------------------------
// In-memory store + faithful evaluation of the reuse lookup's WHERE clause.
// ---------------------------------------------------------------------------

const reuseState: { rows: Record<string, any>[] } = { rows: [] };

function matchesReuseWhere(row: Record<string, any>, where: any): boolean {
  if (row.userId !== where.userId) return false;
  if (row.paymentStatus !== where.paymentStatus) return false;
  // Null-safe org equality — mirrors Prisma's behavior for `organizationId`.
  if (row.organizationId !== where.organizationId) return false;
  if (row.paymentGateway !== where.paymentGateway) return false;
  if (row.deletedAt !== where.deletedAt) return false;
  if (where.expiresAt?.gt) {
    if (!row.expiresAt || !(row.expiresAt > where.expiresAt.gt)) return false;
  }
  const filter = where.appointment ?? {};
  const target = row.appointment ?? {};
  for (const [key, cond] of Object.entries(filter)) {
    // Prisma semantics: an undefined relation condition filters nothing —
    // which is exactly what the helper must never allow for events.
    if (cond === undefined) continue;
    const got = target[key];
    if (cond !== null && typeof cond === "object") {
      for (const [k2, v2] of Object.entries(cond as Record<string, unknown>)) {
        if ((got as Record<string, unknown>)?.[k2] !== v2) return false;
      }
    } else if (got !== cond) return false;
  }
  return true;
}

/** The webinar the checkout flow reads (capacity pre-check + handler). */
function webinarRow() {
  return {
    id: "evt-1",
    status: "SCHEDULED",
    webinarPlan: {
      id: "wplan-1",
      price: 100000,
      priceCurrency: "INR",
      organizationId: null,
      // Storefront gates (E2E audit): the checkout transaction re-checks
      // seller verification, archival and marketplace visibility that the
      // browse surfaces already enforce. `include:` returns every scalar in
      // production, so the fixture carries them too.
      archivedAt: null,
      visibility: "PUBLIC",
      consultantProfile: {
        id: "cp-1",
        userId: "consultant-u1",
        verificationStatus: "VERIFIED",
      },
    },
    appointment: {
      id: "appt-w",
      slotsOfAppointment: [
        {
          id: "slot-1",
          endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          user: [],
        },
      ],
    },
  };
}

/** An open fresh PENDING sibling for user-1 on evt-1 (the first attempt). */
function openSibling(overrides: Record<string, any> = {}) {
  return {
    id: "pay-open",
    userId: "user-1",
    paymentIntent: "order_OPEN",
    paymentStatus: "PENDING",
    expiresAt: new Date(Date.now() + 20 * 60 * 1000),
    organizationId: null,
    paymentGateway: "RAZORPAY",
    deletedAt: null,
    isMockPayment: false,
    // #780 — extended-client reads surface bigint money as Number.
    amount: 100000,
    currency: "INR",
    appointmentId: "appt-w",
    appointment: {
      webinarId: "evt-1",
      // Window gate reads the first slot (WEBINAR flow skips it, but keep the
      // shape faithful for the direct unit cases below).
      slotsOfAppointment: [
        {
          startsAt: new Date("2026-09-01T10:00:00Z"),
          endsAt: new Date("2026-09-01T11:00:00Z"),
        },
      ],
    },
    ...overrides,
  };
}

function checkoutInput(overrides: Record<string, unknown> = {}) {
  return {
    appointmentType: "WEBINAR",
    planId: "wplan-1",
    eventId: "evt-1",
    paymentGateway: "RAZORPAY",
    clientIdempotencyKey: "remount-tab-key-0002",
    ...overrides,
  } as unknown as Parameters<typeof handleCheckout>[0];
}

beforeEach(() => {
  reuseState.rows = [];
  txClient = {
    user: { findUnique: jest.fn(async () => userRow()) },
    membership: { findFirst: jest.fn(async () => null) },
    webinarPlan: {
      findUnique: jest.fn(async () => ({
        consultantProfileId: "cp-1",
        organizationId: null,
      })),
    },
    webinar: { findUnique: jest.fn(async () => webinarRow()) },
    slotOfAppointment: { update: jest.fn(async ({ where }: any) => where) },
    appointmentParticipant: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    consulteeProfile: {
      findUnique: jest.fn(async () => ({ userId: "user_1" })),
    },
    payment: {
      create: jest.fn(async ({ data }: any) => ({
        id: "pay-new",
        // #780 — the extended client reads bigint money back as Number.
        amount: data.amount,
      })),
    },
    paymentLeg: {
      create: jest.fn(async () => ({})),
      findMany: jest.fn(async () => [{ source: "CARD", amountPaise: 100000 }]),
    },
  };
  (createPaymentIntent as jest.Mock).mockResolvedValue({
    id: "order_NEW",
    client_secret: null,
  });
});

/** The buyer. No consultant profile — nobody buys their own plan here. */
function userRow() {
  return {
    id: "user-1",
    consulteeProfile: { id: "cprof-1" },
    consultantProfile: null,
  };
}

describe("rec C — checkout adopts an open PENDING order across remounts", () => {
  it("a second request with a DIFFERENT client key resumes the same order and mints no second gateway order", async () => {
    reuseState.rows.push(openSibling());
    const startedAtMs = Date.now();

    const res = await handleCheckout(
      checkoutInput({ clientIdempotencyKey: "brand-new-tab-key-9" }),
      "user-1",
    );

    expect(res.success).toBe(true);
    expect(res).toMatchObject({
      reused: true,
      orderId: "order_OPEN",
      currency: "INR",
      isMockPayment: false,
      message: "Resuming your in-progress checkout.",
    });
    // BigInt paise cross the boundary as Number (same as the #828 replay).
    expect(res.amount).toBe(100000);
    expect(res.paymentIntent).toEqual({
      id: "order_OPEN",
      client_secret: null,
    });

    // THE point of rec C: no parallel Razorpay order exists to pay.
    expect(createPaymentIntent).not.toHaveBeenCalled();

    // The lookup must be scoped tightly — user + PENDING + fresh window +
    // org equality + gateway + this event's appointment join.
    const where = (prisma.payment.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where).toMatchObject({
      userId: "user-1",
      paymentStatus: "PENDING",
      organizationId: null,
      paymentGateway: "RAZORPAY",
      deletedAt: null,
      appointment: { webinarId: "evt-1" },
    });
    // The window is evaluated at lookup time and must be live, not stale.
    expect(where.expiresAt.gt.getTime()).toBeGreaterThanOrEqual(startedAtMs);

    // Early return still releases both locks via the finally block.
    expect(unlockEventCheckout).toHaveBeenCalled();
    expect(unlockConsulteeBooking).toHaveBeenCalled();
  });

  it.each([
    [
      "the hold has expired",
      openSibling({ expiresAt: new Date(Date.now() - 60 * 1000) }),
    ],
    [
      "the sibling already SUCCEEDED",
      openSibling({ paymentStatus: "SUCCEEDED" }),
    ],
    ["the sibling belongs to another user", openSibling({ userId: "user-2" })],
    [
      "the sibling is for a different event's appointment",
      openSibling({ appointment: { webinarId: "evt-other" } }),
    ],
    [
      "the sibling was minted under another org",
      openSibling({ organizationId: "org-other" }),
    ],
  ])("mints fresh when %s", async (_label, sibling) => {
    reuseState.rows.push(sibling);

    const res = await handleCheckout(checkoutInput(), "user-1");

    expect(res.success).toBe(true);
    expect((res as Record<string, unknown>).reused).toBeUndefined();
    expect(createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 100000,
        currency: "INR",
        paymentGateway: "RAZORPAY",
      }),
    );
    expect(res.paymentIntent?.id).toBe("order_NEW");
  });
});

// ---------------------------------------------------------------------------
// #1220-triage — the gates themselves, exercised directly (the webinar flow
// above cannot discriminate them: eventId already pins scope and its fixtures
// share one price).
// ---------------------------------------------------------------------------
import { findReusablePendingOrderPayment } from "../../lib/payments/operations/checkout";

const SLOT = {
  startsAt: new Date("2026-09-01T10:00:00Z"),
  endsAt: new Date("2026-09-01T11:00:00Z"),
};
const OTHER_SLOT = {
  startsAt: new Date("2026-09-02T10:00:00Z"),
  endsAt: new Date("2026-09-02T11:00:00Z"),
};

function gateDb(rows: Array<Record<string, unknown>>) {
  return { payment: { findMany: async () => rows } };
}

describe("#1220-triage — reuse gates", () => {
  test("CONSULTATION: a different slot time is superseded, never resumed", async () => {
    const row = openSibling({
      appointment: {
        consultationId: "cons_1",
        slotsOfAppointment: [OTHER_SLOT],
      },
    });
    const { reusable, supersede } = await findReusablePendingOrderPayment(
      gateDb([row]) as never,
      {
        userId: "user-1",
        appointmentType: "CONSULTATION",
        planId: "plan-1",
        organizationId: null,
        paymentGateway: "RAZORPAY" as never,
        expectedAmountPaise: 100_000,
        slotWindow: SLOT,
      },
    );
    expect(reusable).toBeNull();
    expect(supersede).toEqual([
      { id: "pay-open", reason: "slot-window-mismatch" },
    ]);
  });

  test("CONSULTATION: identical slot window resumes", async () => {
    const row = openSibling({
      appointment: { consultationId: "cons_1", slotsOfAppointment: [SLOT] },
    });
    const { reusable, supersede } = await findReusablePendingOrderPayment(
      gateDb([row]) as never,
      {
        userId: "user-1",
        appointmentType: "CONSULTATION",
        planId: "plan-1",
        organizationId: null,
        paymentGateway: "RAZORPAY" as never,
        expectedAmountPaise: 100_000,
        slotWindow: SLOT,
      },
    );
    expect(reusable?.id).toBe("pay-open");
    expect(supersede).toEqual([]);
  });

  test("amount parity gate: a stale frozen total is superseded, not resumed", async () => {
    const row = openSibling({ amount: 80_000 }); // coupon changed since mint
    const { reusable, supersede } = await findReusablePendingOrderPayment(
      gateDb([row]) as never,
      {
        userId: "user-1",
        appointmentType: "WEBINAR",
        planId: "plan-1",
        eventId: "evt-1",
        organizationId: null,
        paymentGateway: "RAZORPAY" as never,
        expectedAmountPaise: 100_000,
      },
    );
    expect(reusable).toBeNull();
    expect(supersede).toEqual([{ id: "pay-open", reason: "amount-mismatch" }]);
  });

  test("SUBSCRIPTION: period mismatch supersedes; both-null request matches both-null rows only", async () => {
    const withPeriod = openSibling({
      id: "pay-period",
      appointment: {
        subscriptionId: "sub_1",
        slotsOfAppointment: [SLOT],
      },
    });
    const withoutPeriod = openSibling({
      id: "pay-noperiod",
      appointment: { subscriptionId: "sub_2", slotsOfAppointment: [] },
    });

    // Request WITH a period must not resume a period-less hold.
    const gated = await findReusablePendingOrderPayment(
      gateDb([withoutPeriod, withPeriod]) as never,
      {
        userId: "user-1",
        appointmentType: "SUBSCRIPTION",
        planId: "plan-1",
        organizationId: null,
        paymentGateway: "RAZORPAY" as never,
        expectedAmountPaise: 100_000,
        schedulingPeriod: SLOT,
      },
    );
    expect(gated.reusable?.id).toBe("pay-period");
    expect(gated.supersede.map((s) => s.id)).toEqual(["pay-noperiod"]);

    // Keyless request must not resume a hold that carries a period.
    const keyless = await findReusablePendingOrderPayment(
      gateDb([withPeriod]) as never,
      {
        userId: "user-1",
        appointmentType: "SUBSCRIPTION",
        planId: "plan-1",
        organizationId: null,
        paymentGateway: "RAZORPAY" as never,
        expectedAmountPaise: 100_000,
        schedulingPeriod: null,
      },
    );
    expect(keyless.reusable).toBeNull();
    expect(keyless.supersede.map((s) => s.id)).toEqual(["pay-period"]);
  });
});
