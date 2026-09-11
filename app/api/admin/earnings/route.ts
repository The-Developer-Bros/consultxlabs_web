/**
 * Admin Earnings API
 * View all consultant earnings
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import { EarningStatus } from "@prisma/client";
import { requireBackofficeSurface } from "@/lib/auth-helpers";

/**
 * GET /api/admin/earnings
 * Get all earnings with optional status filter
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("payouts.read");
    if (auth.error) return auth.error;

    // Parse query parameters
    const { searchParams } = new URL(req.url);
    const statusParam = searchParams.get("status");
    const validStatuses = Object.values(EarningStatus);
    const status =
      statusParam && validStatuses.includes(statusParam as EarningStatus)
        ? (statusParam as EarningStatus)
        : null;
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = parseInt(searchParams.get("offset") || "0");

    // Build where clause
    const where = status ? { status } : {};

    // Get earnings
    const [earnings, total] = await Promise.all([
      prisma.consultantEarnings.findMany({
        where,
        include: {
          // #946 allowlist — this route is requirePrivilegedAuth, so STAFF read
          // it. A bare `include:` handed every support agent the consultant's
          // panNumber and ibanOrAccount.
          consultantProfile: {
            select: {
              ...consultantPublicScalars,
              user: { select: { name: true, email: true } },
            },
          },
          payment: {
            select: {
              id: true,
              amount: true,
              currency: true,
            },
          },
          payout: {
            select: {
              id: true,
              status: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.consultantEarnings.count({ where }),
    ]);

    return NextResponse.json({
      earnings,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Error fetching earnings:", error);
    return NextResponse.json(
      { error: "Failed to fetch earnings" },
      { status: 500 },
    );
  }
}
