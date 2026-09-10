/**
 * @jest-environment node
 */

/**
 * PM-10 (#677) — test-vs-live key guards.
 *
 * Both Razorpay clients build straight from env vars, so a TEST key pasted
 * into a production posture used to boot cleanly and fail only at the first
 * customer: charges decline, refunds dead-end, payouts vanish into test mode
 * while the ledger reads COMPLETED. These tests pin:
 *
 *   - core checkout/refund client: NODE_ENV=production + rzp_test_ → throws
 *   - RazorpayX payouts client:   ENABLE_LIVE_PAYOUTS=true + rzp_test_ → throws
 *
 * and the flip side that keeps dev/preview/test working: test keys stay
 * legitimate outside those postures.
 *
 * Each test re-requires the modules under jest.resetModules() because both
 * clients initialize at module load / factory-first-call from process.env.
 * (#1221 made the CORE client construct lazily — the PM-10 guard still fires
 * at module load as a cheap env check, while SDK construction happens on the
 * first getRazorpayClient() call. The assertions below follow that split.)
 * Error-code asserts are duck-typed (not instanceof) on purpose: resetModules
 * means the PaymentError class inside the fresh module registry is a
 * different constructor than any top-level import here.
 */

type EnvKey =
  | "NODE_ENV"
  | "NEXT_PHASE"
  | "RAZORPAY_KEY_ID"
  | "RAZORPAY_SECRET"
  | "RAZORPAYX_KEY_ID"
  | "RAZORPAYX_KEY_SECRET"
  | "RAZORPAYX_ACCOUNT_NUMBER"
  | "ENABLE_LIVE_PAYOUTS"
  | "RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION";

const ENV_KEYS: EnvKey[] = [
  "NODE_ENV",
  "NEXT_PHASE",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_SECRET",
  "RAZORPAYX_KEY_ID",
  "RAZORPAYX_KEY_SECRET",
  "RAZORPAYX_ACCOUNT_NUMBER",
  "ENABLE_LIVE_PAYOUTS",
  "RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION",
];

const savedEnv: Partial<Record<EnvKey, string | undefined>> = {};

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  const env = process.env as Record<string, string | undefined>;
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key];
    if (saved === undefined) delete env[key];
    else env[key] = saved;
  }
});

beforeEach(() => {
  jest.resetModules();
});

/** NODE_ENV is typed readonly (next-env); go through the record to set it.
 * (Uniquely named: this file has no imports, so declarations stay global.) */
function setNodeEnvForGuard(value: string): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

function captureThrow(fn: () => unknown): { message: string; code?: string } {
  try {
    fn();
  } catch (error) {
    const err = error as { message?: string; code?: string };
    return { message: err.message ?? String(error), code: err.code };
  }
  throw new Error("expected the call to throw");
}

// Relative requires on purpose (repo convention for jest.resetModules tests —
// see __tests__/lib/feature-flags.test.ts): the alias does not resolve inside
// a dynamic require, and resetModules needs a fresh registry entry per test.
const requireCoreModule = () => require("../../lib/payments/core/razorpay");
const requirePayoutsFactory = () =>
  require("../../lib/payments/payouts/razorpay-payouts") as typeof import("../../lib/payments/payouts/razorpay-payouts");

