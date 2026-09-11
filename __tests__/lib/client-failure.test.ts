/**
 * @jest-environment node
 */

/**
 * #1067 — a consultant testing the preview deploy was shown, verbatim:
 * "Loading chunk 99515 failed." That is a stale-deploy artefact: we shipped,
 * Netlify swapped the bundle, and their open tab's next `import()` asked for a
 * hash that no longer exists. A refresh fixes it outright, but every join
 * catch block ended with `error.message`, so the user got a bundler internal
 * and no way forward. The same catch had earlier shown them Next's "An error
 * occurred in the Server Components render…" for a server-action failure.
 *
 * The split this pins: the toast is written for the person reading it, the
 * original error and its digest go to Sentry, and a deploy artefact does not
 * page anyone.
 */

import {
  describeClientFailure,
  isChunkLoadError,
  isUserFacingError,
  reportClientFailure,
  userFacingError,
} from "@/lib/errors/classification/client-failure";
// Same specifier as the jest.mock below, so the two cannot drift apart.
import { reportSentryError } from "../../lib/observability/report";

jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

const mockedReport = reportSentryError as jest.Mock;

/** The webpack error, reproduced by name rather than by message. */
function chunkLoadError(): Error {
  const error = new Error("Loading chunk 99515 failed.");
  error.name = "ChunkLoadError";
  return error;
}

const GENERIC_COPY =
  "Something went wrong on our side. Please try again in a moment — we have been notified.";
const REFRESH_COPY =
  "This tab is running an older version. Refresh to continue.";

describe("recognising a stale deploy", () => {
  it("matches the ChunkLoadError name", () => {
    expect(isChunkLoadError(chunkLoadError())).toBe(true);
  });

  it("matches the message even when the name was lost", () => {
    // The exact text the user was shown, minus its name — which is what
    // survives a re-throw that flattens the error into a string.
    expect(
      isChunkLoadError(
        new Error("Loading chunk 99515 failed. (error: /_next/…)"),
      ),
    ).toBe(true);
  });

  it("matches the other engines' wording, not just webpack's", () => {
    // Detection is by shape because every bundler and browser words this
    // differently; pinning one string would silently stop working.
    for (const message of [
      "Failed to fetch dynamically imported module: https://x/_next/a.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
      "Loading CSS chunk 42 failed.",
      "Unable to preload CSS for /assets/x.css",
    ]) {
      expect(isChunkLoadError(new Error(message))).toBe(true);
    }
  });

  it("sees through a wrapper that set `cause`", () => {
    expect(
      isChunkLoadError(
        new Error("Failed to get/create meeting session: boom", {
          cause: chunkLoadError(),
        }),
      ),
    ).toBe(true);
  });

  it("does not fire on an ordinary failure", () => {
    expect(isChunkLoadError(new Error("Network request failed"))).toBe(false);
    expect(isChunkLoadError("chunky")).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });

  it("terminates on a self-referential cause", () => {
    const looping = new Error("nope") as Error & { cause?: unknown };
    looping.cause = looping;
    expect(isChunkLoadError(looping)).toBe(false);
  });
});

describe("what the user is shown", () => {
  it("offers a refresh for a stale deploy, and never the chunk text", () => {
    const failure = describeClientFailure(chunkLoadError(), {
      title: "Error joining meeting",
    });

    expect(failure.kind).toBe("stale-deploy");
    expect(failure.title).toBe("The app was updated");
    expect(failure.description).toBe(REFRESH_COPY);
    expect(failure.offerReload).toBe(true);
    expect(failure.description).not.toMatch(/chunk/i);
  });

  it("hides a raw failure behind one human sentence", () => {
    // Next's production server-action message, which says nothing to a user
    // and implies something they cannot fix.
    const failure = describeClientFailure(
      new Error(
        "An error occurred in the Server Components render. The specific message is omitted in production builds.",
      ),
      { title: "Error joining meeting" },
    );

    expect(failure.kind).toBe("unknown");
    expect(failure.title).toBe("Error joining meeting");
    expect(failure.description).toBe(GENERIC_COPY);
    expect(failure.offerReload).toBe(false);
  });

  it("still shows a message we wrote ourselves", () => {
    // Hiding everything would have swallowed the maintenance refusal, which is
    // the one message on this path worth reading.
    const refusal = userFacingError(
      "New calls cannot be created during maintenance.",
    );

    expect(isUserFacingError(refusal)).toBe(true);
    expect(
      describeClientFailure(refusal, { title: "Error joining meeting" })
        .description,
    ).toBe("New calls cannot be created during maintenance.");
  });

  it("does not treat an ordinary Error as one of ours", () => {
    expect(isUserFacingError(new Error("boom"))).toBe(false);
  });
});

describe("what Sentry is told", () => {
  beforeEach(() => mockedReport.mockClear());

  it("files a stale deploy as expected information, not a fault", () => {
    const failure = reportClientFailure(chunkLoadError(), {
      subsystem: "client",
      op: "join-meeting",
      title: "Error joining meeting",
      extra: { slotId: "slot-1" },
    });

    expect(failure.kind).toBe("stale-deploy");
    const [reported, opts] = mockedReport.mock.calls[0];
    expect(reported).toBeInstanceOf(Error);
    expect(opts.expected).toBe(true);
    expect(opts.tags).toEqual({ failureKind: "stale-deploy" });
    // The message the user never sees still has to reach us.
    expect(opts.extra.errorMessage).toBe("Loading chunk 99515 failed.");
    expect(opts.extra.slotId).toBe("slot-1");
  });

  it("files an ordinary failure as an error, carrying the original message", () => {
    reportClientFailure(new Error("Prisma P1001: cannot reach database"), {
      subsystem: "client",
      op: "join-meeting",
      title: "Error joining meeting",
      extra: { appointmentId: "appt-1" },
    });

    const [, opts] = mockedReport.mock.calls[0];
    expect(opts.expected).toBe(false);
    expect(opts.tags).toEqual({ failureKind: "unknown" });
    expect(opts.extra.errorMessage).toBe("Prisma P1001: cannot reach database");
    expect(opts.extra.appointmentId).toBe("appt-1");
  });

  it("keeps the digest, which is all a server-action failure gives us", () => {
    const opaque = Object.assign(
      new Error("An error occurred in the Server Components render."),
      { digest: "3849201755" },
    );

    reportClientFailure(opaque, {
      subsystem: "client",
      title: "Error joining meeting",
    });

    expect(mockedReport.mock.calls[0][1].extra.digest).toBe("3849201755");
  });

  it("normalises a non-Error throw instead of dropping it", () => {
    reportClientFailure("just a string", {
      subsystem: "client",
      title: "Error joining meeting",
    });

    const [, opts] = mockedReport.mock.calls[0];
    expect(opts.extra.errorMessage).toBe("just a string");
    expect(opts.expected).toBe(false);
  });
});
