/**
 * @jest-environment node
 */

/**
 * #1080 — the planner's class Join always reported "No joinable session found
 * for this class". `classInclude` was `appointments: true`, so the slot rows
 * the component derives the session from never left the database, the `?? []`
 * fallback swallowed the absence, and the message was indistinguishable from
 * the legitimate out-of-window case.
 *
 * The failure was a silently empty array, so asserting a boolean would not
 * have caught it. This drives the real route over a fake Postgres that
 * PROJECTS each row through the include the route hands it — a field the route
 * does not ask for cannot reach the payload — and then runs the real session
 * helpers over the result, which is what the component does.
 */

import { GET } from "../../app/api/dashboard/consultant/[consultantId]/planner/route";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import {
  getCurrentOrNextSession,
  getJoinableSession,
  getSessionJoinState,
} from "@/lib/appointments/slots";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: jest.fn(),
  isPrivileged: () => false,
  forbiddenResponse: jest.fn(),
}));
jest.mock("../../lib/api/scope/parse", () => ({
  __esModule: true,
  resolveOrgScope: () => ({ ok: true, scope: { kind: "all" } }),
  scopeOrgId: () => null,
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webinar: { findMany: jest.fn() },
    class: { findMany: jest.fn() },
    collaborator: { findMany: jest.fn() },
    consultantProfile: { findUnique: jest.fn() },
    membership: { findMany: jest.fn() },
    slotOfAppointment: { groupBy: jest.fn() },
  },
}));

const db = prisma as unknown as {
  webinar: { findMany: jest.Mock };
  class: { findMany: jest.Mock };
  collaborator: { findMany: jest.Mock };
  consultantProfile: { findUnique: jest.Mock };
  membership: { findMany: jest.Mock };
  slotOfAppointment: { groupBy: jest.Mock };
};
const mockedAuth = requireApiAuth as unknown as jest.Mock;

const CONSULTANT_PROFILE_ID = "cp-1";
const NOW = new Date("2026-08-01T10:20:00.000Z");
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

/** A slot row as Postgres holds it, before any select is applied. */
interface StoredSlot {
  id: string;
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  completionStatus: string;
  deletedAt: Date | null;
  meetingSession: {
    id: string;
    endedAt: Date | null;
    endedReason: string | null;
  } | null;
  user: Array<{ id: string }>;
}

interface StoredAppointment {
  id: string;
  organizationId: string | null;
  slotsOfAppointment: StoredSlot[];
}

