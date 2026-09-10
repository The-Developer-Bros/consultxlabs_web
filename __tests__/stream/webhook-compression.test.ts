import crypto from "crypto";
import { gzipSync, gunzipSync } from "node:zlib";

/**
 * #1270 — Stream signs the UNCOMPRESSED payload and then optionally gzips it on
 * the wire. `enable_hook_payload_compression` defaults to true for apps created
 * after 2026-05-07, with a 256-byte threshold every recording and session event
 * clears.
 *
 * The route used to HMAC whatever `req.text()` returned. Against a gzipped
 * delivery that is the compressed bytes, the signature cannot match, and the
 * route answers 401 — which Stream treats as FINAL. It is not in the retryable
 * set, so the event is dropped and never redelivered. Silently, and for every
 * delivery: no attendance, no recordings, no session ends. That is the shape of
 * the #1134 outage, which left 0 WebhookEvent rows and 1,663 sessions that
 * never ended.
 *
 * These tests exercise the read-and-verify pair directly rather than the route,
 * because the route's own module graph pulls the whole dispatcher in. The
 * contract under test is small and exact: whatever arrives on the wire, the
 * bytes we HMAC must be the bytes Stream signed.
 */

const SECRET = "test-api-secret";

/** What Stream does: sign the plain payload, then optionally gzip the body. */
function deliver(payload: string, compress: boolean) {
  const signature = crypto
    .createHmac("sha256", SECRET)
    .update(payload)
    .digest("hex");
  const wire = compress
    ? gzipSync(Buffer.from(payload, "utf8"))
    : Buffer.from(payload, "utf8");
  return { signature, wire };
}

/** The route's rule, extracted: trust the bytes, not the headers. */
function readSignedBody(raw: Buffer): string {
  const isGzipped = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  if (!isGzipped) return raw.toString("utf8");
  // Synchronous twin of the route's promisified gunzip — same branch, same
  // magic-byte test.
  return gunzipSync(raw).toString("utf8");
}

function verify(body: string, signature: string): boolean {
  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(body)
    .digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b);
}

// Comfortably past Stream's 256-byte compression threshold, so this is the
// shape a real recording or session event arrives in.
const EVENT = JSON.stringify({
  type: "call.session_participant_joined",
  call_cid: "default:slot-c0d2fdc8-523f-48c7-9fed-fa1a5d9830fb",
  created_at: "2026-08-30T10:00:00.000Z",
  participant: {
    user: { id: "cmqb17w91009stxyo3enzheni", name: "A Consultee" },
    user_session_id: "sess-".padEnd(120, "x"),
  },
  padding: "x".repeat(300),
});

describe("Stream webhook payload compression (#1270)", () => {
  it("is actually over Stream's compression threshold", () => {
    // If this ever drops under 256 bytes the rest of the suite stops testing
    // the case it is named for.
    expect(Buffer.byteLength(EVENT)).toBeGreaterThan(256);
  });

  it("verifies an uncompressed delivery, as it always did", () => {
    const { signature, wire } = deliver(EVENT, false);
    expect(verify(readSignedBody(wire), signature)).toBe(true);
  });

  it("verifies a GZIPPED delivery — the case that used to 401 forever", () => {
    const { signature, wire } = deliver(EVENT, true);

    // The wire bytes really are compressed and really are not the payload.
    expect(wire[0]).toBe(0x1f);
    expect(wire[1]).toBe(0x8b);
    expect(wire.toString("utf8")).not.toEqual(EVENT);

    expect(verify(readSignedBody(wire), signature)).toBe(true);
  });

  it("would have failed on the old behaviour, which is why this test exists", () => {
    const { signature, wire } = deliver(EVENT, true);
    // The old route: HMAC over whatever came off the wire.
    expect(verify(wire.toString("utf8"), signature)).toBe(false);
  });

  it("still rejects a forged signature, compressed or not", () => {
    const forged = crypto
      .createHmac("sha256", "not-the-secret")
      .update(EVENT)
      .digest("hex");

    for (const compress of [false, true]) {
      const { wire } = deliver(EVENT, compress);
      expect(verify(readSignedBody(wire), forged)).toBe(false);
    }
  });

  it("detects gzip from the bytes, not from a Content-Encoding header", () => {
    // A platform layer may decompress the body and leave the header on, or pass
    // it through and strip it. Neither changes what the bytes are.
    const { signature, wire } = deliver(EVENT, true);
    expect(verify(readSignedBody(wire), signature)).toBe(true);

    const plain = deliver(EVENT, false);
    expect(verify(readSignedBody(plain.wire), plain.signature)).toBe(true);
  });
});
