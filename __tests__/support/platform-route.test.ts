/**
 * @jest-environment node
 */

/**
 * #support-hub — PLATFORM intake route wiring (stateless scope).
 *
 * Auth and catalog gating at the boundary: an anonymous caller gets the
 * UNAUTHORIZED envelope; an unknown/stale flowId 404s with refresh guidance
 * instead of silently escalating. The flowchart engine itself is covered by
 * platform-flows/flow-walk suites.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  spamLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));

jest.mock("../../lib/validation/limits", () => ({
  __esModule: true,
  assertBodySize: jest.fn(() => null),
}));

jest.mock("../../lib/prisma", () => {
  const db = {
    membership: { findMany: jest.fn(async () => []) },
    // Escalation writes a ticket; the counter behind its reference and the
    // staff fan-out both live on the same client.
    supportTicket: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({
        id: "t1",
        title: "T",
        organizationId: null,
        referenceNumber: "FAM-2026-000001",
      })),
    },
    supportTicketCounter: { upsert: jest.fn(async () => ({ nextSeq: 2 })) },
    supportFlowOutcome: { create: jest.fn(async () => ({})) },
    user: { findMany: jest.fn(async () => []) },
    organization: { findUnique: jest.fn(async () => null) },
    // Assigned after the literal: referencing `db` inside its own initializer
    // makes TypeScript give up and infer `any`.
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === "function" ? (arg as (tx: unknown) => unknown)(db) : arg,
  );
  return {
    __esModule: true,
    default: db,
    ALLOCATION_TX_MAX_WAIT_MS: 5000,
    ALLOCATION_TX_TIMEOUT_MS: 15000,
  };
});

jest.mock("../../lib/novu", () => ({
  __esModule: true,
  notifySupportTicketCreated: jest.fn(async () => ({ success: true })),
  notifySupportTicketUpdateForStaff: jest.fn(async () => []),
}));

import { NextRequest } from "next/server";
import { getSession } from "../../lib/auth-server";
import { GET, POST } from "../../app/api/support/platform/route";

const mockedGetSession = getSession as jest.Mock;

function postReq(body: unknown): NextRequest {
  return new NextRequest("https://x.test/api/support/platform", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/support/platform", () => {
  it("401 UNAUTHORIZED envelope without a session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await POST(postReq({ flowId: "anything" }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("UNAUTHORIZED");
  });

  it("404 envelope with refresh guidance for an unknown flow (stale catalog)", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    // Bare entry turn — exactly what PlatformSupportSheet.startFlow sends.
    const res = await POST(postReq({ flowId: "no-such-flow" }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe("NOT_FOUND");
    expect(json.error).toContain("refresh");
  });

  it("REGRESSION: a bare entry turn {flowId} passes validation (the XOR refine used to 400 it)", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    const res = await POST(postReq({ flowId: "PAYMENTS_BILLING", nodeId: null }));
    // Reaches the engine and answers with the entry prompt — NOT a
    // VALIDATION_FAILED 400.
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.escalated).toBe(false);
    expect(json.data.messages.length).toBeGreaterThan(0);
  });

  it("VALIDATION_FAILED envelope when a turn carries BOTH an option and a message", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1" } });
    const res = await POST(
      postReq({ flowId: "PAYMENTS_BILLING", chosenOptionId: "twice", userMessage: "both" }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("VALIDATION_FAILED");
    // Developer detail: the zod flatten rides along.
    expect(json.detail).toBeDefined();
  });
});

describe("asking for a person, in the scope that had no way to", () => {
  /**
   * The unrecognized-input nudge tells the user to type "agent". The
   * appointment thread honours that through `decideEscalation`; nothing was
   * checking here, so in the platform drawer the instruction dead-ended and the
   * bot simply re-presented itself — a promise the product could not keep.
   */
  it("escalates a free-text message that asks for a human", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1", name: "U" } });
    const res = await POST(
      postReq({
        flowId: "PAYMENTS_BILLING",
        nodeId: "start",
        userMessage: "just get me an agent please",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.escalated).toBe(true);
    expect(json.data.supportTicketId).toBeTruthy();
  });

  it("leaves an ordinary message to the flow", async () => {
    mockedGetSession.mockResolvedValue({ user: { id: "u1", name: "U" } });
    const res = await POST(
      postReq({
        flowId: "PAYMENTS_BILLING",
        nodeId: "start",
        userMessage: "where is my money",
      }),
    );
    const json = await res.json();
    expect(json.data.escalated).toBe(false);
  });
});

describe("GET /api/support/platform", () => {
  it("401 UNAUTHORIZED envelope without a session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("UNAUTHORIZED");
  });
});
