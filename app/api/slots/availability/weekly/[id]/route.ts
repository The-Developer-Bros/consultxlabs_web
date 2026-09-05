import { NextRequest, NextResponse } from "next/server";
import { coalesceAndResolve } from "@/utils/slotAllocation/mergeAdjacentWeeklyRows";
import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { Prisma, DayOfWeek } from "@prisma/client";
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
import * as Sentry from "@sentry/nextjs";

/**
 * The tail every weekly-slot edit shares: reject an overlap, stamp the
 * consultant's current UTC offset, write, then fold adjacent rows and answer
 * with the row that now covers the edit (#1320). PUT and PATCH differ only in
 * how they arrive at the four values, so only that part stays in the handler.
 *
 * All of it runs in ONE Serializable transaction. Coalescing rewrites the
 * consultant's whole weekly set as delete-then-recreate, so on the bare client
 * a failure between the two halves leaves the consultant with no availability
 * at all, and a concurrent save reads a set the other writer is mid-way
 * through replacing. Serializable also closes the check-then-act window the
 * overlap read used to leave open.
 */
async function applyWeeklySlotEdit(
  id: string,
  currentSlot: {
    consultantProfileId: string;
    consultantProfile: { user: { timezone: string | null } | null };
  },
  next: {
    startDay: DayOfWeek;
    endDay: DayOfWeek;
    startTimeUtc: number;
    endTimeUtc: number;
  },
  callerSuppliedOffsetMinutes: number | null,
) {
  // #1326 — the profile timezone decides the offset for every write path, and
  // a caller may only agree with it. This route used to default a consultant
  // with no profile timezone to UTC 0 rather than to the launch offset, so
  // every row it touched projected five and a half hours away from where it
  // was published. Resolved before the transaction so a contradiction costs no
  // write.
  const profileTimezone = currentSlot.consultantProfile.user?.timezone ?? null;
  let utcOffsetMinutes: number;
  try {
    utcOffsetMinutes = resolveWeeklyUtcOffsetMinutes({
      profileTimezone,
      callerSupplied: callerSuppliedOffsetMinutes,
      consultantProfileId: currentSlot.consultantProfileId,
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
    next,
    resolveWeeklyTimezone(profileTimezone),
    utcOffsetMinutes,
  );

  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Cross-midnight-aware overlap check against the authoritative
        // consultant.
        const overlappingSlot = await tx.slotOfAvailabilityWeekly.findFirst({
          where: buildWeeklyOverlapWhere(
            currentSlot.consultantProfileId,
            next.startDay,
            next.endDay,
            next.startTimeUtc,
            next.endTimeUtc,
            id,
          ),
        });

        if (overlappingSlot) {
          return NextResponse.json(
            {
              error: `This slot (${minutesToTimeString(next.startTimeUtc)}-${minutesToTimeString(next.endTimeUtc)}) overlaps with an existing slot`,
            },
            { status: 409 },
          );
        }

        // No `include`: the coalesce below can fold this row away, so the
        // covering row — not this one — is what the client is answered with.
        const updatedSlot = await tx.slotOfAvailabilityWeekly.update({
          where: { id },
          data: { ...next, utcOffsetMinutes, ...localColumns },
        });

        const covering = await coalesceAndResolve(
          tx,
          updatedSlot.consultantProfileId,
          {
            startDay: updatedSlot.startDay,
            endDay: updatedSlot.endDay,
            startTimeUtc: updatedSlot.startTimeUtc,
            endTimeUtc: updatedSlot.endTimeUtc,
          },
        );
        return NextResponse.json({ data: covering }, { status: 200 });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        // Prisma's 2s/5s defaults are for a single statement; this body is an
        // overlap read, a write and a whole-set rewrite, and PG_POOL_MAX=1
        // serialises connection acquisition on the deploy.
        maxWait: 10_000,
        timeout: 15_000,
      },
    ),
  );
}

/**
 * The catch every write handler shares. `logAction` is what the server log
 * says; `failAction` is what the client is told, and PATCH deliberately logs
 * "partially updating" while answering with the same copy PUT does.
 */
