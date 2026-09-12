/**
 * @jest-environment node
 */

/**
 * #1580 C-P0-4 — a banned collaborator used to stay ACCEPTED: still in every
 * future split, on rosters and recordings, and on the public co-host list.
 * Phase 1 now moves their PENDING/ACCEPTED rows to REMOVED and hands the
 * affected plans to phase 2, which runs the same Stream revocation
 * `removeCollaborator` runs. Reinstatement does not restore the rows.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { moderationAction: { update: jest.fn(async () => ({})) } },
}));
jest.mock("../../lib/stream-client", () => ({
  __esModule: true,
  getStreamChatClient: jest.fn(() => ({
    revokeUserToken: jest.fn(async () => undefined),
    deactivateUser: jest.fn(async () => undefined),
  })),
  withStreamCircuitBreaker: jest.fn(async (op: () => Promise<unknown>) => op()),
  isExpectedStreamError: jest.fn(() => false),
}));
jest.mock("../../lib/novu", () => ({
  notifyModerationWarning: jest.fn(async () => ({ success: true })),
  notifyAccountSuspended: jest.fn(async () => ({ success: true })),
  notifyAccountBanned: jest.fn(async () => ({ success: true })),
  notifyVerificationStatusChanged: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/moderation/cancel-user-engagements", () => ({
  __esModule: true,
  cancelFutureEngagementsForUser: jest.fn(async () => ({
    engagementsCancelled: 0,
    attendeeRemovals: 0,
    refundsIssued: 0,
    refundedPaise: 0,
    failures: [],
    remaining: [],
  })),
}));
jest.mock("../../lib/collaborators/service", () => ({
  revokeCollaboratorAccess: jest.fn(async () => ({ success: true })),
}));

import { revokeCollaboratorAccess } from "@/lib/collaborators/service";
import {
  applyBestEffortEffects,
  applyTransactionalEffects,
} from "@/lib/moderation/side-effects";

const tx = {
  user: {
    update: jest.fn(async () => ({})),
    findUnique: jest.fn(async () => ({ consultantProfileId: "cp-1" })),
  },
  session: { deleteMany: jest.fn(async () => ({ count: 1 })) },
  consultantEarnings: {
    findMany: jest.fn(async () => []),
    updateMany: jest.fn(async () => ({ count: 0 })),
  },
  collaborator: {
    findMany: jest.fn(async () => [
      { collaboratorType: "WEBINAR", webinarPlanId: "wp-1", classPlanId: null },
      { collaboratorType: "CLASS", webinarPlanId: null, classPlanId: "cp-9" },
    ]),
    updateMany: jest.fn(async () => ({ count: 2 })),
  },
};

const input = {
  actionType: "USER_BANNED" as const,
  report: {
    id: "r1",
    type: "PROFILE" as const,
    targetUserId: "u1",
    reviewId: null,
  },
  staffUserId: "admin-1",
};

describe("a ban revokes collaborator standing", () => {
  it("flips both rows to REMOVED in phase 1 and revokes both plans in phase 2", async () => {
    const transactional = await applyTransactionalEffects(tx as never, input);

    expect(tx.collaborator.updateMany).toHaveBeenCalledWith({
      where: {
        consultantProfileId: "cp-1",
        status: { in: ["PENDING", "ACCEPTED"] },
      },
      data: { status: "REMOVED", respondedAt: expect.any(Date) },
    });
    expect(transactional.collaborationsRemoved).toEqual([
      { planType: "webinar", planId: "wp-1" },
      { planType: "class", planId: "cp-9" },
    ]);

    const summary = await applyBestEffortEffects(input, transactional);

    expect(revokeCollaboratorAccess).toHaveBeenCalledTimes(2);
    expect(revokeCollaboratorAccess).toHaveBeenCalledWith(
      "webinar",
      "wp-1",
      "u1",
      {
        notify: false,
      },
    );
    expect(revokeCollaboratorAccess).toHaveBeenCalledWith(
      "class",
      "cp-9",
      "u1",
      {
        notify: false,
      },
    );
    expect(summary.collaboratorRevocation).toBe("ok");
    expect(summary.errors).toBeUndefined();
  });

  it("records a failed revocation per plan without blocking the other steps", async () => {
    (revokeCollaboratorAccess as jest.Mock).mockResolvedValueOnce({
      success: false,
    });
    const summary = await applyBestEffortEffects(input, {
      collaborationsRemoved: [
        { planType: "webinar", planId: "wp-1" },
        { planType: "class", planId: "cp-9" },
      ],
    });
    expect(summary.collaboratorRevocation).toBe("failed");
    expect(summary.errors).toEqual(["collaborator-revoke: webinar:wp-1"]);
    expect(summary.stream).toBe("ok");
  });
});
