import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { Prisma as PrismaNamespace } from "@prisma/client";
import type { ReferralCode, Referral, ReferralCredit } from "@prisma/client";
import { sumPaise } from "@/lib/payments/utils/money";
import {
  QUALIFICATION_WINDOW_DAYS,
  CREDIT_EXPIRY_DAYS,
  ANNUAL_REWARD_CAP_PAISE,
  CONSULTANT_WAIVER_SESSIONS,
} from "./constants";

// #780 — bare model types still say bigint; the extended client returns number
export type ReferralCodeRow = Omit<
  ReferralCode,
  "referrerReward" | "refereeReward" | "totalEarned"
> & {
  referrerReward: number | null;
  refereeReward: number | null;
  totalEarned: number;
};
export type ReferralRow = Omit<
  Referral,
  "referrerRewardAmount" | "refereeRewardAmount"
> & {
  referrerRewardAmount: number | null;
  refereeRewardAmount: number | null;
};
export type ReferralCreditRow = Omit<
  ReferralCredit,
  "amount" | "usedAmount" | "remainingAmount"
> & {
  amount: number;
  usedAmount: number;
  remainingAmount: number;
};

// Re-export so existing server-side consumers can still import from service
export { QUALIFICATION_WINDOW_DAYS, CREDIT_EXPIRY_DAYS };

// Constants
// #880 conservative launch: ₹300 each (the referrer reward ramps to ₹500 once
// unit economics are validated). Role-weighting and the consultant commission
// waiver arrive in later phases; these are the flat launch baselines.
const DEFAULT_REFERRER_REWARD = 30000; // ₹300 in paise
const DEFAULT_REFEREE_REWARD = 30000; // ₹300 in paise

/**
 * Creates or returns an existing referral code for a user.
 */
export async function createReferralCode(
  userId: string,
): Promise<ReferralCodeRow> {
  const existing = await prisma.referralCode.findUnique({
    where: { userId },
  });

  if (existing) return existing;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });

  const code = await generateUniqueCode(user?.name);

  try {
    return await prisma.referralCode.create({
      data: {
        userId,
        code,
        referrerReward: DEFAULT_REFERRER_REWARD,
        refereeReward: DEFAULT_REFEREE_REWARD,
      },
    });
  } catch (error) {
    // FIX #596: Handle race condition — concurrent first-use requests
    // can both pass the findUnique check, then one fails on unique constraint.
    if (
      error instanceof PrismaNamespace.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const rawTarget = error.meta?.target;
      const target = Array.isArray(rawTarget)
        ? rawTarget
        : typeof rawTarget === "string"
          ? [rawTarget]
          : [];
      const isUserIdConflict = target.includes("userId");

      // userId conflict: another request created the record first — return it
      if (isUserIdConflict) {
        const raced = await prisma.referralCode.findUnique({
          where: { userId },
        });
        if (raced) return raced;
      }

      // code conflict: generated code collided — retry with a new code
      const isCodeConflict = target.includes("code");
      if (isCodeConflict) {
        const retryCode = await generateUniqueCode(user?.name);
        return prisma.referralCode.create({
          data: {
            userId,
            code: retryCode,
            referrerReward: DEFAULT_REFERRER_REWARD,
            refereeReward: DEFAULT_REFEREE_REWARD,
          },
        });
      }
    }
    throw error;
  }
}

/**
 * Generates a unique referral code, trying name-based first, then random fallback.
 */
export async function generateUniqueCode(
  name?: string | null,
): Promise<string> {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  if (name) {
    const prefix = name
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 4);

    if (prefix.length >= 3) {
      for (let i = 0; i < 100; i++) {
        const suffix =
          chars[Math.floor(Math.random() * chars.length)] +
          chars[Math.floor(Math.random() * chars.length)];
        const code = `${prefix}${suffix}`;
        const exists = await prisma.referralCode.findUnique({
          where: { code },
        });
        if (!exists) return code;
      }
    }
  }

  // Fallback to random code
  let code: string;
  do {
    code = Array.from(
      { length: 8 },
      () => chars[Math.floor(Math.random() * chars.length)],
    ).join("");
  } while (await prisma.referralCode.findUnique({ where: { code } }));

  return code;
}

