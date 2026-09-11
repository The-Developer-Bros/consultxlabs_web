/**
 * Request-level idempotency for money mutations.
 *
 * `/api/checkout` and org wallet top-ups already dedupe on a client-minted key
 * that lands in a unique column (`Payment.clientIdempotencyKey`,
 * `WalletTopUp.providerOrderId`).
 *
 * The gateway idempotency headers (`X-Refund-Idempotency`,
 * `X-Payout-Idempotency`) stop a duplicate reaching the bank, but they are
 * keyed off rows we create first — so a duplicate REQUEST still creates a
 * second row with a second gateway key, and the gateway honours both. This
 * closes that gap one layer earlier.
 *
 * Where it is actually mounted, and where it is not:
 *
 *   - `/api/admin/refunds` uses it. Note this is currently defence for a
 *     future caller: the refunds dashboard is read-only and nothing in the app
 *     POSTs to that route yet, so no client sends the header. With no header
 *     the wrapper is a pass-through, so mounting it costs nothing and means the
 *     protection exists the day a button does.
 *   - Admin payout processing does NOT use it and does not need it — a Redis
 *     lock plus a per-payout APPROVED->PROCESSING CAS already make it
 *     exactly-once.
 *   - Org payout creation does NOT use it: `createOrgPayoutBatch` derives a
 *     deterministic key from (organizationId, periodStart) with a unique
 *     constraint and a P2002 re-read.
 *   - Invoice pay does NOT use it: it reuses `providerPaymentOrderId`.
 *   - The overage order route does NOT use it; it was genuinely unprotected and
 *     was fixed in kind (reuse the unpaid order, refuse when one is in flight,
 *     CAS the stamp) because the right key there is the order itself.
 *
 * Usage — note the `await`, which is load-bearing whenever the call sits inside
 * a `try`. `return somePromise` hands the promise to the caller before it
 * settles, so a rejection bypasses the enclosing catch and surfaces as Next's
 * bare 500-with-empty-body instead of the route's typed error mapping:
 *
 *   return await withIdempotency(req, { scope: "admin.refund", userId }, async () => {
 *     ...do the work...
 *     return NextResponse.json({ refundId });
 *   });
 *
 * When the caller sends no `Idempotency-Key` the handler runs unchanged, so
 * this is additive for every existing client.
 */
import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";

/** How long a key is honoured. Longer than any sane client retry window. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Razorpay's own minimum; applying it here keeps the two layers consistent. */
const MIN_KEY_LENGTH = 10;
const MAX_KEY_LENGTH = 255;

export type IdempotencyOptions = {
  /** Route-owned namespace, e.g. "admin.refund". Must be stable. */
  scope: string;
  /** Authenticated caller. Keys never cross users. */
  userId: string;
};

function hashBody(body: string): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

/**
 * Wrap a money mutation so a repeated `Idempotency-Key` replays the original
 * response instead of doing the work twice.
 *
 * The handler receives the parsed body so the caller does not have to read the
 * request stream twice (a `Request` body can only be consumed once).
 */
