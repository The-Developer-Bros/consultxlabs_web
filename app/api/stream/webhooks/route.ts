/**
 * Stream Webhook Handler — verify and acknowledge only.
 *
 * #1134 P1-2 — Stream gives a failed delivery a SIX SECOND per-request timeout
 * inside a FIFTEEN SECOND total budget, then drops the event permanently. The
 * attempt count is deliberately not asserted here: Stream's own documentation
 * contradicts itself, with the webhooks overview giving 3 attempts for
 * 408/429/5xx and 2 for network errors while their retries announcement says "a
 * maximum of five attempts, whichever comes first". Both agree on the budget,
 * and the budget is what this design turns on.
 *
 * A DB health probe plus an idempotency read plus the handler plus the
 * completion mark does not fit in six seconds on a cold Netlify instance, and
 * this repo has already measured ~30s of event-loop stall on instance boot.
 *
 * So this route does the two things that must happen synchronously — verify the
 * signature, and reject a body that can never be valid — then acknowledges and
 * hands off to `after()`. Everything else lives in lib/stream/webhook-dispatch,
 * which the stuck-event sweeper also drives; durability comes from the
 * WebhookEvent row, not from a retry window we cannot fit inside.
 *
 * Handled events are listed in HANDLED_EVENT_TYPES over in the dispatch module.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse, after } from "next/server";
import crypto from "crypto";
import { gunzip as gunzipCb } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import { verifySignature } from "stream-chat";
import { streamLogger } from "@/lib/stream-logger";
import {
  HANDLED_EVENT_TYPES,
  processStreamEvent,
  recordStreamEventReceipt,
  streamBaseEventSchema,
} from "@/lib/stream/webhook-dispatch";

const gunzip = promisify(gunzipCb);

/**
 * Read the delivery body as the bytes Stream SIGNED.
 *
 * Stream computes its HMAC over the UNCOMPRESSED payload, then optionally gzips
 * it on the wire. `enable_hook_payload_compression` defaults to **true** for
 * apps created after 2026-05-07, with a 256-byte threshold that every recording
 * and session event clears. This app currently has it unset — verified against
 * the live settings — so today the body arrives as plain text and `req.text()`
 * was right by accident.
 *
 * The accident is not worth relying on. If a gzipped body ever arrives, the
 * signature computed over the compressed bytes cannot match, this route answers
 * 401, and Stream treats a 401 as FINAL — it is not in the retryable set, so
 * the event is dropped and never redelivered. Every attendance row, recording
 * and session-end would vanish silently, which is exactly the shape of the
 * #1134 outage: 0 WebhookEvent rows, 0 MeetingAttendance, 1,663 sessions that
 * never ended.
 *
 * Detecting the gzip magic bytes rather than trusting `Content-Encoding` is
 * deliberate: a platform layer may decompress the body and leave the header on,
 * or pass it through and strip it. The bytes cannot lie about what they are.
 */
async function readSignedBody(req: NextRequest): Promise<string> {
  const raw = Buffer.from(await req.arrayBuffer());

  // 0x1f 0x8b — the gzip magic number. Two bytes is enough; nothing else Stream
  // sends starts with them, since a JSON payload begins with `{`.
  const isGzipped = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  if (!isGzipped) return raw.toString("utf8");

  const decompressed = await gunzip(raw);
  streamLogger.debug("Decompressed a gzipped Stream webhook payload", {
    compressedBytes: raw.length,
    decompressedBytes: decompressed.length,
  });
  return decompressed.toString("utf8");
}

