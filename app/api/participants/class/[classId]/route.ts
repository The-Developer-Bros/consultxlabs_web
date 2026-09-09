import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { refundRemovedAttendeeSeat } from "@/lib/payments/operations/event-refunds";
import { removeUserFromEventChannel } from "@/actions/stream/chat/event-channel.action";
import { findLiveEventSlot } from "@/lib/appointments/live-event-slot";
import {
  applyRateLimit,
  eventMutationLimiter,
  participantReadLimiter,
} from "@/lib/rate-limit";

// Display fields only — the old `user: true` shipped every User scalar
// (role, verification state, timestamps…) for every participant on every
// poll of the roster page.
const PARTICIPANT_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
} as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ classId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const rl = await applyRateLimit(participantReadLimiter, session.user.id);
  if (rl) return rl;

  try {
    const { classId } = await params;
    // Non-privileged users can view the roster if they own the plan OR are an
    // accepted collaborator granted canSeeAttendees (#768). Everyone else 404s.
    const classEvent = await prisma.class.findFirst({
      where: {
        id: classId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              classPlan: {
                OR: [
                  {
                    consultantProfileId:
                      session.user.consultantProfileId ?? "__none__",
                  },
                  {
                    collaborators: {
                      some: {
                        consultantProfileId:
                          session.user.consultantProfileId ?? "__none__",
                        status: "ACCEPTED",
                        canSeeAttendees: true,
                      },
                    },
                  },
                ],
              },
            }),
      },
      include: {
        classPlan: true,
        appointments: {
          select: {
            id: true,
            slotsOfAppointment: {
              select: {
                id: true,
                user: { select: PARTICIPANT_USER_SELECT },
              },
            },
          },
        },
      },
    });

    if (!classEvent) {
      return new NextResponse("Class not found", { status: 404 });
    }

    // Get unique participants by user ID
    const participants = Array.from(
      new Map(
        classEvent.appointments
          ?.flatMap(
            (appointment) =>
              appointment.slotsOfAppointment?.flatMap(
                (slot) => slot.user || [],
              ) || [],
          )
          .map((user) => [user.id, user]) || [],
      ).values(),
    );

    return NextResponse.json({
      classEvent,
      participants,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("[CLASS_PARTICIPANTS_GET]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ classId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const rl = await applyRateLimit(eventMutationLimiter, session.user.id);
  if (rl) return rl;

  try {
    const { classId } = await params;

    const { searchParams } = new URL(request.url);
    const parsedUserId = z
      .string()
      .trim()
      .min(1)
      .max(64)
      .safeParse(searchParams.get("userId"));
    if (!parsedUserId.success) {
      return new NextResponse("User ID is required", { status: 400 });
    }
    const userId = parsedUserId.data;

    // #1005 — consultees may remove themselves (self-leave). Organisers and
    // privileged roles may remove anyone on their event.
    const isSelfLeave = userId === session.user.id;
    const isOrganiser =
      isPrivileged(session.user.role) || !!session.user.consultantProfileId;
    if (!isSelfLeave && !isOrganiser) {
      return forbiddenResponse(
        "Only consultants can remove other participants",
      );
    }

    // Ownership check for organiser removals; self-leave only needs the event
    // to exist and the caller to be on the roster (checked via userSlots).
    const classEvent = await prisma.class.findFirst({
      where: {
        id: classId,
        ...(isSelfLeave || isPrivileged(session.user.role)
          ? {}
          : {
              classPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
      },
      select: { id: true },
    });

    if (!classEvent) {
      return new NextResponse("Class not found", { status: 404 });
    }

    // #1005 — class self-leave is allowed between sessions until the *last*
    // live session has started. Webinar DELETE correctly keys on the earliest
    // atom (one contiguous event); a months-long class keeps past sessions as
    // COMPLETED/UNVERIFIED which are still "live" for run math, so an earliest
    // gate permanently 400s after week 1 while the UI still offers Leave.
    // Organiser removals keep working mid/post session for moderation.
    if (isSelfLeave) {
      const lastLive = await findLiveEventSlot({ classId }, { order: "desc" });
      if (lastLive && lastLive.startsAt.getTime() <= Date.now()) {
        return NextResponse.json(
          { error: "Cannot leave a class after its last session has started." },
          { status: 400 },
        );
      }
    }

    // #1003 — nothing to remove means nothing to refund. The refund helper
    // looks the payment up by user + event rather than by what was actually
    // released, so a removal that released nothing still raised an ops page.
    //
    // The roster read used to sit OUTSIDE the write, which made that guard
    // decorative under concurrency: a repeat click, a stale tab, or an
    // organiser removing someone who is leaving at the same moment both read a
    // non-empty roster and both went on to refund one paid seat twice.
    // Re-reading inside a Serializable transaction makes the seat itself the
    // arbiter — the loser is aborted on the row it also tried to write, and its
    // retry sees the empty roster.
    const removedSlots = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const userSlots = await tx.slotOfAppointment.findMany({
            where: {
              appointment: { classId },
              user: { some: { id: userId } },
            },
            select: { id: true },
          });
          if (userSlots.length === 0) return 0;

          // Sequential inside the tx: the parent row's `updatedAt` write is
          // what raises the serialization conflict for the losing writer.
          for (const slot of userSlots) {
            await tx.slotOfAppointment.update({
              where: { id: slot.id },
              data: {
                user: {
                  disconnect: { id: userId },
                },
              },
            });
          }

          // #1319 A9 — the seat is released; the participant row stays
          // as history. Same transaction as the disconnects, and only on
          // the seat-was-present path, so a `removed: false` answer never
          // flips a row this request did not release.
          await tx.appointmentParticipant.updateMany({
            where: { appointment: { classId }, userId },
            data: { status: "CANCELLED" },
          });

          return userSlots.length;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          // The disconnect loop is one round trip per seat and a months-long
          // class carries every past session on the roster, so the default 5s
          // budget is reachable. A P2028 timeout is not a serialization abort:
          // withSerializableRetry rethrows it, the handler answers 500, and the
          // rollback leaves the seat held and the fee unrefunded. House budget
          // (see lib/payments/operations/*), shared with the webinar handler so
          // the two removals keep one concurrency contract.
          maxWait: 10_000,
          timeout: 15_000,
        },
      ),
    );

    // 200, not 404: DELETE is idempotent and "this person is off the roster"
    // is the requested end state either way. A 404 made the second click read
    // as a failure to the roster client, which throws on any non-ok response —
    // so it showed "Failed to remove participant" and never invalidated the
    // query, leaving the removed row on screen.
    if (removedSlots === 0) {
      return NextResponse.json({ removed: false, refund: null });
    }

    // #1003 — seat was paid; refund after roster commit (non-throwing).
    // #1005 — pass initiatedBy so self-leave does not get organiser-fault 100%.
    const refund = await refundRemovedAttendeeSeat({
      kind: "class",
      eventId: classId,
      attendeeUserId: userId,
      initiatedByUserId: session.user.id,
      initiatedBy: isSelfLeave ? "attendee" : "organiser",
    });

    // #1169 PR 4 — a removed/refunded attendee must not keep reading the event
    // chat until the nightly expiry job notices. Non-throwing by contract.
    const channelRemoval = await removeUserFromEventChannel(
      "class",
      classId,
      userId,
    );
    if (!channelRemoval.success) {
      console.warn(
        JSON.stringify({
          event: "attendee_channel_removal_failed",
          eventType: "class",
          eventId: classId,
          userId,
          timestamp: new Date().toISOString(),
        }),
      );
    }

    return NextResponse.json({ removed: true, refund });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("[CLASS_PARTICIPANT_DELETE]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}
