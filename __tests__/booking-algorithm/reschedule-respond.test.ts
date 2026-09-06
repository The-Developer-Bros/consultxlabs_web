/**
 * @jest-environment node
 */

/**
 * #1163 / #1169 PR 4 (API half) — the counterparty's answer to a reschedule
 * proposal, exercised as behavior.
 *
 * This is the only coverage for a new authorization path that moves a booking's
 * slots, so it drives the real `acceptProposal` / `declineProposal` and the real
 * route against a mocked Prisma and a mocked allocator, and asserts what they
 * DO: which times reach the allocator and under which lock, which CAS
 * transition is written and from which from-set, which slots are touched (none,
 * on decline — that is the module's documented contract), and which status code
 * each refusal answers with.
 *
 * `transitionRescheduleRequest` is deliberately NOT mocked: the from-state guard
 * it builds is the thing under test on the lost-race cases.
 */

const mockRequestFindUnique = jest.fn();
const mockRequestFindFirst = jest.fn();
const mockAllocate = jest.fn();
const mockGetSession = jest.fn();
const mockHasActiveDispute = jest.fn();
// #1166 ORG-9 — what isOrgAdminOfAppointment reads to tell a payer admin's
// initiation from a stranger's.
const mockMembershipFindUnique = jest.fn();
// #1340 — pass-through by default (set in beforeEach); one case makes it throw.
const mockWithAppointmentLock = jest.fn();
const passThroughLock = (...args: unknown[]) =>
  (args[1] as () => Promise<unknown>)();

const txStub = {
  rescheduleRequest: {
    updateMany: jest.fn(),
    findUnique: jest.fn().mockResolvedValue({ status: "PENDING_REVIEW" }),
  },
  bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  // Present so a decline that wrote slots would be caught rather than silently
  // passing: "the released slots stay released" is the contract.
  slotOfAppointment: { updateMany: jest.fn() },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(txStub),
    rescheduleRequest: {
      findUnique: (...a: unknown[]) => mockRequestFindUnique(...a),
      findFirst: (...a: unknown[]) => mockRequestFindFirst(...a),
    },
    membership: {
      findUnique: (...a: unknown[]) => mockMembershipFindUnique(...a),
    },
  },
}));

jest.mock("../../utils/slotAllocation/SlotAllocationService", () => ({
  SlotAllocationService: { allocate: (...a: unknown[]) => mockAllocate(...a) },
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}));

jest.mock("../../lib/payments/dispute-guard", () => ({
  hasActiveDisputeForAppointment: (...a: unknown[]) =>
    mockHasActiveDispute(...a),
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

// #1340 — the accept path now serializes on the appointment atom. The real
// module pulls @upstash/redis (ESM) in, so the lock is stubbed to a pass-through
// that records which appointment it was asked for; the two error classes are
// re-declared here because the route matches them with `instanceof`.
jest.mock("../../utils/appointmentlock", () => {
  class AppointmentBusyError extends Error {
    readonly httpStatus = 423 as const;
    readonly code = "APPOINTMENT_BUSY" as const;
    constructor(readonly appointmentId: string) {
      super("This appointment is being updated. Please try again in a moment.");
      this.name = "AppointmentBusyError";
    }
  }
  class BookingLockUnavailableError extends Error {
    readonly httpStatus = 503 as const;
    readonly code = "BOOKING_LOCK_UNAVAILABLE" as const;
    constructor(readonly context: string) {
      super(`Cannot secure a booking lock (${context}) right now.`);
      this.name = "BookingLockUnavailableError";
    }
  }
  return {
    AppointmentBusyError,
    BookingLockUnavailableError,
    withAppointmentLock: (...a: unknown[]) => mockWithAppointmentLock(...a),
  };
});

import fs from "fs";
import path from "path";

import {
  acceptProposal,
  declineProposal,
} from "@/lib/booking/reschedule-respond";
import { tryAutoConfirmProposal } from "@/lib/booking/reschedule-auto-confirm";
import { AppointmentBusyError } from "@/utils/appointmentlock";
import { POST as respondHandler } from "@/app/api/appointments/[appointmentId]/reschedule/respond/route";

const HOUR = 3_600_000;
const APPT = "appt-1";
const REQ = "resched-1";
const CONSULTANT_USER = "consultant-user-1";
const CONSULTEE_USER = "consultee-user-1";

function makeParams(id: string = APPT) {
  return { params: Promise.resolve({ appointmentId: id }) };
}

function makeRequest(body: Record<string, unknown> = { action: "accept" }) {
  return new Request(
    `http://localhost/api/appointments/${APPT}/reschedule/respond`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    },
  ) as never;
}

/** The row `acceptProposal` reads. Open and in-date unless told otherwise. */
function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQ,
    appointmentId: APPT,
    status: "PENDING_REVIEW",
    expiresAt: new Date(Date.now() + 48 * HOUR),
    proposedSlots: [
      { startsAt: new Date("2026-09-01T10:00:00.000Z") },
      { startsAt: new Date("2026-09-08T10:00:00.000Z") },
    ],
    ...overrides,
  };
}

