/**
 * @jest-environment node
 */

/**
 * Pin the HMAC-SHA256 signing contract. Receivers depend on these
 * invariants — any drift here breaks every integrator's signature
 * check at once, so the assertions are intentionally low-level.
 */

import {
  DEFAULT_REPLAY_WINDOW_SECONDS,
  generateEndpointSecret,
  signPayload,
  verifySignature,
  SIGNATURE_HEADER,
} from "@/lib/enterprise/outbound-webhooks/signing";

describe("signPayload / verifySignature roundtrip", () => {
  const secret = "test-secret-very-long-32-bytes-or-more-abcdef";
  const body = JSON.stringify({ id: "evt_1", type: "invoice.issued" });

  it("verifies a signature produced for the same body + secret + timestamp", () => {
    const ts = 1_700_000_000;
    const header = signPayload(secret, body, ts);
    const result = verifySignature(secret, body, header, {
      now: () => ts,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a body mutation (the signature does not commute with edits)", () => {
    const ts = 1_700_000_000;
    const header = signPayload(secret, body, ts);
    const result = verifySignature(secret, `${body} `, header, {
      now: () => ts,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects a different secret (forgery attempt)", () => {
    const ts = 1_700_000_000;
    const header = signPayload(secret, body, ts);
    const result = verifySignature("wrong-secret", body, header, {
      now: () => ts,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects timestamps outside the replay window", () => {
    const ts = 1_700_000_000;
    const header = signPayload(secret, body, ts);
    // Simulate "now" being 12h ahead → far outside the 9h default window.
    const tooLate = ts + DEFAULT_REPLAY_WINDOW_SECONDS + 1;
    const result = verifySignature(secret, body, header, {
      now: () => tooLate,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("REPLAY_WINDOW_EXCEEDED");
  });

  it("rejects malformed header values gracefully (no throw)", () => {
    expect(verifySignature(secret, body, "not-a-sig-header").valid).toBe(
      false,
    );
    // Missing t= component.
    expect(verifySignature(secret, body, "v1=abcd").valid).toBe(false);
    // Missing v1= component.
    expect(verifySignature(secret, body, "t=12345").valid).toBe(false);
  });

  it("produces a header in the documented shape (t=<unix>,v1=<hex>)", () => {
    const header = signPayload(secret, body, 1_700_000_000);
    expect(header).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/);
  });
});

describe("generateEndpointSecret", () => {
  it("returns 64 hex chars (32 bytes of entropy)", () => {
    const secret = generateEndpointSecret();
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is non-deterministic across calls", () => {
    const a = generateEndpointSecret();
    const b = generateEndpointSecret();
    expect(a).not.toBe(b);
  });
});

describe("SIGNATURE_HEADER", () => {
  it("matches the documented header name (integrators copy-paste this)", () => {
    expect(SIGNATURE_HEADER).toBe("X-Familiarise-Signature");
  });
});
