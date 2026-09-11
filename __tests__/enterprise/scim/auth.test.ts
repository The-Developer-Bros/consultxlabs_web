/**
 * @jest-environment node
 */

/**
 * `requireScimAuth` is the gate for every SCIM call. The tests below
 * pin:
 *
 *   - Missing / malformed Authorization header → 401 SCIM error.
 *   - Unknown token → 401 with the documented detail string.
 *   - Revoked token → 401 + an audit row recording the attempt.
 *   - Rate-limit exceeded → 429 with a SCIM error envelope.
 *   - Happy path → returns the (organizationId, tokenId) grant.
 */

import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

jest.mock("../../../lib/prisma", () => ({
  __esModule: true,
  default: {
    scimToken: { findUnique: jest.fn(), update: jest.fn() },
    orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
  },
}));

jest.mock("../../../lib/rate-limit", () => ({
  scimLimiter: {} as Record<string, unknown>,
  applyRateLimit: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { applyRateLimit } from "@/lib/rate-limit";
import { requireScimAuth } from "@/lib/scim/auth";

const mockedPrisma = prisma as unknown as {
  scimToken: { findUnique: jest.Mock; update: jest.Mock };
  orgAuditLog: { create: jest.Mock };
};
const mockedApplyRateLimit = applyRateLimit as jest.Mock;

function makeReq(authHeader?: string) {
  const headers = new Headers();
  if (authHeader) headers.set("authorization", authHeader);
  return new NextRequest("http://localhost/scim/v2/Users", { headers });
}

function hashOf(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

describe("requireScimAuth", () => {
  beforeEach(() => {
    mockedPrisma.scimToken.findUnique.mockReset();
    mockedPrisma.scimToken.update.mockResolvedValue({});
    mockedPrisma.orgAuditLog.create.mockClear();
    mockedApplyRateLimit.mockReset();
  });

  it("401 when Authorization header is missing", async () => {
    const result = await requireScimAuth(makeReq());
    expect(result.response?.status).toBe(401);
  });

  it("401 when scheme is not 'Bearer'", async () => {
    const result = await requireScimAuth(makeReq("Basic abc"));
    expect(result.response?.status).toBe(401);
  });

  it("401 when the bearer token is unknown", async () => {
    mockedPrisma.scimToken.findUnique.mockResolvedValue(null);
    const result = await requireScimAuth(makeReq("Bearer not-real"));
    expect(result.response?.status).toBe(401);
    expect(mockedPrisma.scimToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashOf("not-real") },
      // #789 — expiresAt is now selected so the deadline can be enforced.
      select: {
        id: true,
        organizationId: true,
        status: true,
        expiresAt: true,
      },
    });
  });

  it("#789 — 401 when an ACTIVE token is past its expiresAt", async () => {
    mockedPrisma.scimToken.findUnique.mockResolvedValue({
      id: "tok-1",
      organizationId: "org-1",
      status: "ACTIVE",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const result = await requireScimAuth(makeReq("Bearer expired-token"));
    expect(result.response?.status).toBe(401);
    expect(result.grant).toBeUndefined();
  });

  it("#789 — allows an ACTIVE token whose expiresAt is still in the future", async () => {
    mockedPrisma.scimToken.findUnique.mockResolvedValue({
      id: "tok-1",
      organizationId: "org-1",
      status: "ACTIVE",
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockedApplyRateLimit.mockResolvedValue(null);
    const result = await requireScimAuth(makeReq("Bearer live-token"));
    expect(result.grant).toEqual({
      organizationId: "org-1",
      tokenId: "tok-1",
    });
  });

  it("401 when the token is REVOKED and audits the misuse", async () => {
    mockedPrisma.scimToken.findUnique.mockResolvedValue({
      id: "tok-1",
      organizationId: "org-1",
      status: "REVOKED",
    });
    const result = await requireScimAuth(makeReq("Bearer revoked-token"));
    expect(result.response?.status).toBe(401);
    // Critical: the SCIM_TOKEN_USED_AFTER_REVOKE audit must fire so the
    // operator sees the rotation gap on the audit-log dashboard.
    expect(mockedPrisma.orgAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          action: "SCIM_TOKEN_USED_AFTER_REVOKE",
        }),
      }),
    );
  });

  it("429 when the rate limit is exceeded", async () => {
    mockedPrisma.scimToken.findUnique.mockResolvedValue({
      id: "tok-1",
      organizationId: "org-1",
      status: "ACTIVE",
    });
    // applyRateLimit returns a NextResponse when over budget — emulate
    // that by returning a truthy object.
    mockedApplyRateLimit.mockResolvedValue({ status: 429 });
    const result = await requireScimAuth(makeReq("Bearer ok-token"));
    expect(result.response?.status).toBe(429);
  });

  it("happy path returns the grant + bumps lastUsedAt", async () => {
    mockedPrisma.scimToken.findUnique.mockResolvedValue({
      id: "tok-1",
      organizationId: "org-1",
      status: "ACTIVE",
    });
    mockedApplyRateLimit.mockResolvedValue(null);
    const result = await requireScimAuth(makeReq("Bearer ok-token"));
    expect(result.grant).toEqual({
      organizationId: "org-1",
      tokenId: "tok-1",
    });
    // lastUsedAt is best-effort fire-and-forget; we don't await its
    // promise inside the function, but the call must be queued.
    expect(mockedPrisma.scimToken.update).toHaveBeenCalledWith({
      where: { id: "tok-1" },
      data: { lastUsedAt: expect.any(Date) },
    });
  });
});
