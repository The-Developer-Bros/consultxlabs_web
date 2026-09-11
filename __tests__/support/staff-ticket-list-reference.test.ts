/**
 * @jest-environment node
 */

/**
 * E2E F-4 — staff queue rendered uuid-tail labels (e.g. `66A3CB17`) for
 * tickets that HAVE a referenceNumber. Root cause: `formattedTickets` in
 * `app/api/staff/support-tickets/route.ts` omitted `referenceNumber`, so
 * `ticketLabel()` fell back to `ticket.id.slice(-8)`.
 *
 * Pins the fix: the staff list passes `referenceNumber` through, so the
 * queue can render `FAM-2026-000006`.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requirePrivilegedAuth: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportTicket: {
      findMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
  },
}));

import { NextRequest } from "next/server";
import { requirePrivilegedAuth } from "../../lib/auth-helpers";
import prisma from "../../lib/prisma";
import { GET } from "../../app/api/staff/support-tickets/route";
import { ticketLabel } from "../../utils/supportTicketUrl";

const mockedAuth = requirePrivilegedAuth as jest.Mock;
const mockedFindMany = prisma.supportTicket.findMany as jest.Mock;
const mockedCount = prisma.supportTicket.count as jest.Mock;
const mockedGroupBy = prisma.supportTicket.groupBy as jest.Mock;

const TICKET_ROW = {
  id: "0f8fad5b-6bd8-4e9d-9c9f-aa1166a3cb17",
  referenceNumber: "FAM-2026-000006",
  title: "Refund not received",
  description: "Paid twice, refund pending",
  priority: "HIGH",
  status: "OPEN",
  category: null,
  issueType: "REFUND_REQUEST",
  user: { id: "u1", name: "U", email: "u@x.test", image: null },
  assignedToId: null,
  _count: { responses: 0, attachments: 0 },
  consultationId: null,
  subscriptionId: null,
  paymentId: null,
  refundId: null,
  createdAt: new Date("2026-03-01T00:00:00Z"),
  updatedAt: new Date("2026-03-01T00:00:00Z"),
};

beforeEach(() => {
  mockedAuth.mockResolvedValue({ session: { user: { id: "s1", role: "STAFF" } } });
  mockedFindMany.mockResolvedValue([TICKET_ROW]);
  mockedCount.mockResolvedValue(1);
  mockedGroupBy.mockResolvedValue([]);
});

describe("GET /api/staff/support-tickets (E2E F-4)", () => {
  it("returns referenceNumber for a ticket that has one", async () => {
    const res = await GET(
      new NextRequest("https://x.test/api/staff/support-tickets"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tickets).toHaveLength(1);
    expect(json.tickets[0].referenceNumber).toBe("FAM-2026-000006");
  });

  it("the returned row labels as the FAM- ref, not the uuid tail", async () => {
    const res = await GET(
      new NextRequest("https://x.test/api/staff/support-tickets"),
    );
    const json = await res.json();
    expect(ticketLabel(json.tickets[0])).toBe("FAM-2026-000006");
  });
});
