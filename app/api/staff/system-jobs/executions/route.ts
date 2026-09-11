/**
 * Staff System Jobs Executions API
 * List job execution history
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { SystemJobStatus, Prisma } from "@prisma/client";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import * as Sentry from "@sentry/nextjs";
/**
 * GET /api/staff/system-jobs/executions
 * List job execution history with filters
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("systemJobs.manage");
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get("jobId");
    const status = searchParams.get("status") as SystemJobStatus | null;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = (page - 1) * limit;

    const where: Prisma.SystemJobExecutionWhereInput = {};

    if (jobId) {
      where.jobId = jobId;
    }
    if (status) {
      where.status = status;
    }

    const [executions, total] = await Promise.all([
      prisma.systemJobExecution.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.systemJobExecution.count({ where }),
    ]);

    // Get user info for triggered executions
    const triggeredByIds = executions
      .filter((e) => e.triggeredBy)
      .map((e) => e.triggeredBy as string);

    const triggeredByUsers =
      triggeredByIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: triggeredByIds } },
            select: { id: true, name: true, email: true },
          })
        : [];

    const userMap = new Map(triggeredByUsers.map((u) => [u.id, u]));

    const formattedExecutions = executions.map((execution) => ({
      id: execution.id,
      jobId: execution.jobId,
      jobName: execution.jobName,
      status: execution.status,
      startedAt: execution.startedAt,
      endedAt: execution.endedAt,
      durationMs: execution.durationMs,
      itemsProcessed: execution.itemsProcessed,
      errorCount: execution.errorCount,
      triggeredBy: execution.triggeredBy
        ? userMap.get(execution.triggeredBy) || {
            id: execution.triggeredBy,
            name: "Deleted User",
            email: null,
          }
        : null,
      result: execution.result,
      errorLog: execution.errorLog,
    }));

    return NextResponse.json({
      executions: formattedExecutions,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    console.error("Error fetching job executions:", error);
    return NextResponse.json(
      { error: "Failed to fetch job executions" },
      { status: 500 },
    );
  }
}
