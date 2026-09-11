/**
 * @jest-environment node
 */

/**
 * Better Stack Telemetry sink (#776 §K). The contract: no network when the
 * flag is off, a Bearer-authed POST when on+configured, and NEVER throws into
 * the caller (recordSystemEvent's critical path must survive an ingest outage).
 *
 * The flag is read at module load, so each case sets env + jest.resetModules
 * and re-imports.
 */

describe("emitTelemetryLog", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    process.env = OLD_ENV;
    jest.restoreAllMocks();
  });

  it("is a no-op (no fetch) when the flag is off", async () => {
    process.env.ENABLE_BETTERSTACK_TELEMETRY = "false";
    process.env.BETTERSTACK_SOURCE_TOKEN = "tok";
    process.env.BETTERSTACK_INGEST_URL = "https://in.example.com";
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;

    const { emitTelemetryLog } = await import(
      "@/lib/observability/betterstack-telemetry"
    );
    await emitTelemetryLog({ level: "error", message: "boom" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT fetch when flag on but token/url missing", async () => {
    process.env.ENABLE_BETTERSTACK_TELEMETRY = "true";
    delete process.env.BETTERSTACK_SOURCE_TOKEN;
    delete process.env.BETTERSTACK_INGEST_URL;
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;

    const { emitTelemetryLog } = await import(
      "@/lib/observability/betterstack-telemetry"
    );
    await emitTelemetryLog({ level: "warn", message: "x" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs with a Bearer source token when on+configured", async () => {
    process.env.ENABLE_BETTERSTACK_TELEMETRY = "true";
    process.env.BETTERSTACK_SOURCE_TOKEN = "tok-123";
    process.env.BETTERSTACK_INGEST_URL = "https://in.example.com";
    const fetchSpy = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchSpy as never;

    const { emitTelemetryLog } = await import(
      "@/lib/observability/betterstack-telemetry"
    );
    await emitTelemetryLog({
      level: "error",
      message: "stuck payout",
      category: "PAYOUT",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://in.example.com");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok-123");
    const body = JSON.parse(opts.body);
    expect(body.level).toBe("error");
    expect(body.message).toBe("stuck payout");
    expect(body.category).toBe("PAYOUT");
  });

  it("never throws when the ingest call fails", async () => {
    process.env.ENABLE_BETTERSTACK_TELEMETRY = "true";
    process.env.BETTERSTACK_SOURCE_TOKEN = "tok";
    process.env.BETTERSTACK_INGEST_URL = "https://in.example.com";
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error("network down")) as never;
    jest.spyOn(console, "error").mockImplementation(() => {});

    const { emitTelemetryLog } = await import(
      "@/lib/observability/betterstack-telemetry"
    );
    await expect(
      emitTelemetryLog({ level: "error", message: "x" }),
    ).resolves.toBeUndefined();
  });
});