function weeklySlotErrorResponse(
  error: unknown,
  logAction: string,
  failAction: string,
) {
  console.error(`Error ${logAction} weekly slot:`, error);
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    { tags: { subsystem: "scheduling" } },
  );
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  ) {
    return NextResponse.json(
      { error: "Weekly slot not found" },
      { status: 404 },
    );
  }
  return NextResponse.json(
    { error: `An error occurred while ${failAction} the weekly slot` },
    { status: 500 },
  );
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const weeklySlot = await prisma.slotOfAvailabilityWeekly.findUnique({
      where: { id: id },
      include: {
        consultantProfile: true,
      },
    });

    if (!weeklySlot) {
      return NextResponse.json(
        { error: "Weekly slot not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: weeklySlot }, { status: 200 });
  } catch (error) {
    console.error("Error fetching weekly slot:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "scheduling" } },
    );
    return NextResponse.json(
      { error: "An error occurred while fetching the weekly slot" },
      { status: 500 },
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    // Auth check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    // Fetch existing slot for authoritative consultantProfileId and ownership
    const currentSlot = await prisma.slotOfAvailabilityWeekly.findUnique({
      where: { id },
      include: {
        consultantProfile: {
          select: { userId: true, user: { select: { timezone: true } } },
        },
      },
    });

    if (!currentSlot) {
      return NextResponse.json(
        { error: "Weekly slot not found" },
        { status: 404 },
      );
    }

    // Ownership check
    if (currentSlot.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Forbidden: you do not own this slot" },
        { status: 403 },
      );
    }

    const body = await req.json();

    if (
      !body.startDay ||
      !body.endDay ||
      body.startTimeUtc === undefined ||
      body.startTimeUtc === null ||
      body.endTimeUtc === undefined ||
      body.endTimeUtc === null
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (
      !Object.values(DayOfWeek).includes(body.startDay) ||
      !Object.values(DayOfWeek).includes(body.endDay)
    ) {
      return NextResponse.json(
        { error: "Invalid day of week" },
        { status: 400 },
      );
    }

    const startTimeUtc: number = body.startTimeUtc;
    const endTimeUtc: number = body.endTimeUtc;

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
      body.startDay,
      body.endDay,
      startTimeUtc,
      endTimeUtc,
    );
    if (timeError) {
      return NextResponse.json({ error: timeError }, { status: 400 });
    }

    // Use authoritative consultantProfileId from existing slot (FIX 9)
    const effectiveConsultantProfileId = currentSlot.consultantProfileId;

    // Reject consultant reassignment
    if (
      body.consultantProfileId &&
      body.consultantProfileId !== effectiveConsultantProfileId
    ) {
      return NextResponse.json(
        { error: "Cannot reassign slot to a different consultant" },
        { status: 400 },
      );
    }

    return await applyWeeklySlotEdit(
      id,
      { ...currentSlot, consultantProfileId: effectiveConsultantProfileId },
      {
        startDay: body.startDay,
        endDay: body.endDay,
        startTimeUtc,
        endTimeUtc,
      },
      body.utcOffsetMinutes ?? null,
    );
  } catch (error) {
    return weeklySlotErrorResponse(error, "updating", "updating");
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    // Auth check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const body = await req.json();

    if (body.startDay && !Object.values(DayOfWeek).includes(body.startDay)) {
      return NextResponse.json(
        { error: "Invalid day of week for start time" },
        { status: 400 },
      );
    }

    if (body.endDay && !Object.values(DayOfWeek).includes(body.endDay)) {
      return NextResponse.json(
        { error: "Invalid day of week for end time" },
        { status: 400 },
      );
    }

    const currentSlot = await prisma.slotOfAvailabilityWeekly.findUnique({
      where: { id: id },
      include: {
        consultantProfile: {
          select: { userId: true, user: { select: { timezone: true } } },
        },
      },
    });

    if (!currentSlot) {
      return NextResponse.json(
        { error: "Weekly slot not found" },
        { status: 404 },
      );
    }

    // Ownership check
    if (currentSlot.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Forbidden: you do not own this slot" },
        { status: 403 },
      );
    }

    // Reject consultant reassignment
    if (
      body.consultantProfileId &&
      body.consultantProfileId !== currentSlot.consultantProfileId
    ) {
      return NextResponse.json(
        { error: "Cannot reassign slot to a different consultant" },
        { status: 400 },
      );
    }

    const startTimeUtc: number = body.startTimeUtc ?? currentSlot.startTimeUtc;
    const endTimeUtc: number = body.endTimeUtc ?? currentSlot.endTimeUtc;

    if (
      (body.startTimeUtc !== undefined &&
        (typeof body.startTimeUtc !== "number" ||
          !Number.isInteger(body.startTimeUtc))) ||
      (body.endTimeUtc !== undefined &&
        (typeof body.endTimeUtc !== "number" ||
          !Number.isInteger(body.endTimeUtc))) ||
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

    const effectiveStartDay = body.startDay || currentSlot.startDay;
    const effectiveEndDay = body.endDay || currentSlot.endDay;

    // Day-aware time order validation (supports overnight slots)
    const timeError = validateWeeklySlotTimeOrder(
      effectiveStartDay,
      effectiveEndDay,
      startTimeUtc,
      endTimeUtc,
    );
    if (timeError) {
      return NextResponse.json({ error: timeError }, { status: 400 });
    }

    // PATCH omits what it does not change, so the effective day pair is what
    // both the overlap check and the write use.
    return await applyWeeklySlotEdit(
      id,
      currentSlot,
      {
        startDay: effectiveStartDay,
        endDay: effectiveEndDay,
        startTimeUtc,
        endTimeUtc,
      },
      body.utcOffsetMinutes ?? null,
    );
  } catch (error) {
    return weeklySlotErrorResponse(error, "partially updating", "updating");
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    // Auth check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const weeklySlot = await prisma.slotOfAvailabilityWeekly.findUnique({
      where: { id },
      include: { consultantProfile: { select: { userId: true } } },
    });

    if (!weeklySlot) {
      return NextResponse.json(
        { error: "Weekly slot not found" },
        { status: 404 },
      );
    }

    // Ownership check
    if (weeklySlot.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Forbidden: you do not own this slot" },
        { status: 403 },
      );
    }

    const deletedSlot = await prisma.slotOfAvailabilityWeekly.delete({
      where: { id: id },
      include: {
        consultantProfile: true,
      },
    });

    return NextResponse.json(
      { message: "Weekly slot deleted successfully", data: deletedSlot },
      { status: 200 },
    );
  } catch (error) {
    return weeklySlotErrorResponse(error, "deleting", "deleting");
  }
}
