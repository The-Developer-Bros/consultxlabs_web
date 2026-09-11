/**
 * Unpaid Trial Expiry - Core Logic
 *
 * Cancels paid trials the consultant accepted but the learner never paid for,
 * once `paymentDueAt` has passed. Without this an AWAITING_PAYMENT trial holds
 * a consultant's slot indefinitely: it counts as occupied in
 * `buildOccupiedAppointmentFilter`, so the consultant can neither deliver it
 * nor rebook the time.
 *
 * Releasing the slot needs no slot surgery — occupancy is derived from the
 * trial's status, so moving it to CANCELLED drops it out of that filter.
 *
 * The learner is not penalised: a cancelled trial frees the
 * learner-consultant pair, so they can request again. See
 * lib/trials/eligibility.ts.
 *
 * This module exports the core function. It is imported by:
 * - jobs/trials/expire-unpaid-trials.ts (GitHub Actions)
 * - app/api/cleanup/expire-unpaid-trials/route.ts (API endpoint)
 *
 * Schedule: Hourly
 */

import { TrialSessionStatus } from "@prisma/client";

import { withCronLock } from "@/lib/cron/with-cron-lock";
import prisma from "../../lib/prisma";

export interface ExpireUnpaidTrialsResult {
  success: boolean;
  trialsExpired: number;
  errors: string[];
  timestamp: string;
}

/**
 * Expire unpaid trial sessions.
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: the updateMany is idempotent, lock is
// belt-and-braces.
export async function expireUnpaidTrials(): Promise<ExpireUnpaidTrialsResult> {
  return withCronLock("expire-unpaid-trials", { failMode: "open" }, () =>
    expireUnpaidTrialsUnlocked(),
  );
}

async function expireUnpaidTrialsUnlocked(): Promise<ExpireUnpaidTrialsResult> {
  const errors: string[] = [];
  let trialsExpired = 0;
  const now = new Date();

  console.log("🧹 Starting unpaid trial expiry...");

  try {
    const result = await prisma.trialSession.updateMany({
      where: {
        status: TrialSessionStatus.AWAITING_PAYMENT,
        // A null paymentDueAt means the pay-link was never minted — the gateway
        // call failed after acceptance. Sweep those too: holding a slot for a
        // trial nobody can pay for is the worst case of all.
        OR: [{ paymentDueAt: { lt: now } }, { paymentDueAt: null }],
      },
      data: {
        status: TrialSessionStatus.CANCELLED,
        // The link is dead once cancelled; leaving it would let a stale
        // dashboard row send someone to a checkout for a released slot.
        pendingPaymentUrl: null,
        paymentDueAt: null,
      },
    });

    trialsExpired = result.count;
    console.log(`   Trials expired: ${trialsExpired}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    console.error("❌ Failed to expire unpaid trials:", message);
  }

  return {
    success: errors.length === 0,
    trialsExpired,
    errors,
    timestamp: now.toISOString(),
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
