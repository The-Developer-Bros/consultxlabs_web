import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import crypto from "node:crypto";
import { logWebhookEvent, isDbHealthy } from "../utils";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import {
  razorpayWebhookEnvelopeSchema,
  type RazorpayWebhookEnvelope,
} from "../../../../schemas/webhooks/razorpay";
// #785 — dispatch switch extracted to a Next-agnostic module so the B5
// stuck-webhook sweeper (jobs/cleanup/sweep-stuck-webhook-events) can replay
// crashed events through the exact same handler routing.
import { processRazorpayWebhookEvent } from "../razorpay-dispatch";
import {
  isPayoutEventName,
  matchRazorpayWebhookSecret,
  resolveRazorpayPaymentSecrets,
  verifyRazorpaySignature,
} from "./signature";

// #1377 — signature verification needs `node:crypto`, which the edge runtime
// does not provide. Node is already the App Router default for route handlers;
// pinning it here means a future project-wide default flip cannot silently
// break every inbound payment confirmation.
export const runtime = "nodejs";

/**
 * #1459 — a Razorpay event payload is a few kilobytes; the largest we have seen
 * is well under a hundredth of this. Anything bigger is not a delivery we have
 * to serve, and reading it into a buffer to HMAC it is work an unauthenticated
 * caller gets to make us do. The refusal is the first thing the handler does,
 * so an oversized body never reaches the signature read and never writes a
 * webhook-inbox row.
 */
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/**
 * #1459 — Content-Length is optional and set by the caller, so the header check
 * alone is a cap only a well-behaved sender honours: omit it, or send chunked,
 * and `req.text()` would buffer whatever arrives. Counting the bytes as they
 * stream in and abandoning the read the moment the cap is passed is what makes
 * the limit hold against the caller it was written for. The whole body is
 * decoded in one pass at the end, because a multi-byte character split across
 * two chunks must not be decoded twice — the HMAC covers these exact bytes.
 *
 * @returns The raw body, or `null` when the request exceeded the cap.
 */
