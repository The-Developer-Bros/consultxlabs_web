/**
 * Staff Moderation Report Action API
 * Take moderation action on a report — with real side-effects (#693).
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ModerationActionType } from "@prisma/client";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import type { UserRole } from "@prisma/client";
import {
  applyTransactionalEffects,
  applyBestEffortEffects,
  persistActionSideEffects,
  type ModerationReportRef,
  type SideEffectSummary,
} from "@/lib/moderation/side-effects";
import * as Sentry from "@sentry/nextjs";
import { purgeReviewSurfaces } from "@/lib/data/public-cache";
interface RouteParams {
  params: Promise<{ reportId: string }>;
}

/**
 * POST /api/staff/moderation/reports/[reportId]/action
 * Take moderation action on a report
 */
const VALID_ACTIONS: ModerationActionType[] = [
  "WARNING_ISSUED",
  "CONTENT_REMOVED",
  "USER_SUSPENDED",
  "USER_BANNED",
  "PROFILE_UNVERIFIED",
  "NO_ACTION",
];

type ModerationActionInput = {
  actionType: ModerationActionType;
  report: ModerationReportRef;
  staffUserId: string;
  notes?: string;
  suspensionDays?: number;
};

// Returns a 400 response when the action-type / suspensionDays payload is
// invalid, or null when the request is well-formed.
function validateActionRequest(
  actionType: unknown,
  suspensionDays: unknown,
): NextResponse | null {
  if (
    !actionType ||
    !VALID_ACTIONS.includes(actionType as ModerationActionType)
  ) {
    return NextResponse.json({ error: "Invalid action type" }, { status: 400 });
  }
  if (
    actionType === "USER_SUSPENDED" &&
    (!Number.isInteger(suspensionDays) ||
      (suspensionDays as number) < 1 ||
      (suspensionDays as number) > 365)
  ) {
    return NextResponse.json(
      { error: "suspensionDays must be an integer between 1 and 365" },
      { status: 400 },
    );
  }
  return null;
}

// Account-state side-effects commit atomically with the action row — the report
// can never read ACTION_TAKEN while the target kept access.
function applyModerationTransaction(
  reportId: string,
  actionType: ModerationActionType,
  notes: string | undefined,
  staffUserId: string,
  input: ModerationActionInput,
) {
  return prisma.$transaction(
    async (tx) => {
      // Status re-check rides the WHERE (CAS) — two staff racing the same
      // report resolve to exactly one winner.
      const moved = await tx.moderationReport.updateMany({
        where: {
          id: reportId,
          status: { in: ["PENDING", "UNDER_REVIEW", "ESCALATED"] },
        },
        data: {
          status: actionType === "NO_ACTION" ? "DISMISSED" : "ACTION_TAKEN",
          resolvedAt: new Date(),
          resolvedBy: staffUserId,
        },
      });
      if (moved.count === 0) {
        throw Object.assign(
          new Error("This report has already been resolved"),
          { httpStatus: 409 },
        );
      }

      const action = await tx.moderationAction.create({
        data: {
          reportId,
          actionType,
          notes,
          takenById: staffUserId,
        },
        include: {
          takenBy: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      const transactional = await applyTransactionalEffects(tx, input);

      const updatedReport = await tx.moderationReport.findUniqueOrThrow({
        where: { id: reportId },
      });

      return { action, updatedReport, transactional };
    },
    { maxWait: 10000, timeout: 30000 },
  );
}

function moderationActionErrorResponse(error: unknown): NextResponse {
  if (error instanceof Error && "httpStatus" in error) {
    const status =
      typeof (error as { httpStatus?: number }).httpStatus === "number"
        ? (error as { httpStatus: number }).httpStatus
        : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    { tags: { subsystem: "staff" } },
  );
  console.error("Error taking moderation action:", error);
  return NextResponse.json({ error: "Failed to take action" }, { status: 500 });
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    const { reportId } = await params;
    const body = await req.json();
    const { actionType, notes, suspensionDays } = body;

    // Moderation is staff's remit (`moderation.manage`), but banning and
    // suspending an account is not: BACKOFFICE_PERMISSIONS reserves
    // `users.moderate` for ADMIN because those are irreversible and
    // account-destroying, and staff are employees with turnover. The gate is
    // per-ACTION rather than per-route so staff keep the rest of the queue —
    // warnings, content removal, un-verifying a profile.
    const ACCOUNT_DESTRUCTIVE: ModerationActionType[] = [
      "USER_BANNED",
      "USER_SUSPENDED",
    ];
    if (
      ACCOUNT_DESTRUCTIVE.includes(actionType) &&
      !hasBackofficePermission(session.user.role as UserRole, "users.moderate")
    ) {
      return NextResponse.json(
        {
          error:
            "Forbidden — banning or suspending an account requires an admin",
        },
        { status: 403 },
      );
    }

    const validationError = validateActionRequest(actionType, suspensionDays);
    if (validationError) return validationError;

    // Check report exists
    const report = await prisma.moderationReport.findUnique({
      where: { id: reportId },
      select: {
        id: true,
        status: true,
        targetUserId: true,
        reviewId: true,
        // #1270 — CONTENT_REMOVED needs the message identity to delete
        // anything; without it the action removed nothing at all.
        streamMessageId: true,
      },
    });

    if (!report) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    // Idempotency: a resolved report never re-runs side-effects (a staff
    // double-click on BAN must not double-refund).
    if (report.status === "ACTION_TAKEN" || report.status === "DISMISSED") {
      return NextResponse.json(
        { error: "This report has already been resolved" },
        { status: 409 },
      );
    }

    const input = {
      actionType: actionType as ModerationActionType,
      report: {
        id: report.id,
        targetUserId: report.targetUserId,
        reviewId: report.reviewId,
        streamMessageId: report.streamMessageId,
      },
      staffUserId: session.user.id,
      notes,
      suspensionDays,
    };

    const { action, updatedReport, transactional } =
      await applyModerationTransaction(
        reportId,
        actionType,
        notes,
        session.user.id,
        input,
      );

    // #705 — the moderation path never invalidated the public caches, so a
    // removed review kept rendering on the landing page and explore for up to
    // an hour. Purged AFTER the transaction commits: purging before would
    // repopulate the cache from rows a rollback then restores.
    if (transactional.reviewRemovedConsultantProfileId) {
      purgeReviewSurfaces(transactional.reviewRemovedConsultantProfileId);
    }

    // Refunds, Stream revocation, and notifications are best-effort — each
    // step's outcome (including failures) is persisted for staff visibility.
    let sideEffects: SideEffectSummary = transactional;
    try {
      sideEffects = await applyBestEffortEffects(input, transactional);
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "moderation" } },
      );
    }
    await persistActionSideEffects(action.id, sideEffects);

    return NextResponse.json({
      action,
      report: updatedReport,
      sideEffects,
      message: `Action '${actionType}' taken successfully`,
    });
  } catch (error) {
    return moderationActionErrorResponse(error);
  }
}
