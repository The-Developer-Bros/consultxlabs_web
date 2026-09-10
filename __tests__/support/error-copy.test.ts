/**
 * @jest-environment node
 */

/**
 * #support-hub — client-side error presentation (lib/support/error-copy.ts).
 *
 * The contract: users get code-mapped, actionable copy; developers get the
 * raw payload on the console; nothing throws on malformed error bodies.
 */

import {
  describeSupportError,
  readSupportError,
  throwSupportError,
} from "../../lib/support/error-copy";

function jsonResponse(payload: unknown, status = 400): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("readSupportError", () => {
  it("parses the envelope from a failed response", async () => {
    const payload = await readSupportError(jsonResponse({ error: "x", code: "NOT_FOUND" }));
    expect(payload.code).toBe("NOT_FOUND");
  });

  it("never throws on non-JSON bodies", async () => {
    const res = new Response("<html>502</html>", { status: 502 });
    await expect(readSupportError(res)).resolves.toEqual({});
  });
});

describe("describeSupportError", () => {
  it("prefers the code-specific copy", () => {
    expect(
      describeSupportError({ code: "INVALID_ID", error: "Invalid appointment id" }),
    ).toContain("link looks broken");
  });

  it("falls back to the server's user-safe message for unknown codes", () => {
    expect(describeSupportError({ error: "That support topic isn't available" })).toBe(
      "That support topic isn't available",
    );
  });

  it("uses the caller's fallback when there is nothing at all", () => {
    expect(describeSupportError(null, "Please try again.")).toBe("Please try again.");
    expect(describeSupportError({}, "Please try again.")).toBe("Please try again.");
  });

  it("never surfaces developer detail to users", () => {
    const msg = describeSupportError({
      code: "VALIDATION_FAILED",
      detail: { fieldErrors: { rating: ["Expected number"] } },
    });
    expect(msg).not.toContain("rating");
    expect(msg).not.toContain("Expected number");
  });
});

describe("throwSupportError", () => {
  it("logs the raw payload for devs and throws code-mapped copy for users", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = jsonResponse(
      { error: "Invalid appointment id", code: "INVALID_ID", detail: { id: ["too long"] } },
      400,
    );
    errSpy.mockClear();

    const thrown = await throwSupportError(res, "support turn").catch((e: Error) => e);
    expect(thrown).toBeInstanceOf(Error);
    // User-facing message is the friendly copy…
    expect(thrown.message).toContain("link looks broken");
    // …while devs saw status + raw envelope on the console.
    expect(errSpy).toHaveBeenCalledWith(
      "[support] support turn failed",
      400,
      expect.objectContaining({ code: "INVALID_ID" }),
    );
  });

  it("maps RATE_LIMITED copy so throttled users know what to do", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const res = jsonResponse({ error: "Too many requests", code: "RATE_LIMITED" }, 429);
    const thrown = await throwSupportError(res, "tickets").catch((e: Error) => e);
    expect(thrown.message).toContain("too quickly");
  });
});