async function readBodyWithinCap(req: NextRequest): Promise<string | null> {
  const stream = req.body;
  // No stream means there is no body to bound; `text()` yields "" and the
  // signature check below rejects it.
  if (!stream) return req.text();

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_WEBHOOK_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function POST(req: NextRequest) {
  // Content-Length is what a refusal can be based on before a single byte is
  // read, so an honest oversized delivery costs us nothing at all. A caller
  // that omits or understates it is caught by readBodyWithinCap instead.
  const declaredBytes = Number(req.headers.get("content-length"));
  if (
    Number.isFinite(declaredBytes) &&
    declaredBytes > MAX_WEBHOOK_BODY_BYTES
  ) {
    console.warn(
      `Rejected oversized Razorpay webhook body: ${declaredBytes} bytes`,
    );
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  Sentry.setTag("subsystem", "payments");

  // #1377 — the payment-side secrets, current first and (only during a
  // rotation) the previous one. See resolveRazorpayPaymentSecrets for why the
  // grace window exists: a hard cutover loses events permanently.
  const paymentSecrets = resolveRazorpayPaymentSecrets();
  if (paymentSecrets.length === 0) {
    console.error("RAZORPAY_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  // M2 FIX: RazorpayX payout webhooks may use a separate secret.
  // Try the main Razorpay secret first. If that fails and a RazorpayX secret
  // is configured, re-verify with it (for payout.* events).
  const razorpayXSecret = process.env.RAZORPAYX_WEBHOOK_SECRET;

  const signature = req.headers.get("x-razorpay-signature");
  // The HMAC covers the RAW bytes. Read them once here and hand the same
  // string to every verification attempt — parsing and re-serialising would
  // reorder keys and break the digest.
  const body = signature ? await readBodyWithinCap(req) : "";
  if (body === null) {
    console.warn(
      `Rejected oversized Razorpay webhook body: over ${MAX_WEBHOOK_BODY_BYTES} bytes`,
    );
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const matchedRole = signature
    ? matchRazorpayWebhookSecret(body, signature, paymentSecrets)
    : null;

  if (matchedRole === "previous") {
    // The rotation grace is meant to be short. Every delivery that only the
    // OLD secret can verify is reported so a variable left behind after the
    // cutover shows up in the operations timeline instead of quietly
    // extending the window forever.
    await recordSystemEvent({
      category: "WEBHOOK",
      severity: "WARN",
      message:
        "Razorpay webhook verified with RAZORPAY_WEBHOOK_SECRET_PREVIOUS — rotation grace still in use",
      context: { provider: "razorpay" },
    });
  }

  if (!matchedRole) {
    // M2 FIX: Only allow RazorpayX secret fallback for payout.* events.
    // Read the event name from the (still unverified) body first — this
    // prevents non-payout events from being accepted with the RazorpayX
    // secret, and can only ever narrow what we accept.
    const isPossiblyPayoutEvent = signature ? isPayoutEventName(body) : false;

    const razorpayXAccepted =
      isPossiblyPayoutEvent &&
      !!signature &&
      !!razorpayXSecret &&
      !paymentSecrets.some(
        (candidate) => candidate.value === razorpayXSecret,
      ) &&
      verifyRazorpaySignature(body, signature, razorpayXSecret);

    if (!razorpayXAccepted) {
      // #776 §K — repeated HMAC failures are a tamper/misconfig signal.
      await recordSystemEvent({
        category: "WEBHOOK",
        severity: "WARN",
        message: isPossiblyPayoutEvent
          ? "Razorpay webhook HMAC verification failed (RazorpayX secret)"
          : "Razorpay webhook HMAC verification failed",
        context: isPossiblyPayoutEvent
          ? { provider: "razorpayx", event: "payout.*" }
          : { provider: "razorpay" },
      });
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }
    // RazorpayX signature valid for payout event — continue processing
  }

  // DB health check — return 503 if DB is unreachable so Razorpay retries
  if (!(await isDbHealthy())) {
    Sentry.logger.warn("razorpay webhook: db unhealthy, returning 503");
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 503 },
    );
  }

  // M3 FIX: Parse, log, and idempotency-check synchronously (fast path),
  // then return 200 immediately and process the event asynchronously via
  // Next.js `after()` to stay within Razorpay's 5-second webhook timeout.

  let event: RazorpayWebhookEnvelope;
  let eventType: string;

  try {
    const rawJson: unknown = JSON.parse(body);
    event = razorpayWebhookEnvelopeSchema.parse(rawJson);
    eventType = event.event;
  } catch (parseError) {
    console.error("Razorpay webhook parse error:", parseError);
    Sentry.captureException(parseError, {
      tags: { subsystem: "payments" },
      contexts: { webhook: { provider: "razorpay" } },
    });
    return NextResponse.json(
      { error: "Invalid webhook payload" },
      { status: 400 },
    );
  }

  // Razorpay sends `x-razorpay-event-id`, and it is tempting as the dedup key.
  // This repo deliberately does NOT use it — see
  // .claude/skills/finance/references/razorpay/references/webhooks.md.
  //
  // Two reasons, and the second is the one that matters. First, the synthesized
  // key dedups on the *business fact* rather than the delivery, so two distinct
  // deliveries describing the same state transition collapse to one. Second,
  // and decisively: the HMAC covers the BODY ONLY. A header is unsigned, so
  // keying on it would let anyone holding one captured (body, signature) pair
  // replay it N times under N invented header values and get N full dispatches.
  // The key below is derived entirely from signature-covered material — an
  // entity id from the payload, or a hash of the raw body — which is what makes
  // the dedup boundary tamper-proof rather than merely convenient.
  //
  // Every downstream handler is separately idempotent, so the amplification
  // would not have moved money; it would have removed a defence-in-depth layer
  // for no correctness gain. If you change this, you are changing what "already
  // processed" means AND weakening a trust boundary.
  // #1132 — refund/dispute MUST be probed before payment. Razorpay sends
  // `contains: ["refund","payment"]` on refund events, so a payment-first chain
  // keyed every refund on a given payment to the same id. The second partial
  // refund then matched as a duplicate and never reached handleRefundCreated —
  // no Refund row, no earnings reversal, no credit note, no ledger posting,
  // while the money had already left. Most-specific entity wins.
  const entityId =
    event.payload?.refund?.entity?.id ||
    event.payload?.dispute?.entity?.id ||
    event.payload?.payout?.entity?.id ||
    event.payload?.payment?.entity?.id ||
    event.payload?.order?.entity?.id ||
    event.account_id ||
    `body_${crypto.createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
  const eventId = `${eventType}:${entityId}`;

  // Idempotency check (synchronous — must complete before returning 200)
  const { isNew } = await logWebhookEvent(
    "razorpay",
    eventId,
    eventType,
    event.payload,
    signature || undefined,
  );

  if (!isNew) {
    console.log(`⚠️ Duplicate webhook event ${eventId}, returning OK`);
    return NextResponse.json({ status: "ok", duplicate: true });
  }

  Sentry.logger.info(Sentry.logger.fmt`razorpay webhook: ${eventType}`, {
    eventId,
  });

  // Return 200 immediately — process the event asynchronously
  after(async () => {
    await processRazorpayWebhookEvent(event, eventType, eventId);
  });

  return NextResponse.json({ status: "ok" });
}
