import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import { searchLimiter, applyRateLimit, getClientIp } from "@/lib/rate-limit";

export async function GET(req: NextRequest) {
  try {
    // Rate limit: 60 requests per minute per IP
    const rl = await applyRateLimit(searchLimiter, getClientIp(req));
    if (rl) return rl;

    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const query = searchParams.get("q")?.trim();
    const excludeId = searchParams.get("excludeId");

    if (!query || query.length < 1) {
      return NextResponse.json({ data: [] });
    }

    const consultants = await prisma.consultantProfile.findMany({
      where: {
        ...(excludeId && { id: { not: excludeId } }),
        user: {
          OR: [
            { name: { contains: query, mode: "insensitive" } },
            { email: { contains: query, mode: "insensitive" } },
          ],
        },
      },
      select: {
        id: true,
        user: {
          select: {
            name: true,
            email: true,
            image: true,
          },
        },
      },
      take: 10,
      orderBy: { user: { name: "asc" } },
    });

    return NextResponse.json({ data: consultants });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "consultants" } });
    console.error("Error searching consultants:", error);
    return NextResponse.json(
      { error: "Failed to search consultants" },
      { status: 500 },
    );
  }
}
