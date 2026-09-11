/**
 * Centralized Stream Client Manager
 * Provides singleton instances for StreamChat and handles connection management
 */

import * as Sentry from "@sentry/nextjs";
import { StreamChat } from "stream-chat";
import { StreamClient } from "@stream-io/node-sdk";
import { createCircuitBreaker } from "@/lib/redis";

// Environment validation
const STREAM_API_KEY = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const STREAM_API_SECRET = process.env.STREAM_API_SECRET;

// Singleton instances
let chatClientInstance: StreamChat | null = null;
let videoClientInstance: StreamClient | null = null;

// Connection state tracking
let isInitialized = false;

/**
 * Validates that Stream API credentials are configured
 * @throws Error if credentials are missing
 */
export function validateStreamConfig(): void {
  if (!STREAM_API_KEY) {
    throw new Error(
      "NEXT_PUBLIC_STREAM_API_KEY is not configured. Please set it in your environment variables.",
    );
  }
  if (!STREAM_API_SECRET) {
    throw new Error(
      "STREAM_API_SECRET is not configured. Please set it in your environment variables.",
    );
  }
}

/**
 * Check if Stream is properly configured
 */
export function isStreamConfigured(): boolean {
  return !!(STREAM_API_KEY && STREAM_API_SECRET);
}

/**
 * Get the singleton StreamChat server client instance
 * This client is for server-side operations only (has secret)
 */
export function getStreamChatClient(): StreamChat {
  validateStreamConfig();

  if (!chatClientInstance) {
    chatClientInstance = StreamChat.getInstance(
      STREAM_API_KEY!,
      STREAM_API_SECRET!,
      {
        timeout: 30000, // 30 seconds timeout for operations
      },
    );
    isInitialized = true;
  }

  return chatClientInstance;
}

/**
 * Get the singleton Stream Video server client instance
 * This client is for server-side video operations only (has secret)
 */
export function getStreamVideoClient(): StreamClient {
  validateStreamConfig();

  if (!videoClientInstance) {
    videoClientInstance = new StreamClient(STREAM_API_KEY!, STREAM_API_SECRET!);
  }

  return videoClientInstance;
}

/**
 * Get the Stream API key (safe for client-side)
 */
export function getStreamApiKey(): string {
  if (!STREAM_API_KEY) {
    throw new Error("NEXT_PUBLIC_STREAM_API_KEY is not configured");
  }
  return STREAM_API_KEY;
}

/**
 * Generate a chat token for a user
 * @param userId The user ID to generate token for
 * @param expirationTime Optional expiration time in seconds (default: 1 hour)
 */
export function generateChatToken(
  userId: string,
  expirationTime?: number,
): string {
  const client = getStreamChatClient();

  // #1134 P0-4 — the third argument is `iat`, and omitting it made a ban
  // permanent. Stream treats a token with no `iat` as INVALID once
  // `revoke_tokens_issued_before` is set for that user, and that flag persists
  // until explicitly cleared. So a 7-day suspension revoked every future token
  // too, forever. Match generateVideoToken's 60s skew allowance.
  const issued = Math.floor(Date.now() / 1000) - 60;

  if (expirationTime) {
    const exp = Math.floor(Date.now() / 1000) + expirationTime;
    return client.createToken(userId, exp, issued);
  }

  return client.createToken(userId, undefined, issued);
}

// #1134 P0-1 — a `generateCallToken` wrapper (a token carrying a `call_cids`
// claim) was written for the join gate and then removed unused: the video client
// is an app-wide singleton holding one user token, and the JS SDK has no
// per-call token on a shared client, so using one would mean a second client per
// meeting. /api/meetings/[id]/join grants membership server-side instead. Add
// call tokens back when guest/magic-link join lands, which genuinely needs them.

/**
 * Generate a video token for a user
 * @param userId The user ID to generate token for
 * @param expirationSeconds Token expiration in seconds (default: 3600 = 1 hour)
 */
