/**
 * @jest-environment node
 */

/**
 * #789 — privilege-escalation guard. The members PATCH route already refuses to
 * assign the OWNER role unless the actor is an OWNER, but the POST /members and
 * POST /invitations routes did not, so a MAINTAINER could mint or invite an
 * OWNER and gain the security-sensitive surface by proxy. These tests assert
 * the guard on both POST routes: a MAINTAINER actor is rejected with 403 before
 * any write, while an OWNER actor passes the guard.
 */

import { POST as membersPost } from "../../app/api/organizations/[orgId]/members/route";
import { POST as invitationsPost } from "../../app/api/organizations/[orgId]/invitations/route";
import { requireOrgAccess } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";
import { applyRateLimit } from "@/lib/rate-limit";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireOrgAccess: jest.fn(),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn().mockResolvedValue(null),
  orgInviteLimiter: {},
}));

const mockedRequireOrgAccess = requireOrgAccess as jest.Mock;
const mockedUserFindUnique = (prisma as unknown as {
  user: { findUnique: jest.Mock };
}).user.findUnique;
const mockedApplyRateLimit = applyRateLimit as jest.Mock;

function access(role: string) {
  return {
    error: null,
    session: { user: { id: "u-actor", email: "actor@test.com" } },
    member: { id: "m-actor", role },
    org: { id: "org-1", canHost: true, canSponsor: true, status: "ACTIVE" },
  };
}

function req(body: unknown) {
  return new Request("http://localhost/api/organizations/org-1/members", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as never;
}

const params = { params: Promise.resolve({ orgId: "org-1" }) };

beforeEach(() => {
  jest.clearAllMocks();
  mockedApplyRateLimit.mockResolvedValue(null);
});

describe("OWNER role-escalation guard", () => {
  describe("POST /members", () => {
    it("rejects a MAINTAINER assigning role=OWNER with 403 and no write", async () => {
      mockedRequireOrgAccess.mockResolvedValue(access("MAINTAINER"));
      const res = await membersPost(
        req({ email: "victim@test.com", role: "OWNER" }),
        params,
      );
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("OWNER_ROLE_REQUIRES_OWNER");
      expect(mockedUserFindUnique).not.toHaveBeenCalled();
    });

    it("lets an OWNER past the guard (proceeds to the user lookup)", async () => {
      mockedRequireOrgAccess.mockResolvedValue(access("OWNER"));
      mockedUserFindUnique.mockResolvedValue(null); // → 404 USER_NOT_FOUND
      const res = await membersPost(
        req({ email: "newowner@test.com", role: "OWNER" }),
        params,
      );
      // The guard did NOT short-circuit: the handler reached the user lookup
      // and returned 404, not the 403 escalation block.
      expect(res.status).toBe(404);
      expect(mockedUserFindUnique).toHaveBeenCalled();
    });
  });

  describe("POST /invitations", () => {
    it("rejects a MAINTAINER inviting role=OWNER with 403", async () => {
      mockedRequireOrgAccess.mockResolvedValue(access("MAINTAINER"));
      const res = await invitationsPost(
        req({ email: "victim@test.com", role: "OWNER" }),
        params,
      );
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("OWNER_ROLE_REQUIRES_OWNER");
    });
  });
});