/**
 * Validates a referral code. Returns the code record if valid, null otherwise.
 */
export async function validateReferralCode(
  code: string,
  db: Tx | typeof prisma = prisma,
): Promise<ReferralCodeRow | null> {
  return db.referralCode.findFirst({
    where: {
      OR: [{ code: code.toUpperCase() }, { customCode: code.toUpperCase() }],
      isActive: true,
    },
  });
}

/**
 * Applies a referral code to a newly signed-up user.
 * Creates the Referral record and gives the referee their welcome bonus.
 */
/**
 * FIX #8: Uses Serializable isolation to prevent concurrent code applications
 * from exceeding the maxReferrals cap.
 */
export async function applyReferralCode(
  newUserId: string,
  code: string,
): Promise<ReferralRow | null> {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Validate inside transaction to prevent TOCTOU race conditions
        const referralCode = await validateReferralCode(code, tx);
        if (!referralCode) return null;

        // Can't refer yourself
        if (referralCode.userId === newUserId) return null;

        // Check if max referrals cap reached
        if (referralCode.totalReferrals >= referralCode.maxReferrals)
          return null;

        // Check if already referred
        const existingReferral = await tx.referral.findUnique({
          where: { referredUserId: newUserId },
        });
        if (existingReferral) return null;

        const ref = await tx.referral.create({
          data: {
            referralCodeId: referralCode.id,
            referredUserId: newUserId,
            status: "SIGNED_UP",
            referrerRewardAmount:
              referralCode.referrerReward ?? DEFAULT_REFERRER_REWARD,
            refereeRewardAmount:
              referralCode.refereeReward ?? DEFAULT_REFEREE_REWARD,
          },
        });

        await tx.referralCode.update({
          where: { id: referralCode.id },
          data: { totalReferrals: { increment: 1 } },
        });

        // FIX #437: Referee bonus is NO LONGER given immediately on signup.
        // Both referee (₹200) and referrer (₹500) bonuses are now deferred
        // until the referred user's first paid booking via processQualifyingAction().
        // This eliminates fake account farming (previously ₹200/account with zero revenue).

        return ref;
      },
      {
        isolationLevel: "Serializable",
        timeout: 10000,
      },
    ),
  );
}

/**
 * Called after a user's first paid booking to qualify their referral.
 * Rewards the referrer if the referral is within the qualification window.
 * FIX #7: Entire flow runs in a serializable transaction with conditional status guard
 * to prevent duplicate rewards from concurrent webhook execution.
 */
