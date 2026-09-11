/**
 * Reschedule Proposal Expiry - Core Logic
 *
 * Auto-declines proposals nobody answered, so a booking is never left in a
 * state neither party trusts.
 *
 * A lapsed proposal falls back to the consultant's ordinary allocate queue
 * rather than reverting the request: the slots stay released, so the consultant
 * still sees work to do — they simply lose the consultee's suggested times.
 * That keeps the flow from ever dead-ending.
 *
 * Expiry itself is set at creation as min(now + 72h, earliest released session
 * − 24h); see lib/booking/reschedule-proposals.ts for why a single fixed timer
 * gets one of those two cases wrong.
 *
 * This module exports the core function.
 * It is imported by:
 * - jobs/appointments/expire-reschedule-proposals.ts (GitHub Actions)
 * - app/api/cleanup/reschedule-proposals/route.ts (API endpoint)
 *
 * Schedule: hourly
 */

import * as Sentry from "@sentry/nextjs";
import prisma from "../../lib/prisma";
import { RESCHEDULE_OPEN_STATUSES } from "../../lib/booking/transitions";
import { withCronLock } from "@/lib/cron/with-cron-lock";

export interface RescheduleProposalExpiryResult {
  success: boolean;
  proposalsExpired: number;
  errors: string[];
  timestamp: string;
}

// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open because the work is idempotent.
export async function expireRescheduleProposals(): Promise<RescheduleProposalExpiryResult> {
  return withCronLock("expire-reschedule-proposals", { failMode: "open" }, () =>
    expireRescheduleProposalsUnlocked(),
  );
}

async function expireRescheduleProposalsUnlocked(): Promise<RescheduleProposalExpiryResult> {
  const errors: string[] = [];
  let proposalsExpired = 0;

  console.log("⏳ Expiring lapsed reschedule proposals...");

  try {
    const now = new Date();

    // The status+expiresAt index covers this predicate exactly.
    //
    // Idempotent by construction: the WHERE clause only matches open proposals,
    // and the update moves them out of that set, so a re-run after a partial
    // failure picks up precisely what is left. Clearing openForAppointmentId
    // releases the nullable-unique reservation so the pair can try again.
    const expired = await prisma.rescheduleRequest.updateMany({
      where: {
        status: { in: RESCHEDULE_OPEN_STATUSES },
        expiresAt: { lt: now },
      },
      data: {
        status: "EXPIRED",
        openForAppointmentId: null,
        resolvedAt: now,
      },
    });

    proposalsExpired = expired.count;

    if (proposalsExpired > 0) {
      console.log(`   Expired ${proposalsExpired} proposal(s)`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    console.error("❌ Reschedule proposal expiry failed:", message);
    // Neither caller (GH Actions wrapper, cleanup API route) sees a throw from
    // this function — the failure is folded into the result object instead —
    // so this is the only place left to report it.
    Sentry.captureException(
      error instanceof Error ? error : new Error(message),
      { tags: { subsystem: "jobs", job: "expire-reschedule-proposals" } },
    );
  }

  return {
    success: errors.length === 0,
    proposalsExpired,
    errors,
    timestamp: new Date().toISOString(),
  };
}