function storedSlot(
  id: string,
  startsAt: Date,
  extra: Partial<StoredSlot> = {},
): StoredSlot {
  return {
    id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    isTentative: false,
    completionStatus: "SCHEDULED",
    deletedAt: null,
    meetingSession: null,
    user: [{ id: "user-attendee" }],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// The fake Postgres: honours the include it is given, so an unasked-for field
// is genuinely absent rather than assumed present.
// ---------------------------------------------------------------------------

interface SlotSpec {
  where?: { startsAt?: { gte?: Date; lte?: Date } };
  select?: Record<string, true | { select: Record<string, true> }>;
}
interface ClassIncludeSpec {
  appointments?: true | { include?: { slotsOfAppointment?: SlotSpec } };
}

function projectSlots(spec: SlotSpec, slots: StoredSlot[]) {
  const { gte, lte } = spec.where?.startsAt ?? {};
  return slots
    .filter(
      (slot) =>
        (!gte || slot.startsAt >= gte) && (!lte || slot.startsAt <= lte),
    )
    .map((slot) => {
      if (!spec.select) return slot;
      const projected: Record<string, unknown> = {};
      for (const field of Object.keys(spec.select)) {
        projected[field] = slot[field as keyof StoredSlot] ?? null;
      }
      return projected;
    });
}

let classRows: Array<{
  id: string;
  classPlanId: string;
  classPlan: Record<string, unknown>;
  appointments: StoredAppointment[];
}> = [];

function seedClass(appointments: StoredAppointment[]) {
  classRows = [
    {
      id: "class-1",
      classPlanId: "plan-1",
      classPlan: {
        id: "plan-1",
        title: "Systems design, eight weeks",
        consultantProfileId: CONSULTANT_PROFILE_ID,
        topics: [{ name: "architecture" }],
        classContents: [],
      },
      appointments,
    },
  ];
}

beforeEach(() => {
  // The route bounds its slot window with `classInclude(new Date())`, while
  // these rows are anchored to NOW. Without pinning the clock the suite passes
  // only on the day NOW happens to fall on.
  jest.useFakeTimers({ doNotFake: ["performance"] });
  jest.setSystemTime(NOW);
  mockedAuth.mockResolvedValue({
    session: {
      user: {
        id: "user-consultant",
        role: "USER",
        consultantProfileId: CONSULTANT_PROFILE_ID,
      },
    },
  });
  db.webinar.findMany.mockResolvedValue([]);
  db.collaborator.findMany.mockResolvedValue([]);
  db.membership.findMany.mockResolvedValue([]);
  db.consultantProfile.findUnique.mockResolvedValue({
    userId: "user-consultant",
  });

  // #1346 — the unwindowed firstSessionAt lookup; unlike classInclude's
  // slot select, this reads every row regardless of the ±24h window.
  // The mock applies the predicates the route actually sends, so a regression
  // that drops the deletedAt or completionStatus filter fails here instead of
  // being masked by a filter the mock invented.
  db.slotOfAppointment.groupBy.mockImplementation(
    async (args: {
      where: {
        appointmentId: { in: string[] };
        deletedAt?: null;
        completionStatus?: { notIn: string[] };
      };
    }) => {
      const ids = new Set(args.where.appointmentId.in);
      const excludedStatuses = new Set(
        args.where.completionStatus?.notIn ?? [],
      );
      const requiresNotDeleted = "deletedAt" in args.where;
      const results: Array<{
        appointmentId: string;
        _min: { startsAt: Date };
      }> = [];
      for (const row of classRows) {
        for (const appt of row.appointments) {
          if (!ids.has(appt.id)) continue;
          const live = appt.slotsOfAppointment.filter(
            (slot) =>
              !excludedStatuses.has(slot.completionStatus) &&
              (!requiresNotDeleted || slot.deletedAt === null),
          );
          const earliest = live.reduce<Date | null>(
            (min, slot) => (!min || slot.startsAt < min ? slot.startsAt : min),
            null,
          );
          if (earliest) {
            results.push({
              appointmentId: appt.id,
              _min: { startsAt: earliest },
            });
          }
        }
      }
      return results;
    },
  );

  db.class.findMany.mockImplementation(
    async (args: {
      include?: ClassIncludeSpec;
      where?: { classPlan?: { consultantProfileId?: string } };
    }) => {
      // No include means the participant-count query, which uses `select`.
      if (!args.include) {
        return classRows.map((row) => ({
          id: row.id,
          appointments: row.appointments.map((appt) => ({
            slotsOfAppointment: appt.slotsOfAppointment.map((slot) => ({
              user: slot.user,
            })),
          })),
        }));
      }
      // Only the owned-plans query matches; the collaborated one returns none.
      if (
        args.where?.classPlan?.consultantProfileId !== CONSULTANT_PROFILE_ID
      ) {
        return [];
      }
      const spec = args.include.appointments;
      const slotSpec =
        spec === true ? undefined : spec?.include?.slotsOfAppointment;
      return classRows.map((row) => ({
        ...row,
        appointments: row.appointments.map((appt) => {
          const { slotsOfAppointment, ...scalars } = appt;
          // `appointments: true` — scalars only, and no slots at all. This is
          // the shape the route used to ask for.
          return slotSpec
            ? {
                ...scalars,
                slotsOfAppointment: projectSlots(slotSpec, slotsOfAppointment),
              }
            : scalars;
        }),
      }));
    },
  );
});

/** A slot row as it survives the route's JSON serialization. */
interface PayloadSlot {
  id: string;
  startsAt: string;
  endsAt: string | null;
  isTentative: boolean;
  completionStatus: string;
  meetingSession: {
    id: string;
    endedAt: string | null;
    endedReason: string | null;
  } | null;
}

async function plannerClasses() {
  const res = await GET(
    new Request(
      `http://localhost/api/dashboard/consultant/${CONSULTANT_PROFILE_ID}/planner`,
    ) as never,
    { params: Promise.resolve({ consultantId: CONSULTANT_PROFILE_ID }) },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data.classes as Array<{
    id: string;
    firstSessionAt: string | null;
    appointments: Array<{
      id: string;
      slotsOfAppointment?: PayloadSlot[];
    }>;
  }>;
}

/** A one-hour sitting, live right now: two contiguous 30-minute rows. */
const liveSitting = (extra: Partial<StoredSlot> = {}): StoredAppointment => ({
  id: "appt-live",
  organizationId: null,
  slotsOfAppointment: [
    storedSlot("slot-a1", hoursFromNow(-0.5), extra),
    storedSlot("slot-a2", hoursFromNow(0), extra),
  ],
});

describe("the planner payload carries what a class join reads", () => {
  it("returns the slot rows at all, with exactly the join path's fields", async () => {
    seedClass([liveSitting()]);

    const [cls] = await plannerClasses();
    const slots = cls.appointments[0].slotsOfAppointment;

    expect(slots).toHaveLength(2);
    // An exact key set, both ways: the join path's fields are all present, and
    // nothing the route trimmed on purpose has crept back in.
    expect(Object.keys(slots![0]).sort()).toEqual([
      "completionStatus",
      "endsAt",
      "id",
      "isTentative",
      "meetingSession",
      "startsAt",
    ]);
  });

  it("resolves to the run's anchor, not whichever row came first", async () => {
    seedClass([liveSitting()]);

    const [cls] = await plannerClasses();
    const run = getJoinableSession(cls.appointments[0].slotsOfAppointment!, {
      joinWindowMs: 10 * 60 * 1000,
      now: NOW,
    });

    expect(run).not.toBeNull();
    // The room is keyed to this id (#1061); before #1080 there was no run at
    // all, so the class Join could never even get here.
    expect(run!.anchor.id).toBe("slot-a1");
  });

  it("sees a host-ended call rather than only the clock", async () => {
    // The `meetingSession` select is what makes the ended guard reachable:
    // both rows are still inside their window, so the clock alone says
    // "joinable".
    seedClass([
      liveSitting({
        meetingSession: {
          id: "ms-1",
          endedAt: hoursFromNow(-0.1),
          endedReason: null,
        },
      }),
    ]);

    const [cls] = await plannerClasses();
    const slots = cls.appointments[0].slotsOfAppointment!;
    const run = getCurrentOrNextSession(slots, NOW);

    expect(run).not.toBeNull();
    expect(
      getSessionJoinState(run!, { joinWindowMs: 10 * 60 * 1000, now: NOW }),
    ).toBe("ended");
  });

  it("drops rows a day out while keeping the live run whole", async () => {
    seedClass([
      liveSitting(),
      {
        id: "appt-next-month",
        organizationId: null,
        slotsOfAppointment: [storedSlot("slot-far", hoursFromNow(24 * 30))],
      },
    ]);

    const [cls] = await plannerClasses();
    const ids = cls.appointments.flatMap((appt) =>
      (appt.slotsOfAppointment ?? []).map((slot) => slot.id as string),
    );

    // Truncating a run mid-way would re-split the room #1061 closed, so the
    // bound has to keep every row of anything currently joinable.
    expect(ids).toEqual(["slot-a1", "slot-a2"]);
  });

  it("names the class's first session even when every slot is outside the join window", async () => {
    // #1346 — a class whose only session is 5 days out gets zero slots from
    // classInclude's ±24h window, so the card's date must come from the
    // separate, unwindowed firstSessionAt field.
    const farStart = hoursFromNow(24 * 5);
    seedClass([
      {
        id: "appt-far",
        organizationId: null,
        slotsOfAppointment: [storedSlot("slot-far", farStart)],
      },
    ]);

    const [cls] = await plannerClasses();

    expect(cls.appointments[0].slotsOfAppointment).toHaveLength(0);
    expect(cls.firstSessionAt).toBe(farStart.toISOString());
  });

  it("still counts participants from its own batched query", async () => {
    // The slot select carries no `user`, so the count must not have silently
    // moved onto the trimmed rows.
    seedClass([liveSitting()]);

    const res = await GET(
      new Request(
        `http://localhost/api/dashboard/consultant/${CONSULTANT_PROFILE_ID}/planner`,
      ) as never,
      { params: Promise.resolve({ consultantId: CONSULTANT_PROFILE_ID }) },
    );
    const body = await res.json();

    expect(body.data.participantCounts["class-1"]).toBe(1);
  });
});

afterEach(() => {
  jest.useRealTimers();
});
