/**
 * @jest-environment node
 */

/**
 * Pin the stale-invitation cleanup contract:
 *
 *   - Only rows with `status = 'pending'` AND `expiresAt < now` get
 *     flipped to 'expired'. Already-expired, accepted, or revoked rows
 *     are left alone.
 *   - Each flip emits one `OrgAuditLog(MEMBER / INVITE_EXPIRED)` row
 *     with the original invite metadata in `details` so a MAINTAINER
 *     scanning the audit log sees what lapsed without needing to dig
 *     into worker logs.
 *   - The concurrency guard (re-read inside the transaction) refuses
 *     to flip a row that flipped to 'accepted' between the scan and
 *     the update.
 *   - Idempotent: a second invocation with no stale rows returns
 *     `{ expired: 0 }` and writes no new audit rows.
 *
 * Covers the gap called out in the May 2026 audit (B6.4): the cron
 * existed but had no regression test, so a future "make the audit
 * row conditional" refactor could silently break the visibility.
 */

jest.mock("../../lib/prisma", () => {
  const candidates: Array<{
    id: string;
    organizationId: string;
    email: string;
    role: string;
    expiresAt: Date;
  }> = [];
  return {
    __esModule: true,
    default: {
      invitation: {
        findMany: jest.fn().mockResolvedValue(candidates),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    },
  };
});

import prisma from "@/lib/prisma";
import { cleanupStaleInvitations } from "@/scripts/cleanup/cleanup-stale-invitations";

const mockedPrisma = prisma as unknown as {
  invitation: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  orgAuditLog: { create: jest.Mock };
  $transaction: jest.Mock;
};

function wireTxShim() {
  mockedPrisma.$transaction.mockImplementation(async (fn: unknown) => {
    const tx = {
      invitation: mockedPrisma.invitation,
      orgAuditLog: mockedPrisma.orgAuditLog,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (fn as any)(tx);
  });
}

describe("cleanupStaleInvitations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    wireTxShim();
  });

  it("returns { expired: 0 } when no candidates exist (idempotent no-op)", async () => {
    mockedPrisma.invitation.findMany.mockResolvedValue([]);
    const result = await cleanupStaleInvitations();
    expect(result).toMatchObject({ success: true, expired: 0, errors: [] });
    expect(mockedPrisma.invitation.update).not.toHaveBeenCalled();
    expect(mockedPrisma.orgAuditLog.create).not.toHaveBeenCalled();
  });

  it("flips pending+past invites to expired and emits an INVITE_EXPIRED audit row", async () => {
    const candidate = {
      id: "inv-1",
      organizationId: "org-1",
      email: "alice@acme.com",
      role: "LEARNER",
      expiresAt: new Date("2026-05-01T00:00:00Z"),
    };
    mockedPrisma.invitation.findMany.mockResolvedValue([candidate]);
    mockedPrisma.invitation.findUnique.mockResolvedValue({ status: "pending" });
    mockedPrisma.invitation.update.mockResolvedValue({ id: candidate.id });

    const result = await cleanupStaleInvitations();
    expect(result.expired).toBe(1);
    expect(mockedPrisma.invitation.update).toHaveBeenCalledWith({
      where: { id: candidate.id },
      data: { status: "expired" },
    });
    expect(mockedPrisma.orgAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-1",
        category: "MEMBER",
        action: "INVITE_EXPIRED",
        details: expect.objectContaining({
          email: "alice@acme.com",
          role: "LEARNER",
        }),
      }),
    });
  });

  it("skips invites that flipped to 'accepted' between the scan and the TX (concurrency guard)", async () => {
    const candidate = {
      id: "inv-2",
      organizationId: "org-1",
      email: "bob@acme.com",
      role: "LEARNER",
      expiresAt: new Date("2026-05-01T00:00:00Z"),
    };
    mockedPrisma.invitation.findMany.mockResolvedValue([candidate]);
    // Re-read inside the TX sees the racing accept — refuse to flip.
    mockedPrisma.invitation.findUnique.mockResolvedValue({ status: "accepted" });

    const result = await cleanupStaleInvitations();
    expect(result.expired).toBe(0);
    expect(mockedPrisma.invitation.update).not.toHaveBeenCalled();
    expect(mockedPrisma.orgAuditLog.create).not.toHaveBeenCalled();
  });

  it("collects errors per-row without aborting the whole sweep", async () => {
    const a = {
      id: "inv-a",
      organizationId: "org-1",
      email: "a@x.com",
      role: "LEARNER",
      expiresAt: new Date("2026-05-01T00:00:00Z"),
    };
    const b = {
      id: "inv-b",
      organizationId: "org-2",
      email: "b@x.com",
      role: "LEARNER",
      expiresAt: new Date("2026-05-01T00:00:00Z"),
    };
    mockedPrisma.invitation.findMany.mockResolvedValue([a, b]);

    mockedPrisma.invitation.findUnique.mockResolvedValue({ status: "pending" });
    // First update throws, second succeeds — the sweep should still
    // report the second row as expired.
    mockedPrisma.invitation.update
      .mockRejectedValueOnce(new Error("DB blip"))
      .mockResolvedValueOnce({ id: b.id });

    const result = await cleanupStaleInvitations();
    expect(result.expired).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.success).toBe(false);
  });
});
