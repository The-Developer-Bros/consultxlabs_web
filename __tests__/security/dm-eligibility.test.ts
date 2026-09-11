/**
 * The gate that decides whether two people may hold a direct message.
 *
 * This is the check that did not exist. `createDirectMessageChannel` validated
 * two non-empty strings and nothing else — no session, no relationship query,
 * not even `a !== b` — and was safe only because every caller happened to be a
 * booking-approval or payment-success path. An implementation of the rule DID
 * exist (`checkUserRelationship`) with a full unit-test suite and zero
 * production call sites.
 *
 * What is pinned here is the behaviour that made the difference between the old
 * advisory flag and a real gate:
 *   - the widened, unified status set (the three copies disagreed);
 *   - both directions, because one person can hold both profiles;
 *   - soft-deleted slots do not count;
 *   - a self-pair is refused without a query;
 *   - a failed lookup throws rather than answering "not related".
 */
import { DM_ELIGIBLE_STATUSES } from "@/lib/stream/dm-eligibility-statuses";

// Declared inline rather than pulled from `__tests__/stream/__mocks__`: the
// shared helper covers the whole Stream surface, and `jest/no-mocks-import`
// bars importing it from outside that directory. Four models is little enough
// to state here, and it keeps what this suite depends on visible.
const mockPrisma = {
  user: { findUnique: jest.fn() },
  consultation: { findFirst: jest.fn(), findMany: jest.fn() },
  subscription: { findFirst: jest.fn(), findMany: jest.fn() },
  slotOfAppointment: { findFirst: jest.fn() },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: mockPrisma,
}));

const CONSULTANT = {
  consultantProfileId: "cp-1",
  consulteeProfileId: null,
};
const CONSULTEE = {
  consultantProfileId: null,
  consulteeProfileId: "ce-1",
};
/** One person holding both profiles — an ordinary shape, not an edge case. */
const DUAL = {
  consultantProfileId: "cp-dual",
  consulteeProfileId: "ce-dual",
};

/** Nothing found anywhere unless a test says otherwise. */
function noRelationships() {
  mockPrisma.consultation.findFirst.mockResolvedValue(null);
  mockPrisma.subscription.findFirst.mockResolvedValue(null);
  mockPrisma.slotOfAppointment.findFirst.mockResolvedValue(null);
}

function bothUsersExist(a: unknown, b: unknown) {
  mockPrisma.user.findUnique.mockResolvedValueOnce(a).mockResolvedValueOnce(b);
}

async function load() {
  return import("../../lib/stream/dm-eligibility");
}

describe("canDirectMessage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    noRelationships();
  });

  it("permits a pair with a consultation", async () => {
    bothUsersExist(CONSULTANT, CONSULTEE);
    mockPrisma.consultation.findFirst.mockResolvedValue({ id: "c-1" });

    const { canDirectMessage } = await load();
    await expect(canDirectMessage("consultant-u", "consultee-u")).resolves.toBe(
      true,
    );
  });

  it("permits a pair with a subscription", async () => {
    bothUsersExist(CONSULTANT, CONSULTEE);
    mockPrisma.subscription.findFirst.mockResolvedValue({ id: "s-1" });

    const { canDirectMessage } = await load();
    await expect(canDirectMessage("consultant-u", "consultee-u")).resolves.toBe(
      true,
    );
  });

  it("refuses a pair sharing ONLY an event slot (no consultee↔consultee DMs)", async () => {
    // The group arm was removed from the gate: with `POST /api/stream/channels/open`
    // live, co-membership of one event slot WOULD be a user-reachable path to a
    // peer DM, which the moderation ADR forbids. Host↔attendee DMs are not
    // offered by any surface either — event rows open the team channel.
    bothUsersExist(CONSULTEE, CONSULTEE);
    mockPrisma.slotOfAppointment.findFirst.mockResolvedValue({ id: "slot-1" });

    const { canDirectMessage } = await load();
    await expect(canDirectMessage("attendee-a", "attendee-b")).resolves.toBe(
      false,
    );
    // The slot table is no longer consulted at all.
    expect(mockPrisma.slotOfAppointment.findFirst).not.toHaveBeenCalled();
  });

  it("refuses two strangers", async () => {
    bothUsersExist(CONSULTANT, CONSULTEE);

    const { canDirectMessage } = await load();
    await expect(canDirectMessage("stranger-a", "stranger-b")).resolves.toBe(
      false,
    );
  });

  it("refuses when either user does not exist", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const { canDirectMessage } = await load();
    await expect(canDirectMessage("ghost-a", "ghost-b")).resolves.toBe(false);
  });

  it("refuses a self-pair without querying at all", async () => {
    const { canDirectMessage } = await load();

    await expect(canDirectMessage("same", "same")).resolves.toBe(false);
    // The cheapest check runs first. It also has to run BEFORE the profile
    // lookup, because a dual-profile user genuinely does satisfy both arms of
    // every relationship query against themselves.
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("propagates a lookup failure instead of answering false", async () => {
    mockPrisma.user.findUnique.mockRejectedValue(new Error("DB down"));

    const { canDirectMessage } = await load();
    // The old implementation caught this and returned `false`. As an unused
    // advisory flag that was harmless; as the gate on channel creation it means
    // a transient blip denies a real conversation, and on the reconcile path it
    // makes a live channel look unexpected and therefore sweepable.
    await expect(canDirectMessage("a", "b")).rejects.toThrow("DB down");
  });
});

