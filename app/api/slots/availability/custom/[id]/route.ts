import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { coalesceAndResolveCustom } from "@/utils/slotAllocation/mergeAdjacentWeeklyRows";
import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth-server";

/**
 * The tail both custom-slot edits share: reject an overlap with any other row,
 * write, then fold the rows the edit made adjacent and answer with the row
 * that now covers it (#1320). PUT and PATCH differ only in how they arrive at
 * the two instants.
 *
 * One Serializable transaction, for the reason the weekly twin gives:
 * coalescing deletes the folded rows and extends the survivor, so a failure
 * between those two writes destroys availability rather than merging it.
 */
async function applyCustomSlotEdit(
  id: string,
  consultantProfileId: string,
  next: { startsAt: Date; endsAt: Date },
) {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const overlappingSlot = await tx.slotOfAvailabilityCustom.findFirst({
          where: {
            id: { not: id },
            consultantProfileId,
            OR: [
              {
                startsAt: { lte: next.startsAt },
                endsAt: { gt: next.startsAt },
              },
              {
                startsAt: { lt: next.endsAt },
                endsAt: { gte: next.endsAt },
              },
              {
                startsAt: { gte: next.startsAt },
                endsAt: { lte: next.endsAt },
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

        // No `include`: the coalesce below can fold this row away, so the
        // covering row — not this one — is what the client is answered with.
        const updatedSlot = await tx.slotOfAvailabilityCustom.update({
          where: { id },
          data: { startsAt: next.startsAt, endsAt: next.endsAt },
        });

        const covering = await coalesceAndResolveCustom(
          tx,
          updatedSlot.consultantProfileId,
          { startsAt: updatedSlot.startsAt, endsAt: updatedSlot.endsAt },
        );
        return NextResponse.json({ data: covering }, { status: 200 });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        // See the weekly twin: the defaults are sized for one statement, not
        // for a read, a write and a whole-set rewrite behind PG_POOL_MAX=1.
        maxWait: 10_000,
        timeout: 15_000,
      },
    ),
  );
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const customSlot = await prisma.slotOfAvailabilityCustom.findUnique({
      where: { id: id },
      include: {
        consultantProfile: true,
      },
    });

    if (!customSlot) {
      return NextResponse.json(
        { error: "Custom slot not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: customSlot }, { status: 200 });
  } catch (error) {
    console.error("Error fetching custom slot:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "slots" } },
    );
    return NextResponse.json(
      { error: "An error occurred while fetching the custom slot" },
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
    const currentSlot = await prisma.slotOfAvailabilityCustom.findUnique({
      where: { id },
      include: { consultantProfile: { select: { userId: true } } },
    });

    if (!currentSlot) {
      return NextResponse.json(
        { error: "Custom slot not found" },
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

    if (!body.startsAt || !body.endsAt) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (isNaN(Date.parse(body.startsAt)) || isNaN(Date.parse(body.endsAt))) {
      return NextResponse.json(
        { error: "Invalid date format" },
        { status: 400 },
      );
    }

    const startTime = new Date(body.startsAt);
    const endTime = new Date(body.endsAt);

    if (startTime >= endTime) {
      return NextResponse.json(
        { error: "Start time must be before end time" },
        { status: 400 },
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

    // Uses the authoritative consultantProfileId from the existing row.
    return await applyCustomSlotEdit(id, currentSlot.consultantProfileId, {
      startsAt: startTime,
      endsAt: endTime,
    });
  } catch (error) {
    console.error("Error updating custom slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json(
          { error: "Custom slot not found" },
          { status: 404 },
        );
      }
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "slots" } },
    );
    return NextResponse.json(
      { error: "An error occurred while updating the custom slot" },
      { status: 500 },
    );
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

    const currentSlot = await prisma.slotOfAvailabilityCustom.findUnique({
      where: { id: id },
      include: { consultantProfile: { select: { userId: true } } },
    });

    if (!currentSlot) {
      return NextResponse.json(
        { error: "Custom slot not found" },
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

    if (
      (body.startsAt && isNaN(Date.parse(body.startsAt))) ||
      (body.endsAt && isNaN(Date.parse(body.endsAt)))
    ) {
      return NextResponse.json(
        { error: "Invalid date format" },
        { status: 400 },
      );
    }

    const startTime = body.startsAt
      ? new Date(body.startsAt)
      : currentSlot.startsAt;
    const endTime = body.endsAt ? new Date(body.endsAt) : currentSlot.endsAt;

    if (startTime >= endTime) {
      return NextResponse.json(
        { error: "Start time must be before end time" },
        { status: 400 },
      );
    }

    // Uses the authoritative consultantProfileId from the existing row.
    return await applyCustomSlotEdit(id, currentSlot.consultantProfileId, {
      startsAt: startTime,
      endsAt: endTime,
    });
  } catch (error) {
    console.error("Error partially updating custom slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json(
          { error: "Custom slot not found" },
          { status: 404 },
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while updating the custom slot" },
      { status: 500 },
    );
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

    const customSlot = await prisma.slotOfAvailabilityCustom.findUnique({
      where: { id },
      include: { consultantProfile: { select: { userId: true } } },
    });

    if (!customSlot) {
      return NextResponse.json(
        { error: "Custom slot not found" },
        { status: 404 },
      );
    }

    // Ownership check
    if (customSlot.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Forbidden: you do not own this slot" },
        { status: 403 },
      );
    }

    const deletedSlot = await prisma.slotOfAvailabilityCustom.delete({
      where: { id: id },
      include: {
        consultantProfile: true,
      },
    });

    return NextResponse.json(
      { message: "Custom slot deleted successfully", data: deletedSlot },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error deleting custom slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json(
          { error: "Custom slot not found" },
          { status: 404 },
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while deleting the custom slot" },
      { status: 500 },
    );
  }
}
