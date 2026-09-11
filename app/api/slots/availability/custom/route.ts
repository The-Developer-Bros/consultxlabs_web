import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { coalesceAndResolveCustom } from "@/utils/slotAllocation/mergeAdjacentWeeklyRows";
import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth-server";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const consultantProfileId = searchParams.get("consultantProfileId");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");

    if (!consultantProfileId) {
      return NextResponse.json(
        { error: "consultantProfileId is required" },
        { status: 400 },
      );
    }

    const whereClause: Prisma.SlotOfAvailabilityCustomWhereInput = {
      consultantProfileId: consultantProfileId,
    };

    if (startDate && endDate) {
      if (isNaN(Date.parse(startDate)) || isNaN(Date.parse(endDate))) {
        return NextResponse.json(
          { error: "Invalid date format" },
          { status: 400 },
        );
      }
      whereClause.startsAt = {
        gte: new Date(startDate),
      };
      whereClause.endsAt = {
        lte: new Date(endDate),
      };
    }

    const [customSlots, total] = await Promise.all([
      prisma.slotOfAvailabilityCustom.findMany({
        where: whereClause,
        orderBy: {
          startsAt: "asc",
        },
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
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.slotOfAvailabilityCustom.count({ where: whereClause }),
    ]);

    return NextResponse.json(
      {
        data: customSlots,
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
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "scheduling" } },
    );
    console.error("Error fetching custom slots:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching custom availability slots" },
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
    const { consultantProfileId, startsAt, endsAt } = body;

    if (!consultantProfileId || !startsAt || !endsAt) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    // Ownership check
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { id: consultantProfileId },
      select: { userId: true },
    });
    if (!consultantProfile || consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Forbidden: you do not own this consultant profile" },
        { status: 403 },
      );
    }

    if (isNaN(Date.parse(startsAt)) || isNaN(Date.parse(endsAt))) {
      return NextResponse.json(
        { error: "Invalid date format" },
        { status: 400 },
      );
    }

    const startTime = new Date(startsAt);
    const endTime = new Date(endsAt);

    if (startTime >= endTime) {
      return NextResponse.json(
        { error: "Start time must be before end time" },
        { status: 400 },
      );
    }

    // Overlap check, write and coalescing share one Serializable transaction:
    // coalescing deletes the folded rows and extends the survivor, so on the
    // bare client a failure between those writes destroys availability (#1320).
    return await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // Check for overlapping slots
          const overlappingSlot = await tx.slotOfAvailabilityCustom.findFirst({
            where: {
              consultantProfileId,
              OR: [
                {
                  startsAt: { lte: startTime },
                  endsAt: { gt: startTime },
                },
                {
                  startsAt: { lt: endTime },
                  endsAt: { gte: endTime },
                },
                {
                  startsAt: { gte: startTime },
                  endsAt: { lte: endTime },
                },
              ],
            },
          });

          if (overlappingSlot) {
            return NextResponse.json(
              { error: "This slot overlaps with an existing slot" },
              { status: 409 },
            );
          }

          // Not the response payload: the coalesce below can fold this row
          // away, so the covering row is what the client is answered with.
          await tx.slotOfAvailabilityCustom.create({
            data: {
              consultantProfileId,
              startsAt: startTime,
              endsAt: endTime,
            },
          });

          // #1320 — the overlap guard above still rejects an overlap but permits
          // exact adjacency, which is how the fragmented rows got there. Fold what
          // now touches and answer with the row that covers what was asked for.
          const covering = await coalesceAndResolveCustom(
            tx,
            consultantProfileId,
            { startsAt: startTime, endsAt: endTime },
          );
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
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "scheduling" } },
    );
    console.error("Error creating custom slot:", error);
    return NextResponse.json(
      {
        error: "An error occurred while creating the custom availability slot",
      },
      { status: 500 },
    );
  }
}
