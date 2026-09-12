import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { calculateRevenueSplit } from "@/lib/collaborators/service";
import prisma from "@/lib/prisma";
import { z } from "zod";

const amountSchema = z.coerce.number().int().min(0).max(1_000_000_000);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ planId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { planId } = await params;

    // Only the plan owner, accepted collaborators, or admin/staff may view revenue splits
    if (!isPrivileged(session.user.role)) {
      const plan = await prisma.classPlan.findUnique({
        where: { id: planId },
        select: { consultantProfileId: true },
      });
      if (!plan) {
        return NextResponse.json({ error: "Plan not found" }, { status: 404 });
      }
      const isOwner =
        session.user.consultantProfileId === plan.consultantProfileId;
      if (!isOwner) {
        const collab = await prisma.collaborator.findFirst({
          where: {
            classPlanId: planId,
            consultantProfileId: session.user.consultantProfileId ?? "__none__",
            status: "ACCEPTED",
          },
        });
        if (!collab) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      }
    }

    // #1580 C-P2-7 — bounded: `Number()` accepted NaN, negatives and 1e308,
    // and the split math ran on whatever arrived.
    // `?amount=` coerces to 0, not to the documented default (#1593).
    const rawAmount = req.nextUrl.searchParams.get("amount");
    const amountParsed = amountSchema.safeParse(rawAmount || "10000");
    if (!amountParsed.success) {
      return NextResponse.json(
        { error: "amount must be an integer between 0 and 1,000,000,000" },
        { status: 400 },
      );
    }
    const amount = amountParsed.data;

    const splits = await calculateRevenueSplit("class", planId, amount);
    return NextResponse.json({ data: splits });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "collaborations" } },
    );
    console.error("Error calculating revenue split:", error);
    return NextResponse.json(
      { error: "Failed to calculate revenue split" },
      { status: 500 },
    );
  }
}
