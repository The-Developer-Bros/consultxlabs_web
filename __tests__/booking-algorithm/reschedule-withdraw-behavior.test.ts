/**
 * @jest-environment node
 */

/**
 * withdrawRescheduleRequest — behaviour, not just the enum shape.
 *
 * State-based prisma mock (same idiom as cancel-pending-checkout.test.ts): the
 * tx stub mutates an in-memory store so the CAS guards run for real via the
 * mocked updateMany counts.
 *
 * The asymmetry under test: a WITHDRAWAL restores the booking, a DECLINE does
 * not. Both end the same request, and collapsing them would leave a consultee
 * who was declined silently back where they started.
 */

interface SlotRow {
  id: string;
  isTentative: boolean;
  completionStatus: string;
}

interface RequestRow {
  id: string;
  status: string;
  initiatedById: string;
  releasedSlotIds: string[];
  appointmentId: string;
  openForAppointmentId: string | null;
  appointment: {
    consultationId: string | null;
    subscriptionId: string | null;
  };
}

interface Store {
  request: RequestRow | null;
  slots: SlotRow[];
  consultation: { id: string; status: string } | null;
  subscription: { id: string; status: string } | null;
}

let state: Store;

type Data = Record<string, unknown>;
/** The CAS shape both request tables are guarded by. */
interface StatusCas {
  where: { id: string; status?: { in: string[] } };
  data: Data;
}
/** transitionSlotCompletion's shape: the from-set is an `in` list. */
interface SlotCas {
  where: { id: { in: string[] }; completionStatus: { in: string[] } };
  data: Data;
}

function matchSlots(where: SlotCas["where"]): SlotRow[] {
  return state.slots.filter(
    (s) =>
      where.id.in.includes(s.id) &&
      where.completionStatus.in.includes(s.completionStatus),
  );
}

