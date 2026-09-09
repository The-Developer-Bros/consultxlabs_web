/**
 * Orphaned-confirmation reconcile API endpoint.
 *
 * Thin wrapper around scripts/payments/reconcile-orphaned-confirmations.ts,
 * matching the GitHub Actions job in jobs/payments. Two passes run per
 * invocation: the #830 re-drive of a confirmation that never landed, and the
 * #1356 re-drive of the chat channel a capture failed to create.
 *
 * `?limit=` exists because a Netlify ticker calls this route on a short
 * schedule and cannot spend a function's whole budget on one sweep. It bounds
 * both passes, so a small value means "take a small bite of each backlog"
 * rather than starving one of them. It can only lower the channel pass: that
 * pass keeps its own ceiling in appointments and in buyer-level Stream calls,
 * because one appointment can carry hundreds of buyers. #1391
 */

import {
  cleanupRoute,
  parseLimitParam,
  statusFor,
} from "@/lib/cron/cleanup-route";
import { reconcileOrphanedConfirmations } from "@/scripts/payments/reconcile-orphaned-confirmations";

export const { GET, POST } = cleanupRoute({
  job: "reconcile-orphaned-confirmations",
  run: (req) => {
    // #1459 — this route kept a private parser that swallowed a malformed
    // `?limit=` and swept the default batch instead. Every other ticker target
    // uses the shared one, which answers 400 INVALID_LIMIT on junk and clamps
    // at the cap, so a broken caller is visible rather than silently unbounded.
    const limit = parseLimitParam(req);
    return reconcileOrphanedConfirmations(limit === undefined ? {} : { limit });
  },
  summarize: (r) => ({
    scanned: r.scanned,
    confirmed: r.confirmed,
    stillBlocked: r.stillBlocked,
    channelsEnsured: r.channelsEnsured,
    channelsFailed: r.channelsFailed,
    channelBuyerOps: r.channelBuyerOps,
    channelsDeferred: r.channelsDeferred,
  }),
  // A channel this run could not create is a buyer with no conversation, which
  // an operator has to see; the next run retries it, so it is not a failure.
  status: (r) => statusFor(r, r.channelsFailed > 0),
  failureMessage: "Failed to reconcile orphaned confirmations",
});