describe("the status set the gate queries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    noRelationships();
  });

  it("is the shared ever-transacted set, not a narrower literal", async () => {
    bothUsersExist(CONSULTANT, CONSULTEE);

    const { canDirectMessage } = await load();
    await canDirectMessage("consultant-u", "consultee-u");

    expect(mockPrisma.consultation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: [...DM_ELIGIBLE_STATUSES] },
        }),
      }),
    );
  });

  it("includes COMPLETED and APPROVED_PENDING_PAYMENT", () => {
    // The two the reconciler and the old gate omitted while search included
    // them. That gap is what produced search rows whose channel had never been
    // created — which `channel.watch()` then created, memberless.
    expect(DM_ELIGIBLE_STATUSES).toContain("COMPLETED");
    expect(DM_ELIGIBLE_STATUSES).toContain("APPROVED_PENDING_PAYMENT");
  });

  it("excludes PENDING", () => {
    // Otherwise anyone opens a channel with anyone by requesting a booking they
    // never intend to pay for.
    expect(DM_ELIGIBLE_STATUSES).not.toContain("PENDING");
  });

  it("does not bound subscriptions by their scheduling window", async () => {
    bothUsersExist(CONSULTANT, CONSULTEE);

    const { canDirectMessage } = await load();
    await canDirectMessage("consultant-u", "consultee-u");

    const where = mockPrisma.subscription.findFirst.mock.calls[0][0].where;
    // A lapsed subscription is still a relationship that happened. The window
    // filter used to make the thread unreachable at midnight on the renewal
    // date, mid-conversation and with no notice to either party.
    expect(where).not.toHaveProperty("schedulingPeriodEndsAt");
  });
});

describe("both directions are checked", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    noRelationships();
  });

  it("finds the link when the caller is the consultee", async () => {
    bothUsersExist(CONSULTEE, CONSULTANT);
    mockPrisma.consultation.findFirst.mockResolvedValue({ id: "c-1" });

    const { canDirectMessage } = await load();
    await expect(canDirectMessage("consultee-u", "consultant-u")).resolves.toBe(
      true,
    );
  });

  it("builds both direction clauses for a dual-profile pair", async () => {
    bothUsersExist(DUAL, DUAL);

    const { canDirectMessage } = await load();
    await canDirectMessage("dual-a", "dual-b");

    const where = mockPrisma.consultation.findFirst.mock.calls[0][0].where;
    // Reading only one direction silently denied every pair where the
    // "consultant" side happened to be listed second.
    expect(where.OR).toHaveLength(2);
  });
});

