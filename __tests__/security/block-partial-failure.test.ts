/**
 * @jest-environment node
 */

/**
 * A partial block must not be reported as a block.
 *
 * The ban loop was sequential, so the first rejection abandoned every remaining
 * channel AND skipped the moderation report. Switching to `Promise.allSettled`
 * fixed the abandonment and introduced a subtler problem: every channel was now
 * attempted, but the route still answered `success: true` regardless of how many
 * had actually been banned. The UI branches on `response.ok` alone and renders
 * "This user can no longer message you" — over a conversation they can still
 * post in.
 *
 * A pair can share more than one thread (personal plus one per org context), so
 * partial failure is a real state, not a theoretical one. These pin the three
 * outcomes: all-succeed, some-succeed, none-succeed.
 */
import { NextRequest } from "next/server";

const mockPrisma = {
  user: { findUnique: jest.fn() },
  moderationReport: { create: jest.fn() },
};

const mockQueryChannels = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: () => ({ queryChannels: mockQueryChannels }),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

const mockGetSession = jest.fn();
jest.mock("../../lib/auth-server", () => ({
  getSession: () => mockGetSession(),
}));

/** A channel whose `banUser` resolves or rejects on command. */
function channel(id: string, outcome: "ok" | "fail") {
  return {
    id,
    cid: `messaging:${id}`,
    banUser:
      outcome === "ok"
        ? jest.fn().mockResolvedValue({})
        : jest.fn().mockRejectedValue(new Error("Stream refused")),
  };
}

function request() {
  return new NextRequest("http://localhost/api/stream/users/block", {
    method: "POST",
    body: JSON.stringify({ targetUserId: "target-user" }),
    headers: { "Content-Type": "application/json" },
  });
}

async function post() {
  const { POST } = await import("../../app/api/stream/users/block/route");
  return POST(request());
}

describe("POST /api/stream/users/block", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: "blocker" } });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "target-user" });
    mockPrisma.moderationReport.create.mockResolvedValue({ id: "report-1" });
  });

  it("reports success only when every shared thread is banned", async () => {
    mockQueryChannels.mockResolvedValue([
      channel("dm-a-b", "ok"),
      channel("dmo-org-pair", "ok"),
    ]);

    const response = await post();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockPrisma.moderationReport.create).toHaveBeenCalled();
  });

  it("does NOT claim success when one thread is left writable", async () => {
    mockQueryChannels.mockResolvedValue([
      channel("dm-a-b", "ok"),
      channel("dmo-org-pair", "fail"),
    ]);

    const response = await post();
    const body = await response.json();

    // Not 2xx — the UI's only signal is `response.ok`, so a 200 here renders
    // "This user can no longer message you" over a live channel.
    expect(response.ok).toBe(false);
    expect(body.success).toBe(false);
    expect(body.partial).toBe(true);
    expect(body.blocked).toBe(1);
    expect(body.total).toBe(2);
    // The message has to name the shortfall, because the client surfaces it
    // verbatim.
    expect(body.error).toMatch(/1 of 2/);
  });

  it("still records the moderation report on a partial block", async () => {
    mockQueryChannels.mockResolvedValue([
      channel("dm-a-b", "ok"),
      channel("dmo-org-pair", "fail"),
    ]);

    await post();

    // The attempt happened and half of it took effect. The audit trail is not
    // conditional on the outcome being clean.
    expect(mockPrisma.moderationReport.create).toHaveBeenCalled();
  });

  it("attempts every channel rather than stopping at the first failure", async () => {
    const first = channel("dm-a-b", "fail");
    const second = channel("dmo-org-pair", "ok");
    mockQueryChannels.mockResolvedValue([first, second]);

    await post();

    // The sequential loop aborted here, leaving the second thread unbanned.
    expect(first.banUser).toHaveBeenCalled();
    expect(second.banUser).toHaveBeenCalled();
  });

  it("answers 503 and writes no report when every ban fails", async () => {
    mockQueryChannels.mockResolvedValue([
      channel("dm-a-b", "fail"),
      channel("dmo-org-pair", "fail"),
    ]);

    const response = await post();
    const body = await response.json();

    // The header names three outcomes; this is the third, and it was the one
    // left untested. It differs from the partial case in a way that matters:
    // nothing was blocked, so there is no action to audit.
    expect(response.status).toBe(503);
    expect(body.success).toBeUndefined();
    expect(mockPrisma.moderationReport.create).not.toHaveBeenCalled();
  });

  it("answers 503 when the Stream lookup itself fails", async () => {
    mockQueryChannels.mockRejectedValue(new Error("Stream down"));

    const response = await post();
    const body = await response.json();

    // NOT the 403 "you can only block users you have a conversation with" —
    // an outage is not a policy decision, and saying so to two people
    // mid-conversation is the worst possible moment to be wrong.
    expect(response.status).toBe(503);
    expect(body.error).not.toMatch(/conversation with/);
  });

  it("answers 403 when there is genuinely no shared conversation", async () => {
    mockQueryChannels.mockResolvedValue([]);

    const response = await post();

    expect(response.status).toBe(403);
  });
});
