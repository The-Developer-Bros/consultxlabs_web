/**
 * @jest-environment node
 */

/**
 * FAMILIARISE_WEB-1C — a consultee's appointments page sent Sentry
 * `SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, and
 * put that same string in the toast. A Netlify crash page, a function timeout
 * and a middleware redirect to sign-in all answer with HTML, and the redirect
 * answers with it at status 200 — so `res.ok` alone never caught it.
 *
 * What this pins: the status survives to the caller. The cancel dialog reads
 * `status === 409` to tell "the booking already changed state, refreshing" from
 * a real failure; lose that and a lost CAS race starts looking like a crash.
 */

import { ApiResponseError, requireJsonResponse } from "@/lib/fetch-helpers";

const HTML = "<!DOCTYPE html><html><body>Gateway error</body></html>";

function htmlResponse(status: number): Response {
  return new Response(HTML, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("requireJsonResponse", () => {
  it("turns an HTML error page into a typed error carrying the status", async () => {
    await expect(
      requireJsonResponse(htmlResponse(502), "Failed to cancel appointment"),
    ).rejects.toMatchObject({
      name: "ApiResponseError",
      status: 502,
      message: "Failed to cancel appointment (HTTP 502)",
    });
  });

  it("rejects an HTML body served at 200 — a followed sign-in redirect", async () => {
    const error = await requireJsonResponse(
      htmlResponse(200),
      "Events fetch failed",
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiResponseError);
    expect((error as Error).name).not.toBe("SyntaxError");
    expect((error as ApiResponseError).status).toBe(200);
  });

  it("keeps the 409 the cancel dialog branches on, and the server's own message", async () => {
    await expect(
      requireJsonResponse(
        jsonResponse(409, { error: "This booking changed state" }),
        "Failed to cancel appointment",
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: "This booking changed state",
    });
  });

  it("returns the parsed body on a 2xx JSON response", async () => {
    await expect(
      requireJsonResponse(jsonResponse(200, { refund: { status: "FAILED" } })),
    ).resolves.toEqual({ refund: { status: "FAILED" } });
  });

  it("rejects malformed JSON on a 2xx instead of resolving it as null", async () => {
    const malformed = new Response("{not valid json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const error = await requireJsonResponse(
      malformed,
      "Failed to load plan",
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiResponseError);
    expect((error as ApiResponseError).status).toBe(200);
  });

  it("still surfaces the status when an error response body is malformed JSON", async () => {
    const malformed = new Response("{not valid json", {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    await expect(
      requireJsonResponse(malformed, "Failed to load plan"),
    ).rejects.toMatchObject({
      status: 500,
      message: "Failed to load plan (HTTP 500)",
    });
  });
});