describe("assertCanDirectMessage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    noRelationships();
  });

  it("resolves quietly when permitted", async () => {
    bothUsersExist(CONSULTANT, CONSULTEE);
    mockPrisma.consultation.findFirst.mockResolvedValue({ id: "c-1" });

    const { assertCanDirectMessage } = await load();
    await expect(
      assertCanDirectMessage("consultant-u", "consultee-u"),
    ).resolves.toBeUndefined();
  });

  it("throws a typed error carrying both ids when refused", async () => {
    bothUsersExist(CONSULTANT, CONSULTEE);

    const { assertCanDirectMessage, DmNotPermittedError } = await load();
    await expect(
      assertCanDirectMessage("stranger-a", "stranger-b"),
    ).rejects.toBeInstanceOf(DmNotPermittedError);
  });
});

describe("buildDirections is shared, not duplicated", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    noRelationships();
  });

  // The two link checks used to carry byte-identical copies of the
  // direction-building. Asserting both produce the same OR shape is what stops
  // a fix landing in one and not the other.
  it("consultation and subscription build the same directions", async () => {
    bothUsersExist(DUAL, DUAL);

    const { canDirectMessage } = await load();
    await canDirectMessage("dual-a", "dual-b");

    const consultationOr =
      mockPrisma.consultation.findFirst.mock.calls[0][0].where.OR;
    const subscriptionOr =
      mockPrisma.subscription.findFirst.mock.calls[0][0].where.OR;

    expect(consultationOr).toHaveLength(subscriptionOr.length);
    expect(
      consultationOr.map((d: { requestedById: string }) => d.requestedById),
    ).toEqual(
      subscriptionOr.map((d: { requestedById: string }) => d.requestedById),
    );
  });
});


describe("pairBookingContexts (org-forgery guard)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    noRelationships();
  });

  it("returns only org contexts the pair actually holds", async () => {
    bothUsersExist(CONSULTANT, CONSULTEE);
    mockPrisma.consultation.findMany.mockResolvedValue([
      { consultationPlan: { organizationId: "org-real" }, appointment: null },
    ]);
    mockPrisma.subscription.findMany.mockResolvedValue([]);

    const { pairBookingContexts } = await load();
    const ctx = await pairBookingContexts("a", "b");

    // The whole point: an arbitrary org id ("org-fake") can never be named,
    // because the allowed set is derived from the bookings themselves.
    expect(ctx).toEqual({ personalAllowed: false, organizations: ["org-real"] });
  });

  it("marks personal context when a booking has no org", async () => {
    bothUsersExist(CONSULTANT, CONSULTEE);
    mockPrisma.consultation.findMany.mockResolvedValue([
      {
        consultationPlan: { organizationId: null },
        appointment: { organizationId: null },
      },
    ]);
    mockPrisma.subscription.findMany.mockResolvedValue([]);

    const { pairBookingContexts } = await load();
    const ctx = await pairBookingContexts("a", "b");

    expect(ctx.personalAllowed).toBe(true);
    expect(ctx.organizations).toEqual([]);
  });

  it("answers empty for strangers without querying bookings", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const { pairBookingContexts } = await load();
    const ctx = await pairBookingContexts("ghost-a", "ghost-b");

    expect(ctx).toEqual({ personalAllowed: false, organizations: [] });
    expect(mockPrisma.consultation.findMany).not.toHaveBeenCalled();
  });

  it("uses bookingOrgId precedence — plan org wins over appointment org", async () => {
    bothUsersExist(CONSULTANT, CONSULTEE);
    mockPrisma.consultation.findMany.mockResolvedValue([
      {
        consultationPlan: { organizationId: "org-plan" },
        appointment: { organizationId: "org-appointment" },
      },
    ]);
    mockPrisma.subscription.findMany.mockResolvedValue([]);

    const { pairBookingContexts } = await load();
    const ctx = await pairBookingContexts("a", "b");

    expect(ctx.organizations).toEqual(["org-plan"]);
    expect(ctx.personalAllowed).toBe(false);
  });
});
