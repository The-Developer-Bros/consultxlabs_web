/**
 * @jest-environment node
 */

/**
 * #1319 PR 8 / #448 — the audit-trail read model.
 *
 * Two properties are pinned. The timeline is the MERGE of two sources, so a
 * reschedule proposal has to interleave with the status log by timestamp
 * rather than land in a block at either end; and the read is privileged-only,
 * so an organization or personal scope must be refused before a single query
 * runs (ADR 20 — org roles get no per-session drill-in).
 */

import { getBookingTimeline } from "../../lib/data/booking-history";

const appointmentFindUnique = jest.fn();
const historyFindMany = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findUnique: (args: unknown) => appointmentFindUnique(args),
    },
    bookingStatusHistory: {
      findMany: (args: unknown) => historyFindMany(args),
    },
  },
}));

const PRIVILEGED = { kind: "all" } as const;

function appointmentRow() {
  return {
    id: "appt-1",
    consultationId: "consult-1",
    subscriptionId: null,
    webinarId: null,
    classId: null,
    trialSession: null,
    slotsOfAppointment: [{ id: "slot-1" }],
    rescheduleRequests: [
      {
        id: "resched-1",
        status: "ACCEPTED",
        round: 1,
        reason: "clashes with a standup",
        initiatorRole: "CONSULTEE",
        // Deliberately BETWEEN the two history rows below.
        createdAt: new Date("2026-09-02T11:00:00.000Z"),
        resolvedAt: new Date("2026-09-02T12:00:00.000Z"),
        initiatedBy: { id: "user-1", name: "Asha" },
        _count: { proposedSlots: 3 },
      },
    ],
  };
}

function historyRows() {
  return [
    {
      id: "hist-2",
      entity: "SLOT",
      entityId: "slot-1",
      fromStatus: "SCHEDULED",
      toStatus: "RESCHEDULED",
      reason: null,
      createdAt: new Date("2026-09-02T12:00:00.000Z"),
      actorUser: null,
    },
    {
      id: "hist-1",
      entity: "CONSULTATION",
      entityId: "consult-1",
      fromStatus: "PENDING",
      toStatus: "APPROVED",
      reason: "approved by the consultant",
      createdAt: new Date("2026-09-02T10:00:00.000Z"),
      actorUser: { id: "user-2", name: "Ravi" },
    },
  ];
}

describe("getBookingTimeline", () => {
  beforeEach(() => {
    appointmentFindUnique.mockResolvedValue(appointmentRow());
    historyFindMany.mockResolvedValue(historyRows());
  });

  it("merges status history with reschedule proposals, newest first", async () => {
    const timeline = await getBookingTimeline("appt-1", PRIVILEGED);

    expect(timeline).not.toBeNull();
    expect(timeline!.entries.map((entry) => entry.id)).toEqual([
      "hist-2",
      "resched-1",
      "hist-1",
    ]);

    const [slotMove, proposal, approval] = timeline!.entries;
    expect(slotMove).toMatchObject({
      kind: "status",
      entity: "SLOT",
      from: "SCHEDULED",
      to: "RESCHEDULED",
      actor: null,
    });
    // The proposal is the row the RescheduleRequest table contributes: no
    // from-state, and the proposed-time count the #448 ask named.
    expect(proposal).toMatchObject({
      kind: "reschedule",
      entity: "RESCHEDULE_REQUEST",
      from: null,
      to: "ACCEPTED",
      proposedSlotCount: 3,
      round: 1,
      actor: { id: "user-1", name: "Asha" },
    });
    expect(approval).toMatchObject({ kind: "status", to: "APPROVED" });
    expect(timeline!.truncated).toBe(false);

    // The trail is resolved by entityId, not by the (always NULL) appointmentId
    // column — the SLOT and RESCHEDULE_REQUEST rows only surface because of it.
    // Each id is paired with the entity its writer stamps, so a same-id row of
    // another type cannot enter another appointment's trail.
    const call = historyFindMany.mock.calls[0][0];
    expect(call.where.OR).toEqual([
      { appointmentId: "appt-1" },
      { entity: "CONSULTATION", entityId: { in: ["consult-1"] } },
      { entity: "SLOT", entityId: { in: ["slot-1"] } },
      { entity: "RESCHEDULE_REQUEST", entityId: { in: ["resched-1"] } },
    ]);
    // The window is cut in the database, so equal timestamps need a second key.
    expect(call.orderBy).toEqual([{ createdAt: "desc" }, { id: "asc" }]);
  });

  it("flags truncation when the merge overflows the limit", async () => {
    // Exactly the limit in status rows, so the over-fetch check alone sees
    // nothing: the proposal merged in is what pushes an event off the end.
    historyFindMany.mockResolvedValue(
      Array.from({ length: 200 }, (_, index) => ({
        id: `hist-${String(index).padStart(3, "0")}`,
        entity: "SLOT",
        entityId: "slot-1",
        fromStatus: "SCHEDULED",
        toStatus: "COMPLETED",
        reason: null,
        createdAt: new Date(Date.UTC(2026, 8, 2, 13, 0, index)),
        actorUser: null,
      })),
    );

    const timeline = await getBookingTimeline("appt-1", PRIVILEGED);

    expect(timeline!.entries).toHaveLength(200);
    expect(timeline!.truncated).toBe(true);
  });

  it("never selects an actor's email", async () => {
    await getBookingTimeline("appt-1", PRIVILEGED);

    const actorSelect =
      historyFindMany.mock.calls[0][0].select.actorUser.select;
    expect(actorSelect).toEqual({ id: true, name: true });
  });

  it("refuses a non-privileged scope before touching the database", async () => {
    await expect(
      // Cast: the type signature already rejects this, and the throw is the
      // backstop for an untyped caller.
      getBookingTimeline("appt-1", { kind: "org", orgId: "org-1" } as never),
    ).rejects.toThrow(/privileged-only/i);

    await expect(
      getBookingTimeline("appt-1", { kind: "personal" } as never),
    ).rejects.toThrow(/privileged-only/i);

    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(historyFindMany).not.toHaveBeenCalled();
  });

  it("returns null for an appointment that does not exist", async () => {
    appointmentFindUnique.mockResolvedValue(null);
    await expect(getBookingTimeline("missing", PRIVILEGED)).resolves.toBeNull();
    expect(historyFindMany).not.toHaveBeenCalled();
  });
});
