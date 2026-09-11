/**
 * @jest-environment node
 */

/**
 * The email layer itself, unmocked.
 *
 * `subscribe-send-failure.test.ts` mocks `lib/email` wholesale, so
 * `buildConfirmUrl` never runs there and the original regression would slip
 * through it. This suite exercises the real signing path: with no
 * `WAITLIST_HMAC_SECRET` in a production environment, link construction
 * throws, and the sender must absorb that and return `{ success: false }`
 * rather than throwing into its caller.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { failedEmail: { create: jest.fn() } },
}));

/** NODE_ENV is typed readonly; go through the record to set it in tests. */
function setNodeEnv(value: string) {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

describe("sendWaitlistConfirmEmail — signing failures", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("returns a failure result instead of throwing when the signing key is absent", async () => {
    setNodeEnv("production");
    delete process.env.WAITLIST_HMAC_SECRET;
    process.env.RESEND_API_KEY = "re_test_key";

    const { sendWaitlistConfirmEmail } = await import("../../lib/email");

    const result = await sendWaitlistConfirmEmail({
      email: "reader@example.com",
      name: null,
      issuedAt: Date.now(),
    });

    expect(result.success).toBe(false);
  });

  it("never prints a live confirmation link outside development", async () => {
    setNodeEnv("production");
    process.env.WAITLIST_HMAC_SECRET = "test-secret-value";
    delete process.env.RESEND_API_KEY;

    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const { sendWaitlistConfirmEmail } = await import("../../lib/email");

    await sendWaitlistConfirmEmail({
      email: "reader@example.com",
      name: null,
      issuedAt: Date.now(),
    });

    // The link is a bearer token: printing it would let anyone with log
    // access confirm the address.
    const printed = log.mock.calls.flat().join(" ");
    expect(printed).not.toContain("token=");
    expect(printed).not.toContain("/api/waitlist/confirm");
    log.mockRestore();
  });
});

describe("canSignLinks", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("reports false in production with no secret, without throwing", async () => {
    setNodeEnv("production");
    delete process.env.WAITLIST_HMAC_SECRET;

    const { canSignLinks } = await import("../../lib/waitlist/tokens");
    expect(canSignLinks()).toBe(false);
  });

  it("reports true once the secret is configured", async () => {
    setNodeEnv("production");
    process.env.WAITLIST_HMAC_SECRET = "test-secret-value";

    const { canSignLinks } = await import("../../lib/waitlist/tokens");
    expect(canSignLinks()).toBe(true);
  });
});
