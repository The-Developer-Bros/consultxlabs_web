import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, DisputeStatus, PaymentGateway } from "@prisma/client";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    // Parse query parameters
    const searchParams = req.nextUrl.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const status = searchParams.get("status") as DisputeStatus | null;
    const gateway = searchParams.get("gateway") as PaymentGateway | null;
    const search = searchParams.get("search");
    // #674 comment 7 — optional org-scope filter. Disputes inherit the
    // org tag via the joined Payment row.
    const orgId = searchParams.get("orgId");

    // Build where clause
    const where: Prisma.DisputeWhereInput = {};

    if (status) {
      where.status = status;
    }

    if (gateway) {
      where.paymentGateway = gateway;
    }

    if (search) {
      where.disputeId = {
        contains: search,
        mode: "insensitive",
      };
    }

    if (orgId) {
      where.payment = { is: { organizationId: orgId } };
    }

    // Fetch disputes with pagination. underReviewCount/wonCount are
    // dashboard-wide (unfiltered by search/gateway, like urgentDisputes below)
    // — #997 secondary findings: the stat cards used to `.filter()` the
    // current page's `disputes` array, so they silently showed ≤`limit` (20)
    // instead of the true platform-wide count.
    const [disputes, total, urgentDisputes, underReviewCount, wonCount] =
      await Promise.all([
        prisma.dispute.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            payment: {
              select: {
                id: true,
                paymentIntent: true,
              },
            },
          },
        }),
        prisma.dispute.count({ where }),
        // Count urgent disputes (due within 3 days)
        prisma.dispute.count({
          where: {
            dueBy: {
              lte: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
              gte: new Date(),
            },
            status: {
              in: ["WARNING_NEEDS_RESPONSE", "NEEDS_RESPONSE", "UNDER_REVIEW"],
            },
          },
        }),
        prisma.dispute.count({ where: { status: "UNDER_REVIEW" } }),
        prisma.dispute.count({ where: { status: "WON" } }),
      ]);

    return NextResponse.json({
      disputes,
      total,
      urgentDisputes,
      stats: { underReviewCount, wonCount },
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Admin disputes list error:", error);
    return NextResponse.json(
      { error: "Failed to fetch disputes" },
      { status: 500 },
    );
  }
}
