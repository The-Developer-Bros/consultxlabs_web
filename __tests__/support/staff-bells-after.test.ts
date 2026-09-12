/**
 * @jest-environment node
 */

/**
 * #1614 — the ops support bells must run inside `after()`, not as a bare
 * `void` call. A `void` trigger resolves the wrapper as soon as the Novu HTTP
 * call has started, so the response goes out with the call still in flight and
 * Netlify freezes the instance on top of it; a customer reply then pages
 * nobody. `after()` extends the invocation until the trigger settles. Jest has
 * no Next request lifecycle, so the callback is captured and run on demand.
 */

// jest.mock is hoisted above imports AND local consts, so the factories build
// their mocks inline (no outer refs → no TDZ) and the test reaches them through
// the imported modules.
jest.mock("next/server", () => {
  const actual = jest.requireActual("next/server");
  return {
    ...actual,
    after: jest.fn(),
  };
});

jest.mock("../../lib/novu", () => ({
  notifySupportTicketActivity: jest.fn(async () => [{ success: true }]),
  notifySupportTicketCreated: jest.fn(async () => [{ success: true }]),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportTicket: {
      findUnique: jest.fn(async () => ({
        title: "Refund not received",
        assignedToId: "staff-1",
        referenceNumber: "FAM-2026-000004",
        organizationId: null,
        user: { name: "Asha" },
      })),
    },
    user: {
      findMany: jest.fn(async () => [
        { id: "staff-1", staffProfileId: "sp-1" },
      ]),
    },
  },
}));

import { after } from "next/server";
import { notifySupportTicketActivity } from "@/lib/novu";
import { notifyStaffOfTicketActivity } from "@/lib/support/create-ticket";

const mockedAfter = after as jest.Mock;
const mockedTrigger = notifySupportTicketActivity as jest.Mock;

describe("notifyStaffOfTicketActivity (#1614)", () => {
  it("defers the Novu trigger to after() instead of void-firing it", async () => {
    await notifyStaffOfTicketActivity("ticket-1", null, "response-1");

    // The wrapper has resolved and the trigger has NOT started: it is queued
    // behind the response, not racing it.
    expect(mockedAfter).toHaveBeenCalledTimes(1);
    expect(mockedTrigger).not.toHaveBeenCalled();

    // Running the captured callback is what fires the bell.
    const deferred = mockedAfter.mock.calls[0][0] as () => Promise<void>;
    await deferred();
    expect(mockedTrigger).toHaveBeenCalledTimes(1);
    expect(mockedTrigger).toHaveBeenCalledWith(
      ["staff-1"],
      expect.objectContaining({
        ticketId: "ticket-1",
        reference: "FAM-2026-000004",
        activity: "replied",
        dashboardUrl: "/dashboard/staff/sp-1/tickets",
      }),
      "response-1",
    );
  });

  it("runs the trigger inline when after() has no request scope (the no-show job)", async () => {
    mockedAfter.mockImplementationOnce(() => {
      throw new Error("`after` was called outside a request scope.");
    });

    await notifyStaffOfTicketActivity("ticket-1", null, "response-2");

    expect(mockedTrigger).toHaveBeenCalledTimes(1);
  });
});