/** The row the route reads: a CONSULTANT-initiated proposal on a consultation. */
function openRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQ,
    initiatedById: CONSULTANT_USER,
    appointment: {
      consultationId: "cons-1",
      subscriptionId: null,
      consultation: {
        requestedBy: { userId: CONSULTEE_USER },
        consultationPlan: { consultantProfile: { userId: CONSULTANT_USER } },
      },
      subscription: null,
    },
    ...overrides,
  };
}

function sessionOf(userId: string) {
  return { user: { id: userId } };
}

beforeEach(() => {
  jest.clearAllMocks();
  txStub.rescheduleRequest.updateMany.mockResolvedValue({ count: 1 });
  txStub.slotOfAppointment.updateMany.mockResolvedValue({ count: 0 });
  mockAllocate.mockResolvedValue({ success: true });
  mockHasActiveDispute.mockResolvedValue(false);
  mockRequestFindUnique.mockResolvedValue(proposalRow());
  mockRequestFindFirst.mockResolvedValue(openRequestRow());
  mockGetSession.mockResolvedValue(sessionOf(CONSULTEE_USER));
  mockMembershipFindUnique.mockResolvedValue(null);
  mockWithAppointmentLock.mockImplementation(passThroughLock);
});

describe("accept re-validates through the allocator before anything is written", () => {
  it("sends the proposed times through manual allocation under the wide lock", async () => {
    const out = await acceptProposal({
      rescheduleRequestId: REQ,
      eventType: "consultation",
      eventId: "cons-1",
      resolvedById: CONSULTEE_USER,
    });

    expect(out).toEqual({ done: true });
    // The exact machinery auto-confirm trusts: the allocator does the
    // availability / caps / conflict validation, so nothing is hand-written.
    expect(mockAllocate).toHaveBeenCalledWith({
      eventType: "consultation",
      eventId: "cons-1",
      mode: "manual",
      slots: ["2026-09-01T10:00:00.000Z", "2026-09-08T10:00:00.000Z"],
      // Day-sharded keys would let two concurrent confirmations pass a
      // per-week cap on stale counts.
      wideLock: true,
      // #1340 — the allocator must not close this proposal as superseded by
      // its own times.
      excludeRescheduleRequestId: REQ,
    });
  });

  it("finalizes ACCEPTED with a from-state guard, not a blind write", async () => {
    await acceptProposal({
      rescheduleRequestId: REQ,
      eventType: "consultation",
      eventId: "cons-1",
      resolvedById: CONSULTEE_USER,
    });

    const [args] = txStub.rescheduleRequest.updateMany.mock.calls[0] as [
      {
        where: { id: string; status: { in: string[] } };
        data: Record<string, unknown>;
      },
    ];
    expect(args.where.id).toBe(REQ);
    expect(args.where.status.in).toEqual(
      expect.arrayContaining(["PENDING_REVIEW", "COUNTERED"]),
    );
    // An already-expired row must not be reachable from the accept edge.
    expect(args.where.status.in).not.toContain("EXPIRED");
    expect(args.data).toMatchObject({
      status: "ACCEPTED",
      resolvedById: CONSULTEE_USER,
      openForAppointmentId: null,
    });
  });

  it("writes nothing and leaves the proposal open when the allocator refuses", async () => {
    mockAllocate.mockResolvedValue({
      success: false,
      errorCode: "SLOT_CONFLICT",
    });

    const out = await acceptProposal({
      rescheduleRequestId: REQ,
      eventType: "consultation",
      eventId: "cons-1",
      resolvedById: CONSULTEE_USER,
    });

    expect(out).toEqual({ done: false, reason: "SLOT_CONFLICT" });
    expect(txStub.rescheduleRequest.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a lapsed proposal before the allocator is asked", async () => {
    // The hourly expiry job leaves a lapsed proposal PENDING_REVIEW for up to
    // an hour. Expiry is min(now + 72h, earliest released session − 24h), so
    // accepting one is how a booking lands inside the 24-hour window the
    // reschedule route refuses to move it into.
    mockRequestFindUnique.mockResolvedValue(
      proposalRow({ expiresAt: new Date(Date.now() - HOUR) }),
    );

    const out = await acceptProposal({
      rescheduleRequestId: REQ,
      eventType: "consultation",
      eventId: "cons-1",
      resolvedById: CONSULTEE_USER,
    });

    expect(out).toEqual({ done: false, reason: "PROPOSAL_EXPIRED" });
    expect(mockAllocate).not.toHaveBeenCalled();
    expect(txStub.rescheduleRequest.updateMany).not.toHaveBeenCalled();
  });

  it("has nothing to accept on a preference-only request", async () => {
    mockRequestFindUnique.mockResolvedValue(proposalRow({ proposedSlots: [] }));

    const out = await acceptProposal({
      rescheduleRequestId: REQ,
      eventType: "consultation",
      eventId: "cons-1",
      resolvedById: CONSULTEE_USER,
    });

    expect(out).toEqual({ done: false, reason: "NO_PROPOSED_TIMES" });
    expect(mockAllocate).not.toHaveBeenCalled();
  });

  it("refuses a proposal that was already answered", async () => {
    mockRequestFindUnique.mockResolvedValue(
      proposalRow({ status: "WITHDRAWN" }),
    );

    const out = await acceptProposal({
      rescheduleRequestId: REQ,
      eventType: "consultation",
      eventId: "cons-1",
      resolvedById: CONSULTEE_USER,
    });

    expect(out).toEqual({ done: false, reason: "PROPOSAL_NOT_OPEN" });
    expect(mockAllocate).not.toHaveBeenCalled();
  });
});

/**
 * #1340 — a confirmation must not be superseded by its own times.
 *
 * The allocator's `resolveConsumedPreferenceRequests` closes every OPEN
 * proposal whose released slots the new times replace, because placing times
 * supersedes a competing ask. The confirming caller's own proposal matched that
 * predicate, so it was DECLINED inside the allocator's transaction and the
 * caller's following `PENDING_REVIEW → AUTO_ACCEPTED/ACCEPTED` CAS matched zero
 * rows. The booking moved either way: auto-confirm swallowed the
 * `IllegalTransitionError` and reported `autoConfirmed: false`, while the
 * explicit accept rethrew it as a 409 and never sent the MOVED notification.
 * Both callers now name their own proposal so the sweep skips exactly that row.
 */
describe("#1340 — a confirmation keeps the proposal it is confirming", () => {
  it("accept names its own proposal to the allocator and then closes it ACCEPTED", async () => {
    const out = await acceptProposal({
      rescheduleRequestId: REQ,
      eventType: "consultation",
      eventId: "cons-1",
      resolvedById: CONSULTEE_USER,
    });

    expect(out).toEqual({ done: true });
    expect(mockAllocate).toHaveBeenCalledWith(
      expect.objectContaining({ excludeRescheduleRequestId: REQ }),
    );
    const [args] = txStub.rescheduleRequest.updateMany.mock.calls[0] as [
      { where: { id: string }; data: Record<string, unknown> },
    ];
    expect(args.where.id).toBe(REQ);
    expect(args.data).toMatchObject({ status: "ACCEPTED" });
  });

  it("auto-confirm names its own proposal to the allocator and then closes it AUTO_ACCEPTED", async () => {
    mockRequestFindUnique.mockResolvedValue(
      proposalRow({
        initiatorRole: "CONSULTEE",
        releasedSlotIds: ["released-slot-1"],
        proposedSlots: [
          {
            startsAt: new Date("2026-09-01T10:00:00.000Z"),
            endsAt: new Date("2026-09-01T11:00:00.000Z"),
          },
        ],
      }),
    );

    const out = await tryAutoConfirmProposal(REQ, "consultation", "cons-1");

    expect(out).toEqual({ confirmed: true });
    // #1340 — auto-confirm holds the appointment atom across the allocation and
    // the AUTO_ACCEPTED write, like accept does.
    expect(mockWithAppointmentLock).toHaveBeenCalledWith(
      APPT,
      expect.any(Function),
    );
    expect(mockAllocate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "manual",
        wideLock: true,
        excludeRescheduleRequestId: REQ,
      }),
    );
    const [args] = txStub.rescheduleRequest.updateMany.mock.calls[0] as [
      {
        where: { id: string; status: { in: string[] } };
        data: Record<string, unknown>;
      },
    ];
    expect(args.where.id).toBe(REQ);
    expect(args.where.status.in).toEqual(["PENDING_REVIEW"]);
    expect(args.data).toMatchObject({
      status: "AUTO_ACCEPTED",
      openForAppointmentId: null,
    });
  });
});

