/**
 * @jest-environment node
 */

/**
 * #1580 C-P1-5 — a group event's reminder used to reach only the users joined
 * to the slot: neither the host nor the accepted collaborators. Both are on
 * the recipient list now, read through `collaboratorUserIds`.
 */

const slotFindMany = jest.fn(async (..._args: unknown[]) => [
  {
    id: "slot-1",
    startsAt: new Date(Date.now() + 60 * 60_000),
    appointment: {
      id: "appt-1",
      organizationId: null,
      consultation: null,
      subscription: null,
      class: null,
      webinar: {
        id: "web-1",
        webinarPlanId: "wp-1",
        webinarPlan: {
          title: "W",
          consultantProfile: { userId: "u-host", user: { name: "Host" } },
        },
      },
    },
    user: [{ id: "u-attendee", name: "A" }],
  },
]);
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    slotOfAppointment: { findMany: (...a: unknown[]) => slotFindMany(...a) },
    collaborator: {
      findMany: jest.fn(async () => [
        { consultantProfile: { userId: "u-cohost" } },
      ]),
    },
    $disconnect: jest.fn(),
  },
}));
jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: { set: jest.fn(async () => "OK") },
}));
jest.mock("../../lib/novu/service", () => ({
  notifyAppointmentReminder: jest.fn(async () => undefined),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn(
    (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

import { notifyAppointmentReminder } from "@/lib/novu/service";
import { sendAppointmentReminders } from "@/scripts/appointments/send-appointment-reminders";

it("reminds the attendee, the host and the accepted collaborator of a webinar", async () => {
  await sendAppointmentReminders();

  const recipients = (notifyAppointmentReminder as jest.Mock).mock.calls[0][0];
  expect(recipients).toEqual(
    expect.arrayContaining(["u-attendee", "u-host", "u-cohost"]),
  );
  expect(recipients).toHaveLength(3);
});
