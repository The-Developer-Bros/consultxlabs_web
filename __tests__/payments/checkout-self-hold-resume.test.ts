/**
 * @jest-environment node
 */

/**
 * #1463 — a buyer who closes the gateway modal and clicks Pay again used to be
 * blocked by their OWN tentative hold. `validateSlotAvailability` ran before
 * the open-order resume (`findReusablePendingOrderPayment`, "Rec C") and threw
 * "Time slot is already booked", so the documented same-order resume was
 * unreachable and the buyer waited for the hold to expire.
 *
 * The exclusion has to be exactly as narrow as the resume gate it feeds, which
 * is what this pin holds in place: the same buyer, the same plan, the same
 * gateway and the exact same window passes; a different buyer on the same slot
 * still blocks; the same buyer on an overlapping-but-different window still
 * blocks; and (#1465-triage) so does a hold minted on a different gateway,
 * which `findReusablePendingOrderPayment` could neither resume nor supersede.
 *
 * The transaction client below evaluates the two blocking predicates against an
 * in-memory hold rather than asserting on query shape, so the self-hold
 * exclusion has to actually work for these to pass. Exactness in particular is
 * real: a booked window is stored as N contiguous 30-minute atoms, and the
 * helper decides coverage from the run's first start and last end.
 */

// Boundary mocks. `lib/payments/operations/checkout` transitively imports the
// auth stack through the payouts barrel, which is ESM-only under this Jest
// transform; none of it is reached by the availability helper, which is handed
// its own transaction client.
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

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

jest.mock("../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn(async () => true),
  PURPOSE_CODES: { SESSION_BOOKING: "SESSION_BOOKING" },
}));

import type { Tx } from "../../lib/prisma";
import type { CheckoutInput } from "../../schemas/checkout";
import { validateSlotAvailability } from "../../lib/payments/operations/checkout";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const BUYER = "buyer-user-1";
const CONSULTANT = "consultant-user-1";
const PLAN = "plan-1";

/** The held window: 48 h out, one hour long, stored as two 30-minute atoms. */
const WINDOW_START = new Date(Date.now() + 48 * HOUR_MS);
const WINDOW_END = new Date(WINDOW_START.getTime() + HOUR_MS);

interface HeldSlot {
  appointmentId: string;
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
}

/** One live tentative hold, minted by a previous checkout attempt. */
const HOLD_APPOINTMENT_ID = "appt-hold";
const heldSlots: HeldSlot[] = [
  {
    appointmentId: HOLD_APPOINTMENT_ID,
    startsAt: WINDOW_START,
    endsAt: new Date(WINDOW_START.getTime() + 30 * MINUTE_MS),
    isTentative: true,
  },
  {
    appointmentId: HOLD_APPOINTMENT_ID,
    startsAt: new Date(WINDOW_START.getTime() + 30 * MINUTE_MS),
    endsAt: WINDOW_END,
    isTentative: true,
  },
];

/** The hold's live PENDING payment belongs to the buyer, and to nobody else. */
const HOLD_OWNER = BUYER;

/** ...and it was minted on the gateway the resume gate would look for. */
const HOLD_GATEWAY = "RAZORPAY";

/** The `AND` terms of the two blocking slot queries this suite discriminates. */
interface SlotWhereTerm {
  NOT?: SlotWhereTerm;
  appointmentId?: { in: string[] };
  startsAt?: { lt: Date };
  endsAt?: { gt: Date };
  isTentative?: boolean;
}

/** The self-hold lookup's `where`, as far as this suite reads it. */
interface SelfHoldWhere {
  payment?: {
    some?: {
      userId?: string;
      paymentGateway?: string;
      organizationId?: string | null;
    };
  };
  consultation?: { consultationPlanId?: string };
  slotsOfAppointment?: { some?: { startsAt?: Date } };
}