describe("decline ends the request and leaves the released slots released", () => {
  it("transitions to DECLINED without touching a single slot", async () => {
    const out = await declineProposal({
      rescheduleRequestId: REQ,
      resolvedById: CONSULTEE_USER,
    });

    expect(out).toEqual({ done: true });
    const [args] = txStub.rescheduleRequest.updateMany.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(args.data).toMatchObject({
      status: "DECLINED",
      resolvedById: CONSULTEE_USER,
    });
    // The documented semantics: the initiator still wants to move, so the
    // booking belongs in the consultant's allocate queue. Restoring the slots
    // here is withdraw's job, not decline's.
    expect(txStub.slotOfAppointment.updateMany).not.toHaveBeenCalled();
    expect(mockAllocate).not.toHaveBeenCalled();
  });

  it("reports a lost CAS race as a conflict instead of throwing", async () => {
    txStub.rescheduleRequest.updateMany.mockResolvedValue({ count: 0 });

    const out = await declineProposal({
      rescheduleRequestId: REQ,
      resolvedById: CONSULTEE_USER,
    });

    expect(out).toEqual({ done: false, reason: "PROPOSAL_NOT_OPEN" });
  });
});

describe("the respond route answers 404 to everyone who is not the counterparty", () => {
  it("404s when the booking holds no open request", async () => {
    mockRequestFindFirst.mockResolvedValue(null);

    const res = await respondHandler(makeRequest(), makeParams());

    expect(res.status).toBe(404);
    expect(mockAllocate).not.toHaveBeenCalled();
  });

  it("404s a stranger rather than confirming the booking exists", async () => {
    mockGetSession.mockResolvedValue(sessionOf("someone-else"));

    const res = await respondHandler(makeRequest(), makeParams());

    expect(res.status).toBe(404);
    expect(mockAllocate).not.toHaveBeenCalled();
  });

  it("404s the initiator — they have withdraw, not accept", async () => {
    mockGetSession.mockResolvedValue(sessionOf(CONSULTANT_USER));

    const res = await respondHandler(makeRequest(), makeParams());

    expect(res.status).toBe(404);
    expect(mockAllocate).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await respondHandler(makeRequest(), makeParams());

    expect(res.status).toBe(401);
  });

  it("400s an action that is neither accept nor decline", async () => {
    const res = await respondHandler(
      makeRequest({ action: "maybe" }),
      makeParams(),
    );

    expect(res.status).toBe(400);
  });
});

