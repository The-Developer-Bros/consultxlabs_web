/**
 * @jest-environment node
 */

/**
 * #support-hub — escalation replay-dedup scoping. A B2C (null-org) replay
 * must filter on organizationId: NULL explicitly; passing `?? undefined`
 * would omit the constraint and let a personal retry dedupe against an
 * organization ticket for the same issue type.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportTicket: { findFirst: jest.fn(async () => null) },
  },
}));

import prisma from "../../lib/prisma";
import { findRecentOpenEscalation } from "../../lib/support/create-ticket";

const mockedFind = prisma.supportTicket.findFirst as jest.Mock;

beforeEach(() => {
  mockedFind.mockClear();
});

describe("findRecentOpenEscalation", () => {
  it("filters organizationId: null for B2C replays (not an omitted filter)", async () => {
    await findRecentOpenEscalation("u1", "BILLING_QUESTION", null);
    expect(mockedFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: null }),
      }),
    );
  });

  it("scopes org replays to the attributed organization", async () => {
    await findRecentOpenEscalation("u1", "BILLING_QUESTION", "org-1");
    expect(mockedFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          status: "OPEN",
        }),
      }),
    );
  });
});
