/**
 * Shared operator dashboard statistics.
 *
 * Used by both the admin and staff dashboard home screens. Extracted from
 * the previously-duplicated `app/api/admin/stats/route.ts` and
 * `app/api/staff/stats/route.ts` to give a single source of truth and
 * eliminate drift between the two dashboards' numbers.
 *
 * Future work (see `docs/enterprise/00-foundations/01-overview.md` follow-ups):
 * extract similar shared functions for payments listing, invoice listing,
 * verification queue, etc. The pattern is:
 *   1. Put the query/aggregation in `lib/api/operators/<resource>.ts`.
 *   2. Keep the route files as 5-10 line shells that call the shared util.
 *   3. Any role-based scoping lives in the route handler, not the util.
 */

import prisma from "@/lib/prisma";
import { PaymentStatus, SupportTicketStatus } from "@prisma/client";
import { sumPaise } from "@/lib/payments/utils/money";

export type OperatorDashboardStats = {
  totalPayments: number;
  totalPaymentsValue: number;
  pendingPayments: number;
  pendingPaymentsValue: number;
  expiredPayments: number;
  totalRefunds: number;
  totalRefundsValue: number;
  activeDisputes: number;
  totalDisputes: number;
  recentPayments: Awaited<ReturnType<typeof fetchRecentPayments>>;
  recentRefunds: Awaited<ReturnType<typeof fetchRecentRefunds>>;
  gatewayStats: Record<string, { count: number }>;
};

function fetchRecentPayments() {
  return prisma.payment.findMany({
    take: 5,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      amount: true,
      currency: true,
      paymentStatus: true,
      paymentGateway: true,
      createdAt: true,
      appointment: {
        select: { appointmentType: true },
      },
    },
  });
}

function fetchRecentRefunds() {
  return prisma.refund.findMany({
    take: 5,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      amountPaise: true,
      currency: true,
      status: true,
      paymentGateway: true,
      createdAt: true,
    },
  });
}

/**
 * Fetch the full operator dashboard stats payload.
 *
 * This is the single source of truth — call it from any role-scoped
 * dashboard route (admin, staff) after your auth helper has run. Do not
 * re-implement these queries inside individual route files.
 */
export async function getOperatorDashboardStats(): Promise<OperatorDashboardStats> {
  const [
    totalPayments,
    pendingPayments,
    expiredPayments,
    totalRefunds,
    activeDisputes,
    totalDisputes,
    recentPayments,
    recentRefunds,
    paymentsAggregation,
    pendingPaymentsAggregation,
    refundsAggregation,
    gatewayStats,
  ] = await Promise.all([
    prisma.payment.count(),
    prisma.payment.count({ where: { paymentStatus: PaymentStatus.PENDING } }),
    prisma.payment.count({ where: { paymentStatus: PaymentStatus.EXPIRED } }),
    prisma.refund.count(),
    prisma.dispute.count({
      where: {
        status: {
          in: ["WARNING_NEEDS_RESPONSE", "NEEDS_RESPONSE", "UNDER_REVIEW"],
        },
      },
    }),
    prisma.dispute.count(),
    fetchRecentPayments(),
    fetchRecentRefunds(),
    prisma.payment.aggregate({
      _sum: { amount: true },
      where: { paymentStatus: PaymentStatus.SUCCEEDED },
    }),
    prisma.payment.aggregate({
      _sum: { amount: true },
      where: { paymentStatus: PaymentStatus.PENDING },
    }),
    prisma.refund.aggregate({ _sum: { amountPaise: true } }),
    prisma.payment.groupBy({
      by: ["paymentGateway"],
      _count: true,
    }),
  ]);

  const formattedGatewayStats = gatewayStats.reduce(
    (acc, stat) => {
      acc[stat.paymentGateway] = { count: stat._count };
      return acc;
    },
    {} as Record<string, { count: number }>,
  );

  return {
    totalPayments,
    totalPaymentsValue: sumPaise(paymentsAggregation._sum.amount),
    pendingPayments,
    pendingPaymentsValue: sumPaise(pendingPaymentsAggregation._sum.amount),
    expiredPayments,
    totalRefunds,
    totalRefundsValue: sumPaise(refundsAggregation._sum?.amountPaise),
    activeDisputes,
    totalDisputes,
    recentPayments,
    recentRefunds,
    gatewayStats: formattedGatewayStats,
  };
}

// ---------------------------------------------------------------------------
// Staff dashboard stats
// ---------------------------------------------------------------------------
//
// The staff dashboard home screen surfaces a different mix of numbers than
// the admin dashboard — it focuses on support workload (open tickets,
// resolved-this-week, recent open tickets) and consultant moderation
// (pending reviews) rather than payments. Keeping the staff variant
// separate avoids forcing one giant union type on either caller.

type StaffDashboardRecentTicket = {
  id: string;
  /** #705 — the reference staff and the user name the ticket by. */
  referenceNumber: string | null;
  subject: string;
  user: string;
  userImage: string | null;
  status: string;
  priority: string;
  createdAt: Date;
};

export type StaffDashboardStats = {
  openTickets: number;
  usersAssisted: number;
  pendingReviews: number;
  resolvedToday: number;
  recentTickets: StaffDashboardRecentTicket[];
};

/**
 * Fetch the staff dashboard stats payload.
 *
 * Single source of truth for the staff dashboard home screen — call from
 * `/api/staff/stats` after running `requirePrivilegedAuth()`.
 */
export async function getStaffDashboardStats(): Promise<StaffDashboardStats> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - 7);

  const [
    openTickets,
    resolvedThisWeek,
    pendingReviews,
    resolvedToday,
    recentTickets,
  ] = await Promise.all([
    prisma.supportTicket.count({
      where: { status: SupportTicketStatus.OPEN },
    }),
    prisma.supportTicket.count({
      where: {
        status: {
          in: [SupportTicketStatus.RESOLVED, SupportTicketStatus.CLOSED],
        },
        updatedAt: { gte: weekStart },
      },
    }),
    prisma.consultantReview.count({
      where: {
        createdAt: { gte: weekStart },
        deletedAt: null,
      },
    }),
    prisma.supportTicket.count({
      where: {
        status: {
          in: [SupportTicketStatus.RESOLVED, SupportTicketStatus.CLOSED],
        },
        updatedAt: { gte: todayStart },
      },
    }),
    prisma.supportTicket.findMany({
      where: {
        status: {
          in: [SupportTicketStatus.OPEN, SupportTicketStatus.IN_PROGRESS],
        },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      take: 4,
    }),
  ]);

  return {
    openTickets,
    usersAssisted: resolvedThisWeek,
    pendingReviews,
    resolvedToday,
    recentTickets: recentTickets.map((ticket) => ({
      id: ticket.id,
      referenceNumber: ticket.referenceNumber,
      subject: ticket.title,
      user: ticket.user.name || ticket.user.email || "Unknown",
      userImage: ticket.user.image,
      status: ticket.status.toLowerCase(),
      priority: ticket.priority.toLowerCase(),
      createdAt: ticket.createdAt,
    })),
  };
}
