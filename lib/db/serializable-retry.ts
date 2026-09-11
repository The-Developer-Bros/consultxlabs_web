import { Prisma } from "@prisma/client";

const SERIALIZABLE_MAX_RETRIES = 3;

/**
 * Retries a function that may fail due to Prisma serialization conflicts
 * (P2034) with jittered exponential backoff. Only the isolation-level abort is
 * transient — anything else (IllegalTransitionError, VERSION_CONFLICT 409s,
 * validation errors) propagates immediately so business rejections are never
 * retried into accidental success.
 */
export async function withSerializableRetry<T>(
  fn: () => Promise<T>,
  maxRetries = SERIALIZABLE_MAX_RETRIES,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isSerializationFailure =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034";

      if (!isSerializationFailure || attempt === maxRetries) {
        throw error;
      }

      // 50/100/200ms + jitter so two retrying writers don't re-collide in step.
      const backoffMs = 50 * 2 ** attempt + Math.random() * 25;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error("withSerializableRetry: exhausted retries");
}
