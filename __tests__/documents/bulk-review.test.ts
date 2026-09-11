/**
 * @jest-environment node
 */

/**
 * #347 — bulk document review endpoint. Pins the contract that makes it a safe
 * replacement for the client's N-PATCH fan-out: it authenticates, validates the
 * status + batch, and scopes the single updateMany to the requesting
 * consultant's own documents (so the ids passed can never touch anyone else's).
 */

import { PATCH } from "../../app/api/documents/bulk-review/route";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import { applyRateLimit } from "@/lib/rate-limit";

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { appointmentDocument: { updateMany: jest.fn() } },
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn().mockResolvedValue(null),
  documentReviewLimiter: {},
}));

const mockedGetSession = getSession as jest.Mock;
const mockedApplyRateLimit = applyRateLimit as jest.Mock;
const mockedUpdateMany = prisma.appointmentDocument.updateMany as jest.Mock;

function req(body: unknown) {
  return new Request("http://localhost/api/documents/bulk-review", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as never;
}

// Raw (possibly invalid) body so request.json() can throw.
function rawReq(text: string) {
  return new Request("http://localhost/api/documents/bulk-review", {
    method: "PATCH",
    body: text,
    headers: { "Content-Type": "application/json" },
  }) as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedApplyRateLimit.mockResolvedValue(null);
  mockedGetSession.mockResolvedValue({ user: { id: "consultant-user-1" } });
  mockedUpdateMany.mockResolvedValue({ count: 2 });
});

describe("PATCH /api/documents/bulk-review", () => {
  it("401s without a session and never writes", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await PATCH(
      req({ documentIds: ["d1"], reviewStatus: "APPROVED" }),
    );
    expect(res.status).toBe(401);
    expect(mockedUpdateMany).not.toHaveBeenCalled();
  });

  it("400s on an invalid review status", async () => {
    const res = await PATCH(
      req({ documentIds: ["d1"], reviewStatus: "NONSENSE" }),
    );
    expect(res.status).toBe(400);
    expect(mockedUpdateMany).not.toHaveBeenCalled();
  });

  it("400s on an empty document list", async () => {
    const res = await PATCH(
      req({ documentIds: [], reviewStatus: "APPROVED" }),
    );
    expect(res.status).toBe(400);
    expect(mockedUpdateMany).not.toHaveBeenCalled();
  });

  it("400s on a malformed JSON body (not 500)", async () => {
    const res = await PATCH(rawReq("{ not valid json"));
    expect(res.status).toBe(400);
    expect(mockedUpdateMany).not.toHaveBeenCalled();
  });

  it("returns the rate-limit response and skips the write", async () => {
    mockedApplyRateLimit.mockResolvedValue(
      new Response(JSON.stringify({ error: "Too many requests" }), {
        status: 429,
      }),
    );
    const res = await PATCH(
      req({ documentIds: ["d1"], reviewStatus: "APPROVED" }),
    );
    expect(res.status).toBe(429);
    expect(mockedUpdateMany).not.toHaveBeenCalled();
  });

  it("updates only the consultant's own documents and stamps the reviewer", async () => {
    const res = await PATCH(
      req({
        documentIds: ["d1", "d2"],
        reviewStatus: "APPROVED",
        reviewNotes: "  looks good  ",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { updated: 2, requested: 2 },
    });

    const arg = mockedUpdateMany.mock.calls[0][0];
    expect(arg.where.id).toEqual({ in: ["d1", "d2"] });
    // Ownership is enforced through the appointment's consultant relations.
    expect(arg.where.appointment.OR).toHaveLength(2);
    expect(arg.data.reviewStatus).toBe("APPROVED");
    expect(arg.data.reviewedById).toBe("consultant-user-1");
    expect(arg.data.reviewedAt).toBeInstanceOf(Date);
    expect(arg.data.reviewNotes).toBe("looks good"); // trimmed
  });

  it("omits reviewNotes when none is provided (does not clear existing notes)", async () => {
    await PATCH(req({ documentIds: ["d1"], reviewStatus: "IN_REVIEW" }));
    const arg = mockedUpdateMany.mock.calls[0][0];
    expect("reviewNotes" in arg.data).toBe(false);
  });
});
