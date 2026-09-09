/**
 * Tests for Stream Client initialization and token generation
 * Tests the stream-client.ts module for v9 SDK compatibility
 */

// Mock the Stream SDKs before importing
const mockStreamChatGetInstance = jest.fn();
const mockStreamClientConstructor = jest.fn();

jest.mock("stream-chat", () => ({
  StreamChat: {
    getInstance: mockStreamChatGetInstance,
  },
}));

jest.mock("@stream-io/node-sdk", () => ({
  StreamClient: mockStreamClientConstructor,
}));

// #473 — stream-client goes through a circuit breaker from lib/redis. Mock the
// module (the real one pulls in the un-transformed @upstash/redis ESM). A
// mutable delegate lets the breaker-behaviour tests below override per-case;
// default is a pass-through so closed-breaker behaviour is exercised.
//
// #1280 2.1 — it is now `createCircuitBreaker("stream")` rather than the shared
// `withCircuitBreaker`, because Stream and Redis used to trip each other: five
// Stream failures opened the breaker that booking-lock acquisition also went
// through, so a video-vendor outage stopped checkout. The factory shape is what
// keeps the two sets of failures apart, so the mock reproduces it.
/**
 * Records what the breaker was told about each error.
 *
 * The default delegate ignored the third argument, so `shouldTrip` — the
 * predicate that decides whether a failure counts toward opening the breaker —
 * was invisible to every test. That is the main claim of the #1280 2.2 change:
 * a suspended-app error must NOT trip Stream's breaker. Recording the verdict
 * here is what makes it assertable.
 */
let lastShouldTripVerdict: boolean | null = null;
const recordingBreaker = () =>
  jest.fn(
    async (
      op: () => unknown,
      _fallback?: () => unknown,
      shouldTrip?: (e: unknown) => boolean,
    ) => {
      try {
        return await op();
      } catch (err) {
        // Mirror the real breaker: consult the predicate, and rethrow either way.
        lastShouldTripVerdict = shouldTrip ? shouldTrip(err) : true;
        throw err;
      }
    },
  );
let mockWithCircuitBreaker: jest.Mock = recordingBreaker();
const mockCreateCircuitBreaker = jest.fn((name: string) => ({
  run: (...args: unknown[]) => mockWithCircuitBreaker(...args),
  reset: jest.fn(),
  status: () => ({
    name,
    state: "CLOSED",
    failures: 0,
    lastFailure: null,
  }),
}));
jest.mock("../../lib/redis", () => ({
  createCircuitBreaker: (name: string) => mockCreateCircuitBreaker(name),
  withCircuitBreaker: (...args: unknown[]) => mockWithCircuitBreaker(...args),
}));

// #899 — spy on Sentry so we can assert expected "channel not found" misses are
// NOT reported while genuine Stream errors are.
const mockCaptureException = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

