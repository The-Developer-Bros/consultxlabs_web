import type { PrismaLike } from "@/lib/prisma";
/**
 * Fan-out helper for outbound webhook delivery.
 *
 * Why this is a thin queue-into-DB function (no HTTP)
 * ---------------------------------------------------
 * The originating route handler should never block on a webhook POST.
 * Most events emit during a Prisma `$transaction` (`member.added`
 * inside membership-transitions, `invoice.issued` inside the invoice
 * route's `$transaction`). Trying to HTTP-out from there means:
 *
 *   1. Receiver latency leaks into our route's p99 — a slow integrator
 *      gates an OWNER's invoice-issue clicks.
 *   2. The transaction holds open while we wait for the external POST,
 *      blocking other writers on the same PO / wallet row.
 *   3. A `4xx` from the receiver can't roll back the underlying event
 *      anyway — we already committed the member-added.
 *
 * Instead this function does the minimum work inside the caller's
 * transaction (if one is active) or outside it: query subscribing
 * endpoints, insert one `OutboundWebhookDelivery` row per match in
 * `PENDING` status. The worker (`worker.ts`) drains those rows on a
 * one-minute cron tick.
 *
 * Idempotency of the emit-points
 * ------------------------------
 * `dispatchWebhookEvent` does NOT dedupe across calls — every emit
 * inserts a fresh delivery row. The emit-points are responsible for
 * ensuring they only call this once per business event (e.g. the
 * invoice route gates on `current.status === "DRAFT" && body.status
 * === "ISSUED"` so a no-op PATCH doesn't re-emit `invoice.issued`).
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { OutboundWebhookEvent } from "./event-types";

/**
 * Fire-and-forget by design. The caller usually wires this as
 * `dispatchWebhookEvent(...).catch(logErr)` so a webhook-dispatch
 * outage cannot break the business mutation that triggered it. The
 * underlying writes are cheap (one SELECT + N inserts) and run on the
 * same Prisma connection — if the caller passes a `tx`, the delivery
 * rows commit atomically with the business mutation, which is the
 * correct semantics for "if the invoice issue rolled back, the
 * delivery row should roll back too".
 */
export async function dispatchWebhookEvent<TPayload>(params: {
  prisma: PrismaLike;
  organizationId: string;
  eventType: OutboundWebhookEvent;
  payload: TPayload;
}): Promise<{ enqueuedCount: number }> {
  const { prisma, organizationId, eventType, payload } = params;

  // Subscriber lookup: only ACTIVE endpoints whose `eventSubscriptions`
  // array contains this event type. The `has` predicate maps to a
  // Postgres `ANY (...)` filter — cheap given the
  // (organizationId, status) index.
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: {
      organizationId,
      status: "ACTIVE",
      eventSubscriptions: { has: eventType },
    },
    select: { id: true },
  });

  if (endpoints.length === 0) return { enqueuedCount: 0 };

  // `createMany` skipDuplicates is unnecessary because each delivery
  // row gets a fresh cuid — there's no natural key to collide on.
  await prisma.outboundWebhookDelivery.createMany({
    data: endpoints.map((endpoint) => ({
      webhookEndpointId: endpoint.id,
      eventType,
      // `payload` is stored as JSONB; the cast here narrows TS to the
      // shape Prisma expects. Receivers see this exact JSON body.
      payload: payload as unknown as Prisma.InputJsonValue,
      status: "PENDING" as const,
    })),
  });

  return { enqueuedCount: endpoints.length };
}