/**
 * Evaluate one term of the blocking queries' `AND` array against a held slot.
 * Only the terms this suite can discriminate are modelled; the relation terms
 * (consultant membership, occupancy, the live-payment join) are true for the
 * single fixture hold by construction.
 */
function termMatches(slot: HeldSlot, term: SlotWhereTerm): boolean {
  if (term.NOT) return !termMatches(slot, term.NOT);
  if (term.appointmentId?.in) {
    return term.appointmentId.in.includes(slot.appointmentId);
  }
  if (term.startsAt?.lt) return slot.startsAt < term.startsAt.lt;
  if (term.endsAt?.gt) return slot.endsAt > term.endsAt.gt;
  if (term.isTentative !== undefined) {
    return slot.isTentative === term.isTentative;
  }
  return true;
}

const tx = {
  // The self-hold lookup: same buyer, same plan, an atom starting at the
  // requested window's start. Exact coverage is decided by the helper itself.
  appointment: {
    findMany: async ({ where }: { where: SelfHoldWhere }) => {
      const wantedStart = where.slotsOfAppointment?.some?.startsAt;
      if (where.payment?.some?.userId !== HOLD_OWNER) return [];
      // #1465-triage — the resume gate's own scope, and therefore this
      // exclusion's: a hold on another gateway or another org is not adoptable.
      if (where.payment?.some?.paymentGateway !== HOLD_GATEWAY) return [];
      if ((where.payment?.some?.organizationId ?? null) !== null) return [];
      if (where.consultation?.consultationPlanId !== PLAN) return [];
      if (
        !wantedStart ||
        !heldSlots.some((s) => s.startsAt.getTime() === wantedStart.getTime())
      ) {
        return [];
      }
      return [
        {
          id: HOLD_APPOINTMENT_ID,
          slotsOfAppointment: heldSlots.map((s) => ({
            startsAt: s.startsAt,
            endsAt: s.endsAt,
          })),
        },
      ];
    },
  },
  slotOfAppointment: {
    findFirst: async ({ where }: { where: { AND: SlotWhereTerm[] } }) =>
      heldSlots.find((slot) =>
        where.AND.every((term) => termMatches(slot, term)),
      ) ?? null,
  },
} as unknown as Tx;

function checkoutInput(
  startsAt: Date,
  endsAt: Date,
  paymentGateway: string = HOLD_GATEWAY,
): CheckoutInput {
  return {
    appointmentType: "CONSULTATION",
    planId: PLAN,
    paymentGateway,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  } as unknown as CheckoutInput;
}

describe("#1463 the buyer's own live hold does not block their resume", () => {
  it("lets the same buyer, same plan and exact window through to the open-order resume", async () => {
    const result = await validateSlotAvailability(
      tx,
      checkoutInput(WINDOW_START, WINDOW_END),
      BUYER,
      CONSULTANT,
    );

    expect(result.selfHoldAppointmentIds).toEqual([HOLD_APPOINTMENT_ID]);
  });

  it("still blocks a different buyer on the same slot", async () => {
    await expect(
      validateSlotAvailability(
        tx,
        checkoutInput(WINDOW_START, WINDOW_END),
        "other-buyer",
        CONSULTANT,
      ),
    ).rejects.toThrow("Time slot is already booked");
  });

  it("still blocks a hold this request could not resume (other gateway)", async () => {
    await expect(
      validateSlotAvailability(
        tx,
        checkoutInput(WINDOW_START, WINDOW_END, "STRIPE"),
        BUYER,
        CONSULTANT,
      ),
    ).rejects.toThrow("Time slot is already booked");
  });

  it("still blocks the same buyer on an overlapping but different window", async () => {
    const shifted = new Date(WINDOW_START.getTime() + 30 * MINUTE_MS);

    await expect(
      validateSlotAvailability(
        tx,
        checkoutInput(shifted, new Date(shifted.getTime() + HOUR_MS)),
        BUYER,
        CONSULTANT,
      ),
    ).rejects.toThrow("Time slot is already booked");
  });
});