describe("Stream Client Module", () => {
  const originalEnv = process.env;
  const mockApiKey = "test-api-key";
  const mockApiSecret = "test-api-secret";
  const mockUserId = "test-user-123";

  beforeEach(() => {
    lastShouldTripVerdict = null;
    jest.resetModules();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_STREAM_API_KEY: mockApiKey,
      STREAM_API_SECRET: mockApiSecret,
    };
    // Restore the recording breaker between tests. It has to be the RECORDING
    // one, not a bare pass-through: one case below swaps the delegate to
    // capture `shouldTrip` and that assignment persists, so restoring a
    // pass-through here left every later case unable to see the predicate.
    mockWithCircuitBreaker = recordingBreaker();
    mockCaptureException.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  describe("validateStreamConfig", () => {
    it("should not throw when credentials are configured", async () => {
      const { validateStreamConfig } = await import("@/lib/stream-client");
      expect(() => validateStreamConfig()).not.toThrow();
    });

    it("should throw when API key is missing", async () => {
      delete process.env.NEXT_PUBLIC_STREAM_API_KEY;
      jest.resetModules();
      const { validateStreamConfig } = await import("@/lib/stream-client");
      expect(() => validateStreamConfig()).toThrow(
        "NEXT_PUBLIC_STREAM_API_KEY is not configured",
      );
    });

    it("should throw when API secret is missing", async () => {
      delete process.env.STREAM_API_SECRET;
      jest.resetModules();
      const { validateStreamConfig } = await import("@/lib/stream-client");
      expect(() => validateStreamConfig()).toThrow(
        "STREAM_API_SECRET is not configured",
      );
    });
  });

  describe("isStreamConfigured", () => {
    it("should return true when both credentials are set", async () => {
      const { isStreamConfigured } = await import("@/lib/stream-client");
      expect(isStreamConfigured()).toBe(true);
    });

    it("should return false when API key is missing", async () => {
      delete process.env.NEXT_PUBLIC_STREAM_API_KEY;
      jest.resetModules();
      const { isStreamConfigured } = await import("@/lib/stream-client");
      expect(isStreamConfigured()).toBe(false);
    });

    it("should return false when API secret is missing", async () => {
      delete process.env.STREAM_API_SECRET;
      jest.resetModules();
      const { isStreamConfigured } = await import("@/lib/stream-client");
      expect(isStreamConfigured()).toBe(false);
    });
  });

  describe("getStreamChatClient", () => {
    it("should create a singleton StreamChat instance", async () => {
      const mockInstance = {
        createToken: jest.fn().mockReturnValue("mock-token"),
      };
      mockStreamChatGetInstance.mockReturnValue(mockInstance);

      const { getStreamChatClient, resetClients } =
        await import("@/lib/stream-client");

      resetClients();
      const client1 = getStreamChatClient();
      const client2 = getStreamChatClient();

      // Should return same instance
      expect(client1).toBe(client2);

      // getInstance should only be called once for singleton
      expect(mockStreamChatGetInstance).toHaveBeenCalledTimes(1);
      expect(mockStreamChatGetInstance).toHaveBeenCalledWith(
        mockApiKey,
        mockApiSecret,
        { timeout: 30000 },
      );
    });
  });

  describe("getStreamVideoClient", () => {
    it("should create a singleton StreamClient instance", async () => {
      const mockVideoClient = {
        generateUserToken: jest.fn().mockReturnValue("mock-video-token"),
      };
      mockStreamClientConstructor.mockImplementation(() => mockVideoClient);

      const { getStreamVideoClient, resetClients } =
        await import("@/lib/stream-client");

      resetClients();
      const client1 = getStreamVideoClient();
      const client2 = getStreamVideoClient();

      // Should return same instance
      expect(client1).toBe(client2);

      // Constructor should only be called once for singleton
      expect(mockStreamClientConstructor).toHaveBeenCalledTimes(1);
      expect(mockStreamClientConstructor).toHaveBeenCalledWith(
        mockApiKey,
        mockApiSecret,
      );
    });
  });

  describe("generateChatToken", () => {
    it("should generate token without expiration", async () => {
      const mockToken = "chat-token-no-exp";
      const mockInstance = {
        createToken: jest.fn().mockReturnValue(mockToken),
      };
      mockStreamChatGetInstance.mockReturnValue(mockInstance);

      const { generateChatToken, resetClients } =
        await import("@/lib/stream-client");

      resetClients();
      const token = generateChatToken(mockUserId);

      expect(token).toBe(mockToken);
      // #1134 P0-4 — `iat` is mandatory even with no expiry. Stream treats a
      // token with no `iat` as INVALID once revoke_tokens_issued_before is set
      // for that user, and that flag never clears itself — so an iat-less token
      // turned a 7-day suspension into a permanent chat ban.
      expect(mockInstance.createToken).toHaveBeenCalledWith(
        mockUserId,
        undefined,
        expect.any(Number),
      );
    });

    it("should generate token with custom expiration", async () => {
      const mockToken = "chat-token-with-exp";
      const expirationSeconds = 7200; // 2 hours
      const mockInstance = {
        createToken: jest.fn().mockReturnValue(mockToken),
      };
      mockStreamChatGetInstance.mockReturnValue(mockInstance);

      const { generateChatToken, resetClients } =
        await import("@/lib/stream-client");

      resetClients();
      const token = generateChatToken(mockUserId, expirationSeconds);

      expect(token).toBe(mockToken);
      expect(mockInstance.createToken).toHaveBeenCalledWith(
        mockUserId,
        expect.any(Number),
        expect.any(Number),
      );

      // The `iat` must sit slightly in the past to absorb clock skew, and the
      // `exp` must be ahead of it — a token whose iat is in the future is
      // rejected outright.
      const [, exp, iat] = mockInstance.createToken.mock.calls[0];
      const now = Math.floor(Date.now() / 1000);
      expect(iat).toBeLessThanOrEqual(now);
      expect(iat).toBeGreaterThan(now - 300);
      expect(exp).toBeGreaterThan(iat);
    });
  });

  describe("generateVideoToken", () => {
    it("should generate video token with default expiration", async () => {
      const mockToken = "video-token";
      const mockVideoClient = {
        generateUserToken: jest.fn().mockReturnValue(mockToken),
      };
      mockStreamClientConstructor.mockImplementation(() => mockVideoClient);

      const { generateVideoToken, resetClients } =
        await import("@/lib/stream-client");

      resetClients();
      const token = generateVideoToken(mockUserId);

      expect(token).toBe(mockToken);
      expect(mockVideoClient.generateUserToken).toHaveBeenCalledWith({
        user_id: mockUserId,
        exp: expect.any(Number),
        iat: expect.any(Number),
      });
    });

    it("should generate video token with custom expiration", async () => {
      const mockToken = "video-token-custom";
      const customExpiration = 7200;
      const mockVideoClient = {
        generateUserToken: jest.fn().mockReturnValue(mockToken),
      };
      mockStreamClientConstructor.mockImplementation(() => mockVideoClient);

      const { generateVideoToken, resetClients } =
        await import("@/lib/stream-client");

      resetClients();
      const token = generateVideoToken(mockUserId, customExpiration);

      expect(token).toBe(mockToken);
      expect(mockVideoClient.generateUserToken).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: mockUserId,
        }),
      );
    });
  });

  describe("getStreamApiKey", () => {
    it("should return the API key", async () => {
      const { getStreamApiKey } = await import("@/lib/stream-client");
      expect(getStreamApiKey()).toBe(mockApiKey);
    });

    it("should throw when API key is missing", async () => {
      delete process.env.NEXT_PUBLIC_STREAM_API_KEY;
      jest.resetModules();
      const { getStreamApiKey } = await import("@/lib/stream-client");
      expect(() => getStreamApiKey()).toThrow(
        "NEXT_PUBLIC_STREAM_API_KEY is not configured",
      );
    });
  });

  describe("resetClients", () => {
    it("should reset client instances", async () => {
      const mockChatInstance = { createToken: jest.fn() };
      const mockVideoInstance = { generateUserToken: jest.fn() };

      mockStreamChatGetInstance.mockReturnValue(mockChatInstance);
      mockStreamClientConstructor.mockImplementation(() => mockVideoInstance);

      const {
        getStreamChatClient,
        getStreamVideoClient,
        resetClients,
        isClientInitialized,
      } = await import("@/lib/stream-client");

      // Initialize clients
      resetClients();
      getStreamChatClient();
      getStreamVideoClient();

      expect(isClientInitialized()).toBe(true);

      // Reset and check
      resetClients();
      expect(isClientInitialized()).toBe(false);
    });
  });

  // #899 — a Stream "channel not found" (code 16 / HTTP 404) is the EXPECTED
  // lazy create-or-join miss; it must not trip the breaker nor reach Sentry.
  describe("isExpectedStreamError", () => {
    it.each([
      ["code 16 (channel not found)", { code: 16 }, true],
      ["HTTP 404", { status: 404 }, true],
      ["code 16 + 404", { code: 16, status: 404 }, true],
      ["other Stream error code", { code: 4, status: 400 }, false],
      ["generic error (no code/status)", {}, false],
    ])("classifies %s", async (_label, props, expected) => {
      const { isExpectedStreamError } = await import("@/lib/stream-client");
      expect(
        isExpectedStreamError(Object.assign(new Error("boom"), props)),
      ).toBe(expected);
    });

    it("returns false for non-Error values", async () => {
      const { isExpectedStreamError } = await import("@/lib/stream-client");
      expect(isExpectedStreamError("nope")).toBe(false);
      expect(isExpectedStreamError(null)).toBe(false);
    });
  });

  describe("withStreamCircuitBreaker", () => {
    const channelNotFound = () =>
      Object.assign(
        new Error(
          'StreamChat error code 16: UpdateChannel failed: "Can\'t find channel"',
        ),
        { code: 16, status: 404 },
      );

    it("rethrows an expected 'channel not found' miss WITHOUT capturing it to Sentry", async () => {
      const { withStreamCircuitBreaker } = await import("@/lib/stream-client");
      const err = channelNotFound();

      await expect(
        withStreamCircuitBreaker(() => Promise.reject(err)),
      ).rejects.toBe(err);

      // #899 — the core fix: expected misses are not error-reported.
      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it("passes a shouldTrip predicate that excludes expected misses but trips on real errors", async () => {
      let shouldTrip: ((e: unknown) => boolean) | undefined;
      mockWithCircuitBreaker = jest.fn(
        (op: () => unknown, _fb: unknown, st: (e: unknown) => boolean) => {
          shouldTrip = st;
          return op();
        },
      );

      const { withStreamCircuitBreaker } = await import("@/lib/stream-client");
      await withStreamCircuitBreaker(() => Promise.resolve("ok"));

      expect(shouldTrip).toBeDefined();
      // Expected misses must NOT trip the breaker...
      expect(shouldTrip!(channelNotFound())).toBe(false);
      expect(shouldTrip!(Object.assign(new Error("x"), { status: 404 }))).toBe(
        false,
      );
      // ...genuine outages must.
      expect(shouldTrip!(new Error("ECONNREFUSED"))).toBe(true);
    });

    describe("a suspended app is not an outage (#1280 2.2)", () => {
      /** Stream code 99 / HTTP 403 — "App suspended", per their error table. */
      const appSuspended = () =>
        Object.assign(new Error("App suspended"), { code: 99, status: 403 });

      it("does NOT let a suspended-app error trip the breaker", async () => {
        // The whole point of the classification. Retrying cannot fix a
        // suspension, and opening the breaker only hides the one fact a human
        // can act on. Asserted through the recorded predicate verdict, which
        // the mock ignored entirely before this change — so the main claim of
        // #1280 2.2 was untested.
        const { withStreamCircuitBreaker } =
          await import("@/lib/stream-client");

        await expect(
          withStreamCircuitBreaker(() => Promise.reject(appSuspended())),
        ).rejects.toThrow("App suspended");

        expect(lastShouldTripVerdict).toBe(false);
      });

      it("escalates it to Sentry under its own reason, not the generic branch", async () => {
        const { withStreamCircuitBreaker } =
          await import("@/lib/stream-client");

        await expect(
          withStreamCircuitBreaker(() => Promise.reject(appSuspended())),
        ).rejects.toThrow();

        // Unlike a 429 it does not self-resolve, so it must still page — just
        // as something billing-shaped rather than as one more Stream error in
        // a flap.
        expect(mockCaptureException).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({
            tags: expect.objectContaining({ reason: "stream.billing" }),
          }),
        );
      });

      it("does NOT classify an invalid access key as billing", async () => {
        // Stream code 2 is HTTP 401 "Access Key invalid" — a rotated-away or
        // mistyped key. An earlier revision matched it, which would have sent
        // whoever was on call to the billing page instead of the env vars, and
        // excluded a real misconfiguration from the breaker.
        const { isStreamBillingError } = await import("@/lib/stream-client");

        expect(
          isStreamBillingError(
            Object.assign(new Error("Access Key invalid"), {
              code: 2,
              status: 401,
            }),
          ),
        ).toBe(false);
      });

      it("does NOT classify a bare 403 as billing", async () => {
        // Codes 17 (insufficient permissions) and 70 (no channel access) share
        // 403, so matching the status alone laundered ordinary permission
        // refusals into billing alerts.
        const { isStreamBillingError } = await import("@/lib/stream-client");

        expect(
          isStreamBillingError(
            Object.assign(new Error("Not allowed"), { code: 17, status: 403 }),
          ),
        ).toBe(false);
        expect(
          isStreamBillingError(
            Object.assign(new Error("No channel access"), {
              code: 70,
              status: 403,
            }),
          ),
        ).toBe(false);
      });
    });

    it("captures a genuine Stream error to Sentry and rethrows it", async () => {
      const { withStreamCircuitBreaker } = await import("@/lib/stream-client");
      const err = Object.assign(new Error("Stream 500"), {
        code: 500,
        status: 500,
      });

      await expect(
        withStreamCircuitBreaker(() => Promise.reject(err)),
      ).rejects.toBe(err);
      expect(mockCaptureException).toHaveBeenCalledWith(
        err,
        expect.objectContaining({ tags: { subsystem: "stream" } }),
      );
    });

    it("throws StreamUnavailableError (and reports it) when the breaker is OPEN with no fallback", async () => {
      mockWithCircuitBreaker = jest.fn(() =>
        Promise.reject(
          // #1302 review — the exact string `createCircuitBreaker("stream")`
          // throws (lib/redis.ts). The old fixture said "Redis", which passed
          // only because the guard matches the substring "circuit breaker is
          // OPEN" — so it was asserting against a message this path cannot
          // produce.
          new Error("stream circuit breaker is OPEN - service unavailable"),
        ),
      );

      const { withStreamCircuitBreaker, StreamUnavailableError } =
        await import("@/lib/stream-client");

      await expect(
        withStreamCircuitBreaker(() => Promise.resolve("never")),
      ).rejects.toBeInstanceOf(StreamUnavailableError);
      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.any(StreamUnavailableError),
        expect.objectContaining({ level: "warning" }),
      );
    });

    it("runs the fallback (no throw, no Sentry) when the breaker is OPEN", async () => {
      mockWithCircuitBreaker = jest.fn(() =>
        Promise.reject(
          // #1302 review — the exact string `createCircuitBreaker("stream")`
          // throws (lib/redis.ts). The old fixture said "Redis", which passed
          // only because the guard matches the substring "circuit breaker is
          // OPEN" — so it was asserting against a message this path cannot
          // produce.
          new Error("stream circuit breaker is OPEN - service unavailable"),
        ),
      );

      const { withStreamCircuitBreaker } = await import("@/lib/stream-client");
      const result = await withStreamCircuitBreaker(
        () => Promise.resolve("never"),
        () => "degraded",
      );

      expect(result).toBe("degraded");
      expect(mockCaptureException).not.toHaveBeenCalled();
    });
  });
});
