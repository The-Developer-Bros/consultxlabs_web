/**
 * @jest-environment node
 */

/**
 * Defect 7 — a duplicate trial request answers 409, not 500.
 *
 * POST /api/trials reads the pair, deletes a freed row, then inserts. Those
 * are three statements, so two concurrent requests for the same
 * consultee/consultant pair can both clear the eligibility read and both
 * reach the insert. The loser trips `@@unique([consulteeProfileId,
 * consultantProfileId])` and used to fall into the route's generic catch as a
 * 500 — an alarming answer to a question the sequential path already answers
 * calmly. Here we pin that the race and the sequential case give the client
 * the same 409 + `TRIAL_ALREADY_REQUESTED` code, and that a genuine failure
 * still escalates.
 */

import { Prisma, TrialSessionStatus } from "@prisma/client";

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  trialRequestLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));

jest.mock("../../lib/activity/log-activity", () => ({
  __esModule: true,
  logTrialRequested: jest.fn(async () => undefined),
}));

jest.mock("../../lib/novu", () => ({
  __esModule: true,
  notifyTrialSessionRequested: jest.fn(async () => undefined),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    trialSession: {
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
      create: jest.fn(),
    },
    subscriptionPlan: { findUnique: jest.fn() },
    consulteeProfile: { findUnique: jest.fn() },
    membership: { findFirst: jest.fn() },
  },
}));

import prisma from "../../lib/prisma";
import { getSession } from "../../lib/auth-server";
import { POST } from "../../app/api/trials/route";

const CONSULTEE = "consultee-1";
const CONSULTANT = "consultant-1";
const PLAN = "plan-1";

const mockedSession = getSession as jest.Mock;
const mockedFindUnique = prisma.trialSession.findUnique as jest.Mock;
const mockedCreate = prisma.trialSession.create as jest.Mock;
const mockedDeleteMany = prisma.trialSession.deleteMany as jest.Mock;

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`consulteeProfileId`,`consultantProfileId`)",
    {
      code: "P2002",
      clientVersion: "6.0.0",
      meta: {
        target: ["consulteeProfileId", "consultantProfileId"],
      },
    },
  );
}

function request() {
  return new Request("http://localhost/api/trials", {
    method: "POST",
    body: JSON.stringify({
      consulteeProfileId: CONSULTEE,
      consultantProfileId: CONSULTANT,
      subscriptionPlanId: PLAN,
    }),
  }) as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedSession.mockResolvedValue({
    user: {
      id: "user-1",
      role: "CONSULTEE",
      consulteeProfileId: CONSULTEE,
    },
  });
  // No prior trial for the pair — the read-side gate passes.
  mockedFindUnique.mockResolvedValue(null);
  mockedDeleteMany.mockResolvedValue({ count: 1 });
  (prisma.subscriptionPlan.findUnique as jest.Mock).mockResolvedValue({
    id: PLAN,
    title: "Career Clarity",
    consultantProfileId: CONSULTANT,
    trialEnabled: true,
    consultantProfile: { user: { id: "expert-1", name: "Expert" } },
  });
  (prisma.consulteeProfile.findUnique as jest.Mock).mockResolvedValue({
    id: CONSULTEE,
    user: { id: "user-1", name: "Learner", email: "l@x.com", image: null },
  });
  mockedCreate.mockResolvedValue({
    id: "trial-1",
    status: TrialSessionStatus.PENDING,
    consulteeProfile: { user: { id: "user-1", name: "Learner" } },
    consultantProfile: { user: { id: "expert-1", name: "Expert" } },
  });
});

describe("duplicate trial requests (defect 7)", () => {
  it("answers 409 TRIAL_ALREADY_REQUESTED when the insert loses the race", async () => {
    mockedCreate.mockRejectedValue(uniqueViolation());

    const res = await POST(request());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "You have already requested a trial with this consultant",
      code: "TRIAL_ALREADY_REQUESTED",
    });
  });

  it("answers the same 409 on the sequential path, so the client branches once", async () => {
    // A live trial already exists — no race, the read-side gate catches it.
    mockedFindUnique.mockResolvedValue({
      id: "trial-existing",
      status: TrialSessionStatus.PENDING,
    });

    const res = await POST(request());

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("TRIAL_ALREADY_REQUESTED");
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("still 500s on a failure that is not a unique violation", async () => {
    mockedCreate.mockRejectedValue(new Error("connection reset"));

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect((await res.json()).code).toBeUndefined();
  });

  it("answers 409, not 500, when the rival clears the freed row first", async () => {
    // A declined trial frees the pair, so both requests read it and both go to
    // clear it. `delete` would raise P2025 on the loser and fall into the
    // generic catch as a 500 — one statement earlier than the unique violation
    // this route already answers calmly. `deleteMany` reports a count of zero
    // instead, and the insert stays the arbiter.
    mockedFindUnique.mockResolvedValue({
      id: "trial-freed",
      status: TrialSessionStatus.REJECTED,
    });
    mockedDeleteMany.mockResolvedValue({ count: 0 });
    mockedCreate.mockRejectedValue(uniqueViolation());

    const res = await POST(request());

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("TRIAL_ALREADY_REQUESTED");
  });

  it("creates normally when nothing collides", async () => {
    const res = await POST(request());

    expect(res.status).toBe(201);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });
});
