/**
 * @jest-environment node
 */

/**
 * #1580 C-P1-3 — `isProvider` used to equal "is the plan owner", so an
 * ACCEPTED co-host opening a support thread on their own webinar was offered
 * the attendee "the expert didn't join" flow. The seat predicate now reads
 * the owner plus every ACCEPTED collaborator.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    recording: { findFirst: jest.fn(async () => null) },
    membership: { findFirst: jest.fn(async () => null) },
  },
}));

import prisma from "@/lib/prisma";
import { buildSupportContext } from "@/lib/support/context";
import { flowsForContext } from "@/lib/support/flows";

const mockPrisma = prisma as unknown as {
  appointment: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
};

const PAST_START = new Date(Date.now() - 3 * 3_600_000);
const PAST_END = new Date(PAST_START.getTime() + 60 * 60_000);

beforeEach(() => {
  mockPrisma.appointment.findUnique.mockResolvedValue({
    id: "appt1",
    appointmentType: "WEBINAR",
    organizationId: null,
    cancellationPolicy: null,
    slotsOfAppointment: [
      {
        id: "slot-a",
        startsAt: PAST_START,
        endsAt: PAST_END,
        isTentative: false,
        completionStatus: "COMPLETED",
      },
    ],
    payment: [],
    consultation: null,
    subscription: null,
    webinar: {
      webinarPlan: {
        consultantProfileId: "cp-owner",
        title: "W",
        collaborators: [{ consultantProfileId: "cp-cohost" }],
      },
    },
    class: null,
  });
  mockPrisma.user.findUnique.mockResolvedValue({
    consultantProfileId: "cp-cohost",
  });
});

it("treats an ACCEPTED collaborator as a provider and withholds the attendee NO_SHOW flow", async () => {
  const ctx = await buildSupportContext("t1", "appt1", "u-cohost", "NO_SHOW");
  expect(ctx?.isProvider).toBe(true);

  const noShow = flowsForContext(ctx!).filter((f) => f.category === "NO_SHOW");
  expect(noShow.map((f) => f.title)).toEqual(["The participant didn't join"]);
});

it("reads only ACCEPTED collaborators whose profile is not soft-deleted", async () => {
  await buildSupportContext("t1", "appt1", "u-cohost", "NO_SHOW");
  const select = mockPrisma.appointment.findUnique.mock.calls[0][0].select;
  const expected = {
    status: "ACCEPTED",
    consultantProfile: { deletedAt: null },
  };
  expect(select.webinar.select.webinarPlan.select.collaborators.where).toEqual(
    expected,
  );
  expect(select.class.select.classPlan.select.collaborators.where).toEqual(
    expected,
  );
});
