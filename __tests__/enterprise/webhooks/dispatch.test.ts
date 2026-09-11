/**
 * @jest-environment node
 */

/**
 * `dispatchWebhookEvent` is a fan-out helper — given an
 * organizationId + eventType, it must:
 *
 *   1. SELECT only ACTIVE endpoints whose `eventSubscriptions` array
 *      contains the eventType.
 *   2. INSERT one `OutboundWebhookDelivery` row per matching endpoint
 *      with status=PENDING and the supplied payload as JSONB.
 *
 * The route handlers fire-and-forget against this helper, so the
 * happy-path and zero-subscriber path are the load-bearing cases.
 */

import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";

function makePrismaStub() {
  const findMany = jest.fn();
  const createMany = jest.fn();
  return {
    prisma: {
      webhookEndpoint: { findMany },
      outboundWebhookDelivery: { createMany },
    },
    findMany,
    createMany,
  };
}

describe("dispatchWebhookEvent", () => {
  it("enqueues a delivery row per subscribed ACTIVE endpoint", async () => {
    const { prisma, findMany, createMany } = makePrismaStub();
    findMany.mockResolvedValue([{ id: "ep-1" }, { id: "ep-2" }]);
    createMany.mockResolvedValue({ count: 2 });

    const result = await dispatchWebhookEvent({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      organizationId: "org-1",
      eventType: "invoice.issued",
      payload: { invoiceId: "inv-1", totalPaise: 5000 },
    });

    expect(result.enqueuedCount).toBe(2);
    // The subscriber-lookup MUST filter on status=ACTIVE and the
    // eventSubscriptions `has` predicate; without these two conditions
    // a PAUSED endpoint would receive events.
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        status: "ACTIVE",
        eventSubscriptions: { has: "invoice.issued" },
      },
      select: { id: true },
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          webhookEndpointId: "ep-1",
          eventType: "invoice.issued",
          status: "PENDING",
        }),
        expect.objectContaining({
          webhookEndpointId: "ep-2",
          eventType: "invoice.issued",
          status: "PENDING",
        }),
      ],
    });
  });

  it("short-circuits cleanly when no endpoints match (zero subscribers)", async () => {
    const { prisma, findMany, createMany } = makePrismaStub();
    findMany.mockResolvedValue([]);
    const result = await dispatchWebhookEvent({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      organizationId: "org-1",
      eventType: "member.added",
      payload: { membershipId: "m-1" },
    });
    expect(result.enqueuedCount).toBe(0);
    // Critical: we must NOT call createMany with empty data — Prisma
    // would no-op, but the explicit early return keeps the SQL log
    // clean and makes the route's audit trail less noisy.
    expect(createMany).not.toHaveBeenCalled();
  });

  it("persists the payload verbatim so receivers see the producer's shape", async () => {
    const { prisma, findMany, createMany } = makePrismaStub();
    findMany.mockResolvedValue([{ id: "ep-1" }]);
    createMany.mockResolvedValue({ count: 1 });

    const payload = {
      invoiceId: "inv-1",
      totalPaise: 5000,
      // Nested structure + non-trivial scalar shapes get serialized to
      // JSONB byte-for-byte; the test pins that we don't accidentally
      // re-shape before insertion.
      nested: { currency: "INR", buyer: { gstin: "06ABCDE1234F1Z5" } },
      tags: ["enterprise", "annual"],
    };

    await dispatchWebhookEvent({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
      organizationId: "org-1",
      eventType: "invoice.issued",
      payload,
    });

    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          payload, // referential equality is enough — same object
        }),
      ],
    });
  });
});
