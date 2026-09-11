/**
 * Auth Token Cleanup API Endpoint
 *
 * Thin wrapper around scripts/cleanup-auth-tokens.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Daily at midnight (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { cleanupAuthTokens } from "@/scripts/cleanup/cleanup-auth-tokens";

export const { GET, POST } = cleanupRoute({
  job: "cleanup-auth-tokens",
  run: () => cleanupAuthTokens(),
  summarize: (r) => ({
    verificationTokensDeleted: r.verificationTokensDeleted,
    sessionsDeleted: r.sessionsDeleted,
    passwordResetTokensCleared: r.passwordResetTokensCleared,
    totalCleaned: r.totalCleaned,
  }),
  failureMessage: "Failed to cleanup auth tokens",
});
