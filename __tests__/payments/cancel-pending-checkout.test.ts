/**
 * @jest-environment node
 */

/**
 * #849 — cancelPendingCheckout unit tests.
 *
 * State-based prisma mock (same idiom as refund-operation.test.ts): the tx
 * stub mutates an in-memory store, CAS guards are exercised for real via the
 * mocked updateMany counts. Real-DB rollback semantics (Serializable tx) are
 * covered E2E by the chaos scenario test-cancel-pending-vs-webhook; here we
 * assert the business decisions (claims, scoping, transitions, gateway call).
 */

type Row = Record<string, unknown>;

interface SlotRow {
  id: string;
  appointmentId: string;
  classId: string | null;
  isTentative: boolean;
  completionStatus: string;
  deletedAt: Date | null;
  userIds: string[];
}

interface Store {
  payments: Map<string, Row>;
  consultations: Map<string, Row>;
  subscriptions: Map<string, Row>;
  slots: SlotRow[];
}

let state: Store;

function newStore(): Store {
  return {
    payments: new Map(),
    consultations: new Map(),
    subscriptions: new Map(),
    slots: [],
  };
}

function matchesUserSome(slot: SlotRow, where: Row): boolean {
  const user = where.user as { some?: { id?: string } } | undefined;
  if (!user?.some?.id) return true;
  return slot.userIds.includes(user.some.id);
}

interface SlotWhere {
  appointmentId?: string;
  appointment?: { classId?: string };
  isTentative?: boolean;
  deletedAt?: Date | null;
  completionStatus?: { in?: string[] };
}

function matchSlots(where: Row): SlotRow[] {
  const w = where as SlotWhere;
  return state.slots.filter((slot) => {
    let match = true;
    if (w.appointmentId !== undefined)
      match = match && slot.appointmentId === w.appointmentId;
    if (w.appointment?.classId !== undefined)
      match = match && slot.classId === w.appointment.classId;
    if (w.isTentative !== undefined)
      match = match && slot.isTentative === w.isTentative;
    if (w.deletedAt === null) match = match && slot.deletedAt === null;
    if (w.completionStatus?.in !== undefined)
      match = match && w.completionStatus.in.includes(slot.completionStatus);
    match = match && matchesUserSome(slot, where);
    return match;
  });
}

function makeTx() {
  return {
    payment: {
      findUnique: jest.fn(async ({ where }: any) => {
        const p = state.payments.get(where.id);
        if (!p) return null;
        // Hydrate the appointment include shape the module selects.
        return {
          ...p,
          appointment: p.appointmentId
            ? {
                id: p.appointmentId,
                consultation: p.consultationId
                  ? { id: p.consultationId }
                  : null,
                subscription: p.subscriptionId
                  ? { id: p.subscriptionId }
                  : null,
                webinar: p.webinarId ? { id: p.webinarId } : null,
                class: p.classId ? { id: p.classId } : null,
              }
            : null,
        };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const p = state.payments.get(where.id);
        if (!p) return { count: 0 };
        if (where.userId !== undefined && p.userId !== where.userId)
          return { count: 0 };
        if (
          where.paymentStatus !== undefined &&
          p.paymentStatus !== where.paymentStatus
        )
          return { count: 0 };
        Object.assign(p, data);
        return { count: 1 };
      }),
    },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    consultation: {
      findUnique: jest.fn(
        async ({ where }: any) => state.consultations.get(where.id) ?? null,
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const c = state.consultations.get(where.id);
        if (!c) return { count: 0 };
        const allowed = where.status?.in as string[] | undefined;
        if (allowed && !allowed.includes(c.status as string))
          return { count: 0 };
        Object.assign(c, data);
        return { count: 1 };
      }),
    },
    subscription: {
      findUnique: jest.fn(
        async ({ where }: any) => state.subscriptions.get(where.id) ?? null,
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const s = state.subscriptions.get(where.id);
        if (!s) return { count: 0 };
        const allowed = where.status?.in as string[] | undefined;
        if (allowed && !allowed.includes(s.status as string))
          return { count: 0 };
        Object.assign(s, data);
        return { count: 1 };
      }),
    },
    slotOfAppointment: {
      findMany: jest.fn(async ({ where }: any) =>
        matchSlots(where).map((slot) => ({
          id: slot.id,
          completionStatus: slot.completionStatus,
        })),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const slot = state.slots.find((s) => s.id === where.id);
        if (!slot) return null;
        const disconnectId = data?.user?.disconnect?.id;
        if (disconnectId) {
          slot.userIds = slot.userIds.filter((id) => id !== disconnectId);
        }
        return { id: slot.id };
      }),
      updateManyAndReturn: jest.fn(
        async ({ where, data }: { where: Row; data: Row }) => {
          const moved = matchSlots(where);
          for (const slot of moved) Object.assign(slot, data);
          return moved.map((slot) => ({
            id: slot.id,
            appointmentId: slot.appointmentId,
          }));
        },
      ),
    },
    referralCreditUsage: {
      findMany: jest.fn(async () => []),
    },
  };
}

