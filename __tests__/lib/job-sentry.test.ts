/**
 * #1066 — the half of the cron-Sentry fix that is most likely to regress.
 *
 * `Sentry.init` in a job process is worthless on its own: the SDK batches over
 * HTTP and the process exits as soon as the work is done. So these tests are
 * mostly about `flush` being unconditional — after a normal completion, after
 * an early `return`, and after a throw — rather than about capture, which is
 * the easy half to get right.
 */

// sentry.shared.config is deliberately NOT mocked: the environment gating is
// the thing under test, so it has to run for real. Only the SDK is faked.
const init = jest.fn();
const flush = jest.fn(async (_timeoutMs?: number) => true);
const captureException = jest.fn();
const loggerInfo = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  init: (options: unknown) => init(options),
  flush: (timeoutMs?: number) => flush(timeoutMs),
  captureException: (...args: unknown[]) => captureException(...args),
  logger: { info: (...args: unknown[]) => loggerInfo(...args) },
}));

const appendFileSync = jest.fn();
jest.mock("node:fs", () => ({
  __esModule: true,
  default: { appendFileSync: (...args: unknown[]) => appendFileSync(...args) },
}));

type SentryInitOptions = { enabled?: boolean; tracesSampleRate?: number };
const lastInitOptions = (): SentryInitOptions =>
  init.mock.calls.at(-1)?.[0] as SentryInitOptions;

type JobSentryModule = typeof import("../../lib/observability/job-sentry");
type LockErrorsModule = typeof import("../../lib/cron/cron-lock-errors");

/**
 * Fresh module registry each time so the one-shot `init` guard resets.
 *
 * The lock-error classes come out of the SAME registry, because `instanceof`
 * compares class identity and an isolated registry builds its own copy. They
 * are the real ones rather than stand-ins — lib/cron/cron-lock-errors is a leaf
 * with no imports, so using it costs nothing, and it means these tests would
 * actually catch someone making Unavailable extend Held. (#1066 F9/F11)
 */
function loadModule(): JobSentryModule & LockErrorsModule {
  let mod!: JobSentryModule;
  let errors!: LockErrorsModule;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    mod = require("../../lib/observability/job-sentry") as JobSentryModule;
    errors = require("../../lib/cron/cron-lock-errors") as LockErrorsModule;
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
  return { ...mod, ...errors };
}

