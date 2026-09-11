import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, spamLimiter } from "@/lib/rate-limit";
import { recordSystemEvent } from "@/lib/enterprise/system-events";

// #701 — DPDP Rule 13 grievance intake (minimal). A data principal files a
// grievance; it's stored durably and surfaced to ops via a system event. The
// redressal SLA workflow (assignment, deadlines, closure audit) is deferred.
const GrievanceSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10).max(5000),
});

export async function POST(req: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const userId = auth.session.user.id;

  const limited = await applyRateLimit(spamLimiter, `grievance:${userId}`);
  if (limited) return limited;

  try {
    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Malformed JSON request body" },
        { status: 400 },
      );
    }
    const parsed = GrievanceSchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request" },
        { status: 400 },
      );
    }

    const grievance = await prisma.dpdpGrievance.create({
      data: {
        userId,
        subject: parsed.data.subject,
        description: parsed.data.description,
      },
      select: { id: true, status: true, createdAt: true },
    });

    // Ops visibility — engineering-facing, not rendered to the user. Awaited so
    // the insert completes before the serverless function freezes (this is a
    // low-volume compliance surface, so the extra insert is cheap).
    await recordSystemEvent({
      category: "COMPLIANCE",
      message: `DPDP grievance ${grievance.id} filed by user ${userId}`,
      context: { grievanceId: grievance.id, userId },
    });

    return NextResponse.json({ grievance }, { status: 201 });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "compliance" } });
    console.error("Grievance intake error:", error);
    return NextResponse.json(
      { error: "Failed to file grievance" },
      { status: 500 },
    );
  }
}