export async function processQualifyingAction(
  userId: string,
  action: string,
): Promise<void> {
  await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Read referral INSIDE transaction to prevent TOCTOU race
        const referral = await tx.referral.findUnique({
          where: { referredUserId: userId },
          include: { referralCode: true },
        });

        if (!referral || referral.status !== "SIGNED_UP") return;

        // #880 — program controls (single-row config). A paused program grants
        // nothing and leaves the referral SIGNED_UP so it can still qualify once
        // the program resumes. The monthly budget window rolls over lazily.
        const period = new Date().toISOString().slice(0, 7); // YYYY-MM
        const config = await tx.referralProgramConfig.upsert({
          where: { id: "singleton" },
          create: { id: "singleton", currentPeriod: period },
          update: {},
        });
        if (!config.isActive) return;
        const spentThisMonth =
          config.currentPeriod === period ? config.currentMonthSpentPaise : 0;
        const budgetRemaining =
          config.monthlyBudgetPaise === null
            ? Number.POSITIVE_INFINITY
            : Math.max(0, config.monthlyBudgetPaise - spentThisMonth);
        if (budgetRemaining <= 0) return; // month's budget exhausted → defer

        // REF-3 (#692) — claim the reward atomically: status still SIGNED_UP AND
        // within the qualification window, both asserted in the WHERE. Folding the
        // window into the guarded write (rather than an app-side Date.now() check
        // separate from the status guard) makes reward-vs-expire a single decision
        // against the committed row, closing the gap where a stale read or the
        // expireStaleReferrals cron disagrees with the app-computed window.
        const windowCutoff = new Date(
          Date.now() - QUALIFICATION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
        );
        const updated = await tx.referral.updateMany({
          where: {
            id: referral.id,
            status: "SIGNED_UP",
            signedUpAt: { gte: windowCutoff },
          },
          data: {
            status: "REWARDED",
            qualifiedAt: new Date(),
            qualifyingAction: action,
            // #896 — the *RewardPaidAt timestamps are set below, each only when a
            // credit row is actually created for that side. The referrer grant can
            // clamp to 0 (annual cap / monthly budget) and the referee grant is
            // skipped entirely for CONSULTANT referees, so an unconditional "paid"
            // stamp here would claim a payment that never happened.
          },
        });

        // No reward claimed → either a concurrent call already processed it, or
        // it's past the window. Expire it iff it's still an un-rewarded SIGNED_UP
        // past the cutoff (the status guard makes this a no-op against a REWARDED row).
        if (updated.count === 0) {
          await tx.referral.updateMany({
            where: {
              id: referral.id,
              status: "SIGNED_UP",
              signedUpAt: { lt: windowCutoff },
            },
            data: { status: "EXPIRED" },
          });
          return;
        }

        // Running program spend for this qualification (referrer + referee),
        // used to honor the monthly budget cap and auto-pause on exhaustion.
        let spentNow = 0;

        // #896 — only stamp *RewardPaidAt for a side that actually got a credit.
        let referrerCredited = false;
        let refereeCredited = false;

        // Give referrer their bonus. The amount comes from the program config
        // (the conservative-launch ramp, ₹300 → ₹500), clamped by the annual
        // per-referrer cap and the remaining monthly budget.
        const rampedReferrerReward =
          config.referrerRewardPaise > 0
            ? config.referrerRewardPaise
            : (referral.referrerRewardAmount ?? 0);
        if (rampedReferrerReward > 0) {
          // #880 — bound a referrer's referral earnings to ANNUAL_REWARD_CAP
          // over a trailing year; clamp (or skip) the grant if it would exceed.
          const yearCutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
          const priorCredits = await tx.referralCredit.findMany({
            where: {
              userId: referral.referralCode.userId,
              source: "REFERRAL_BONUS",
              createdAt: { gte: yearCutoff },
            },
            select: { amount: true },
          });
          const earnedThisYear = priorCredits.reduce(
            (sum, c) => sum + Number(c.amount),
            0,
          );
          const grant = Math.min(
            rampedReferrerReward,
            Math.max(0, ANNUAL_REWARD_CAP_PAISE - earnedThisYear),
            budgetRemaining - spentNow,
          );

          if (grant > 0) {
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + CREDIT_EXPIRY_DAYS);

            await tx.referralCredit.create({
              data: {
                userId: referral.referralCode.userId,
                amount: grant,
                currency: "INR",
                source: "REFERRAL_BONUS",
                referralId: referral.id,
                remainingAmount: grant,
                expiresAt,
              },
            });

            // Update referral code stats
            await tx.referralCode.update({
              where: { id: referral.referralCodeId },
              data: {
                successfulReferrals: { increment: 1 },
                totalEarned: { increment: grant },
              },
            });
            spentNow += grant;
            referrerCredited = true;
          }
        }

        // FIX #437: Give referee their bonus (deferred from signup), but only
        // for consultee referees. #880 — a consultant referee's instrument is a
        // commission waiver on their first sessions (applied in earnings-service),
        // not a booking credit a seller can't use, so skip the credit for them.
        const refereeUser = await tx.user.findUnique({
          where: { id: referral.referredUserId },
          select: { role: true },
        });
        const refereeReward = referral.refereeRewardAmount;
        if (
          refereeUser?.role !== "CONSULTANT" &&
          refereeReward &&
          refereeReward > 0
        ) {
          const grant = Math.min(refereeReward, budgetRemaining - spentNow);
          if (grant > 0) {
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + CREDIT_EXPIRY_DAYS);

            await tx.referralCredit.create({
              data: {
                userId: referral.referredUserId,
                amount: grant,
                currency: "INR",
                source: "REFEREE_BONUS",
                referralId: referral.id,
                remainingAmount: grant,
                expiresAt,
              },
            });
            spentNow += grant;
            refereeCredited = true;
          }
        }

        // #896 — stamp paid-at per side, each only when its credit landed. A
        // clamped/skipped grant leaves the timestamp null so the row never
        // claims a payment that didn't happen.
        if (referrerCredited || refereeCredited) {
          await tx.referral.update({
            where: { id: referral.id },
            data: {
              ...(referrerCredited ? { referrerRewardPaidAt: new Date() } : {}),
              ...(refereeCredited ? { refereeRewardPaidAt: new Date() } : {}),
            },
          });
        }

        // #880 — persist the budget window (lazy monthly rollover) and the
        // spend, auto-pausing the program when the monthly budget is exhausted
        // so later qualifications defer until an admin reviews.
        if (config.monthlyBudgetPaise !== null || config.currentPeriod !== period) {
          const newSpent = spentThisMonth + spentNow;
          await tx.referralProgramConfig.update({
            where: { id: config.id },
            data: {
              currentPeriod: period,
              currentMonthSpentPaise: newSpent,
              ...(config.monthlyBudgetPaise !== null &&
              newSpent >= config.monthlyBudgetPaise
                ? { isActive: false }
                : {}),
            },
          });
        }
      },
      {
        isolationLevel: "Serializable",
        timeout: 10000,
      },
    ),
  );
}

