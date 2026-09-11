import { NextRequest, NextResponse } from "next/server";
import prisma from "lib/prisma";
import { getSession } from "@/lib/auth-server";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { assertBodySize } from "@/lib/validation/limits";
import { CreateSupportResponseSchema } from "@/schemas/support";
import * as Sentry from "@sentry/nextjs";
import { userRepliedPatch } from "@/lib/support/sla";
import { notifyStaffOfTicketActivity } from "@/lib/support/create-ticket";
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  try {
    const [session, resolvedParams] = await Promise.all([getSession(), params]);

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to respond to support tickets" },
        { status: 401 },
      );
    }

    // #831 — raw body.message was unbounded and unlimited
    const rl = await applyRateLimit(
      spamLimiter,
      `ticket-response:${session.user.id}`,
    );
    if (rl) return rl;
    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const { ticketId } = resolvedParams;
    const parsed = CreateSupportResponseSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.issues },
        { status: 400 },
      );
    }
    const body = parsed.data;

    // Verify the ticket exists and belongs to the user
    const ticket = await prisma.supportTicket.findFirst({
      where: {
        id: ticketId,
        userId: session.user.id,
      },
    });

    if (!ticket) {
      return NextResponse.json(
        {
          error:
            "This support ticket does not exist or you don't have permission to access it",
        },
        { status: 404 },
      );
    }

    // One transaction: the reply, the activity clock and the SLA resume commit
    // together. Previously the reply was the ONLY write — `lastMessageAt` never
    // moved, so a user chasing their own ticket never resurfaced it in the ops
    // inbox, which sorts on exactly that column.
    const now = new Date();
    const response = await prisma.$transaction(async (tx) => {
      const created = await tx.supportResponse.create({
        data: {
          message: body.message,
          supportTicket: { connect: { id: ticketId } },
          user: { connect: { id: session.user.id } },
        },
        include: {
          user: {
            select: {
              name: true,
              role: true,
            },
          },
        },
      });

      await tx.supportTicket.update({
        where: { id: ticketId },
        data: {
          lastMessageAt: now,
          // The ball is back with us — restart the resolution clock.
          ...userRepliedPatch(ticket, now),
        },
      });
      // CAS, not a bare update: a concurrent staff move off OPEN must not be
      // clobbered back by the user's reply landing a moment later.
      await tx.supportTicket.updateMany({
        where: { id: ticketId, status: "OPEN" },
        data: { status: "IN_PROGRESS" },
      });
      return created;
    });

    // Committed — safe to page the queue. A user's reply used to notify nobody.
    await notifyStaffOfTicketActivity(ticketId, null, response.id).catch(
      (error) => {
        console.error("support: user-reply notification failed", {
          ticketId,
          error,
        });
      },
    );

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    console.error("Error creating support response:", error);
    return NextResponse.json(
      {
        error: "An unexpected error occurred while submitting your response",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
