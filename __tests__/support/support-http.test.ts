/**
 * @jest-environment node
 */

/**
 * #support-hub — the ONE error envelope for the support surface.
 *
 * Contract under test:
 * - Body shape: `{ error, code, detail? }` — user-safe copy, machine code,
 *   developer detail only when provided.
 * - Sentry policy: an original exception is captured WITH its stack (level
 *   error ≥500, warning below); a causeless 5xx/4xx is a captureMessage
 *   warning-worthy contract drift; 401/429 are expected client behavior and
 *   must stay silent.
 * - parseRouteParams: opaque-id schemas answer INVALID_ID envelopes without
 *   imposing uuid/cuid format gates.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { supportError, parseRouteParams } from "../../lib/api/support-http";

const mockedCaptureException = Sentry.captureException as jest.Mock;
const mockedCaptureMessage = Sentry.captureMessage as jest.Mock;

const IdSchema = z.object({ id: z.string().min(1).max(64) });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("supportError envelope", () => {
  it("returns {error, code} with the default copy for the code", async () => {
    const res = supportError({ status: 401, code: "UNAUTHORIZED" });
    expect(res.status).toBe(401);
    const body = await bodyOf(res);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("sign in");
    // No fabricated developer detail.
    expect(body).not.toHaveProperty("detail");
  });

  it("includes detail only when provided", async () => {
    const flatten = { formErrors: [], fieldErrors: { id: ["Too long"] } };
    const res = supportError({
      status: 400,
      code: "VALIDATION_FAILED",
      detail: flatten,
    });
    const body = await bodyOf(res);
    expect(body.detail).toEqual(flatten);
  });

  it("honours a message override while keeping the code stable", async () => {
    const res = supportError({
      status: 404,
      code: "NOT_FOUND",
      message: "Thread not found",
    });
    const body = await bodyOf(res);
    expect(body.error).toBe("Thread not found");
    expect(body.code).toBe("NOT_FOUND");
  });

  it("keeps 5xx detail server-side — never echoed to the client", async () => {
    const res = supportError({
      status: 500,
      code: "INTERNAL",
      detail: { upstream: "connect ECONNREFUSED db.internal:5432" },
    });
    const body = await bodyOf(res);
    expect(body).not.toHaveProperty("detail");
  });
});

describe("Sentry policy", () => {
  it("captures the ORIGINAL exception (stack intact) at error level for 5xx", () => {
    const cause = new Error("boom");
    supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "x", action: "y" },
    });
    expect(mockedCaptureException).toHaveBeenCalledTimes(1);
    const [captured, hints] = mockedCaptureException.mock.calls[0];
    expect(captured).toBe(cause);
    expect(hints.level).toBe("error");
    expect(hints.tags).toMatchObject({ subsystem: "support", code: "INTERNAL" });
    expect(hints.extra).toMatchObject({ route: "x", action: "y" });
    expect(mockedCaptureMessage).not.toHaveBeenCalled();
  });

  it("captures exceptions from 4xx as warnings (contract drift, not paging)", () => {
    supportError({ status: 403, code: "FORBIDDEN", cause: new Error("late authz") });
    expect(mockedCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ level: "warning" }),
    );
  });

  it("applies the 401/429 exemption on the cause path too", () => {
    supportError({ status: 401, code: "UNAUTHORIZED", cause: new Error("stale token") });
    supportError({ status: 429, code: "RATE_LIMITED", cause: new Error("burst") });
    expect(mockedCaptureException).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).not.toHaveBeenCalled();
  });

  it("causeless 4xx is a captureMessage warning — visible, quiet", () => {
    supportError({ status: 400, code: "INVALID_ID" });
    expect(mockedCaptureException).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining("[INVALID_ID]"),
      expect.objectContaining({ level: "warning" }),
    );
  });

  it("causeless 5xx escalates to a captureMessage error", () => {
    supportError({ status: 500, code: "INTERNAL" });
    expect(mockedCaptureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ level: "error" }),
    );
  });

  it.each([401, 429])("%i without cause is expected client noise — uncaptured", (status) => {
    supportError({ status, code: status === 401 ? "UNAUTHORIZED" : "RATE_LIMITED" });
    expect(mockedCaptureException).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).not.toHaveBeenCalled();
  });
});

describe("parseRouteParams", () => {
  it("answers ok with parsed data on valid input", async () => {
    const out = await parseRouteParams(IdSchema, { id: "demo0813-appt-ba" }, { route: "t" });
    if (!out.ok) throw new Error("expected ok");
    expect(out.data.id).toBe("demo0813-appt-ba");
  });

  it("answers with an INVALID_ID envelope (no response throw) on bad input", async () => {
    const out = await parseRouteParams(IdSchema, { id: "" }, { route: "t" });
    if (out.ok) throw new Error("expected failure");
    expect(out.response.status).toBe(400);
    const body = await bodyOf(out.response);
    expect(body.code).toBe("INVALID_ID");
    // Developer detail survives in the envelope…
    expect(body.detail).toBeDefined();
    // …but never leaks into the user copy.
    expect(typeof body.error).toBe("string");
  });

  it("rejects over-long ids that could abuse downstream queries", async () => {
    const out = await parseRouteParams(IdSchema, { id: "x".repeat(65) }, { route: "t" });
    if (out.ok) throw new Error("expected failure");
    expect(out.response.status).toBe(400);
  });

  it("accepts a params PROMISE — handlers pass it unawaited", async () => {
    const out = await parseRouteParams(
      IdSchema,
      Promise.resolve({ id: "slug-id" }),
      { route: "t" },
    );
    if (!out.ok) throw new Error("expected ok");
    expect(out.data.id).toBe("slug-id");
  });
});