/**
 * Returns the user's available (non-expired, non-fully-used) credit balance.
 */
export async function getUserCredits(
  userId: string,
  db: Tx | typeof prisma = prisma,
): Promise<{
  totalAvailable: number;
  credits: ReferralCreditRow[];
}> {
  const credits = await db.referralCredit.findMany({
    where: {
      userId,
      currency: "INR", // Only INR credits for MVP — prevents cross-currency application
      remainingAmount: { gt: 0 },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { expiresAt: "asc" },
  });

  const totalAvailable = credits.reduce((sum, c) => sum + c.remainingAmount, 0);

  return { totalAvailable, credits };
}

/**
 * Applies referral credits to a payment at checkout.
 * Uses FIFO ordering by expiry date (expiring soonest first).
 * Creates per-payment usage records in ReferralCreditUsage ledger for accurate reversal.
 * Returns the total credits used and the remaining amount to pay.
 */
export async function applyCreditsToPayment(
  userId: string,
  paymentAmount: number,
  tx: Tx,
  paymentId?: string,
): Promise<{ creditsUsed: number; remainingToPay: number }> {
  const { credits } = await getUserCredits(userId, tx);

  let creditsUsed = 0;
  let remainingToPay = paymentAmount;

  for (const credit of credits) {
    if (remainingToPay <= 0) break;

    const useAmount = Math.min(credit.remainingAmount, remainingToPay);

    await tx.referralCredit.update({
      where: { id: credit.id },
      data: {
        usedAmount: { increment: useAmount },
        remainingAmount: { decrement: useAmount },
        ...(credit.remainingAmount - useAmount === 0 && {
          usedAt: new Date(),
        }),
      },
    });

    // Create ledger entry for accurate per-payment tracking and reversal
    if (paymentId) {
      const usage = await tx.referralCreditUsage.create({
        data: {
          creditId: credit.id,
          paymentId,
          amount: useAmount,
          originalAmount: useAmount,
        },
      });

      // Enterprise (Arch 4-Modified): every credit consumption writes a
      // matching PaymentLeg so the per-payment leg invariant
      // (`docs/enterprise/10-money-and-ledger/09-payment-legs.md`) holds for any flow that
      // mixes referral credits with card / wallet / invoice. `sourceRef`
      // points at the ReferralCreditUsage row so refund + reversal can
      // join the credit ledger without scanning by paymentId+credit.
      await tx.paymentLeg.create({
        data: {
          paymentId,
          source: "REFERRAL_CREDIT",
          amountPaise: useAmount,
          sourceRef: usage.id,
        },
      });
    }

    creditsUsed += useAmount;
    remainingToPay -= useAmount;
  }

  return { creditsUsed, remainingToPay };
}

/**
 * Reverses referral credits that were consumed for a specific payment.
 * Uses the ReferralCreditUsage ledger for accurate per-payment reversal.
 * Called during refund processing to restore credits to the user.
 *
 * For partial refunds: uses cumulative proportional restoration to avoid
 * rounding drift across multiple partial refunds. Queries the total SUCCEEDED
 * refunds for the payment (including the current one) to compute the cumulative
 * ratio, then restores (cumulativeTarget - alreadyRestored) per usage record.
 * On the final refund (cumulative = original), this guarantees exact restoration.
 * For full refunds: restores all usage and deletes the usage records.
 */
export async function reverseCreditsForPayment(
  paymentId: string,
  tx: Tx,
  refundAmount?: number,
  originalPaymentAmount?: number,
): Promise<number> {
  // Find all usage records for this payment from the ledger. Carry the credit's
  // expiry so we don't restore onto a credit that has since lapsed (REF-2).
  const usageRecords = await tx.referralCreditUsage.findMany({
    where: { paymentId },
    include: { credit: { select: { expiresAt: true } } },
  });

  if (usageRecords.length === 0) return 0;

  // Determine if this is a partial refund
  const isPartialRefund =
    refundAmount !== null &&
    refundAmount !== undefined &&
    originalPaymentAmount !== null &&
    originalPaymentAmount !== undefined &&
    originalPaymentAmount > 0 &&
    refundAmount < originalPaymentAmount;

  // For partial refunds, query the cumulative SUCCEEDED refund total for this
  // payment (the current refund is already recorded before this function runs).
  // Using cumulative totals instead of per-refund ratios eliminates rounding drift.
  let cumulativeRefunded: number | null = null;
  if (isPartialRefund) {
    const aggregate = await tx.refund.aggregate({
      where: { paymentId, status: "SUCCEEDED" },
      _sum: { amountPaise: true },
    });
    // #780 — aggregates bypass the result extension and still return bigint
    const refundedSum = aggregate._sum?.amountPaise;
    cumulativeRefunded =
      refundedSum == null ? (refundAmount ?? 0) : sumPaise(refundedSum);
  }

  let totalRestored = 0;
  let skippedExpired = 0;
  const now = new Date();

  for (const usage of usageRecords) {
    if (usage.amount <= 0) continue;

    // REF-2 (#692) — never resurrect an expired credit. If the credit lapsed
    // after it was applied, restoring remainingAmount onto it just leaves dead
    // balance (getUserCredits filters expiry; the expiry cron re-zeroes it).
    // Skip + log; the usage row stays so the credit reads as still consumed.
    // (Issuing fresh credit on refund-of-expired is a product decision, not done here.)
    // `credit` is a required FK relation that the findMany above always includes,
    // so it is never null here — no optional chain needed.
    const creditExpiresAt = usage.credit.expiresAt;
    if (creditExpiresAt && creditExpiresAt.getTime() < now.getTime()) {
      skippedExpired += usage.amount;
      continue;
    }

    let restoreAmount: number;

    if (isPartialRefund && cumulativeRefunded !== null) {
      // Cumulative proportional approach: compute how much should have been
      // restored in total by now, then subtract what was already restored.
      const cumulativeTarget = Math.round(
        (usage.originalAmount * cumulativeRefunded) / originalPaymentAmount!,
      );
      const alreadyRestored = usage.restoredAmount;
      restoreAmount = Math.min(
        cumulativeTarget - alreadyRestored,
        usage.amount,
      );
    } else {
      // Full refund — restore everything remaining
      restoreAmount = usage.amount;
    }

    if (restoreAmount <= 0) continue;

    // Restore the appropriate amount to the credit
    await tx.referralCredit.update({
      where: { id: usage.creditId },
      data: {
        usedAmount: { decrement: restoreAmount },
        remainingAmount: { increment: restoreAmount },
        ...(restoreAmount >= usage.amount && { usedAt: null }),
      },
    });

    if (restoreAmount >= usage.amount) {
      // Full restore — remove the usage record
      await tx.referralCreditUsage.delete({
        where: { id: usage.id },
      });
    } else {
      // Partial restore — reduce usage amount and track cumulative restored
      await tx.referralCreditUsage.update({
        where: { id: usage.id },
        data: {
          amount: { decrement: restoreAmount },
          restoredAmount: { increment: restoreAmount },
        },
      });
    }

    totalRestored += restoreAmount;
  }

  if (totalRestored > 0) {
    console.log(
      `🔄 Restored ${totalRestored} referral credits for ${isPartialRefund ? "partially " : ""}refunded payment ${paymentId}`,
    );
  }
  if (skippedExpired > 0) {
    // REF-2 — visibility: credit value (in paise) not returned because the
    // underlying credit had already expired.
    console.log(
      `⏭️  Skipped restoring ${skippedExpired} paise of expired referral credit for refunded payment ${paymentId}`,
    );
  }

  return totalRestored;
}

/**
 * Sets a custom vanity code for a user's referral code.
 */
export async function setCustomCode(
  userId: string,
  customCode: string,
): Promise<ReferralCodeRow | null> {
  const referralCode = await prisma.referralCode.findUnique({
    where: { userId },
  });

  if (!referralCode) return null;

  const normalized = customCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.length < 3 || normalized.length > 20) return null;

  // Check uniqueness against both code and customCode fields
  const existing = await prisma.referralCode.findFirst({
    where: {
      OR: [{ code: normalized }, { customCode: normalized }],
      NOT: { id: referralCode.id },
    },
  });
  if (existing) return null;

  return prisma.referralCode.update({
    where: { id: referralCode.id },
    data: { customCode: normalized },
  });
}

