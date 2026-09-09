import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { fetchWebinarPlanDetail } from "@/lib/data/plan-details";
import { apiError } from "@/lib/errors";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import {
  archivedAtForArchive,
  parsePlanArchiveBody,
  PLAN_ORG_GOVERNED_RESPONSE,
  PLAN_ARCHIVE_RESPONSE_NOTE,
} from "@/lib/api/plans/archive";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ webinarPlanId: string }> },
) {
  try {
    const { webinarPlanId } = await params;
    const webinarPlan = await fetchWebinarPlanDetail(webinarPlanId);

    if (!webinarPlan) {
      return NextResponse.json(
        { error: "Webinar plan not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(
      { data: webinarPlan },
      {
        status: 200,
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "plans" } });
    return apiError({ tag: "[WebinarPlan.GET]", error });
  }
}

/**
 * Retired. Plan writes go through POST/PATCH on
 * /api/bookings/webinars/crud-with-plan, which validates with
 * WebinarPlanSchema and maintains the plan + instance + slot run atomically.
 * This legacy PUT bypassed Zod entirely, so retiring it (no callers remained)
 * removes the last unvalidated write path to WebinarPlan.
 */
export async function PUT() {
  return NextResponse.json(
    {
      error:
        "PUT is no longer supported on this route. Use POST/PATCH on /api/bookings/webinars/crud-with-plan.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}

/**
 * Sole-owner archive/restore (#1494). Webinar/class plan writes otherwise go
 * through crud-with-plan, but that route owns the full create/reschedule
 * transaction; a plain archivedAt toggle does not need that machinery and
 * lives here next to the DELETE it replaces for the sole-owner case.
 * consultantProfile is nullable on this model (org-curated catalog plans may
 * have no single owner), so a null profile can never match a session user.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ webinarPlanId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const { webinarPlanId } = await params;

    const parsedBody = await parsePlanArchiveBody(request);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: parsedBody.error, details: parsedBody.details },
        { status: 400 },
      );
    }
    const { archived } = parsedBody;

    const existingPlan = await prisma.webinarPlan.findUnique({
      where: { id: webinarPlanId },
      include: { consultantProfile: true },
    });

    if (!existingPlan) {
      return NextResponse.json(
        { error: "Webinar plan not found" },
        { status: 404 },
      );
    }

    if (
      !existingPlan.consultantProfile ||
      existingPlan.consultantProfile.userId !== session.user.id
    ) {
      return NextResponse.json(
        { error: "You do not have permission to update this webinar plan" },
        { status: 403 },
      );
    }

    if (existingPlan.organizationId) {
      return NextResponse.json(PLAN_ORG_GOVERNED_RESPONSE, { status: 403 });
    }

    const webinarPlan = await prisma.webinarPlan.update({
      where: { id: webinarPlanId },
      data: {
        archivedAt: archived
          ? archivedAtForArchive(existingPlan.archivedAt)
          : null,
      },
    });

    return NextResponse.json(
      {
        data: { id: webinarPlan.id, archivedAt: webinarPlan.archivedAt },
        message: PLAN_ARCHIVE_RESPONSE_NOTE,
      },
      { status: 200 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Webinar plan not found" },
        { status: 404 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "plans" } });
    return apiError({ tag: "[WebinarPlan.PATCH]", error });
  }
}

/**
 * Retired alongside PUT: deletion is a soft withdrawal via archivedAt
 * (#catalog-archive), never a hard delete — the legacy DELETE cascaded through
 * to Appointment and Payment rows.
 */
export async function DELETE() {
  return NextResponse.json(
    {
      error:
        "DELETE is no longer supported on this route. Plans are withdrawn via archivedAt, not deleted.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}