describe("job Sentry runner", () => {
  const ORIGINAL_ENV = process.env;
  let originalExitCode: typeof process.exitCode;
  let consoleError: jest.SpyInstance;
  let consoleWarn: jest.SpyInstance;
  let consoleLog: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    flush.mockImplementation(async () => true);
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    // Jest itself runs inside GitHub Actions, where these are set for real —
    // the step-annotation path must not key off the harness's own environment.
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_OUTPUT;
    // The runner logs every failure it captures; these suites throw on purpose.
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleLog = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    process.env = ORIGINAL_ENV;
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    consoleLog.mockRestore();
  });

  describe("flushes on every exit path", () => {
    it("flushes after the body completes normally", async () => {
      const { runJobWithSentry } = loadModule();

      await runJobWithSentry("happy-job", async () => {});

      expect(flush).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
    });

    it("flushes when the body returns early without doing its work", async () => {
      // The lock-held / maintenance-skip shape: the body bails, but it may
      // already have queued a log or a breadcrumb.
      const { runJobWithSentry } = loadModule();
      const lockHeld = jest.fn(() => true);
      const afterReturn = jest.fn();

      await runJobWithSentry("early-return-job", async () => {
        if (lockHeld()) return;
        afterReturn();
      });

      expect(afterReturn).not.toHaveBeenCalled();
      expect(flush).toHaveBeenCalledTimes(1);
      expect(captureException).not.toHaveBeenCalled();
      // An early return is a clean skip, not a failure.
      expect(process.exitCode).toBeUndefined();
    });

    it("flushes AFTER capturing when the body throws", async () => {
      const { runJobWithSentry } = loadModule();
      const boom = new Error("job blew up");
      const order: string[] = [];
      captureException.mockImplementation(() => order.push("capture"));
      flush.mockImplementation(async () => {
        order.push("flush");
        return true;
      });

      await runJobWithSentry("throwing-job", async () => {
        throw boom;
      });

      // Flushing before the capture would drain an empty queue and drop the
      // very event the run exists to report.
      expect(order).toEqual(["capture", "flush"]);
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
    });

    it("does not rethrow a body error (an unhandled rejection would kill the flush)", async () => {
      const { runJobWithSentry } = loadModule();

      await expect(
        runJobWithSentry("throwing-job", async () => {
          throw new Error("job blew up");
        }),
      ).resolves.toBeUndefined();
    });

    it("tags the captured error with the job name", async () => {
      const { runJobWithSentry } = loadModule();

      await runJobWithSentry("tagged-job", async () => {
        throw new Error("nope");
      });

      const [, context] = captureException.mock.calls[0] as [
        unknown,
        { tags: Record<string, string> },
      ];
      expect(context.tags).toMatchObject({
        subsystem: "jobs",
        job: "tagged-job",
      });
    });

    it("normalises a non-Error throw instead of dropping it", async () => {
      const { runJobWithSentry } = loadModule();

      await runJobWithSentry("string-throw-job", async () => {
        throw "just a string";
      });

      const [captured] = captureException.mock.calls[0] as [Error];
      expect(captured).toBeInstanceOf(Error);
      expect(captured.message).toBe("just a string");
    });
  });

  describe("a held cron lock is a skip, not a failure", () => {
    // #476 — another replica is already running the job. Every job used to
    // decide this for itself; centralising it is what removed 58 copies of
    // the same catch block.
    it("does not set a non-zero exit code", async () => {
      const { runJobWithSentry, CronLockHeldError } = loadModule();

      await runJobWithSentry("locked-job", async () => {
        throw new CronLockHeldError("locked-job");
      });

      expect(process.exitCode).toBeUndefined();
    });

    it("is not captured to Sentry as an error", async () => {
      const { runJobWithSentry, CronLockHeldError } = loadModule();

      await runJobWithSentry("locked-job", async () => {
        throw new CronLockHeldError("locked-job");
      });

      expect(captureException).not.toHaveBeenCalled();
      expect(loggerInfo).toHaveBeenCalledWith(
        "job:locked-job skipped — cron lock held",
      );
    });

    it("still flushes, because the skipped run may already have logged", async () => {
      const { runJobWithSentry, CronLockHeldError } = loadModule();

      await runJobWithSentry("locked-job", async () => {
        throw new CronLockHeldError("locked-job");
      });

      expect(flush).toHaveBeenCalledTimes(1);
    });

    it("does not mark the workflow step failed", async () => {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_OUTPUT = "/tmp/does-not-matter";
      const { runJobWithSentry, CronLockHeldError } = loadModule();

      await runJobWithSentry("locked-job", async () => {
        throw new CronLockHeldError("locked-job");
      });

      expect(appendFileSync).not.toHaveBeenCalled();
    });

    it("still pages on CronLockUnavailableError, which is a different thing", async () => {
      // A fail-closed money job that cannot obtain a real lock has NOT been
      // skipped by a healthy sibling — it has failed. The real class is used
      // here so that making it extend CronLockHeldError breaks this test.
      const { runJobWithSentry, CronLockHeldError, CronLockUnavailableError } =
        loadModule();
      expect(new CronLockUnavailableError("unlockable-job")).not.toBeInstanceOf(
        CronLockHeldError,
      );

      await runJobWithSentry("unlockable-job", async () => {
        throw new CronLockUnavailableError("unlockable-job");
      });

      expect(captureException).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
    });
  });

  describe("GitHub Actions step outcome", () => {
    it("writes success=false and an ::error:: annotation when a job fails", async () => {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_OUTPUT = "/tmp/step-output";
      const { runJobWithSentry } = loadModule();

      await runJobWithSentry("annotated-job", async () => {
        throw new Error("boom");
      });

      expect(appendFileSync).toHaveBeenCalledWith(
        "/tmp/step-output",
        "success=false\n",
      );
      expect(consoleLog).toHaveBeenCalledWith(
        "::error::annotated-job failed: boom",
      );
    });

    it("writes nothing outside GitHub Actions", async () => {
      const { runJobWithSentry } = loadModule();

      await runJobWithSentry("local-job", async () => {
        throw new Error("boom");
      });

      expect(appendFileSync).not.toHaveBeenCalled();
    });
  });

  describe("exit code", () => {
    it("preserves an exit code the body set for itself", async () => {
      // Jobs signal "ran, but found problems" this way now that they can no
      // longer call process.exit().
      const { runJobWithSentry } = loadModule();

      await runJobWithSentry("discrepancy-job", async () => {
        process.exitCode = 2;
      });

      expect(process.exitCode).toBe(2);
      expect(flush).toHaveBeenCalledTimes(1);
    });
  });

  describe("init", () => {
    it("initialises before the body runs, reusing the app's shared config", async () => {
      const { runJobWithSentry } = loadModule();
      const order: string[] = [];
      init.mockImplementation(() => order.push("init"));

      await runJobWithSentry("ordered-job", async () => {
        order.push("body");
      });

      expect(order).toEqual(["init", "body"]);
    });

    it("initialises once even across several runs in the same process", async () => {
      const { runJobWithSentry } = loadModule();

      await runJobWithSentry("a", async () => {});
      await runJobWithSentry("b", async () => {});

      expect(init).toHaveBeenCalledTimes(1);
      expect(flush).toHaveBeenCalledTimes(2);
    });

    it("runs the job anyway if Sentry setup throws", async () => {
      // initJobSentry() is called outside the try, so a throw here would become
      // an unhandled rejection: no capture, no annotation, no flush.
      const { runJobWithSentry } = loadModule();
      init.mockImplementation(() => {
        throw new Error("bad DSN");
      });
      const body = jest.fn(async () => {});

      await expect(
        runJobWithSentry("uninstrumentable-job", body),
      ).resolves.toBeUndefined();
      expect(body).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe("does not ship a developer's local run to production Sentry", () => {
    // #901 gated `next dev` off via NODE_ENV. A bare `npx tsx jobs/…` process
    // has no NODE_ENV at all, so that gate passes — and 16 jobs load
    // dotenv/config from a .env carrying a real production DSN.
    const asBareTsxProcess = () => {
      delete (process.env as Record<string, string | undefined>).NODE_ENV;
      process.env.NEXT_PUBLIC_SENTRY_DSN = "https://key@example.test/1";
    };

    it("stays disabled for a local run with no NODE_ENV and a development environment", () => {
      asBareTsxProcess();
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "development";

      loadModule().initJobSentry();

      expect(lastInitOptions().enabled).toBe(false);
    });

    it("stays disabled when the Sentry environment is not set at all", () => {
      asBareTsxProcess();
      delete process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;

      loadModule().initJobSentry();

      expect(lastInitOptions().enabled).toBe(false);
    });

    it("is enabled for a GitHub Actions run, which sets environment=production", () => {
      asBareTsxProcess();
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";

      loadModule().initJobSentry();

      expect(lastInitOptions().enabled).toBe(true);
    });

    it("stays disabled in a deployed environment with no DSN", () => {
      // The job gate only ever NARROWS what the shared config decided.
      asBareTsxProcess();
      delete process.env.NEXT_PUBLIC_SENTRY_DSN;
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";

      loadModule().initJobSentry();

      expect(lastInitOptions().enabled).toBe(false);
    });

    it("pins the trace sample rate instead of inheriting the NODE_ENV default", () => {
      // Without this, an unset NODE_ENV resolves to 100% sampling while the
      // events report environment: production.
      asBareTsxProcess();
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";

      loadModule().initJobSentry();

      expect(lastInitOptions().tracesSampleRate).toBe(0);
    });
  });

  describe("flush failure", () => {
    it("does not fail the job when the transport cannot be drained", async () => {
      const { runJobWithSentry } = loadModule();
      flush.mockImplementation(async () => {
        throw new Error("network down");
      });

      await expect(
        runJobWithSentry("undrainable-job", async () => {}),
      ).resolves.toBeUndefined();
      expect(process.exitCode).toBeUndefined();
    });

    it("still reports the body's failure when the flush itself fails", async () => {
      const { runJobWithSentry } = loadModule();
      flush.mockImplementation(async () => {
        throw new Error("network down");
      });

      await runJobWithSentry("undrainable-failing-job", async () => {
        throw new Error("boom");
      });

      expect(captureException).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
    });

    it("warns when the drain TIMES OUT, which resolves false rather than throwing", async () => {
      // The quiet one: flush() returning false means the events were dropped,
      // and nothing else in the run would ever say so.
      const { runJobWithSentry } = loadModule();
      flush.mockImplementation(async () => false);

      await runJobWithSentry("slow-drain-job", async () => {});

      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining("queued events were dropped"),
      );
    });
  });

  describe("flush budget", () => {
    it("uses the shared default when a job asks for nothing", async () => {
      const { runJobWithSentry, JOB_FLUSH_TIMEOUT_MS } = loadModule();

      await runJobWithSentry("ordinary-job", async () => {});

      expect(flush).toHaveBeenCalledWith(JOB_FLUSH_TIMEOUT_MS);
    });

    it("honours a per-job override for jobs that queue events in a loop", async () => {
      // reconcile-ledgers fires one fatal event per drifted wallet.
      const { runJobWithSentry } = loadModule();

      await runJobWithSentry("batch-job", async () => {}, {
        flushTimeoutMs: 30_000,
      });

      expect(flush).toHaveBeenCalledWith(30_000);
    });
  });

  describe("runJob (module-tail form)", () => {
    it("runs the body and flushes without the caller awaiting anything", async () => {
      const { runJob } = loadModule();
      const body = jest.fn(async () => {});

      runJob("tail-job", body);
      // Fire-and-forget: let the microtask queue drain.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(body).toHaveBeenCalledTimes(1);
      expect(flush).toHaveBeenCalledTimes(1);
    });

    it("swallows a throwing body rather than raising an unhandled rejection", async () => {
      const { runJob } = loadModule();

      runJob("tail-throwing-job", async () => {
        throw new Error("boom");
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(process.exitCode).toBe(1);
      expect(flush).toHaveBeenCalled();
    });
  });
});
