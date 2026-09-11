import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { sumPaise } from "@/lib/payments/utils/money";

export async function GET() {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    // Get current date info for time-based queries
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Fetch user counts by role
    const [
      totalUsers,
      totalConsultants,
      totalConsultees,
      totalStaff,
      newUsersThisMonth,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { role: UserRole.CONSULTANT } }),
      prisma.user.count({ where: { role: UserRole.CONSULTEE } }),
      prisma.user.count({ where: { role: UserRole.STAFF } }),
      prisma.user.count({
        where: { createdAt: { gte: startOfMonth } },
      }),
    ]);

    // Active users (completed onboarding)
    const [activeConsultants, activeConsultees] = await Promise.all([
      prisma.user.count({
        where: {
          role: UserRole.CONSULTANT,
          onboardingCompleted: true,
        },
      }),
      prisma.user.count({
        where: {
          role: UserRole.CONSULTEE,
          onboardingCompleted: true,
        },
      }),
    ]);

    // Get top domains by consultant count
    const topDomains = await prisma.domain.findMany({
      select: {
        name: true,
        _count: {
          select: { consultantProfiles: true },
        },
      },
      orderBy: {
        consultantProfiles: { _count: "desc" },
      },
      take: 5,
    });

    // Format top domains
    const formattedTopDomains = topDomains.map((domain) => ({
      name: domain.name,
      consultantCount: domain._count.consultantProfiles,
    }));

    // Session stats and payment stats - run in parallel for better performance
    const [
      totalSessions,
      completedSessions,
      upcomingSessions,
      cancelledSessions,
      paymentStats,
      revenueThisMonth,
      refundTotal,
    ] = await Promise.all([
      // Total appointments
      prisma.appointment.count(),
      // Completed sessions (slots that have ended)
      prisma.appointment.count({
        where: {
          slotsOfAppointment: {
            some: {
              endsAt: { lt: now },
            },
          },
        },
      }),
      // Upcoming sessions (slots that haven't started yet)
      prisma.appointment.count({
        where: {
          slotsOfAppointment: {
            some: {
              startsAt: { gt: now },
            },
          },
        },
      }),
      // Cancelled sessions
      prisma.consultation.count({
        where: { status: "CANCELLED" },
      }),
      // Payment stats
      prisma.payment.aggregate({
        _sum: { amount: true },
        _count: true,
        where: { paymentStatus: "SUCCEEDED" },
      }),
      // Revenue this month
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: {
          paymentStatus: "SUCCEEDED",
          createdAt: { gte: startOfMonth },
        },
      }),
      // Refund total
      prisma.refund.aggregate({
        _sum: { amountPaise: true },
        where: { status: "SUCCEEDED" },
      }),
    ]);

    const totalRevenue = sumPaise(paymentStats._sum.amount);
    const avgSessionValue =
      paymentStats._count > 0 ? totalRevenue / paymentStats._count : 0;

    return NextResponse.json({
      // User stats
      totalUsers,
      totalConsultants,
      totalConsultees,
      totalStaff,
      newUsersThisMonth,
      activeConsultants,
      activeConsultees,

      // Session stats
      totalSessions,
      completedSessions,
      upcomingSessions,
      cancelledSessions,

      // Revenue stats
      totalRevenue,
      revenueThisMonth: sumPaise(revenueThisMonth._sum.amount),
      avgSessionValue,
      totalRefunds: sumPaise(refundTotal._sum?.amountPaise),

      // Top domains
      topDomains: formattedTopDomains,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Error fetching analytics:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