describe("core checkout/refund client (lib/payments/core/razorpay.ts)", () => {
  it("prod posture + rzp_test_ key → throws at init, naming RAZORPAY_KEY_ID and the fix", () => {
    setNodeEnvForGuard("production");
    process.env.RAZORPAY_KEY_ID = "rzp_test_wrongposture";
    process.env.RAZORPAY_SECRET = "some_secret";

    const thrown = captureThrow(() => requireCoreModule());

    expect(thrown.message).toMatch(/RAZORPAY_KEY_ID/);
    expect(thrown.message).toMatch(/rzp_test_wrongposture/);
    expect(thrown.message).toMatch(/LIVE keys/);
    expect(thrown.code).toBe("RAZORPAY_TEST_KEY_IN_PRODUCTION");
  });

  it("prod posture + rzp_test_ key + RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION=true → boots with a loud error log (pre-launch opt-out)", () => {
    setNodeEnvForGuard("production");
    process.env.RAZORPAY_KEY_ID = "rzp_test_optout";
    process.env.RAZORPAY_SECRET = "some_secret";
    process.env.RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION = "true";
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => requireCoreModule()).not.toThrow();
      expect(spy).toHaveBeenCalledWith(
        expect.stringMatching(/RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION=true/),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("prod posture + rzp_test_ key → the refund modules still load; only the gateway core throws (cancel preview must not die at import)", async () => {
    setNodeEnvForGuard("production");
    process.env.RAZORPAY_KEY_ID = "rzp_test_wrongposture";
    process.env.RAZORPAY_SECRET = "some_secret";
    jest.doMock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
    await expect(
      import("../../lib/payments/operations/refund"),
    ).resolves.toBeDefined();
    await expect(
      import("../../lib/payments/operations/booking-refund"),
    ).resolves.toBeDefined();
    expect(() => requireCoreModule()).toThrow();
  });

  it("dev posture + rzp_test_ key → initializes fine (test keys are legitimate there)", () => {
    setNodeEnvForGuard("development");
    process.env.RAZORPAY_KEY_ID = "rzp_test_legit_in_dev";
    process.env.RAZORPAY_SECRET = "some_secret";

    const mod = requireCoreModule();

    expect(mod.getRazorpayClient()).not.toBeNull();
  });

  it("next build phase + prod posture + rzp_test_ key → initializes fine (builds move no money)", () => {
    setNodeEnvForGuard("production");
    process.env.NEXT_PHASE = "phase-production-build";
    process.env.RAZORPAY_KEY_ID = "rzp_test_buildkey";
    process.env.RAZORPAY_SECRET = "testsecret";
    expect(() => requireCoreModule()).not.toThrow();
  });

  it("production + rzp_live_ key → initializes fine (the guard only fires on test keys)", () => {
    setNodeEnvForGuard("production");
    process.env.RAZORPAY_KEY_ID = "rzp_live_realkeyid";
    process.env.RAZORPAY_SECRET = "some_secret";

    const mod = requireCoreModule();

    expect(mod.getRazorpayClient()).not.toBeNull();
  });
});

describe("RazorpayX payouts client (lib/payments/payouts/razorpay-payouts.ts)", () => {
  function seedPayoutCreds(keyId: string): void {
    process.env[keyId === "fallback" ? "RAZORPAY_KEY_ID" : "RAZORPAYX_KEY_ID"] =
      keyId === "fallback" ? "rzp_test_via_fallback" : keyId;
    if (keyId !== "fallback") delete process.env.RAZORPAY_KEY_ID;
    else delete process.env.RAZORPAYX_KEY_ID;
    process.env.RAZORPAYX_KEY_SECRET = "x_secret";
    process.env.RAZORPAYX_ACCOUNT_NUMBER = "acc_number";
  }

  it("ENABLE_LIVE_PAYOUTS=true + direct RAZORPAYX test key → throws at factory init", () => {
    process.env.ENABLE_LIVE_PAYOUTS = "true";
    seedPayoutCreds("rzp_test_xdirect");

    const thrown = captureThrow(() =>
      requirePayoutsFactory().getRazorpayPayoutsService(),
    );

    expect(thrown.message).toMatch(/RAZORPAYX_KEY_ID/);
    expect(thrown.message).toMatch(/rzp_test_xdirect/);
    expect(thrown.code).toBe("RAZORPAYX_TEST_KEYS_IN_LIVE_MODE");
  });

  it("ENABLE_LIVE_PAYOUTS=true + test key arriving via the RAZORPAY_KEY_ID fallback → throws too", () => {
    process.env.ENABLE_LIVE_PAYOUTS = "true";
    seedPayoutCreds("fallback");

    const thrown = captureThrow(() =>
      requirePayoutsFactory().getRazorpayPayoutsService(),
    );

    expect(thrown.message).toMatch(/falling back to RAZORPAY_KEY_ID/);
    expect(thrown.message).toMatch(/rzp_test_via_fallback/);
    expect(thrown.code).toBe("RAZORPAYX_TEST_KEYS_IN_LIVE_MODE");
  });

  it("flag off + test key → constructs fine (dev/preview/sandbox-smoke posture)", () => {
    delete process.env.ENABLE_LIVE_PAYOUTS;
    seedPayoutCreds("rzp_test_xflagoff");

    const { getRazorpayPayoutsService } = requirePayoutsFactory();

    expect(getRazorpayPayoutsService().isConfigured()).toBe(true);
  });

  it("production NODE_ENV alone does NOT fire the X guard while live payouts stay frozen", () => {
    // Chosen semantics: the disbursement freeze is what makes test keys safe.
    // With ENABLE_LIVE_PAYOUTS=false no money moves via X even in production,
    // so prod-under-freeze with sandbox keys keeps working until go-live.
    setNodeEnvForGuard("production");
    delete process.env.ENABLE_LIVE_PAYOUTS;
    seedPayoutCreds("rzp_test_xprodfrozen");

    const { getRazorpayPayoutsService } = requirePayoutsFactory();

    expect(getRazorpayPayoutsService().isConfigured()).toBe(true);
  });

  it("next build phase + live flag + test key → constructs fine (builds move no money)", () => {
    process.env.ENABLE_LIVE_PAYOUTS = "true";
    process.env.NEXT_PHASE = "phase-production-build";
    process.env.RAZORPAYX_KEY_ID = "rzp_test_buildx";
    // #1219-triage — a missing secret must not be the reason this passes:
    // construct against a complete credential set so the exemption (not an
    // unrelated config throw) is what's under test.
    process.env.RAZORPAYX_KEY_SECRET = "xsecret";
    process.env.RAZORPAYX_ACCOUNT_NUMBER = "acc_1";
    const mod = requirePayoutsFactory();
    expect(() => mod.getRazorpayPayoutsService()).not.toThrow();
  });

  it("isRazorpayPayoutsConfigured rethrows the guard instead of reading as 'not configured'", () => {
    // balance-preflight fails OPEN on a plain false — a swallowed guard there
    // would wave a live batch through on test keys. It must propagate.
    process.env.ENABLE_LIVE_PAYOUTS = "true";
    seedPayoutCreds("rzp_test_xpreflight");

    const { isRazorpayPayoutsConfigured } = requirePayoutsFactory();
    const thrown = captureThrow(() => isRazorpayPayoutsConfigured());

    expect(thrown.code).toBe("RAZORPAYX_TEST_KEYS_IN_LIVE_MODE");
  });
});
