/**
 * @jest-environment node
 */

/**
 * #1230 wave-4c — lead status transitions: CAS claim (terminal/concurrent
 * advance ⇒ 409 LEAD_NOT_CLAIMABLE) and the privileged gate.
 */

import { NextRequest } from "next/server";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    lead: {
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requirePrivilegedAuth: jest.fn(),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn().mockResolvedValue(null),
  adminMutationLimiter: { limit: jest.fn() },
}));

import prisma from "../../lib/prisma";
import { requirePrivilegedAuth } from "../../lib/auth-helpers";
import { PATCH } from "../../app/api/admin/leads/[leadId]/route";

const m = jest.mocked(prisma) as unknown as {
  lead: { updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
};
const mockedAuth = requirePrivilegedAuth as jest.Mock;

function drive(status: string) {
  const req = new NextRequest("http://localhost/api/admin/leads/lead_1", {
    method: "PATCH",
    body: JSON.stringify({ status }),
    headers: { "Content-Type": "application/json" },
  });
  return PATCH(req, { params: Promise.resolve({ leadId: "lead_1" }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuth.mockResolvedValue({ error: null, session: { user: { id: "admin-1" } } });
});

describe("PATCH /api/admin/leads/[leadId]", () => {
  it("gates on requirePrivilegedAuth (error propagates)", async () => {
    mockedAuth.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      }),
    });
    const res = await drive("CONTACTED");
    expect(res.status).toBe(403);
  });

  it("400s on an invalid body", async () => {
    const req = new NextRequest("http://localhost/api/admin/leads/lead_1", {
      method: "PATCH",
      body: JSON.stringify({ nonsense: true }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PATCH(req, {
      params: Promise.resolve({ leadId: "lead_1" }),
    });
    expect(res.status).toBe(400);
  });

  it("200s when the CAS claims the row and returns the fresh lead", async () => {
    m.lead.updateMany.mockResolvedValue({ count: 1 });
    m.lead.findUniqueOrThrow.mockResolvedValue({
      id: "lead_1",
      status: "CONTACTED",
    });

    const res = await drive("CONTACTED");
    expect(res.status).toBe(200);
    expect(m.lead.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "lead_1",
          status: { in: ["NEW"] },
        }),
        data: { status: "CONTACTED" },
      }),
    );
  });

  it("409 LEAD_NOT_CLAIMABLE on a terminal row (count 0)", async () => {
    m.lead.updateMany.mockResolvedValue({ count: 0 });

    const res = await drive("CLOSED_WON");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("LEAD_NOT_CLAIMABLE");
  });
});
