/**
 * @jest-environment node
 */

/**
 * #1580 C-P0-2 — an ACCEPTED collaborator who bought a seat on their own event
 * satisfied every group-arm predicate (registered, held, paid) and could review
 * the host as a "consultee" of an event they are paid a share of. The webinar
 * and class arms now carry a NOT clause on the plan's ACCEPTED collaborators,
 * keyed on the reviewing user, so their own event never reaches the list.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findMany: jest.fn(async () => []) },
    membership: { findMany: jest.fn(async () => []) },
    consultantReview: { findMany: jest.fn(async () => []) },
  },
}));

import prisma from "@/lib/prisma";
import { listReviewableSessions } from "@/lib/reviews";

type Arm = Record<string, unknown> & {
  webinarId?: unknown;
  classId?: unknown;
  NOT?: unknown;
};

const collaboratorExclusion = {
  collaborators: {
    some: { status: "ACCEPTED", consultantProfile: { userId: "user-1" } },
  },
};

describe("a collaborator's own event is not reviewable", () => {
  it("excludes webinar and class appointments whose plan lists the user as an ACCEPTED collaborator", async () => {
    await listReviewableSessions("consultee-1", "user-1");

    const findMany = prisma.appointment.findMany as jest.Mock;
    expect(findMany).toHaveBeenCalledTimes(1);
    const arms: Arm[] = findMany.mock.calls[0][0].where.OR;

    const webinarArm = arms.find((a) => a.webinarId !== undefined);
    const classArm = arms.find((a) => a.classId !== undefined);
    expect(webinarArm?.NOT).toEqual({
      webinar: { webinarPlan: collaboratorExclusion },
    });
    expect(classArm?.NOT).toEqual({
      class: { classPlan: collaboratorExclusion },
    });

    // The 1:1 arms are untouched — a consultation has no collaborators.
    const oneToOneArms = arms.filter(
      (a) => a.webinarId === undefined && a.classId === undefined,
    );
    expect(oneToOneArms).toHaveLength(3);
    for (const arm of oneToOneArms) expect(arm.NOT).toBeUndefined();
  });
});