export async function withIdempotency(
  req: NextRequest,
  opts: IdempotencyOptions,
  handler: (body: unknown) => Promise<NextResponse>,
): Promise<NextResponse> {
  const rawBody = await req.text();
  let parsedBody: unknown = undefined;
  if (rawBody.length > 0) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const key = req.headers.get("Idempotency-Key")?.trim();

  // No key supplied — behave exactly as before. Making the header mandatory
  // would break every existing client, and a route with no key is no worse off
  // than it is today.
  if (!key) {
    return handler(parsedBody);
  }

  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
    return NextResponse.json(
      {
        error: `Idempotency-Key must be between ${MIN_KEY_LENGTH} and ${MAX_KEY_LENGTH} characters`,
      },
      { status: 400 },
    );
  }

  const requestHash = hashBody(rawBody);
  const now = new Date();
  const where = {
    scope_key_userId: { scope: opts.scope, key, userId: opts.userId },
  };

  // Claim the key. The unique index is the race guard: two concurrent requests
  // with the same key both try to create, and exactly one wins with P2002.
  try {
    await prisma.idempotencyRecord.create({
      data: {
        scope: opts.scope,
        key,
        userId: opts.userId,
        requestHash,
        expiresAt: new Date(now.getTime() + TTL_MS),
      },
    });
  } catch (err) {
    if (
      typeof err !== "object" ||
      err === null ||
      (err as { code?: string }).code !== "P2002"
    ) {
      throw err;
    }

    const existing = await prisma.idempotencyRecord.findUnique({ where });

    // Expired keys are reusable — the row is swept lazily, so a stale one must
    // not permanently burn its key.
    if (existing && existing.expiresAt <= now) {
      await prisma.idempotencyRecord.update({
        where,
        data: {
          requestHash,
          responseBody: Prisma.JsonNull,
          responseStatus: null,
          completedAt: null,
          createdAt: now,
          expiresAt: new Date(now.getTime() + TTL_MS),
        },
      });
      return runAndRecord(handler, parsedBody, where);
    }

    if (!existing) {
      // Vanished between the failed create and the read (concurrent sweep).
      // Treat as a fresh request rather than inventing an error.
      return handler(parsedBody);
    }

    // Same key, different body. This is a client bug — replaying the original
    // response would be actively misleading (the caller asked for something
    // else and would think it succeeded).
    if (existing.requestHash !== requestHash) {
      return NextResponse.json(
        {
          error:
            "Idempotency-Key was already used with a different request body",
          code: "IDEMPOTENCY_KEY_REUSED",
        },
        { status: 422 },
      );
    }

    // Still in flight. Racing it would defeat the point; tell the caller to
    // retry rather than doing the work twice.
    if (!existing.completedAt) {
      return NextResponse.json(
        {
          error: "A request with this Idempotency-Key is still in progress",
          code: "IDEMPOTENCY_IN_FLIGHT",
        },
        { status: 409 },
      );
    }

    // Genuine retry — replay the original outcome verbatim.
    return NextResponse.json(existing.responseBody ?? {}, {
      status: existing.responseStatus ?? 200,
      headers: { "Idempotent-Replay": "true" },
    });
  }

  return runAndRecord(handler, parsedBody, where);
}

/**
 * Run the handler and persist its response against the claimed key.
 *
 * A thrown handler leaves `completedAt` null. That is deliberate: the mutation
 * may or may not have partially applied, so the honest state is "unknown", and
 * the next retry with the same key gets a 409 rather than silently re-running a
 * money operation. The record expires after the TTL and the key frees up.
 */
async function runAndRecord(
  handler: (body: unknown) => Promise<NextResponse>,
  body: unknown,
  where: { scope_key_userId: { scope: string; key: string; userId: string } },
): Promise<NextResponse> {
  let response: NextResponse;
  try {
    response = await handler(body);
  } catch (err) {
    // A THROWN handler must free the key too. The money routes signal their
    // caller-actionable failures by throwing — refundPayment raises
    // RefundValidationError for things like REFUND_BLOCKED_BY_DISPUTE, which
    // the route maps to a 400 and which the operator is expected to fix and
    // retry. Leaving the claim in place would answer that retry with
    // IDEMPOTENCY_IN_FLIGHT for the full 24-hour TTL.
    //
    // Freeing it is safe for the same reason the non-2xx path is: the
    // underlying operations are individually idempotent (the refund's
    // Serializable Phase 1 re-derives the refundable balance, the gateway call
    // carries its own key), so a retry cannot double-apply.
    await prisma.idempotencyRecord.delete({ where }).catch(() => {});
    throw err;
  }

  // Only successful responses are replayable. Recording a 4xx/5xx would pin the
  // caller to a failure they are entitled to retry out of.
  if (response.status >= 200 && response.status < 300) {
    let responseBody: unknown = null;
    try {
      responseBody = await response.clone().json();
    } catch {
      responseBody = null;
    }
    await prisma.idempotencyRecord.update({
      where,
      data: {
        completedAt: new Date(),
        responseStatus: response.status,
        responseBody: responseBody as never,
      },
    });
  } else {
    // Free the key so the caller can legitimately retry after fixing the cause.
    await prisma.idempotencyRecord.delete({ where }).catch(() => {}); // already swept — nothing to undo
  }

  return response;
}
