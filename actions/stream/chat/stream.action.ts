"use server";

import { z } from "zod";
import {
  generateVideoToken,
  generateChatToken,
  isStreamConfigured,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import * as Sentry from "@sentry/nextjs";

// Token expiry for both chat and video (1 hour)
const TOKEN_EXPIRATION_SECONDS = 3600;

// Input validation
const userIdSchema = z.string().min(1, "User ID is required");

/**
 * Tokens may only be minted for the caller's own userId (staff/admin may mint
 * for anyone), and never for a banned user — Stream's server-side API skips all
 * permission checks, so this session bind is the only gate against identity
 * spoofing and re-minting a revoked/suspended identity (#693/#899).
 */
async function assertCanMintToken(forUserId: string): Promise<void> {
  // Bypass the cookie-session cache so a just-demoted staff/admin (or a
  // just-banned user) can't keep minting cross-user tokens until the cache
  // expires (#899).
  const session = await getSession(true);
  if (!session?.user?.id) {
    throw new Error("Unauthorized: sign in to request a Stream token");
  }
  // Never mint for a banned/suspended user (#693).
  if (session.user.banned) {
    throw new Error("Forbidden: account suspended");
  }
  if (session.user.id !== forUserId && !isPrivileged(session.user.role)) {
    throw new Error("Forbidden: cannot mint a token for another user");
  }
}

/**
 * Generate a video call token for a user
 * Token is valid for 1 hour by default
 * @param userId The user ID to generate token for
 * @returns The video token string
 */
export async function tokenProvider(userId: string): Promise<string> {
  // Validate input
  const validatedUserId = userIdSchema.parse(userId);
  await assertCanMintToken(validatedUserId);

  if (!isStreamConfigured()) {
    streamLogger.error("Stream not configured for video token generation");
    throw new Error("Stream API is not configured");
  }

  try {
    const token = generateVideoToken(validatedUserId, TOKEN_EXPIRATION_SECONDS);

    streamLogger.debug("Generated video token", { userId: validatedUserId });

    return token;
  } catch (error) {
    streamLogger.error("Failed to generate video token", error, {
      userId: validatedUserId,
    });
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    throw error;
  }
}

/**
 * Generate a chat token for a user
 * Token is valid for 1 hour by default
 * @param userId The user ID to generate token for
 * @returns The chat token string
 */
export async function chatTokenProvider(userId: string): Promise<string> {
  // Validate input
  const validatedUserId = userIdSchema.parse(userId);
  await assertCanMintToken(validatedUserId);

  if (!isStreamConfigured()) {
    streamLogger.error("Stream not configured for chat token generation");
    throw new Error("Stream API is not configured");
  }

  try {
    const token = generateChatToken(validatedUserId, TOKEN_EXPIRATION_SECONDS);

    streamLogger.debug("Generated chat token", { userId: validatedUserId });

    return token;
  } catch (error) {
    streamLogger.error("Failed to generate chat token", error, {
      userId: validatedUserId,
    });
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    throw error;
  }
}
