/**
 * @jest-environment node
 */

/**
 * ORG_WORKSPACE onboarding handoff: the role is committed on the User row at
 * step 0 so the create-org wizard's `POST /api/organizations` authorizes.
 * These cover the revert that runs when the user backs out of that wizard —
 * without it they are stranded on ORG_WORKSPACE with onboardingCompleted false.
 */

// Factories are inlined rather than closing over module-level consts: the
// `import`s below are hoisted above them, so a captured const is still in TDZ
// when the action module first requires these.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { user: { updateMany: jest.fn() } },
}));

jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(),
}));

// The action module also exports the full onboarding writer; stubbing it keeps
// jest away from that import chain, which these tests never exercise.
jest.mock("../../utils/onboarding-server", () => ({
  processOnboardingData: jest.fn(),
}));

import { resetOnboardingRoleAction } from "../../actions/forms/onboarding.action";
import { getSession } from "../../lib/auth-server";
import prisma from "../../lib/prisma";

const mockGetSession = getSession as unknown as jest.Mock;
const mockUpdateMany = prisma.user.updateMany as unknown as jest.Mock;

const USER_ID = "user-1";

describe("resetOnboardingRoleAction", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue({ user: { id: USER_ID } });
    mockUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("rejects an unauthenticated caller", async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(resetOnboardingRoleAction(USER_ID)).resolves.toEqual({
      success: false,
      error: "Unauthorized",
    });
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses to reset a different user's role", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "someone-else" } });

    await expect(resetOnboardingRoleAction(USER_ID)).resolves.toEqual({
      success: false,
      error: "Forbidden",
    });
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("reverts to the signup default only while the handoff is provisional", async () => {
    await expect(resetOnboardingRoleAction(USER_ID)).resolves.toEqual({
      success: true,
      reverted: true,
    });

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: {
        id: USER_ID,
        role: "ORG_WORKSPACE",
        onboardingCompleted: { not: true },
        memberships: { none: {} },
      },
      data: { role: "CONSULTEE" },
    });
  });

  it("reports no revert when the guard matches nothing (real org owner)", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await expect(resetOnboardingRoleAction(USER_ID)).resolves.toEqual({
      success: true,
      reverted: false,
    });
  });
});