let tx: ReturnType<typeof makeTx>;

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(async (fn: any, _opts: any) => fn(tx)),
  },
}));

jest.mock("../../scripts/payments/cleanup-abandoned-payments", () => ({
  __esModule: true,
  cancelPaymentIntent: jest.fn(async () => undefined),
}));

const mockReverseBookingUtilization = jest.fn(async () => ({
  reversed: false,
  engagementsReversed: 0,
  fullyReversed: false,
}));

jest.mock("../../lib/api/organizations/program-helpers", () => ({
  __esModule: true,
  reverseBookingUtilization: (...a: unknown[]) =>
    mockReverseBookingUtilization(...(a as [])),
}));

import { cancelPendingCheckout } from "../../lib/payments/operations/cancel-pending";
import { cancelPaymentIntent } from "../../scripts/payments/cleanup-abandoned-payments";
import { IllegalTransitionError } from "../../lib/enterprise/transitions";

function seedConsultationPayment({
  paymentStatus = "PENDING",
  status = "APPROVED_PENDING_PAYMENT",
  isMockPayment = false,
}: Partial<{
  paymentStatus: string;
  status: string;
  isMockPayment: boolean;
}> = {}) {
  state.payments.set("pay-1", {
    id: "pay-1",
    userId: "user-1",
    paymentStatus,
    paymentIntent: "order_abc",
    paymentGateway: "RAZORPAY",
    isMockPayment,
    appointmentId: "appt-1",
    consultationId: "cons-1",
    subscriptionId: null,
    webinarId: null,
    classId: null,
  });
  state.consultations.set("cons-1", {
    id: "cons-1",
    status,
  });
  state.slots.push({
    id: "slot-1",
    appointmentId: "appt-1",
    classId: null,
    isTentative: true,
    completionStatus: "SCHEDULED",
    deletedAt: null,
    userIds: ["user-1"],
  });
}

beforeEach(() => {
  state = newStore();
  tx = makeTx();
  jest.clearAllMocks();
});

describe("cancelPendingCheckout — happy path (consultation)", () => {
  it("expires the payment, releases tentative slots, cancels the parent, cancels the gateway intent", async () => {
    seedConsultationPayment({});

    const result = await cancelPendingCheckout({
      paymentId: "pay-1",
      userId: "user-1",
    });

    expect(result).toEqual({ ok: true, slotsReleased: 1 });
    expect(state.payments.get("pay-1")?.paymentStatus).toBe("EXPIRED");
    // Freed by status, not deleted: the row stays so support can see the
    // hold the buyer abandoned (doctrine rule 2).
    expect(state.slots).toHaveLength(1);
    expect(state.slots[0].completionStatus).toBe("CANCELLED");
    expect(state.slots[0].deletedAt).toBeInstanceOf(Date);
    const cons = state.consultations.get("cons-1");
    expect(cons?.status).toBe("CANCELLED");
    expect(cons?.cancellationNotes).toBe("Cancelled by user during checkout");
    expect(cons?.cancelledAt).toBeInstanceOf(Date);
    expect(cancelPaymentIntent).toHaveBeenCalledWith("order_abc", "RAZORPAY");
    // #1333 — the slot history rows name the appointment the rows came back with.
    const slotHistory = (
      tx.bookingStatusHistory.create as jest.Mock
    ).mock.calls.filter(([call]) => call.data.entity === "SLOT");
    expect(slotHistory.length).toBeGreaterThan(0);
    for (const [call] of slotHistory) {
      expect(call.data).toEqual(
        expect.objectContaining({
          toStatus: "CANCELLED",
          appointmentId: "appt-1",
        }),
      );
    }
  });

  it("skips the gateway cancel for mock payments", async () => {
    seedConsultationPayment({ isMockPayment: true });

    const result = await cancelPendingCheckout({
      paymentId: "pay-1",
      userId: "user-1",
    });

    expect(result.ok).toBe(true);
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it("#1003 — returns the program engagement to the org's cap", async () => {
    // Checkout debits BookingUtilization inside the booking transaction,
    // BEFORE capture. Abandoning an org-funded checkout therefore burned a
    // contracted seat permanently until this reversal was wired in.
    seedConsultationPayment({});

    await cancelPendingCheckout({ paymentId: "pay-1", userId: "user-1" });

    expect(mockReverseBookingUtilization).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ paymentId: "pay-1" }),
    );
  });

  it("#1003 — does not reverse utilization when the cancel is refused", async () => {
    seedConsultationPayment({ paymentStatus: "SUCCEEDED" });

    await cancelPendingCheckout({ paymentId: "pay-1", userId: "user-1" });

    expect(mockReverseBookingUtilization).not.toHaveBeenCalled();
  });
});