function makeTx() {
  return {
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    rescheduleRequest: {
      findUnique: jest.fn(async () => state.request),
      updateMany: jest.fn(async ({ where, data }: StatusCas) => {
        const row = state.request;
        if (!row || row.id !== where.id) return { count: 0 };
        // The CAS: the from-set is the state machine.
        if (where.status?.in && !where.status.in.includes(row.status)) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    slotOfAppointment: {
      findMany: jest.fn(async ({ where }: SlotCas) =>
        matchSlots(where).map((s) => ({
          id: s.id,
          completionStatus: s.completionStatus,
        })),
      ),
      updateManyAndReturn: jest.fn(async ({ where, data }: SlotCas) => {
        const targets = matchSlots(where);
        targets.forEach((s) => Object.assign(s, data));
        return targets.map((s) => ({ id: s.id }));
      }),
    },
    subscription: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        state.subscription && state.subscription.id === where.id
          ? { status: state.subscription.status }
          : null,
      ),
      updateMany: jest.fn(async ({ where, data }: StatusCas) => {
        const row = state.subscription;
        if (!row || row.id !== where.id) return { count: 0 };
        if (where.status?.in && !where.status.in.includes(row.status)) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    consultation: {
      findUnique: jest.fn(async () => state.consultation ?? null),
      updateMany: jest.fn(async ({ where, data }: StatusCas) => {
        const row = state.consultation;
        if (!row || row.id !== where.id) return { count: 0 };
        if (where.status?.in && !where.status.in.includes(row.status)) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
}

let tx: ReturnType<typeof makeTx>;

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    rescheduleRequest: {
      findUnique: jest.fn(async () => state.request),
    },
    $transaction: jest.fn(
      async (fn: (t: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    ),
  },
}));

const reportSentryError = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryError: (...args: unknown[]) => reportSentryError(...args),
}));

import { withdrawRescheduleRequest } from "../../lib/booking/reschedule-withdraw";

const INITIATOR = "user-consultee";
const OTHER = "user-consultant";

function seed(
  overrides: Partial<{
    status: string;
    slots: SlotRow[];
    consultationId: string | null;
    subscriptionId: string | null;
    consultationStatus: string;
    subscriptionStatus: string;
  }> = {},
) {
  const slots = overrides.slots ?? [
    { id: "slot-1", isTentative: true, completionStatus: "RESCHEDULED" },
    { id: "slot-2", isTentative: true, completionStatus: "RESCHEDULED" },
  ];
  const consultationId =
    overrides.consultationId === undefined
      ? "cons-1"
      : overrides.consultationId;

  state = {
    request: {
      id: "req-1",
      status: overrides.status ?? "PENDING_REVIEW",
      initiatedById: INITIATOR,
      releasedSlotIds: slots.map((s) => s.id),
      appointmentId: "appt-1",
      openForAppointmentId: "appt-1",
      appointment: {
        consultationId,
        subscriptionId: overrides.subscriptionId ?? null,
      },
    },
    slots,
    consultation: consultationId
      ? {
          id: consultationId,
          status: overrides.consultationStatus ?? "PENDING",
        }
      : null,
    subscription: overrides.subscriptionId
      ? {
          id: overrides.subscriptionId,
          status: overrides.subscriptionStatus ?? "PENDING",
        }
      : null,
  };
  tx = makeTx();
  reportSentryError.mockClear();
}

describe("withdrawRescheduleRequest", () => {
  it("restores the released slots and reopens the appointment's lock", async () => {
    seed();

    const result = await withdrawRescheduleRequest({
      rescheduleRequestId: "req-1",
      withdrawnById: INITIATOR,
    });

    expect(result).toEqual({ withdrawn: true });
    expect(state.slots).toEqual([
      { id: "slot-1", isTentative: false, completionStatus: "SCHEDULED" },
      { id: "slot-2", isTentative: false, completionStatus: "SCHEDULED" },
    ]);
    expect(state.request?.status).toBe("WITHDRAWN");
    // Terminal, so the nullable-unique stops reserving the appointment. Miss
    // this and every later reschedule of this booking is blocked forever.
    expect(state.request?.openForAppointmentId).toBeNull();
  });

  it("refuses anyone who did not open it, and touches nothing", async () => {
    seed();

    const result = await withdrawRescheduleRequest({
      rescheduleRequestId: "req-1",
      withdrawnById: OTHER,
    });

    expect(result).toEqual({ withdrawn: false, reason: "NOT_INITIATOR" });
    expect(state.request?.status).toBe("PENDING_REVIEW");
    expect(state.slots.every((s) => s.completionStatus === "RESCHEDULED")).toBe(
      true,
    );
  });

  it("refuses a request that already resolved", async () => {
    seed({ status: "ACCEPTED" });

    const result = await withdrawRescheduleRequest({
      rescheduleRequestId: "req-1",
      withdrawnById: INITIATOR,
    });

    expect(result).toEqual({ withdrawn: false, reason: "PROPOSAL_NOT_OPEN" });
    expect(state.slots.every((s) => s.completionStatus === "RESCHEDULED")).toBe(
      true,
    );
  });

  it("reports a lost CAS as PROPOSAL_NOT_OPEN, not as an error", async () => {
    seed();
    // The other party answers between the open-status read and the CAS. The
    // transition then matches zero rows and throws IllegalTransitionError —
    // a modelled outcome, so it must not reach Sentry or become a 500.
    tx.rescheduleRequest.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await withdrawRescheduleRequest({
      rescheduleRequestId: "req-1",
      withdrawnById: INITIATOR,
    });

    expect(result).toEqual({ withdrawn: false, reason: "PROPOSAL_NOT_OPEN" });
    expect(reportSentryError).not.toHaveBeenCalled();
  });

  it("puts a consultation back to APPROVED so it leaves the allocate queue", async () => {
    seed();

    await withdrawRescheduleRequest({
      rescheduleRequestId: "req-1",
      withdrawnById: INITIATOR,
    });

    expect(state.consultation?.status).toBe("APPROVED");
  });

  it("restores a WHOLE-subscription reschedule to APPROVED", async () => {
    // E2E-audit P1 fix. A whole-booking reschedule (no slotIds) flips the
    // subscription to PENDING via the reschedule route. Withdrawing used to
    // leave it there, stranded in the consultant's request queue, where
    // expirePendingSubscriptions could EXPIRE + fully refund a plan that
    // still owed — or had already delivered — sessions.
    seed({
      consultationId: null,
      subscriptionId: "sub-1",
      subscriptionStatus: "PENDING",
    });

    const result = await withdrawRescheduleRequest({
      rescheduleRequestId: "req-1",
      withdrawnById: INITIATOR,
    });

    expect(result).toEqual({ withdrawn: true });
    expect(state.subscription?.status).toBe("APPROVED");
    expect(tx.consultation.updateMany).not.toHaveBeenCalled();
    // The slots still restore alongside the parent.
    expect(state.slots.every((s) => s.completionStatus === "SCHEDULED")).toBe(
      true,
    );
  });

  it("leaves a PARTIAL subscription proposal's parent alone (#448)", async () => {
    // #448's guarantee survives: a partial (per-session) proposal never
    // flipped the parent, so it sits at APPROVED and the restore must not
    // touch it. The PENDING-only read is what distinguishes the two.
    seed({
      consultationId: null,
      subscriptionId: "sub-1",
      subscriptionStatus: "APPROVED",
    });

    const result = await withdrawRescheduleRequest({
      rescheduleRequestId: "req-1",
      withdrawnById: INITIATOR,
    });

    expect(result).toEqual({ withdrawn: true });
    expect(state.subscription?.status).toBe("APPROVED");
    expect(tx.subscription.updateMany).not.toHaveBeenCalled();
    expect(state.slots.every((s) => s.completionStatus === "SCHEDULED")).toBe(
      true,
    );
  });

  it("reports a partial restore instead of claiming success silently", async () => {
    // One row's status drifted, so the RESCHEDULED-filtered updateMany skips
    // it. The withdrawal is committed and correct, but the booking is
    // half-restored and nothing else would ever say so.
    seed({
      slots: [
        { id: "slot-1", isTentative: true, completionStatus: "RESCHEDULED" },
        { id: "slot-2", isTentative: true, completionStatus: "CANCELLED" },
      ],
    });

    const result = await withdrawRescheduleRequest({
      rescheduleRequestId: "req-1",
      withdrawnById: INITIATOR,
    });

    expect(result).toEqual({ withdrawn: true });
    expect(reportSentryError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("restored 1 of 2"),
      }),
      expect.objectContaining({ op: "reschedule-withdraw-partial" }),
    );
  });
});
