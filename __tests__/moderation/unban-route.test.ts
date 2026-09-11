/**
 * @jest-environment node
 */

/**
 * #1270 — a permanent ban could not be lifted.
 *
 * USER_BANNED calls `chat.deactivateUser`, which is permanent, and
 * `restoreStreamAccess` — the documented inverse — had zero callers. An admin
 * reversing a wrongful ban by clearing `User.banned` produced an account that
 * could sign in, book and pay but could never connect to chat again, with
 * nothing anywhere explaining why.
 *
 * `hasBackofficePermission` is deliberately NOT mocked: the point of the gate
 * is the real matrix, and a mocked one would pass whatever it was told.
 */

type ActionCreateArgs = {
  data: { reportId: string; actionType: string; takenById: string };
};

const tx = {
  user: { updateMany: jest.fn(async () => ({ count: 1 })) },
  moderationAction: {
    create: jest.fn(async ({ data }: ActionCreateArgs) => ({
      id: "action-1",
      ...data,
    })),
  },
};

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    moderationReport: {
      findUnique: jest.fn(async () => ({ id: "r1", targetUserId: "u1" })),
    },
    $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requirePrivilegedAuth: jest.fn(),
}));

jest.mock("../../lib/moderation/side-effects", () => ({
  __esModule: true,
  restoreStreamAccess: jest.fn(async () => undefined),
  persistActionSideEffects: jest.fn(async () => undefined),
}));

import { POST } from "../../app/api/staff/moderation/reports/[reportId]/unban/route";
import { requirePrivilegedAuth } from "../../lib/auth-helpers";
import prisma from "../../lib/prisma";
import {
  persistActionSideEffects,
  restoreStreamAccess,
} from "../../lib/moderation/side-effects";

const mockedAuth = requirePrivilegedAuth as jest.Mock;
const mockedRestore = restoreStreamAccess as jest.Mock;
const mockedPersist = persistActionSideEffects as jest.Mock;

const call = (notes = "wrongful ban") =>
  POST(
    new Request("http://localhost/unban", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    }) as never,
    { params: Promise.resolve({ reportId: "r1" }) },
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuth.mockResolvedValue({
    session: { user: { id: "admin-1", role: "ADMIN" } },
  });
  mockedRestore.mockResolvedValue(undefined);
});

describe("POST /api/staff/moderation/reports/[reportId]/unban", () => {
  it("refuses a staff moderator — reversing a ban is as destructive as taking one", async () => {
    mockedAuth.mockResolvedValue({
      session: { user: { id: "staff-1", role: "STAFF" } },
    });

    const res = await call();

    expect(res.status).toBe(403);
    expect(mockedRestore).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("clears the ban columns, records who did it, and restores Stream access", async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u1", banned: true },
      data: { banned: false, banReason: null, banExpires: null },
    });
    expect(tx.moderationAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actionType: "USER_REINSTATED",
          takenById: "admin-1",
          reportId: "r1",
        }),
      }),
    );
    expect(mockedRestore).toHaveBeenCalledWith("u1");
    expect(await res.json()).toMatchObject({ sideEffects: { stream: "ok" } });
  });

  it("says so when the ban was lifted but Stream never heard about it", async () => {
    mockedRestore.mockRejectedValue(new Error("Stream is down"));

    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sideEffects.stream).toBe("failed");
    expect(body.sideEffects.errors[0]).toContain("Stream is down");
    // Persisted too, so the report keeps showing the gap after the toast is gone.
    expect(mockedPersist).toHaveBeenCalledWith(
      "action-1",
      expect.objectContaining({ stream: "failed" }),
    );
  });

  it("404s on an unknown report before touching anything", async () => {
    (prisma.moderationReport.findUnique as jest.Mock).mockResolvedValueOnce(
      null,
    );

    const res = await call();

    expect(res.status).toBe(404);
    expect(mockedRestore).not.toHaveBeenCalled();
  });
});
