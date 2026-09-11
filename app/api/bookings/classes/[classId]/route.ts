import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { Prisma, ClassStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import {
  requireApiAuth,
  isPrivileged,
  authorizeEventAccess,
} from "@/lib/auth-helpers";
import { CLASS_EVENT_ALLOWED_FROM } from "@/lib/booking/transitions";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { classId } = await params;

    const authz = await authorizeEventAccess(session, "class", classId);
    if (authz) return authz;

    const classData = await prisma.class.findUniqueOrThrow({
      where: { id: classId },
      include: {
        classPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true,
              },
            },
            topics: true,
            classContents: {
              orderBy: {
                order: "asc",
              },
            },
          },
        },
        appointments: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true, // Changed from consulteeProfile to user
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: classData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  // Set once a guarded status write is attempted; lets the P2025 handler
  // below distinguish a CAS-guard miss (409) from a missing row (404).
  let statusWriteAttempted = false;

  try {
    const { classId } = await params;
    const body = await request.json();

    // Doctrine #1 — status writes go through the CAS map. `body.status` used
    // to be written raw, so an owner could drive illegal edges that
    // CLASS_EVENT_ALLOWED_FROM exists to prevent. The allowed-from set rides
    // the UPDATE's WHERE below, so a racing transition matches zero rows.
    const requestedStatus =
      typeof body.status === "string" ? (body.status as ClassStatus) : undefined;
    if (
      requestedStatus &&
      !Object.values(ClassStatus).includes(requestedStatus)
    ) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    let allowedFrom: ClassStatus[] | null = null;
    if (requestedStatus) {
      const current = await prisma.class.findUnique({
        where: { id: classId },
        select: { status: true },
      });
      if (!current) {
        return NextResponse.json({ error: "Class not found" }, { status: 404 });
      }
      allowedFrom = CLASS_EVENT_ALLOWED_FROM[requestedStatus];
      if (!allowedFrom.includes(current.status)) {
        return NextResponse.json(
          {
            error: `Illegal transition: ${current.status} → ${requestedStatus}`,
            code: "ILLEGAL_TRANSITION",
          },
          { status: 409 },
        );
      }
    }
    statusWriteAttempted = Boolean(requestedStatus);

    // Only the owning consultant or ADMIN/STAFF can update a class instance
    const classData = await prisma.class.update({
      where: {
        id: classId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              classPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
        ...(requestedStatus && allowedFrom
          ? { status: { in: allowedFrom } }
          : {}),
      },
      data: {
        schedulingPeriodStartsAt: body.schedulingPeriodStartsAt,
        schedulingPeriodEndsAt: body.schedulingPeriodEndsAt,
        status: requestedStatus,
        recordingUrls: body.recordingUrls,
        feedbackSummary: body.feedbackSummary,
      },
      include: {
        classPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true,
              },
            },
            topics: true,
            classContents: {
              orderBy: {
                order: "asc",
              },
            },
          },
        },
        appointments: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true, // Changed from consulteeProfile to user
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: classData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      // A WHERE miss can be either "no such class" or "the status moved
      // between our read and this write" — the latter is the CAS guard
      // working and must surface as 409, not a phantom 404.
      return NextResponse.json(
        {
          error: statusWriteAttempted
            ? "Class not found or status changed concurrently"
            : "Class not found",
        },
        { status: statusWriteAttempted ? 409 : 404 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { classId } = await params;

    // FIX #425: Check for active bookings/payments before allowing deletion.
    // Use same ownership filter as the delete to prevent info disclosure.
    // Use DB-side existence checks to avoid loading all appointments into memory.
    const classOwnershipFilter = isPrivileged(session.user.role)
      ? {}
      : { classPlan: { consultantProfileId: session.user.consultantProfileId ?? "__none__" } };
    const now = new Date();

    const classExists = await prisma.class.findUnique({
      where: { id: classId, ...classOwnershipFilter },
      select: { id: true },
    });
    if (!classExists) {
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    }

    const hasActivePayments = !!(await prisma.class.findFirst({
      where: {
        id: classId,
        appointments: {
          some: { payment: { some: { paymentStatus: { notIn: ["FAILED", "EXPIRED"] } } } },
        },
      },
      select: { id: true },
    }));
    if (hasActivePayments) {
      return NextResponse.json(
        { error: "Cannot delete class with active payments. Cancel or refund first." },
        { status: 400 },
      );
    }

    const hasUpcomingSlots = !!(await prisma.class.findFirst({
      where: {
        id: classId,
        appointments: {
          some: { slotsOfAppointment: { some: { endsAt: { gt: now } } } },
        },
      },
      select: { id: true },
    }));
    if (hasUpcomingSlots) {
      return NextResponse.json(
        { error: "Cannot delete class with upcoming or in-progress slots." },
        { status: 400 },
      );
    }

    // Only the owning consultant or ADMIN/STAFF can delete a class instance
    const classData = await prisma.class.delete({
      where: {
        id: classId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              classPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
      },
      include: {
        classPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true,
              },
            },
            topics: true,
            classContents: {
              orderBy: {
                order: "asc",
              },
            },
          },
        },
        appointments: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true, // Changed from consulteeProfile to user
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: classData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
