/**
 * Admin Subscriptions API
 * View and manage platform subscriptions
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";

/**
 * GET /api/admin/subscriptions
 * Get all subscriptions with optional filters
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    // Parse query parameters
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status"); // active, expired, cancelled
    const search = searchParams.get("search");
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = parseInt(searchParams.get("offset") || "0");
    // #674 comment 7 — optional org-scope filter on Payment.organizationId.
    const orgId = searchParams.get("orgId");

    const now = new Date();
    const soonThreshold = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days from now

    // Build subscription date filter based on status
    let subscriptionDateFilter: Prisma.SubscriptionWhereInput = {};
    if (status === "active") {
      // Active = ends more than 7 days from now (includes expiring_soon for "active" filter)
      subscriptionDateFilter = {
        schedulingPeriodEndsAt: { gt: now },
      };
    } else if (status === "expiring_soon") {
      // Expiring soon = ends within 7 days but not expired
      subscriptionDateFilter = {
        schedulingPeriodEndsAt: { gt: now, lte: soonThreshold },
      };
    } else if (status === "expired") {
      // Expired = ends in the past
      subscriptionDateFilter = {
        schedulingPeriodEndsAt: { lte: now },
      };
    }

    // Build where clause with status filter in the database query
    const where: Prisma.PaymentWhereInput = {
      appointment: {
        appointmentType: "SUBSCRIPTION",
        subscription:
          Object.keys(subscriptionDateFilter).length > 0
            ? subscriptionDateFilter
            : undefined,
      },
    };

    if (search) {
      where.OR = [
        {
          user: {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
            ],
          },
        },
      ];
    }

    if (orgId) {
      where.organizationId = orgId;
    }

    // Base where clause for all subscription queries (without status filter)
    const baseWhere = {
      paymentStatus: "SUCCEEDED" as const,
      appointment: {
        appointmentType: "SUBSCRIPTION" as const,
      },
    };

    // Get subscription payments and stats in parallel
    const [subscriptions, total, activeCount, expiringCount, expiredCount] =
      await Promise.all([
        prisma.payment.findMany({
          where: {
            ...where,
            paymentStatus: "SUCCEEDED",
          },
          include: {
            user: {
              select: { name: true, email: true },
            },
            appointment: {
              include: {
                subscription: {
                  include: {
                    subscriptionPlan: {
                      include: {
                        consultantProfile: {
                          include: { user: { select: { name: true } } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
        }),
        prisma.payment.count({
          where: {
            ...where,
            paymentStatus: "SUCCEEDED",
          },
        }),
        // Count active subscriptions (ends > 7 days from now)
        prisma.payment.count({
          where: {
            ...baseWhere,
            appointment: {
              appointmentType: "SUBSCRIPTION",
              subscription: { schedulingPeriodEndsAt: { gt: soonThreshold } },
            },
          },
        }),
        // Count expiring soon subscriptions (ends within 7 days)
        prisma.payment.count({
          where: {
            ...baseWhere,
            appointment: {
              appointmentType: "SUBSCRIPTION",
              subscription: {
                schedulingPeriodEndsAt: { gt: now, lte: soonThreshold },
              },
            },
          },
        }),
        // Count expired subscriptions
        prisma.payment.count({
          where: {
            ...baseWhere,
            appointment: {
              appointmentType: "SUBSCRIPTION",
              subscription: { schedulingPeriodEndsAt: { lte: now } },
            },
          },
        }),
      ]);

    // Format subscriptions with status
    const formattedSubscriptions = subscriptions.map((s) => {
      const subscription = s.appointment?.subscription;
      const endDate = subscription?.schedulingPeriodEndsAt;
      const isActive = endDate && new Date(endDate) > now;
      const isExpiringSoon =
        endDate &&
        new Date(endDate) > now &&
        new Date(endDate) < new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      return {
        id: s.id,
        paymentId: s.id,
        amount: s.amount,
        currency: s.currency,
        gateway: s.paymentGateway,
        userName: s.user?.name || "Unknown",
        userEmail: s.user?.email || "",
        consultantName:
          subscription?.subscriptionPlan?.consultantProfile?.user?.name,
        startDate: subscription?.schedulingPeriodStartsAt,
        endDate: subscription?.schedulingPeriodEndsAt,
        subscriptionStatus: subscription?.status,
        status: isActive
          ? isExpiringSoon
            ? "expiring_soon"
            : "active"
          : "expired",
        createdAt: s.createdAt,
      };
    });

    // Status filtering now happens in the database query, so pagination is correct
    return NextResponse.json({
      subscriptions: formattedSubscriptions,
      stats: {
        activeCount,
        expiringCount,
        expiredCount,
      },
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Error fetching subscriptions:", error);
    return NextResponse.json(
      { error: "Failed to fetch subscriptions" },
      { status: 500 },
    );
  }
}
