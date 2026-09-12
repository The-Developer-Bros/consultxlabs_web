/**
 * @jest-environment node
 */

/**
 * #1580 — an erased consultant used to stay an ACCEPTED collaborator in every
 * split and roster. The scrub now runs the same flip the moderation ban runs
 * inside its transaction and revokes Stream access per plan after commit.
 */

jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(async () => undefined),
}));
jest.mock("../../lib/api/organizations/seat-count", () => ({
  releaseSeatsForTerminatedAssignments: jest.fn(async () => undefined),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/collaborators/service", () => ({
  revokeCollaboratorAccess: jest.fn(async () => ({ success: true })),
}));

import { revokeCollaboratorAccess } from "@/lib/collaborators/service";
import { scrubUser } from "@/lib/compliance/erasure/scrub-user";

const tx = {
  user: {
    update: jest.fn(async () => ({})),
    findUnique: jest.fn(async () => ({ consultantProfileId: "cp-1" })),
  },
  consultantProfile: { updateMany: jest.fn(async () => ({ count: 1 })) },
  collaborator: {
    updateManyAndReturn: jest.fn(async () => [
      { collaboratorType: "WEBINAR", webinarPlanId: "wp-1", classPlanId: null },
    ]),
  },
  session: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  account: { deleteMany: jest.fn(async () => ({ count: 0 })) },
};
const db = {
  user: {
    findUnique: jest.fn(async () => ({
      id: "u1",
      erasedAt: null,
      pseudonymousId: null,
    })),
  },
  membership: { findMany: jest.fn(async () => []) },
  $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
};

describe("DPDP erasure flips collaborator rows", () => {
  it("moves PENDING/ACCEPTED rows to REMOVED in the transaction and revokes each plan after it", async () => {
    const result = await scrubUser(db as never, "u1");

    expect(result.scrubbed).toBe(true);
    expect(tx.collaborator.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          consultantProfileId: "cp-1",
          status: { in: ["PENDING", "ACCEPTED"] },
        },
        data: { status: "REMOVED", respondedAt: expect.any(Date) },
      }),
    );
    expect(revokeCollaboratorAccess).toHaveBeenCalledWith(
      "webinar",
      "wp-1",
      "u1",
      { notify: false },
    );
  });
});
