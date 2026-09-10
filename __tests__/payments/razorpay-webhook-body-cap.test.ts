/**
 * @jest-environment node
 */

/**
 * #1459 — the Razorpay webhook route is unauthenticated until the HMAC is
 * checked, and checking the HMAC means reading the whole body into a buffer. A
 * real Razorpay event is a few kilobytes, so an oversized body is never a
 * delivery we owe service to; refusing it before the signature read is what
 * keeps a stranger from choosing how much memory the route allocates. The
 * refusal has to come first in the handler for that to hold, which is what this
 * pins: the request carries a signature header, so every later step would
 * otherwise run, and neither the body read nor the verifier is reached.
 */

jest.mock("@sentry/nextjs", () => ({
  setTag: jest.fn(),
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../app/api/webhooks/utils", () => ({
  verifyWebhookSignature: jest.fn(),
  logWebhookEvent: jest.fn(),
  isDbHealthy: jest.fn(),
}));

// The route verifies through its own module, not the shared webhook util, so
// this is the mock that proves the HMAC path was skipped.
jest.mock("../../app/api/webhooks/razorpay/signature", () => ({
  isPayoutEventName: jest.fn().mockReturnValue(false),
  matchRazorpayWebhookSecret: jest.fn().mockReturnValue("current"),
  resolveRazorpayPaymentSecrets: jest.fn().mockReturnValue(["secret"]),
  verifyRazorpaySignature: jest.fn().mockReturnValue(true),
}));

jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  processRazorpayWebhookEvent: jest.fn(),
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: jest.fn(),
}));

import type { NextRequest } from "next/server";

import { POST } from "../../app/api/webhooks/razorpay/route";
import { logWebhookEvent } from "../../app/api/webhooks/utils";
import {
  matchRazorpayWebhookSecret,
  resolveRazorpayPaymentSecrets,
} from "../../app/api/webhooks/razorpay/signature";

function oversizedRequest(bytes: number) {
  const headers = new Headers({
    "content-length": String(bytes),
    "x-razorpay-signature": "deadbeef",
  });
  const text = jest.fn().mockResolvedValue("{}");
  return { req: { headers, text } as unknown as NextRequest, text };
}

/**
 * A delivery that declares no size at all — the case a header check cannot
 * see. `pumped` counts the 64 KB chunks the route actually pulled, which is
 * how the test tells "stopped at the cap" apart from "buffered the lot".
 */
function undeclaredRequest(chunkCount: number) {
  const counter = { pumped: 0 };
  let remaining = chunkCount;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      remaining--;
      counter.pumped++;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
  });
  const headers = new Headers({ "x-razorpay-signature": "deadbeef" });
  return { req: { headers, body } as unknown as NextRequest, counter };
}

describe("Razorpay webhook body cap (#1459)", () => {
  it("refuses a body over 256 KB with 413, before the signature read", async () => {
    const { req, text } = oversizedRequest(512 * 1024);

    const res = await POST(req);

    expect(res.status).toBe(413);
    // The refusal precedes the read, so nothing was buffered to be hashed.
    expect(text).not.toHaveBeenCalled();
    expect(resolveRazorpayPaymentSecrets).not.toHaveBeenCalled();
    expect(matchRazorpayWebhookSecret).not.toHaveBeenCalled();
    expect(logWebhookEvent).not.toHaveBeenCalled();
  });

  it("stops reading a body that never declared its size, once past the cap", async () => {
    // 32 × 64 KB = 2 MB offered; the cap is 256 KB, so the fifth chunk is the
    // one that crosses it and the read must abandon there. A ReadableStream
    // pre-pulls one chunk past the reader, hence six rather than five — the
    // point is that it is nowhere near the 32 a full buffering would have.
    const { req, counter } = undeclaredRequest(32);

    const res = await POST(req);

    expect(res.status).toBe(413);
    expect(counter.pumped).toBeLessThanOrEqual(6);
    expect(matchRazorpayWebhookSecret).not.toHaveBeenCalled();
    expect(logWebhookEvent).not.toHaveBeenCalled();
  });
});