export function generateVideoToken(
  userId: string,
  expirationSeconds: number = 3600,
): string {
  const client = getStreamVideoClient();

  const exp = Math.round(Date.now() / 1000) + expirationSeconds;
  const issued = Math.round(Date.now() / 1000) - 60; // 1 minute ago for clock skew

  return client.generateUserToken({
    user_id: userId,
    exp,
    iat: issued,
  });
}

/**
 * Check if the Stream client is initialized
 */
export function isClientInitialized(): boolean {
  return isInitialized;
}

/**
 * Reset client instances (useful for testing)
 */
export function resetClients(): void {
  chatClientInstance = null;
  videoClientInstance = null;
  isInitialized = false;
}

/**
 * Sentinel thrown by withStreamCircuitBreaker when the breaker is OPEN and the
 * caller did not supply a fallback. Lets hot paths distinguish "Stream is down,
 * we fast-failed" from a genuine Stream API error and degrade accordingly.
 */
export class StreamUnavailableError extends Error {
  constructor() {
    super("Stream circuit breaker is OPEN — Stream temporarily unavailable");
    this.name = "StreamUnavailableError";
  }
}

/**
 * #899 — a Stream "channel not found" (error code 16 / HTTP 404) is the EXPECTED
 * miss on the lazy create-or-join path: callers probe with addMembers/query
 * before getOrCreate, so a not-yet-created webinar/class channel always 404s the
 * first time. It proves Stream is up and responding, so it must NOT trip the
 * circuit breaker or be reported to Sentry as an error — only genuine outages
 * (network/timeout/5xx) should. (stream-chat ErrorFromResponse exposes .code/.status.)
 */
export function isExpectedStreamError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as { code?: number | null; status?: number };
  return e.code === 16 || e.status === 404;
}

/**
 * A Stream rate-limit rejection (HTTP 429) means the app exhausted a per-minute
 * quota — quota, not availability. The 2026-08-23 incident showed why the two
 * must not be conflated: the daily expire cron burned through its
 * UpdateChannelPartial budget, and the resulting 429s tripped this breaker,
 * which then fast-failed the UNRELATED deleteChannels stage too. Rate limits
 * therefore neither trip the breaker nor page Sentry as errors; callers that
 * pace themselves (see jobs/stream/expire-event-channels.ts FREEZE_PACING_MS)
 * should stay under the cap in the first place.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as { status?: number };
  return e.status === 429;
}

/**
 * A Stream refusal to serve because the APP IS SUSPENDED is not an outage, and
 * treating it as one is how the most likely real incident at a pre-revenue
 * company presents as an unreadable flap.
 *
 * #1280 2.2 — only 404 and 429 were classified, so a suspended account fell
 * into the generic branch: Sentry error, breaker trips, 30-second reset,
 * half-open probe, trips again, forever. Nothing in that loop says "we owe
 * Stream money", which is the only fact a human can act on.
 *
 * ## Exactly one code, checked against Stream's published table
 *
 * Read from <https://getstream.io/chat/docs/node/api_errors_response/>:
 *
 *   | code | HTTP | meaning              |
 *   |------|------|----------------------|
 *   |   99 |  403 | App suspended        |
 *   |    2 |  401 | Access Key invalid   |
 *   |   17 |  403 | Insufficient perms   |
 *   |   70 |  403 | No channel access    |
 *
 * An earlier revision of this matched `402 || 403 || code 99 || code 2`, and
 * three quarters of that was wrong in a way that mattered:
 *
 *   - **code 2 is authentication, not billing.** A rotated-away or mistyped
 *     API key would have been excluded from the breaker and reported as "we owe
 *     Stream money" — the single most misleading diagnosis available for a
 *     misconfiguration, because it sends someone to the billing page instead of
 *     the env vars.
 *   - **a bare 403 is not billing either.** Codes 17 and 70 share it, so an
 *     ordinary permission refusal would have been laundered into a billing
 *     alert.
 *   - **Stream documents no 402 at all.** Keeping it implied knowledge of a
 *     contract that does not exist.
 *
 * So: code 99, and nothing else. Narrow and cited beats broad and guessed —
 * anything this does not catch still reaches the generic branch, which pages.
 *
 * Treated like 429 for the breaker: it does NOT trip, because retrying cannot
 * fix it and opening the breaker only hides the cause. Unlike 429 it does not
 * self-resolve, so it escalates to its own alert.
 */