describe("cancelPendingCheckout — CAS / status guards", () => {
  it("returns NOT_PENDING when the webhook already confirmed (SUCCEEDED), with zero writes", async () => {
    seedConsultationPayment({ paymentStatus: "SUCCEEDED" });

    const result = await cancelPendingCheckout({
      paymentId: "pay-1",
      userId: "user-1",
    });

    expect(result).toEqual({ ok: false, code: "NOT_PENDING" });
    expect(state.payments.get("pay-1")?.paymentStatus).toBe("SUCCEEDED");
    expect(state.slots).toHaveLength(1);
    expect(state.slots[0].completionStatus).toBe("SCHEDULED");
    expect(state.slots[0].deletedAt).toBeNull();
    expect(state.consultations.get("cons-1")?.status).toBe(
      "APPROVED_PENDING_PAYMENT",
    );
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it("second cancel of the same payment returns NOT_PENDING", async () => {
    seedConsultationPayment({});

    const first = await cancelPendingCheckout({
      paymentId: "pay-1",
      userId: "user-1",
    });
    const second = await cancelPendingCheckout({
      paymentId: "pay-1",
      userId: "user-1",
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, code: "NOT_PENDING" });
  });

  it("returns NOT_FOUND for a foreign user's payment, with zero writes", async () => {
    seedConsultationPayment({});

    const result = await cancelPendingCheckout({
      paymentId: "pay-1",
      userId: "user-other",
    });

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(state.payments.get("pay-1")?.paymentStatus).toBe("PENDING");
    expect(state.slots).toHaveLength(1);
    expect(state.slots[0].deletedAt).toBeNull();
  });

  it("returns NOT_FOUND for a missing payment", async () => {
    const result = await cancelPendingCheckout({
      paymentId: "nope",
      userId: "user-1",
    });
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});

describe("cancelPendingCheckout — narrow parent from-set", () => {
  it("throws IllegalTransitionError when the parent is already SCHEDULED (another payment won)", async () => {
    seedConsultationPayment({ status: "SCHEDULED" });

    await expect(
      cancelPendingCheckout({ paymentId: "pay-1", userId: "user-1" }),
    ).rejects.toThrow(IllegalTransitionError);
    // The real DB rolls the whole Serializable tx back; the route maps the
    // error to 409. (E2E rollback covered by the chaos scenario.)
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
  });
});

describe("cancelPendingCheckout — subscription parent", () => {
  it("cancels the subscription parent through the guarded transition", async () => {
    state.payments.set("pay-s", {
      id: "pay-s",
      userId: "user-1",
      paymentStatus: "PENDING",
      paymentIntent: "order_s",
      paymentGateway: "RAZORPAY",
      isMockPayment: true,
      appointmentId: "appt-s",
      consultationId: null,
      subscriptionId: "sub-1",
      webinarId: null,
      classId: null,
    });
    state.subscriptions.set("sub-1", {
      id: "sub-1",
      status: "APPROVED_PENDING_PAYMENT",
    });
    state.slots.push({
      id: "slot-s",
      appointmentId: "appt-s",
      classId: null,
      isTentative: true,
      completionStatus: "SCHEDULED",
      deletedAt: null,
      userIds: ["user-1"],
    });

    const result = await cancelPendingCheckout({
      paymentId: "pay-s",
      userId: "user-1",
    });

    expect(result).toEqual({ ok: true, slotsReleased: 1 });
    expect(state.payments.get("pay-s")?.paymentStatus).toBe("EXPIRED");
    const sub = state.subscriptions.get("sub-1");
    expect(sub?.status).toBe("CANCELLED");
    expect(sub?.cancellationNotes).toBe("Cancelled by user during checkout");
    expect(sub?.cancelledAt).toBeInstanceOf(Date);
  });

  it("rolls back when the subscription parent is already SCHEDULED", async () => {
    state.payments.set("pay-s2", {
      id: "pay-s2",
      userId: "user-1",
      paymentStatus: "PENDING",
      paymentIntent: "order_s2",
      paymentGateway: "RAZORPAY",
      isMockPayment: true,
      appointmentId: "appt-s2",
      consultationId: null,
      subscriptionId: "sub-2",
      webinarId: null,
      classId: null,
    });
    state.subscriptions.set("sub-2", { id: "sub-2", status: "SCHEDULED" });

    await expect(
      cancelPendingCheckout({ paymentId: "pay-s2", userId: "user-1" }),
    ).rejects.toThrow(IllegalTransitionError);
  });
});

describe("cancelPendingCheckout — webinar scoping", () => {
  it("releases only the caller's tentative seat on a shared webinar appointment", async () => {
    state.payments.set("pay-w", {
      id: "pay-w",
      userId: "user-1",
      paymentStatus: "PENDING",
      paymentIntent: "order_w",
      paymentGateway: "RAZORPAY",
      isMockPayment: false,
      appointmentId: "appt-w",
      consultationId: null,
      subscriptionId: null,
      webinarId: "web-1",
      classId: null,
    });
    state.slots.push(
      {
        id: "slot-mine",
        appointmentId: "appt-w",
        classId: null,
        isTentative: true,
        completionStatus: "SCHEDULED",
        deletedAt: null,
        userIds: ["user-1"],
      },
      {
        id: "slot-theirs",
        appointmentId: "appt-w",
        classId: null,
        isTentative: true,
        completionStatus: "SCHEDULED",
        deletedAt: null,
        userIds: ["user-2"],
      },
      {
        id: "slot-confirmed",
        appointmentId: "appt-w",
        classId: null,
        isTentative: false,
        completionStatus: "SCHEDULED",
        deletedAt: null,
        userIds: ["user-1"],
      },
    );

    const result = await cancelPendingCheckout({
      paymentId: "pay-w",
      userId: "user-1",
    });

    // Both of the caller's slots on the shared webinar appointment release
    // their seat; the rows survive because other attendees share them.
    expect(result).toEqual({ ok: true, slotsReleased: 2 });
    expect(state.slots.map((s) => s.id).sort()).toEqual([
      "slot-confirmed",
      "slot-mine",
      "slot-theirs",
    ]);
    expect(
      state.slots.filter((s) => s.userIds.includes("user-1")).map((s) => s.id),
    ).toEqual([]);
  });
});

describe("cancelPendingCheckout — class scoping", () => {
  it("releases the caller's tentative slots across all class session appointments", async () => {
    state.payments.set("pay-c", {
      id: "pay-c",
      userId: "user-1",
      paymentStatus: "PENDING",
      paymentIntent: "order_c",
      paymentGateway: "RAZORPAY",
      isMockPayment: false,
      appointmentId: "appt-c1",
      consultationId: null,
      subscriptionId: null,
      webinarId: null,
      classId: "class-1",
    });
    state.slots.push(
      {
        id: "c1-mine",
        appointmentId: "appt-c1",
        classId: "class-1",
        isTentative: true,
        completionStatus: "SCHEDULED",
        deletedAt: null,
        userIds: ["user-1"],
      },
      {
        id: "c2-mine",
        appointmentId: "appt-c2",
        classId: "class-1",
        isTentative: true,
        completionStatus: "SCHEDULED",
        deletedAt: null,
        userIds: ["user-1"],
      },
      {
        id: "c2-theirs",
        appointmentId: "appt-c2",
        classId: "class-1",
        isTentative: true,
        completionStatus: "SCHEDULED",
        deletedAt: null,
        userIds: ["user-2"],
      },
    );

    const result = await cancelPendingCheckout({
      paymentId: "pay-c",
      userId: "user-1",
    });

    expect(result).toEqual({ ok: true, slotsReleased: 2 });
    // Session rows are shared with the other students, so they stay put.
    expect(state.slots.map((s) => s.id)).toEqual([
      "c1-mine",
      "c2-mine",
      "c2-theirs",
    ]);
    expect(
      state.slots.filter((s) => s.userIds.includes("user-1")).map((s) => s.id),
    ).toEqual([]);
  });
});

describe("cancelPendingCheckout — gateway cancel failure is non-fatal", () => {
  it("still reports success when the gateway cancel throws", async () => {
    seedConsultationPayment({});
    (cancelPaymentIntent as jest.Mock).mockRejectedValueOnce(
      new Error("gateway down"),
    );

    const result = await cancelPendingCheckout({
      paymentId: "pay-1",
      userId: "user-1",
    });

    expect(result.ok).toBe(true);
    expect(state.payments.get("pay-1")?.paymentStatus).toBe("EXPIRED");
  });
});