/**
 * Gets a user's referral code with stats.
 */
export async function getReferralCode(
  userId: string,
): Promise<ReferralCodeRow | null> {
  return prisma.referralCode.findUnique({
    where: { userId },
  });
}

/**
 * Gets a user's referral list (people they referred).
 */
export async function getUserReferrals(
  userId: string,
): Promise<
  (ReferralRow & { referredUser: { name: string; image: string | null } })[]
> {
  const referralCode = await prisma.referralCode.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!referralCode) return [];

  return prisma.referral.findMany({
    where: { referralCodeId: referralCode.id },
    include: {
      referredUser: {
        select: { name: true, image: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Gets a user's full credit history (including used/expired).
 */
export async function getCreditHistory(
  userId: string,
): Promise<ReferralCreditRow[]> {
  return prisma.referralCredit.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Expires unqualified referrals that are past the qualification window.
 * Called by cron job.
 */
export async function expireStaleReferrals(): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - QUALIFICATION_WINDOW_DAYS);

  const result = await prisma.referral.updateMany({
    where: {
      status: "SIGNED_UP",
      signedUpAt: { lt: cutoffDate },
    },
    data: { status: "EXPIRED" },
  });

  return result.count;
}

/**
 * Expires credits that are past their expiry date.
 * Called by cron job.
 */
export async function expireStaleCredits(): Promise<number> {
  const result = await prisma.referralCredit.updateMany({
    where: {
      remainingAmount: { gt: 0 },
      expiresAt: { lt: new Date() },
    },
    data: { remainingAmount: 0 },
  });

  return result.count;
}

/**
 * #880 — proactively roll the monthly referral-budget window. A cron may call
 * this; the qualification path also rolls it over lazily. Does NOT re-activate
 * an auto-paused program — re-enabling is an explicit admin action.
 */
export async function resetReferralBudgetMonthly(): Promise<void> {
  const period = new Date().toISOString().slice(0, 7);
  await prisma.referralProgramConfig.updateMany({
    where: { currentPeriod: { not: period } },
    data: { currentPeriod: period, currentMonthSpentPaise: 0 },
  });
}

/**
 * #880 — is this consultant eligible for the referral commission waiver on the
 * session being settled? True when they are the referee of a live referral AND
 * this is within their first CONSULTANT_WAIVER_SESSIONS settled (paid) sessions.
 * The caller passes the same `tx` as the earnings write so the session count is
 * consistent; org-hosted settlements are excluded by the caller.
 */
export async function isConsultantReferralWaiverActive(
  tx: Tx,
  consultantProfileId: string,
): Promise<boolean> {
  const profile = await tx.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: { userId: true },
  });
  if (!profile) return false;

  // #896 — a still-SIGNED_UP referral only grants the waiver while it's inside
  // the qualification window; past it the row is stale (the expire cron just
  // hasn't run yet) and must not waive. REWARDED rows already qualified, so
  // they carry no window check.
  const windowCutoff = new Date(
    Date.now() - QUALIFICATION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const referral = await tx.referral.findFirst({
    where: {
      referredUserId: profile.userId,
      OR: [
        { status: "REWARDED" },
        { status: "SIGNED_UP", signedUpAt: { gte: windowCutoff } },
      ],
    },
    select: { id: true },
  });
  if (!referral) return false;

  // Count excludes the row being created (idempotency guarantees this payment
  // has none yet), so 0/1/2 prior sessions ⇒ waive, 3+ ⇒ full commission.
  // #896 — exclude org-hosted settlements (the waiver only applies to non-org
  // sessions, so a HYBRID consultant must not burn quota on org sessions) and
  // REFUNDED earnings (a refunded session must not consume a waiver slot).
  const priorSessions = await tx.consultantEarnings.count({
    where: {
      consultantProfileId,
      status: { not: "REFUNDED" },
      payment: { organizationEarnings: { none: {} } },
    },
  });
  return priorSessions < CONSULTANT_WAIVER_SESSIONS;
}

/**
 * Process consultant referral qualifying action when they receive a paid booking.
 * Looks up the consultant userId from the payment's appointment chain and triggers
 * processQualifyingAction for "first_paid_booking_received".
 *
 * Used by both checkout.ts (mock/zero-amount) and handlers.ts (webhook-confirmed).
 */
export async function processConsultantBookingReferral(
  paymentLookup: { id?: string; paymentIntent?: string },
  buyerUserId: string,
): Promise<void> {
  const where = paymentLookup.id
    ? { id: paymentLookup.id }
    : { paymentIntent: paymentLookup.paymentIntent! };

  const payment = await prisma.payment.findUnique({
    where,
    include: {
      appointment: {
        include: {
          consultation: {
            include: {
              consultationPlan: {
                select: { consultantProfile: { select: { userId: true } } },
              },
            },
          },
          subscription: {
            include: {
              subscriptionPlan: {
                select: { consultantProfile: { select: { userId: true } } },
              },
            },
          },
          webinar: {
            select: {
              webinarPlanId: true,
              webinarPlan: {
                select: { consultantProfile: { select: { userId: true } } },
              },
            },
          },
          class: {
            select: {
              classPlanId: true,
              classPlan: {
                select: { consultantProfile: { select: { userId: true } } },
              },
            },
          },
        },
      },
    },
  });

  const consultantUserId =
    payment?.appointment?.consultation?.consultationPlan?.consultantProfile
      ?.userId ||
    payment?.appointment?.subscription?.subscriptionPlan?.consultantProfile
      ?.userId ||
    payment?.appointment?.webinar?.webinarPlan?.consultantProfile?.userId ||
    payment?.appointment?.class?.classPlan?.consultantProfile?.userId;

  if (consultantUserId && consultantUserId !== buyerUserId) {
    await processQualifyingAction(
      consultantUserId,
      "first_paid_booking_received",
    );
  }

  // FIX #619: Also qualify ACCEPTED collaborators on webinar/class bookings.
  // Collaborators earn revenue from these bookings and should trigger referral
  // qualification just like plan owners.
  const webinarPlanId = payment?.appointment?.webinar?.webinarPlanId;
  const classPlanId = payment?.appointment?.class?.classPlanId;

  const collaboratorUserIds: string[] = [];

  if (webinarPlanId) {
    const collabs = await prisma.collaborator.findMany({
      where: { webinarPlanId, status: "ACCEPTED" },
      select: { consultantProfile: { select: { userId: true } } },
    });
    collaboratorUserIds.push(...collabs.map((c) => c.consultantProfile.userId));
  }

  if (classPlanId) {
    const collabs = await prisma.collaborator.findMany({
      where: { classPlanId, status: "ACCEPTED" },
      select: { consultantProfile: { select: { userId: true } } },
    });
    collaboratorUserIds.push(...collabs.map((c) => c.consultantProfile.userId));
  }

  // Deduplicate and exclude buyer + plan owner (already processed above)
  const uniqueCollabUserIds = Array.from(
    new Set(
      collaboratorUserIds.filter(
        (id) => id !== buyerUserId && id !== consultantUserId,
      ),
    ),
  );

  for (const collabUserId of uniqueCollabUserIds) {
    await processQualifyingAction(collabUserId, "first_paid_booking_received");
  }
}