export function isStreamBillingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as { code?: number | null };
  return e.code === 99;
}

/**
 * #1280 2.1 — Stream's OWN breaker, not Redis's.
 *
 * These used to be the same object. Five Stream failures opened it and booking
 * locks went through it too, so a video-vendor outage stopped checkout; in the
 * other direction a Redis outage told users "Video is temporarily unavailable"
 * and pointed `/api/health` at the wrong vendor.
 */
const streamCircuitBreaker = createCircuitBreaker("stream");

/** Exposed so /api/health can report Stream's breaker rather than Redis's. */
export function getStreamCircuitStatus() {
  return streamCircuitBreaker.status();
}

/**
 * #473 — wrap a hot-path Stream network call in Stream's circuit breaker so a
 * Stream outage fast-fails (sub-ms) instead of every dashboard load eating the
 * full 30s client timeout and cascading.
 *
 * Closed-breaker behaviour is identical to calling `operation` directly, except
 * an expected "channel not found" miss (#899) is classified via `shouldTrip` so
 * it neither counts toward the breaker nor reaches Sentry — it rejects with the
 * original error for the caller's create/fallback branch. Other real Stream
 * errors reject with the original error and are captured. Only when the breaker
 * is already OPEN does withCircuitBreaker reject with its generic "circuit
 * breaker is OPEN" Error — we intercept that to run the caller's `fallback`
 * (graceful degradation) or throw the typed StreamUnavailableError.
 */
export async function withStreamCircuitBreaker<T>(
  operation: () => Promise<T>,
  fallback?: () => T,
): Promise<T> {
  try {
    // #899 — expected "channel not found" misses must not trip the breaker;
    // neither do 429s (quota ≠ outage, see isRateLimitError).
    return await streamCircuitBreaker.run(
      operation,
      undefined,
      (e) =>
        !(
          isExpectedStreamError(e) ||
          isRateLimitError(e) ||
          isStreamBillingError(e)
        ),
    );
  } catch (error) {
    // Distinguish "breaker is OPEN, we never tried" from a real Stream error.
    if (
      error instanceof Error &&
      error.message.includes("circuit breaker is OPEN")
    ) {
      if (fallback) return fallback();
      const unavailable = new StreamUnavailableError();
      Sentry.captureException(unavailable, {
        tags: { subsystem: "stream" },
        level: "warning",
      });
      throw unavailable;
    }
    // A billing refusal is the one class here that needs a HUMAN, not a retry.
    // It is reported before the generic branch and with its own tag, so it does
    // not read as one more Stream error in a flap.
    if (isStreamBillingError(error)) {
      Sentry.captureException(error, {
        tags: { subsystem: "stream", reason: "stream.billing" },
        level: "error",
      });
      throw error;
    }
    // #899 — an expected miss (channel not found) is normal on the lazy
    // create-or-join path: rethrow for the caller's create/fallback branch
    // without Sentry noise. A 429 is self-inflicted quota exhaustion, already
    // alerted on by Stream itself — also not an error page. Only genuine
    // Stream errors are captured.
    if (!(isExpectedStreamError(error) || isRateLimitError(error))) {
      Sentry.captureException(error, { tags: { subsystem: "stream" } });
    }
    throw error;
  }
}

// Type exports for external use
export type { StreamChat };