/**
 * Verify the Stream webhook signature.
 *
 * #1280 — the HMAC is the SDK's `verifySignature` rather than a hand-rolled
 * `createHmac` + `timingSafeEqual`. It is the same algorithm, constant-time the
 * same way, and maintained against the cross-SDK contract instead of by us. The
 * hand-rolled version also compared `Buffer.from(signature)` against the
 * expected hex without validating that the input was hex at all, so a
 * same-length non-hex header reached `timingSafeEqual` on a byte comparison
 * that could never match but did not say why.
 *
 * ## Why NOT `verifyAndParseWebhook`
 *
 * `stream-chat@9.52.0` ships `verifyAndParseWebhook(rawBody, signature, secret)`
 * which decompresses, verifies and parses in one call — strictly more than this
 * does. It is deliberately not used, and the reason is worth writing down so it
 * is not "fixed" later.
 *
 * It returns only the parsed `Event`. It does not hand back the uncompressed
 * bytes. Our dedup key is `sha256` OF THOSE BYTES (see below), chosen because it
 * is the only material Stream actually signs — so adopting the helper would
 * force the key to be re-derived by re-serialising the parsed object, and
 * `JSON.stringify` is not byte-stable across key order or number formatting.
 * Two retries of one delivery could then hash differently and dispatch twice.
 *
 * So: the SDK verifies, `readSignedBody` keeps the bytes, and the two
 * responsibilities stay separate. `parseSqs`/`parseSns` are likewise not used —
 * Stream attaches no application-level HMAC to those transports and we are on
 * HTTP.
 */
function verifyStreamSignature(
  req: NextRequest,
  body: string,
  secret: string,
): boolean {
  const signature = req.headers.get("x-signature");

  if (!signature) {
    streamLogger.warn("No x-signature header found in Stream webhook request");
    return false;
  }

  try {
    return verifySignature(body, signature, secret);
  } catch (error) {
    streamLogger.error("Error verifying Stream webhook signature", error);
    return false;
  }
}

/**
 * #1134 P0-5 — Stream signs webhooks with the **API secret**. There is no
 * separate "signing secret" field in their dashboard, so requiring a distinct
 * `STREAM_WEBHOOK_SECRET` meant this route 500'd on every delivery for as long
 * as it existed: 0 rows in WebhookEvent for provider='stream', 0
 * MeetingAttendance, and 1,663 MeetingSessions that never ended.
 *
 * The override is kept so the value can be rotated independently if Stream ever
 * ships one, but the API secret is the correct default rather than a fatal gap.
 */
function getWebhookSecret(): string | undefined {
  return process.env.STREAM_WEBHOOK_SECRET || process.env.STREAM_API_SECRET;
}

