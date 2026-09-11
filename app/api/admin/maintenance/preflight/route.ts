import { NextResponse } from "next/server";

import { requireAdminAuth } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";

/**
 * GET /api/admin/maintenance/preflight
 *
 * Returns pre-maintenance readiness data so admins can make an informed
 * decision before activating maintenance mode.
 */
export async function GET() {
  const auth = await requireAdminAuth();
  if (auth.error) return auth.error;

  const now = new Date();
  const fourHoursFromNow = new Date(now.getTime() + 4 * 60 * 60 * 1000);

  const [
    activeCalls,
    pendingPayments,
    upcomingAppointments,
    pendingPayouts,
    openDisputes,
  ] = await Promise.all([
    prisma.meetingSession.count({ where: { endedAt: null } }),
    prisma.payment.count({ where: { paymentStatus: "PENDING" } }),
    prisma.slotOfAppointment.count({
      where: {
        startsAt: { gte: now, lte: fourHoursFromNow },
        isTentative: false,
        // A cancelled session is tombstoned, not deleted, so an unfiltered
        // count warns the operator about sessions that will never happen.
        deletedAt: null,
      },
    }),
    prisma.consultantPayout.count({ where: { status: "PENDING" } }),
    prisma.dispute.count({
      where: {
        status: { in: ["NEEDS_RESPONSE", "WARNING_NEEDS_RESPONSE"] },
      },
    }),
  ]);

  const warnings: string[] = [];
  if (activeCalls > 0)
    warnings.push(`${activeCalls} active video call(s) in progress`);
  if (pendingPayments > 0)
    warnings.push(`${pendingPayments} pending payment(s) in flight`);
  if (upcomingAppointments > 0)
    warnings.push(`${upcomingAppointments} appointment(s) in the next 4 hours`);
  if (pendingPayouts > 0) warnings.push(`${pendingPayouts} pending payout(s)`);
  if (openDisputes > 0)
    warnings.push(`${openDisputes} open dispute(s) requiring response`);

  let recommendation: "SAFE" | "CAUTION" | "RISKY";
  if (activeCalls > 0 || pendingPayments > 0 || openDisputes > 0) {
    recommendation = "RISKY";
  } else if (upcomingAppointments > 0 || pendingPayouts > 0) {
    recommendation = "CAUTION";
  } else {
    recommendation = "SAFE";
  }

  return NextResponse.json({
    activeCalls,
    pendingPayments,
    upcomingAppointments,
    pendingPayouts,
    openDisputes,
    recommendation,
    warnings,
    checkedAt: now.toISOString(),
  });
}