describe("the respond route drives the loop for the counterparty", () => {
  it("accepts and reports the booking as moved", async () => {
    const res = await respondHandler(makeRequest(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(mockAllocate).toHaveBeenCalledTimes(1);
  });

  // #1340 — accept moves slots, so it belongs behind the same per-appointment
  // atom the cancel and reschedule routes take; a concurrent cancel and accept
  // used to interleave freely.
  it("serializes the accept on the appointment lock and answers 423 while it is held", async () => {
    await respondHandler(makeRequest(), makeParams());
    expect(mockWithAppointmentLock).toHaveBeenCalledWith(
      APPT,
      expect.any(Function),
    );

    mockWithAppointmentLock.mockImplementation(() => {
      throw new AppointmentBusyError(APPT);
    });
    const res = await respondHandler(makeRequest(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(423);
    expect(body.code).toBe("APPOINTMENT_BUSY");
    // The busy attempt never reached the allocator, so nothing moved.
    expect(mockAllocate).toHaveBeenCalledTimes(1);
  });

  it("declines without asking the allocator for anything", async () => {
    const res = await respondHandler(
      makeRequest({ action: "decline" }),
      makeParams(),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.declined).toBe(true);
    expect(mockAllocate).not.toHaveBeenCalled();
  });

  it("answers 422 — not 409 — when there are no concrete times to accept", async () => {
    mockRequestFindUnique.mockResolvedValue(proposalRow({ proposedSlots: [] }));

    const res = await respondHandler(makeRequest(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.code).toBe("NO_PROPOSED_TIMES");
  });

  it("answers 409 when the proposal lapsed before it was answered", async () => {
    mockRequestFindUnique.mockResolvedValue(
      proposalRow({ expiresAt: new Date(Date.now() - HOUR) }),
    );

    const res = await respondHandler(makeRequest(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("PROPOSAL_EXPIRED");
  });

  it("answers 409 when the allocator cannot confirm the times", async () => {
    mockAllocate.mockResolvedValue({
      success: false,
      errorCode: "OUTSIDE_AVAILABILITY",
    });

    const res = await respondHandler(makeRequest(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("OUTSIDE_AVAILABILITY");
  });

  it("resolves a subscription proposal against the subscription event", async () => {
    mockRequestFindFirst.mockResolvedValue(
      openRequestRow({
        appointment: {
          consultationId: null,
          subscriptionId: "sub-1",
          consultation: null,
          subscription: {
            requestedBy: { userId: CONSULTEE_USER },
            subscriptionPlan: {
              consultantProfile: { userId: CONSULTANT_USER },
            },
          },
        },
      }),
    );

    const res = await respondHandler(makeRequest(), makeParams());

    expect(res.status).toBe(200);
    expect(mockAllocate).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "subscription", eventId: "sub-1" }),
    );
  });
});

describe("#1008 — a disputed booking is frozen against acceptance", () => {
  it("refuses to move the slots while a payment dispute is live", async () => {
    mockHasActiveDispute.mockResolvedValue(true);

    const res = await respondHandler(makeRequest(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("DISPUTE_ACTIVE");
    expect(mockAllocate).not.toHaveBeenCalled();
  });

  it("still 404s a stranger, so the guard is not a dispute oracle", async () => {
    mockHasActiveDispute.mockResolvedValue(true);
    mockGetSession.mockResolvedValue(sessionOf("someone-else"));

    const res = await respondHandler(makeRequest(), makeParams());
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.code).toBeUndefined();
  });

  it("lets the counterparty decline — decline moves nothing", async () => {
    mockHasActiveDispute.mockResolvedValue(true);

    const res = await respondHandler(
      makeRequest({ action: "decline" }),
      makeParams(),
    );

    expect(res.status).toBe(200);
  });
});

/**
 * #1166 ORG-9 — three openers, not two.
 *
 * "The counterparty" used to mean "a participant who is not the initiator",
 * which reads correctly only while the initiator IS one of the two
 * participants. An org admin rescheduling a session their organization funded
 * matches neither profile, so the test was true for BOTH parties at once: the
 * consultee could accept a proposal opened on their own behalf, and either
 * party could confirm a move the other had never seen. An org admin acts on the
 * payer's side, so the consultant is the one who answers.
 */
describe("who counts as the counterparty", () => {
  const ORG_ADMIN_USER = "org-admin-user-1";
  const ORG = "org-acme";

  function orgFundedRow(initiatedById: string) {
    return openRequestRow({
      initiatedById,
      appointment: {
        consultationId: "cons-1",
        subscriptionId: null,
        organizationId: ORG,
        consultation: {
          requestedBy: { userId: CONSULTEE_USER },
          consultationPlan: { consultantProfile: { userId: CONSULTANT_USER } },
        },
        subscription: null,
      },
    });
  }

  it("consultant opened it — the consultee answers, the consultant cannot", async () => {
    mockRequestFindFirst.mockResolvedValue(orgFundedRow(CONSULTANT_USER));

    mockGetSession.mockResolvedValue(sessionOf(CONSULTEE_USER));
    expect((await respondHandler(makeRequest(), makeParams())).status).toBe(
      200,
    );

    mockGetSession.mockResolvedValue(sessionOf(CONSULTANT_USER));
    expect((await respondHandler(makeRequest(), makeParams())).status).toBe(
      404,
    );
  });

  it("consultee opened it — the consultant answers, the consultee cannot", async () => {
    mockRequestFindFirst.mockResolvedValue(orgFundedRow(CONSULTEE_USER));

    mockGetSession.mockResolvedValue(sessionOf(CONSULTANT_USER));
    expect((await respondHandler(makeRequest(), makeParams())).status).toBe(
      200,
    );

    mockGetSession.mockResolvedValue(sessionOf(CONSULTEE_USER));
    expect((await respondHandler(makeRequest(), makeParams())).status).toBe(
      404,
    );
  });

  it("an org admin opened it — that is a payer-side act, so only the consultant answers", async () => {
    mockRequestFindFirst.mockResolvedValue(orgFundedRow(ORG_ADMIN_USER));
    mockMembershipFindUnique.mockResolvedValue({
      status: "ACTIVE",
      role: "OWNER",
    });

    mockGetSession.mockResolvedValue(sessionOf(CONSULTANT_USER));
    expect((await respondHandler(makeRequest(), makeParams())).status).toBe(
      200,
    );

    // The regression: pre-fix this was 200, letting the sponsored learner
    // confirm a move made on their own behalf.
    mockGetSession.mockResolvedValue(sessionOf(CONSULTEE_USER));
    expect((await respondHandler(makeRequest(), makeParams())).status).toBe(
      404,
    );

    expect(mockMembershipFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_organizationId: {
            userId: ORG_ADMIN_USER,
            organizationId: ORG,
          },
        },
      }),
    );
  });

  it("an initiator who is neither party nor a payer admin leaves nobody able to answer", async () => {
    // Fail closed: a proposal from an unidentifiable opener must not be
    // confirmable by whoever asks first.
    mockRequestFindFirst.mockResolvedValue(orgFundedRow("stranger-user"));
    mockMembershipFindUnique.mockResolvedValue({
      status: "ACTIVE",
      role: "LEARNER",
    });

    for (const who of [CONSULTANT_USER, CONSULTEE_USER]) {
      mockGetSession.mockResolvedValue(sessionOf(who));
      expect((await respondHandler(makeRequest(), makeParams())).status).toBe(
        404,
      );
    }
  });
});

/**
 * Wiring checks, deliberately not behavioral: these two side-effects fire in
 * the participants routes and the Razorpay webhook handler, which own their own
 * suites and harnesses. What this PR changed is that the calls exist at all, so
 * that is what is guarded here.
 */
describe("lifecycle hygiene wiring", () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(process.cwd(), rel), "utf8");

  it("removed attendees lose event-channel access at refund time", () => {
    for (const rel of [
      "app/api/participants/webinar/[webinarId]/route.ts",
      "app/api/participants/class/[classId]/route.ts",
    ]) {
      expect(read(rel)).toContain("removeUserFromEventChannel(");
    }
  });

  it("the booked notification carries the session time (#1085)", () => {
    const handlers = read("lib/payments/webhooks/handlers.ts");
    // B9 — the notification is SKIPPED when no slot exists yet (a
    // subscription placeholder rendered a blank date placeholder), and when
    // it fires the time is guaranteed present (non-optional chain).
    expect(handlers).toContain(
      "appointment_booked_notification_skipped_no_slots",
    );
    expect(handlers).toContain("dateTime: firstSlot.startsAt.toISOString()");
  });
});
