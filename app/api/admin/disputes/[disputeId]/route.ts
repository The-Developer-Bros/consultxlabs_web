import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";

interface RouteParams {
  params: Promise<{
    disputeId: string;
  }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication (admin or staff)
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const resolvedParams = await params;

    // Fetch dispute details
    const dispute = await prisma.dispute.findUnique({
      where: { id: resolvedParams.disputeId },
      include: {
        payment: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (!dispute) {
      return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
    }

    return NextResponse.json(dispute);
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Admin dispute details error:", error);
    return NextResponse.json(
      { error: "Failed to fetch dispute details" },
      { status: 500 },
    );
  }
}
