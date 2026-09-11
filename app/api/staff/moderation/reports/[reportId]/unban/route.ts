/**
 * Staff Moderation Unban API (#1270).
 *
 * The missing inverse of USER_BANNED. A ban deactivates the target on Stream,
 * which is permanent, and until now nothing in the codebase ever undid it: an
 * admin reversing a wrongful ban by clearing `User.banned` produced an account
 * that could sign in, book, and pay, but could never connect to chat again,
 * with nothing on any screen explaining why.
 *
 * The route is deliberately idempotent on the database side and unconditional
 * on the Stream side. A hand-edited row has already cleared the ban columns —
 * that is exactly the case this exists to repair — so restoreStreamAccess runs
 * whether or not there was anything left to clear.
 */
import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import type { UserRole } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import {
  persistActionSideEffects,
  restoreStreamAccess,
  type SideEffectSummary,
} from "@/lib/moderation/side-effects";

interface RouteParams {
  params: Promise<{ reportId: string }>;
}

/**
 * POST /api/staff/moderation/reports/[reportId]/unban
 * Lift the ban or suspension on the report's target user.
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    // Same gate as banning: `users.moderate` is ADMIN-only, and reversing an
    // enforcement decision is as consequential as taking one.
    if (
      !hasBackofficePermission(session.user.role as UserRole, "users.moderate")
    ) {
      return NextResponse.json(
        { error: "Forbidden — lifting a ban requires an admin" },
        { status: 403 },
      );
    }

    const { reportId } = await params;
    const body = await req.json().catch(() => ({}));
    const notes: string | undefined =
      typeof body?.notes === "string" && body.notes.length > 0
        ? body.notes.slice(0, 2000)
        : undefined;

    const report = await prisma.moderationReport.findUnique({
      where: { id: reportId },
      select: { id: true, targetUserId: true },
    });
    if (!report) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    // Clearing the columns and recording who cleared them commit together, so
    // a reinstated account can never be missing its audit row.
    const action = await prisma.$transaction(async (tx) => {
      await tx.user.updateMany({
        where: { id: report.targetUserId, banned: true },
        data: { banned: false, banReason: null, banExpires: null },
      });
      return tx.moderationAction.create({
        data: {
          reportId: report.id,
          actionType: "USER_REINSTATED",
          notes,
          takenById: session.user.id,
        },
        include: {
          takenBy: { select: { id: true, name: true, email: true } },
        },
      });
    });

    const sideEffects: SideEffectSummary = {};
    try {
      await restoreStreamAccess(report.targetUserId);
      sideEffects.stream = "ok";
    } catch (error) {
      // The account is signed-in-able but still mute on Stream. Say so rather
      // than reporting a clean reinstatement — that asymmetry is the whole
      // reason this route exists.
      sideEffects.stream = "failed";
      sideEffects.streamAttempts = 1;
      sideEffects.errors = [
        `stream: ${error instanceof Error ? error.message : String(error)}`,
      ];
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "moderation" } },
      );
    }
    await persistActionSideEffects(action.id, sideEffects);

    return NextResponse.json({
      action,
      sideEffects,
      message: "Ban lifted",
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "moderation" } },
    );
    console.error("Error lifting moderation ban:", error);
    return NextResponse.json({ error: "Failed to lift ban" }, { status: 500 });
  }
}