export async function POST(req: NextRequest) {
  const secret = getWebhookSecret();

  // Validate webhook secret is configured
  if (!secret) {
    streamLogger.error(
      "Neither STREAM_WEBHOOK_SECRET nor STREAM_API_SECRET is configured — Stream webhooks cannot be verified",
    );
    Sentry.captureException(new Error("Stream webhook secret not configured"), {
      tags: { subsystem: "stream" },
      level: "fatal",
    });
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  // The bytes Stream signed — decompressed first when the delivery is gzipped.
  // See readSignedBody.
  const body = await readSignedBody(req);

  // Verify signature
  const isValid = verifyStreamSignature(req, body, secret);

  if (!isValid) {
    streamLogger.warn("Invalid Stream webhook signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // #1134 P1-2 — the DB health probe used to run here, on the request path, to
  // buy a 503 retry. That trade is bad on Stream's budget: six seconds per
  // request inside fifteen seconds total, then the event is dropped forever. A
  // probe plus an idempotency read plus the handler plus the mark does not fit
  // in six seconds on a cold Netlify instance — and this repo has already
  // measured ~30s of event-loop stall on instance boot.
  //
  // So: acknowledge first, process in after(). Durability comes from the
  // WebhookEvent row and the stuck-event sweeper (which now covers Stream), not
  // from a retry window we cannot fit inside.
  try {
    const event = JSON.parse(body);

    // Parse base event to get type
    const baseEvent = streamBaseEventSchema.parse(event);
    const eventType = baseEvent.type;

    // Check if this is an event type we handle
    if (!(HANDLED_EVENT_TYPES as readonly string[]).includes(eventType)) {
      streamLogger.debug(`Unhandled Stream event type: ${eventType}`);
      return NextResponse.json({ status: "ok", handled: false });
    }

    // #1134 P1-9 — dedup key derived ONLY from HMAC-verified material.
    //
    // An earlier version preferred Stream's `X-Webhook-ID` header. That
    // header is convenient operationally but is NOT covered by the signature
    // (Stream signs the body only), so one captured `(body, signature)` pair
    // could be replayed under N invented header values and mint N distinct
    // dedup keys — N dispatches from one verified delivery. Razorpay made
    // exactly this trade in the opposite direction for the same reason
    // (razorpay/route.ts "dedup key derived only from signature-covered
    // material").
    //
    // Keying on sha256(body) instead:
    //   - Retries of one delivery redeliver byte-identical payloads → they
    //     collapse to one key (the property X-Webhook-ID was bought for).
    //   - Legitimately-different events differ somewhere in the body
    //     (participant ids, message ids, timestamps) → never collapsed, which
    //     fixes the old hand-rolled key's bug where two flags in the same
    //     second deduped to one and participant joined/left dropped the user
    //     id entirely.
    const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
    const eventId = `stream_${baseEvent.type}_${bodyHash}`;

    const signature = req.headers.get("x-signature") || undefined;

    // Persist BEFORE acknowledging, then process in after().
    //
    // The durability argument used to be circular: it said durability comes from
    // the WebhookEvent row and the sweeper, while the row itself was written
    // inside `after()` — on the non-durable side of the acknowledgement. If the
    // instance froze before `after()` ran, or the DB probe inside it returned
    // unhealthy, no row was ever written; Stream already had its 200 and would
    // never redeliver; and the sweeper can only re-drive rows that exist. Three
    // paths, all losing a first delivery silently.
    //
    // One indexed insert of an already-parsed body fits inside the six-second
    // per-request timeout where the full handler does not — which is the whole
    // reason the handler moved to `after()` in the first place. This keeps that
    // split and makes the sweeper's guarantee real.
    //
    // A failure here is the one case worth a non-2xx: nothing is recorded, so
    // Stream's redelivery is the only remaining chance.
    try {
      await recordStreamEventReceipt(eventId, eventType, event, signature);
    } catch (persistError) {
      streamLogger.error(
        `Failed to persist Stream event ${eventId} before ack`,
        persistError,
      );
      Sentry.captureException(
        persistError instanceof Error
          ? persistError
          : new Error(String(persistError)),
        { tags: { subsystem: "stream" }, level: "error" },
      );
      return NextResponse.json(
        { error: "Could not record event" },
        { status: 503 },
      );
    }

    // Acknowledge now; do the work after the response is sent. Everything below
    // this point is off Stream's retry budget, and its durability now genuinely
    // comes from the row written above plus sweep-stuck-webhook-events.
    after(async () => {
      // `claimAlreadyHeld` because the receipt above created this row. Without
      // it, dispatch re-claims an id it already owns, sees its own IN-PROGRESS
      // row, and returns without handling anything — which left every event to
      // the sweeper, six to sixteen minutes later, instead of running inline.
      await processStreamEvent(
        event,
        eventType,
        eventId,
        signature,
        baseEvent,
        {
          claimAlreadyHeld: true,
        },
      );
    });

    return NextResponse.json({ status: "ok", accepted: true });
  } catch (error) {
    streamLogger.error("Stream webhook error", error);

    // A malformed body will never become well-formed, so 400 and stop the
    // retries rather than burning the budget on a permanent failure.
    //
    // `JSON.parse` throws SyntaxError, not ZodError, so genuinely malformed JSON
    // used to fall past this branch to the 500 below — and Stream then spent its
    // whole retry budget redelivering a body that could never parse.
    if (error instanceof SyntaxError) {
      streamLogger.error("Stream webhook received unparseable JSON", error);
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (error instanceof z.ZodError) {
      streamLogger.error("Stream webhook validation error", error);
      return NextResponse.json(
        { error: "Invalid event format", details: error.errors },
        { status: 400 },
      );
    }

    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );

    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}

/**
 * HEAD handler for webhook verification.
 * Some webhook providers send a HEAD request to check the endpoint is live.
 */
export async function HEAD() {
  return new NextResponse(null, { status: 200 });
}
