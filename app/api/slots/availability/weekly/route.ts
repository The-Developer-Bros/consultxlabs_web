import * as Sentry from "@sentry/nextjs";
import { coalesceAndResolve } from "@/utils/slotAllocation/mergeAdjacentWeeklyRows";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { DayOfWeek, Prisma } from "@prisma/client";
import {
  minutesToTimeString,
  validateWeeklySlotTimeOrder,
  buildWeeklyOverlapWhere,
} from "@/utils/slotAllocation/slotTimeUtils";
import {
  resolveWeeklyTimezone,
  resolveWeeklyUtcOffsetMinutes,
  WeeklyOffsetConflictError,
  weeklyRowLocalColumns,
} from "@/lib/scheduling/weeklyUtcOffset";
import { getSession } from "@/lib/auth-server";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const consultantProfileId = searchParams.get("consultantProfileId");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");

    if (!consultantProfileId) {
      return NextResponse.json(
        { error: "consultantProfileId is required" },
        { status: 400 },
      );
    }

    const skip = (page - 1) * limit;

    const [weeklySlots, total] = await Promise.all([
      prisma.slotOfAvailabilityWeekly.findMany({
        where: {
          consultantProfileId: consultantProfileId,
        },
        orderBy: [{ startDay: "asc" }, { startTimeUtc: "asc" }],
        include: {
          consultantProfile: {
            select: {
              id: true,
              user: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
        skip,
        take: limit,
      }),
      prisma.slotOfAvailabilityWeekly.count({
        where: { consultantProfileId: consultantProfileId },
      }),
    ]);

    return NextResponse.json(
      {
        data: weeklySlots,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error fetching weekly slots:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "scheduling" } },
    );
    return NextResponse.json(
      { error: "An error occurred while fetching weekly availability slots" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    // Auth check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const body = await req.json();
    const {
      consultantProfileId,
      startDay,
      endDay,
      startTimeUtc,
      endTimeUtc,
      utcOffsetMinutes: suppliedUtcOffsetMinutes,
    } = body;

    if (
      !consultantProfileId ||
      !startDay ||
      !endDay ||
      startTimeUtc === undefined ||
      startTimeUtc === null ||
      endTimeUtc === undefined ||
      endTimeUtc === null
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    // Ownership check (also fetch user timezone for offset computation)
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { id: consultantProfileId },
      select: { userId: true, user: { select: { timezone: true } } },
    });
    if (!consultantProfile || consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Forbidden: you do not own this consultant profile" },
        { status: 403 },
      );
    }

    if (
      !Object.values(DayOfWeek).includes(startDay) ||
      !Object.values(DayOfWeek).includes(endDay)
    ) {
      return NextResponse.json(
        { error: "Invalid day of week" },
        { status: 400 },
      );
    }

    if (
      typeof startTimeUtc !== "number" ||
      typeof endTimeUtc !== "number" ||
      !Number.isInteger(startTimeUtc) ||
      !Number.isInteger(endTimeUtc) ||
      startTimeUtc < 0 ||
      startTimeUtc > 1439 ||
      endTimeUtc < 0 ||
      endTimeUtc > 1439
    ) {
      return NextResponse.json(
        {
          error:
            "Invalid time format: must be integer 0-1439 (minutes since midnight UTC)",
        },
        { status: 400 },
      );
    }

    // Day-aware time order validation (supports overnight slots)
    const timeError = validateWeeklySlotTimeOrder(
      startDay,
      endDay,
      startTimeUtc,
      endTimeUtc,
    );
    if (timeError) {
      return NextResponse.json({ error: timeError }, { status: 400 });
    }

    // #1326 — the consultant's profile timezone decides the offset, and a
    // caller who sends one of their own may only agree with it. Resolved once,
    // before the transaction, so a contradiction costs no write.
    const profileTimezone = consultantProfile.user?.timezone ?? null;
    let utcOffsetMinutes: number;
    try {
      utcOffsetMinutes = resolveWeeklyUtcOffsetMinutes({
        profileTimezone,
        callerSupplied: suppliedUtcOffsetMinutes ?? null,
        consultantProfileId,
      });
    } catch (error) {
      if (error instanceof WeeklyOffsetConflictError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: 400 },
        );
      }
      throw error;
    }
    // #872 — dual-written, read by nothing until the reader flip.
    const localColumns = weeklyRowLocalColumns(
      { startDay, endDay, startTimeUtc, endTimeUtc },
      resolveWeeklyTimezone(profileTimezone),
      utcOffsetMinutes,
    );

    // Overlap check, write and coalescing share one Serializable transaction:
    // coalescing rewrites the consultant's whole weekly set as
    // delete-then-recreate, so a half-applied rewrite on the bare client would
    // leave them with no availability at all (#1320).
    return await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // Cross-midnight-aware overlap check
          const overlappingSlot = await tx.slotOfAvailabilityWeekly.findFirst({
            where: buildWeeklyOverlapWhere(
              consultantProfileId,
              startDay,
              endDay,
              startTimeUtc,
              endTimeUtc,
            ),
          });

          if (overlappingSlot) {
            return NextResponse.json(
              {
                error: `This slot (${minutesToTimeString(startTimeUtc)}-${minutesToTimeString(endTimeUtc)}) overlaps with an existing slot`,
              },
              { status: 409 },
            );
          }

          // Not the response payload: the coalesce below can fold this row
          // away, so the covering row is what the client is answered with.
          await tx.slotOfAvailabilityWeekly.create({
            data: {
              consultantProfileId,
              startDay,
              endDay,
              startTimeUtc,
              endTimeUtc,
              utcOffsetMinutes,
              ...localColumns,
            },
          });

          // #1320 — an entry that touches an existing row becomes one row; answer
          // with the row that now covers what was asked for.
          const covering = await coalesceAndResolve(tx, consultantProfileId, {
            startDay,
            endDay,
            startTimeUtc,
            endTimeUtc,
          });
          return NextResponse.json({ data: covering }, { status: 201 });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          // The defaults are sized for one statement; this body is a read, a
          // write and a whole-set rewrite behind PG_POOL_MAX=1.
          maxWait: 10_000,
          timeout: 15_000,
        },
      ),
    );
  } catch (error) {
    console.error("Error creating weekly slot:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "scheduling" } },
    );
    return NextResponse.json(
      {
        error: "An error occurred while creating the weekly availability slot",
      },
      { status: 500 },
    );
  }
}
