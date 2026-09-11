import { AppointmentStatus } from "@prisma/client";

/**
 * Anti-scalper cap for request-for-approval holds (booking-journey audit B1).
 *
 * Every PENDING consultation request pins a tentative slot that blocks the
 * consultant's calendar, and nothing used to bound how many one account
 * could accumulate — the hourly rate limiter still allowed a bot farm to pin
 * a popular consultant's entire inventory for days. The cap is on ACTIVE
 * (PENDING) requests only: approved-awaiting-payment requests are bounded by
 * Payment.expiresAt sweeps instead, and terminal requests hold nothing.
 */

export const MAX_ACTIVE_REQUESTS_PER_USER = 3;

/**
 * How many PENDING consultation requests this consultee currently has open.
 *
 * Structurally typed rather than Pick<PrismaClient, …>: the extended client
 * (lib/prisma) is a DynamicClientExtensionThis whose comparison against
 * PrismaClient blows tsc's stack; every caller passes that client.
 */
export async function countActiveConsultationRequests(
  db: {
    consultation: {
      count: (args: {
        where: {
          requestedById: string;
          status: AppointmentStatus;
        };
      }) => Promise<number>;
    };
  },
  consulteeProfileId: string,
): Promise<number> {
  return db.consultation.count({
    where: {
      requestedById: consulteeProfileId,
      status: AppointmentStatus.PENDING,
    },
  });
}
