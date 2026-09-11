/**
 * @jest-environment node
 */

/**
 * #1182 — pending-payments quotes the FROZEN Payment.amount, not the plan.
 *
 * An approval-pending item's charge was fixed onto its Payment row when the
 * pay-link was minted; the plan's price stays mutable underneath. Quoting the
 * plan meant a consultant who repriced after accepting turned this widget
 * into a number the gateway would not honour. Mirrors #1180's rule on the
 * trial checkout page: frozen payment first, plan only as the pre-mint quote.
 */

import { GET } from "../../app/api/dashboard/consultee/[consulteeId]/pending-payments/route";
import { requireApiAuth } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: jest.fn(),
  isPrivileged: jest.fn(() => false),
  forbiddenResponse: jest.fn(
    (message: string) =>
      new Response(JSON.stringify({ error: message }), { status: 403 }),
  ),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consulteeProfile: { findUnique: jest.fn() },
    consultation: { findMany: jest.fn() },
    subscription: { findMany: jest.fn() },
    payment: { findMany: jest.fn() },
    trialSession: { findMany: jest.fn() },
  },
}));

const mockedAuth = requireApiAuth as jest.Mock;
const mockedConsultations = prisma.consultation.findMany as jest.Mock;
const mockedSubscriptions = prisma.subscription.findMany as jest.Mock;
const mockedGatewayPayments = prisma.payment.findMany as jest.Mock;
const mockedTrials = prisma.trialSession.findMany as jest.Mock;

function frozenPayment(amount: number, currency = "INR") {
  return [{ amount, currency }];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuth.mockResolvedValue({
    session: {
      user: { id: "user-1", role: "USER", consulteeProfileId: "consultee-1" },
    },
  });
  mockedConsultations.mockResolvedValue([]);
  mockedSubscriptions.mockResolvedValue([]);
  mockedGatewayPayments.mockResolvedValue([]);
  mockedTrials.mockResolvedValue([]);
  (prisma.consulteeProfile.findUnique as jest.Mock).mockResolvedValue({
    id: "consultee-1",
    userId: "user-1",
  });
});

async function getPendingPayments() {
  const res = await GET(new Request("http://localhost/api"), {
    params: Promise.resolve({ consulteeId: "consultee-1" }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).pendingPayments as Array<{
    id: string;
    type: string;
    amount: number;
    currency: string;
  }>;
}

describe("pending-payments quotes the frozen Payment.amount (#1182)", () => {
  it("an approval-pending consultation shows the minted amount after the plan was repriced", async () => {
    // Link minted at ₹3,500; the plan has since gone up to ₹4,000. The
    // gateway will charge the frozen figure, so that is what is quoted.
    mockedConsultations.mockResolvedValue([
      {
        id: "cons-1",
        updatedAt: new Date("2026-08-01T10:00:00Z"),
        pendingPaymentUrl: "order_123",
        appointment: { id: "appt-1", payment: frozenPayment(350_000) },
        consultationPlan: {
          title: "Career Clarity",
          price: 400_000,
          priceCurrency: "INR",
          consultantProfile: { user: { name: "Advisor" } },
        },
      },
    ]);

    const items = await getPendingPayments();

    const item = items.find((i) => i.id === "cons-1");
    expect(item?.amount).toBe(350_000);
    expect(item?.currency).toBe("INR");
  });

  it("falls back to the plan price before any payment exists (the genuine pre-mint quote)", async () => {
    mockedConsultations.mockResolvedValue([
      {
        id: "cons-2",
        updatedAt: new Date("2026-08-01T10:00:00Z"),
        pendingPaymentUrl: null,
        appointment: { id: "appt-2", payment: [] },
        consultationPlan: {
          title: "Career Clarity",
          price: 400_000,
          priceCurrency: "INR",
          consultantProfile: { user: { name: "Advisor" } },
        },
      },
    ]);

    const items = await getPendingPayments();

    expect(items.find((i) => i.id === "cons-2")?.amount).toBe(400_000);
  });

  it("an approval-pending subscription shows its appointment's frozen amount and currency", async () => {
    mockedSubscriptions.mockResolvedValue([
      {
        id: "sub-1",
        updatedAt: new Date("2026-08-01T10:00:00Z"),
        pendingPaymentUrl: "order_456",
        appointments: [
          {
            id: "appt-s1",
            payment: frozenPayment(1_250_000),
          },
        ],
        subscriptionPlan: {
          title: "Weekly Mentoring",
          price: 999_999, // repriced down after acceptance
          priceCurrency: "INR",
          consultantProfile: { user: { name: "Mentor" } },
        },
      },
    ]);

    const items = await getPendingPayments();

    const item = items.find((i) => i.id === "sub-1");
    expect(item?.amount).toBe(1_250_000);
    expect(item?.currency).toBe("INR");
  });

  it("a paid trial awaiting payment shows the frozen trial charge, not the current trialPriceInPaise", async () => {
    mockedTrials.mockResolvedValue([
      {
        id: "trial-1",
        updatedAt: new Date("2026-08-01T10:00:00Z"),
        paymentDueAt: new Date("2026-08-05T10:00:00Z"),
        pendingPaymentUrl: "order_789",
        appointment: { id: "appt-t1" },
        payment: { amount: 100_000, currency: "INR" },
        subscriptionPlan: {
          title: "Deep Dive",
          trialPriceInPaise: 200_000, // repriced after acceptance
          priceCurrency: "INR",
          consultantProfile: { user: { name: "Guide" } },
        },
      },
    ]);

    const items = await getPendingPayments();

    expect(items.find((i) => i.id === "trial-1")?.amount).toBe(100_000);
  });

  it("a free trial (no payment ever minted) still quotes zero via the plan fallback", async () => {
    mockedTrials.mockResolvedValue([
      {
        id: "trial-free",
        updatedAt: new Date("2026-08-01T10:00:00Z"),
        paymentDueAt: null,
        pendingPaymentUrl: null,
        appointment: { id: "appt-t2" },
        payment: null,
        subscriptionPlan: {
          title: "Taster",
          trialPriceInPaise: 0,
          priceCurrency: "INR",
          consultantProfile: { user: { name: "Guide" } },
        },
      },
    ]);

    const items = await getPendingPayments();

    expect(items.find((i) => i.id === "trial-free")?.amount).toBe(0);
  });
});
